"""
Audio analysis and file writing helpers.

Split out of the node so the node file states what the node does and nothing
else.  Nothing in here touches ComfyUI or aiohttp — it is pure numpy/torch in,
bytes or dicts out, which also makes it the only part of the package that is
straightforward to unit-test.
"""

import math
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


# ITU-R BS.1770-4 K-weighting, published for 48 kHz. Used verbatim at that rate
# -- it is what ACE-Step produces and what the reference implementations are
# checked against, and re-deriving it could only lose accuracy.
_K48_SHELF_B = (1.53512485958697, -2.69169618940638, 1.19839281085285)
_K48_SHELF_A = (1.0, -1.69065929318241, 0.73248077421585)
_K48_HPF_B = (1.0, -2.0, 1.0)
_K48_HPF_A = (1.0, -1.99004745483398, 0.99007225036298)

# Every other rate is derived from that table rather than reusing it. A digital
# filter's response is fixed in normalised frequency, so the 48 kHz numbers run
# at 44.1 kHz slide both corners down by 48/44.1 -- the shelf from 1682 Hz to
# 1545 Hz -- and measure a curve the standard does not describe.
#
# The derivation goes through the analog prototype: inverse bilinear at 48 kHz,
# forward bilinear at the target rate, gain matched at 1 kHz. It round-trips at
# 48 kHz to 1e-15 and reproduces the table's response at 44.1 kHz to within
# 0.002 dB. Measured against ffmpeg's ebur128 on real material at both rates,
# the result agrees to 0.0 LU.

# BS.1770 channel weights: L, R and C unweighted, surrounds +1.5 dB.
_CHANNEL_GAIN = (1.0, 1.0, 1.0, 1.41, 1.41)

_BLOCK_S = 0.400        # gating block length
_OVERLAP = 4            # 75% block overlap
_ABS_GATE = -70.0       # LUFS, the absolute gate
_REL_GATE = -10.0       # LU below the absolutely-gated mean
_OFFSET = -0.691        # the standard's calibration constant

_KCACHE = {}


def _rescale(b, a, fs_to, fs_from=48000.0, f_ref=1000.0):
    """Re-digitise a 48 kHz biquad at another rate through its analog form."""
    from scipy.signal import tf2zpk, zpk2tf, freqz

    zeros, poles, _ = tf2zpk(b, a)
    to_s = lambda d: 2 * fs_from * (d - 1) / (d + 1)          # noqa: E731
    to_z = lambda s: (2 * fs_to + s) / (2 * fs_to - s)        # noqa: E731
    nb, na = zpk2tf(to_z(to_s(zeros)), to_z(to_s(poles)), 1.0)
    nb, na = np.real(nb), np.real(na)
    old = abs(freqz(b, a, worN=[2 * math.pi * f_ref / fs_from])[1][0])
    new = abs(freqz(nb, na, worN=[2 * math.pi * f_ref / fs_to])[1][0])
    return nb * (old / new), na


def _kweighting(sample_rate: int):
    if sample_rate == 48000:
        return (_K48_SHELF_B, _K48_SHELF_A), (_K48_HPF_B, _K48_HPF_A)
    if sample_rate not in _KCACHE:
        _KCACHE[sample_rate] = (
            _rescale(_K48_SHELF_B, _K48_SHELF_A, sample_rate),
            _rescale(_K48_HPF_B, _K48_HPF_A, sample_rate),
        )
    return _KCACHE[sample_rate]


