"""
Audio analysis and file writing helpers.

Split out of the node so the node file states what the node does and nothing
else.  Nothing in here touches ComfyUI or aiohttp — it is pure numpy/torch in,
bytes or dicts out, which also makes it the only part of the package that is
straightforward to unit-test.
"""

import struct

import numpy as np


def save_wav(waveform, sample_rate: int, filepath: str) -> None:
    """Write a torch waveform to a 16-bit PCM WAV file.

    Accepts (batch, channels, samples) or (channels, samples); takes the first
    batch item and at most two channels.
    """
    if waveform.dim() == 3:
        waveform = waveform[0]

    n_ch = min(waveform.shape[0], 2)
    samples = np.clip(waveform[:n_ch].cpu().float().numpy(), -1.0, 1.0)
    interleaved = samples[0] if n_ch == 1 else samples.T.flatten()
    pcm = (interleaved * 32767).astype(np.int16)

    n_frames = waveform.shape[-1]
    data_size = n_frames * n_ch * 2

    with open(filepath, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, n_ch, sample_rate,
                            sample_rate * n_ch * 2, n_ch * 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        f.write(pcm.tobytes())


def compute_lufs(waveform) -> float:
    """Approximate integrated loudness (LUFS) via the ITU-R BS.1770 K-weighting.

    Uses scipy when available for the two-stage K-weighting filter; falls back
    to plain RMS with the same -0.691 offset when scipy is missing, which is
    less accurate but keeps the badge populated rather than blank.
    """
    if waveform.dim() == 3:
        waveform = waveform[0]

    mono = waveform.float().mean(dim=0).cpu().numpy()

    try:
        from scipy.signal import lfilter

        # Stage 1: high-shelf ("head" filter)
        b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
        a1 = [1.0, -1.69065929318241, 0.73248077421585]
        # Stage 2: high-pass ("RLB" weighting)
        b2 = [1.0, -2.0, 1.0]
        a2 = [1.0, -1.99004745483398, 0.99007225036298]

        stage2 = lfilter(b2, a2, lfilter(b1, a1, mono))
        ms = float(np.mean(stage2 ** 2))
        return round(-0.691 + 10.0 * np.log10(ms + 1e-10), 1)
    except Exception:
        rms = float(np.sqrt(np.mean(mono ** 2) + 1e-10))
        return round(20.0 * np.log10(rms) - 0.691, 1)


def build_peaks(waveform, num_bars: int = 120) -> dict:
    """Downsample to per-bar RMS values, normalised to 0-1 per channel.

    Returned as {"ch0": [...], "ch1": [...]} — the shape the waveform renderer
    expects.  Mono files produce ch0 only, and the front end uses the absence
    of ch1 as its stereo test.
    """
    if waveform.dim() == 3:
        waveform = waveform[0]

    result = {}
    for c in range(min(waveform.shape[0], 2)):
        samples = waveform[c].cpu().float().numpy()
        n = len(samples)
        chunk = max(1, n // num_bars)
        peaks = []
        for i in range(num_bars):
            seg = samples[i * chunk:(i + 1) * chunk]
            peaks.append(float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0)
        mx = max(peaks) if max(peaks) > 0 else 1.0
        result[f"ch{c}"] = [round(p / mx, 4) for p in peaks]

    return result


# Contiguous and full-coverage, matching web/renderers/freq_percentages.js.
# Disjoint windows (the classic 60-250 / 500-2000 / 4-6k) leave 250-500 Hz,
# 2-4 kHz and everything above 6 kHz uncounted, so their "percentages" are
# shares of an arbitrary subset and move whenever the gaps do. These edges mean
# every bin lands in exactly one band and the four figures always total 100%.
BAND_EDGES_HZ = (0.0, 250.0, 2000.0, 6000.0, float("inf"))
BAND_LABELS = ("BASS", "MID", "PRES", "HF")


def compute_bench(waveform, sample_rate: int) -> dict:
    """Whole-file measurements for the bench panel.

    One calculation, one source of truth. The point of this living here is that
    the panel, the waveform and the loudness badge all describe the SAME audio;
    separate nodes measuring the same take with different band edges and
    different peak conventions is exactly the confusion this replaces.

    IMPORTANT: this measures the waveform as generated, BEFORE save_wav clamps
    it to +/-1.0. A model that overshoots full scale reports its true peak here
    (e.g. +1.32 dBFS) while the WAV the player loads has been clipped flat at
    the ceiling. Both facts are reported, because only seeing the second one
    makes the clipping look like the player's fault.
    """
    if waveform.dim() == 3:
        waveform = waveform[0]

    n_ch = min(int(waveform.shape[0]), 2)
    data = waveform[:n_ch].detach().cpu().float().numpy()
    n = int(data.shape[1])
    if n == 0:
        return {}

    def db(x, floor=-120.0):
        return floor if x <= 1e-12 else round(float(20.0 * np.log10(x)), 2)

    peak = float(np.abs(data).max())
    rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2)))

    # Samples the WAV write will flatten against the ceiling.
    over = int(np.count_nonzero(np.abs(data) > 1.0))
    # Samples already sitting at the ceiling before any clamping.
    at_ceiling = int(np.count_nonzero(np.abs(data) >= 0.999969482421875))

    corr = None
    if n_ch >= 2:
        a = data[0].astype(np.float64)
        b = data[1].astype(np.float64)
        sa, sb = float(np.sqrt((a * a).sum())), float(np.sqrt((b * b).sum()))
        if sa > 1e-12 and sb > 1e-12:
            corr = round(float((a * b).sum() / (sa * sb)), 3)

    mono = data.mean(axis=0).astype(np.float64)
    bands, hf_outliers = _band_energy(mono, sample_rate)

    return {
        "peak_db": db(peak),
        "peak_linear": round(peak, 6),
        "rms_db": db(rms),
        "crest_db": round(db(peak) - db(rms), 2) if rms > 1e-12 else None,
        "dc_offset": round(float(mono.mean()), 6),
        # over_fs is the number the model is responsible for; clipped_samples is
        # what ends up in the file after the clamp. They differ only when the
        # generation overshoots.
        "over_fs": over,
        "clipped_samples": at_ceiling + over,
        "clipped_pct": round(100.0 * (at_ceiling + over) / (n * n_ch), 4),
        "lr_corr": corr,
        "bands": bands,
        "hf_outliers": hf_outliers,
        "samples": n,
        "channels": n_ch,
    }