def compute_lufs(waveform, sample_rate: int = 48000) -> float:
    """Integrated loudness in LUFS, per ITU-R BS.1770-4.

    THE TWO THINGS THIS GETS RIGHT THAT THE FIRST VERSION DID NOT.

    1. Channels are SUMMED, not averaged. The standard defines loudness over
       the sum of per-channel weighted powers, sum(G_i * z_i). The first
       version averaged L and R into mono before measuring, which is a
       different quantity: 3 dB low for correlated stereo and up to 6 dB low
       for uncorrelated. Measured on a real take (L/R correlation 0.79) it read
       3.70 LU low all by itself.

    2. It is GATED. Integrated loudness is the mean of 400 ms blocks that pass
       an absolute gate at -70 LUFS and a relative gate 10 LU below the
       absolutely-gated mean -- so intros, fades and silence do not drag the
       figure down. The first version took the mean square of the whole file.

    Together those two put the badge 3.84 LU below the reference on the take
    they were found with: -17.3 where ffmpeg's ebur128 reports -13.5. A number
    that wrong is worse than no number, because it is the one a mastering
    decision gets made against.

    `sample_rate` is required for both the filter design and the block length.
    It defaults to 48000 only so an old call site fails loudly on non-48 kHz
    audio rather than silently, and every call site in this package passes it.
    """
    if hasattr(waveform, "dim") and waveform.dim() == 3:
        waveform = waveform[0]

    chans = np.asarray(
        waveform.float().cpu().numpy() if hasattr(waveform, "cpu") else waveform,
        dtype=np.float64,
    )
    if chans.ndim == 1:
        chans = chans[None, :]
    n_ch, n_samples = chans.shape
    if n_samples == 0:
        return _ABS_GATE

    try:
        from scipy.signal import lfilter
    except Exception:
        # No K-weighting available. Keep the channel rule right so the badge is
        # in the right neighbourhood rather than 3-6 dB low, and accept that it
        # is unweighted and ungated.
        z = sum(_CHANNEL_GAIN[min(c, 4)] * float(np.mean(chans[c] ** 2))
                for c in range(n_ch))
        return round(_OFFSET + 10.0 * math.log10(z + 1e-12), 1)

    (sb, sa), (hb, ha) = _kweighting(int(sample_rate))
    block = int(round(_BLOCK_S * sample_rate))
    hop = max(1, block // _OVERLAP)

    def weighted(c):
        return lfilter(hb, ha, lfilter(sb, sa, chans[c]))

    if n_samples < block:
        # Shorter than one gating block: there is nothing to gate, so report
        # the weighted level rather than nothing.
        z = sum(_CHANNEL_GAIN[min(c, 4)] * float(np.mean(weighted(c) ** 2))
                for c in range(n_ch))
        return round(_OFFSET + 10.0 * math.log10(z + 1e-12), 1)

    n_blocks = 1 + (n_samples - block) // hop
    starts = np.arange(n_blocks) * hop
    z = np.zeros(n_blocks)
    for c in range(n_ch):
        y = weighted(c)
        # Cumulative sum rather than a per-block slice: 75% overlap means every
        # sample lands in four blocks, and a three-minute take is ~2,200 of
        # them.
        csum = np.concatenate(([0.0], np.cumsum(y * y)))
        z += _CHANNEL_GAIN[min(c, 4)] * (csum[starts + block] - csum[starts]) / block

    loud = _OFFSET + 10.0 * np.log10(z + 1e-12)
    keep = loud > _ABS_GATE
    if not keep.any():
        return _ABS_GATE
    relative = _OFFSET + 10.0 * math.log10(float(z[keep].mean())) + _REL_GATE
    keep &= loud > relative
    if not keep.any():
        return _ABS_GATE
    return round(_OFFSET + 10.0 * math.log10(float(z[keep].mean())), 1)


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
# The first edge is 20 Hz, not 0. Bin 0 is DC, and a Hann window smears a
# constant offset across the first few bins either side of it — zeroing bin 0
# alone still left a 0.05 offset showing up as 4% "bass" in the test below.
# Nothing musical lives under 20 Hz, both paths use the same first edge, and
# the shares are of what was counted, so they still total 100.
BAND_EDGES_HZ = (20.0, 250.0, 2000.0, 6000.0, float("inf"))
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
    # Two RMS conventions, both reported, because they legitimately disagree.
    #
    #   rms       - mean square across BOTH channels: sqrt((sum L^2 + sum R^2) / 2n).
    #               The energy actually in the stereo file.
    #   rms_mono  - mean square of the (L+R)/2 downmix. What a mono-summing
    #               meter shows, and what most standalone "bench" nodes report.
    #
    # For channels of equal power they differ by exactly 10*log10((1 + r) / 2)
    # dB, where r is the L/R correlation below. So they agree on a fully
    # correlated signal (r = 1), the downmix reads 0.99 dB lower at r = 0.591,
    # and 3.01 dB lower on uncorrelated channels (r = 0) because the downmix
    # halves the amplitude while the sum of two independent signals only grows
    # as sqrt(2). Neither number is wrong; they answer different questions.
    # Verified numerically - see docs/TECHNICAL.md, "Two RMS conventions".
    rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2)))

    # Samples the WAV write will flatten against the ceiling.
    over = int(np.count_nonzero(np.abs(data) > 1.0))
    # Samples AT OR ABOVE the ceiling. This is a superset of `over`: anything
    # above 1.0 is also above the ceiling, so the two must never be added.
    at_ceiling = int(np.count_nonzero(np.abs(data) >= 0.999969482421875))

    corr = None
    if n_ch >= 2:
        a = data[0].astype(np.float64)
        b = data[1].astype(np.float64)
        sa, sb = float(np.sqrt((a * a).sum())), float(np.sqrt((b * b).sum()))
        if sa > 1e-12 and sb > 1e-12:
            corr = round(float((a * b).sum() / (sa * sb)), 3)

    mono = data.mean(axis=0).astype(np.float64)
    rms_mono = float(np.sqrt(np.mean(mono ** 2)))
    bands, hf_outliers = _band_energy(mono, sample_rate)

    return {
        "peak_db": db(peak),
        "peak_linear": round(peak, 6),
        "rms_db": db(rms),
        # Not displayed in the bench strip. Present so a logged take can be
        # compared against a mono-summing meter without re-measuring the file.
        "rms_mono_db": db(rms_mono),
        "crest_db": round(db(peak) - db(rms), 2) if rms > 1e-12 else None,
        "dc_offset": round(float(mono.mean()), 6),
        # Two different questions, and the second is a SUPERSET of the first:
        #   over_fs         samples ABOVE full scale — what the model produced
        #                   and what save_wav's clamp destroys.
        #   clipped_samples samples AT OR ABOVE the ceiling — what ends up
        #                   flattened in the written file. Contains over_fs.
        # So clipped_samples >= over_fs always, and the two are EQUAL when every
        # sample at the ceiling got there by overshooting. Adding them, as this
        # did until 2.2.2, double-counts the overshoot: a take with 87 over-full
        # -scale samples reported 174 clipped.
        "over_fs": over,
        "clipped_samples": at_ceiling,
        "clipped_pct": round(100.0 * at_ceiling / (n * n_ch), 4),
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

    # The denominator is the energy INSIDE the bands, not all of it. With a
    # first edge above DC the two differ, and dividing by the larger would give
    # four shares that quietly fail to reach 100.
    counted = freqs >= BAND_EDGES_HZ[0]
    total = float(acc[counted].sum()) or 1.0

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