def _band_energy(mono, sample_rate: int):
    """Share of total energy per contiguous band, via one Welch-style average.

    Averaging the magnitude spectrum over windows rather than transforming the
    whole file at once keeps memory flat on a long take and gives a far steadier
    estimate than a single enormous FFT.
    """
    n = len(mono)
    size = 8192
    if n < size:
        size = 1 << max(8, int(np.floor(np.log2(max(n, 256)))))
    hop = size // 2
    win = np.hanning(size)

    acc = np.zeros(size // 2, dtype=np.float64)
    frames = 0
    for off in range(0, max(1, n - size + 1), hop):
        seg = mono[off:off + size]
        if len(seg) < size:
            break
        spec = np.abs(np.fft.rfft(seg * win))[:size // 2]
        acc += spec * spec          # energy, so the shares add up correctly
        frames += 1
    if frames == 0:
        return {lbl: 0.0 for lbl in BAND_LABELS}, 0
    acc /= frames

    freqs = np.fft.rfftfreq(size, 1.0 / sample_rate)[:size // 2]
    total = float(acc.sum()) or 1.0

    bands = {}
    for i, lbl in enumerate(BAND_LABELS):
        sel = (freqs >= BAND_EDGES_HZ[i]) & (freqs < BAND_EDGES_HZ[i + 1])
        bands[lbl] = round(100.0 * float(acc[sel].sum()) / total, 2)

    # Isolated content above 16 kHz, well clear of the programme: usually
    # encoder birdies or a resampler artefact rather than musical air.
    hi = acc[freqs > 16000.0]
    hf_outliers = 0
    if hi.size:
        med = float(np.median(acc)) or 1e-20
        hf_outliers = int(np.count_nonzero(hi > med * 50.0))

    return bands, hf_outliers
