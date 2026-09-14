from __future__ import annotations

import hashlib, json, math, uuid
from datetime import datetime, timezone
from typing import Any, Tuple

import numpy as np
import torch

try:
    from ..nova_categories import ANALYSIS
except ImportError:  # direct execution / test harness
    from nova_categories import ANALYSIS

VERSION = "0.2.0"
SCHEMA = "nova.track_inspector.report"
SCHEMA_VERSION = 2
EPS = 1e-12


def _db(v: float) -> float:
    return 20.0 * math.log10(max(float(v), EPS))


def _finite(v: float, fallback: float = 0.0) -> float:
    try:
        x = float(v)
        return x if math.isfinite(x) else fallback
    except Exception:
        return fallback


def _pcm_sha256(x: torch.Tensor) -> str:
    a = x.detach().to("cpu", torch.float32).contiguous().numpy().astype("<f4", copy=False)
    return hashlib.sha256(a.tobytes(order="C")).hexdigest()


def _canonical_sha256(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(b).hexdigest()


def _robust_center_scale(values: np.ndarray, floor: float = 1e-6) -> Tuple[float, float]:
    values = np.asarray(values, dtype=np.float64)
    values = values[np.isfinite(values)]
    if values.size == 0:
        return 0.0, max(1.0, floor)
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    return med, max(1.4826 * mad, floor)


def _corr(l: np.ndarray, r: np.ndarray) -> float:
    if l.size < 4 or r.size < 4:
        return 1.0
    l0, r0 = l - l.mean(), r - r.mean()
    den = math.sqrt(float(np.dot(l0, l0) * np.dot(r0, r0))) + EPS
    return float(np.dot(l0, r0) / den)


def _median_smooth(a: np.ndarray, width: int = 5) -> np.ndarray:
    if len(a) < 3 or width <= 1:
        return np.array(a, copy=True)
    width = min(width, len(a) if len(a) % 2 else len(a) - 1)
    width = max(3, width | 1)
    pad = width // 2
    out = np.empty_like(a, dtype=np.float64)
    if a.ndim == 1:
        ap = np.pad(a, (pad, pad), mode="edge")
        for i in range(len(a)):
            out[i] = np.median(ap[i:i + width])
    else:
        ap = np.pad(a, ((pad, pad), (0, 0)), mode="edge")
        for i in range(len(a)):
            out[i] = np.median(ap[i:i + width], axis=0)
    return out


def _spectral_metrics(mono: np.ndarray, sr: int, rms_db: float, prev_signature: np.ndarray | None):
    """Robust whole-window spectrum.

    v0.1.x used one short FFT taken from the centre of each 3 s window. On tonal
    material a single note/cymbal could therefore look like a huge whole-window
    HF/presence change. v0.2.0 samples the full analysis window and averages the
    power spectra before deriving bands.
    """
    nfft = 8192 if len(mono) >= 8192 else 4096 if len(mono) >= 4096 else 2048
    if len(mono) < nfft:
        mono = np.pad(mono, (0, nfft - len(mono)))

    max_start = max(0, len(mono) - nfft)
    # Five evenly distributed frames keep this dependency-light and fast while
    # representing the complete analysis window much better than one FFT.
    starts = np.linspace(0, max_start, num=min(5, max(1, max_start // max(1, nfft // 2) + 1)), dtype=np.int64)
    starts = np.unique(starts)
    win = np.hanning(nfft).astype(np.float32)
    powers = []
    for st in starts:
        seg = mono[int(st):int(st) + nfft]
        if len(seg) < nfft:
            seg = np.pad(seg, (0, nfft - len(seg)))
        spec = np.fft.rfft(seg * win)
        powers.append(np.square(np.abs(spec)).astype(np.float64))
    power = np.mean(np.stack(powers, axis=0), axis=0) + EPS
    spec = np.sqrt(power)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    total = float(power.sum()) + EPS

    def band(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        frac = float(power[m].sum() / total) if m.any() else 0.0
        pct = frac * 100.0
        # Approximate per-band RMS level from total window RMS and energy share.
        band_dbfs = float(rms_db + 10.0 * math.log10(max(frac, 1e-12)))
        return pct, band_dbfs

    bass, bass_db = band(20, 250)
    mid, mid_db = band(250, 2000)
    presence, presence_db = band(2000, 6000)
    hf, hf_db = band(6000, sr / 2 + 1)

    centroid = float((freqs * power).sum() / total)
    csum = np.cumsum(power)
    ridx = int(np.searchsorted(csum, 0.85 * csum[-1]))
    rolloff = float(freqs[min(ridx, len(freqs) - 1)])
    arith = float(np.mean(spec)) + EPS
    flatness = float(np.clip(np.exp(np.mean(np.log(spec + EPS))) / arith, 0.0, 1.0))
    prob = power / total
    entropy = float(-np.sum(prob * np.log(prob + EPS)) / math.log(max(2, len(prob))))
    spectral_crest = float(np.max(spec) / arith)

    # Stable 64-bin log-spectrum signature. Flux now compares like-for-like
    # signatures; v0.1.x accidentally compared arrays of different sizes and
    # therefore emitted spectral_flux=0 for every window.
    chunks = np.array_split(np.log1p(power), 64)
    signature = np.asarray([float(c.mean()) for c in chunks], dtype=np.float64)
    signature -= signature.mean()
    signature /= np.linalg.norm(signature) + EPS
    if prev_signature is None or prev_signature.shape != signature.shape:
        flux = 0.0
    else:
        flux = float(np.sqrt(np.mean(np.square(np.maximum(signature - prev_signature, 0.0)))))

    return {
        "bass_percent": bass,
        "mid_percent": mid,
        "presence_percent": presence,
        "hf_percent": hf,
        "bass_dbfs": bass_db,
        "mid_dbfs": mid_db,
        "presence_dbfs": presence_db,
        "hf_dbfs": hf_db,
        "spectral_centroid_hz": centroid,
        "spectral_rolloff_hz": rolloff,
        "spectral_flatness": flatness,
        "spectral_entropy": entropy,
        "spectral_crest": spectral_crest,
        "spectral_flux": flux,
    }, signature


def _transient_density(mono: np.ndarray, sr: int) -> float:
    step = max(1, int(sr * 0.010))
    n = len(mono) // step
    if n < 4:
        return 0.0
    env = np.sqrt(np.mean(mono[:n * step].reshape(n, step) ** 2, axis=1) + EPS)
    d = np.diff(env)
    med, sc = _robust_center_scale(d, floor=1e-6)
    return float(np.sum(d > med + 2.5 * sc) / max(len(mono) / sr, EPS))


def _window_features(x: np.ndarray, sr: int, start: int, end: int, prev_signature):
    w = x[:, start:end]
    mono = np.mean(w, axis=0)
    rms = float(np.sqrt(np.mean(mono * mono) + EPS))
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    rms_db, peak_db = _db(rms), _db(peak)
    corr, lr_delta = 1.0, 0.0
    if w.shape[0] >= 2:
        corr = _corr(w[0], w[1])
        lr = math.sqrt(float(np.mean(w[0] * w[0])) + EPS)
        rr = math.sqrt(float(np.mean(w[1] * w[1])) + EPS)
        lr_delta = abs(_db(lr) - _db(rr))

    sp, signature = _spectral_metrics(mono, sr, rms_db, prev_signature)

    # Noise-like content heuristic. This is intentionally conservative: it is a
    # content/artifact risk estimate, not a musical taste score.
    flat_risk = np.clip((sp["spectral_flatness"] - 0.30) / 0.38, 0.0, 1.0)
    entropy_risk = np.clip((sp["spectral_entropy"] - 0.78) / 0.18, 0.0, 1.0)
    crest_safety = np.clip((sp["spectral_crest"] - 3.0) / 12.0, 0.0, 1.0)
    zcr = float(np.mean(np.signbit(mono[1:]) != np.signbit(mono[:-1]))) if mono.size > 1 else 0.0
    zcr_risk = np.clip((zcr - 0.15) / 0.25, 0.0, 1.0)
    noise = float(100.0 * np.clip(0.42 * flat_risk + 0.38 * entropy_risk + 0.12 * (1.0 - crest_safety) + 0.08 * zcr_risk, 0.0, 1.0))

    return {
        "rms_dbfs": rms_db,
        "sample_peak_dbfs": peak_db,
        "crest_db": peak_db - rms_db,
        "lr_correlation": corr,
        "lr_level_delta_db": lr_delta,
        "dc_offset": float(np.mean(mono)) if mono.size else 0.0,
        "zero_crossing_rate": zcr,
        "clip_ratio": float(np.mean(np.abs(w) >= 0.999)) if w.size else 0.0,
        "transient_density_hz": _transient_density(mono, sr),
        "noise_likelihood_percent": noise,
        **sp,
    }, signature


def _severity(score):
    return "CRITICAL" if score >= 90 else "WARNING" if score >= 72 else "REVIEW" if score >= 50 else "INFO"


def _grade(score):
    return "A+" if score >= 97 else "A" if score >= 93 else "A-" if score >= 90 else "B+" if score >= 87 else "B" if score >= 83 else "B-" if score >= 80 else "C+" if score >= 75 else "C" if score >= 70 else "C-" if score >= 65 else "D" if score >= 55 else "F"


def _merge(markers, hop):
    if not markers:
        return []
    markers = sorted(markers, key=lambda m: (m["type"], m["start_seconds"]))
    out = []
    rank = {"INFO": 0, "REVIEW": 1, "WARNING": 2, "CRITICAL": 3}
    for m in markers:
        if out and out[-1]["type"] == m["type"] and m["start_seconds"] <= out[-1]["end_seconds"] + hop * 1.25:
            p = out[-1]
            p["end_seconds"] = max(p["end_seconds"], m["end_seconds"])
            if m["score"] > p["score"]:
                for k in ("score", "message", "metrics", "listener_relevance", "confidence"):
                    if k in m:
                        p[k] = m[k]
            if rank.get(m["severity"], 0) > rank.get(p["severity"], 0):
                p["severity"] = m["severity"]
        else:
            out.append(dict(m))
    out.sort(key=lambda m: m["start_seconds"])
    for i, m in enumerate(out, 1):
        m["id"] = i
        m["duration_seconds"] = max(0.0, m["end_seconds"] - m["start_seconds"])
    return out


def _waveform_envelope(x, sr, points=1200):
    mono = x.mean(axis=0)
    n = len(mono)
    points = max(16, min(points, n))
    edges = np.linspace(0, n, points + 1, dtype=np.int64)
    out = []
    for i in range(points):
        a, b = int(edges[i]), int(edges[i + 1])
        seg = mono[a:b]
        if seg.size:
            out.append({"time": float((a + b) * .5 / sr), "min": float(seg.min()), "max": float(seg.max()), "peak_abs": float(np.abs(seg).max())})
    return out


class NovaTrackInspector:
    CATEGORY = ANALYSIS
    FUNCTION = "inspect"
    RETURN_TYPES = ("AUDIO", "STRING", "STRING", "STRING", "FLOAT", "STRING")
    RETURN_NAMES = ("audio", "inspection_json", "markers_json", "timeline_json", "score", "verdict")
    DESCRIPTION = "Whole-track listening-aid analysis. Pass-through only; no DSP is applied."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "analysis_resolution": (["Normal", "Fine", "Fast"], {"default": "Normal"}),
            "marker_sensitivity": ("FLOAT", {"default": 60.0, "min": 0.0, "max": 100.0, "step": 1.0}),
            "coherence_sensitivity": ("FLOAT", {"default": 60.0, "min": 0.0, "max": 100.0, "step": 1.0}),
        }}

    def inspect(self, audio, analysis_resolution="Normal", marker_sensitivity=60.0, coherence_sensitivity=60.0):
        wf = audio["waveform"]
        sr = int(audio["sample_rate"])
        if wf.dim() == 2:
            wf = wf.unsqueeze(0)
        if wf.dim() != 3 or wf.shape[0] != 1:
            raise ValueError("Nova Track Inspector accepts one track per node.")
        x_t = wf[0].detach().to("cpu", torch.float32).contiguous()
        x = x_t.numpy().astype(np.float32, copy=False)
        if x.shape[0] > 2:
            x = x[:2]
        channels, samples = x.shape
        duration = samples / sr
        if duration < 2:
            raise ValueError("Nova Track Inspector requires at least 2 seconds of audio.")

        if analysis_resolution == "Fine":
            window_s, hop_s = 2.0, .5
        elif analysis_resolution == "Fast":
            window_s, hop_s = 4.0, 2.0
        else:
            window_s, hop_s = 3.0, 1.0
        window_n, hop_n = int(window_s * sr), int(hop_s * sr)
        starts = list(range(0, max(1, samples - window_n + 1), hop_n))
        if not starts or starts[-1] + window_n < samples:
            starts.append(max(0, samples - window_n))
        starts = sorted(set(starts))

        timeline, signatures = [], []
        prev_signature = None
        for idx, start in enumerate(starts):
            end = min(samples, start + window_n)
            feat, signature = _window_features(x, sr, start, end, prev_signature)
            prev_signature = signature
            timeline.append({
                "index": idx,
                "time": float((start + end) * .5 / sr),
                "start_seconds": float(start / sr),
                "end_seconds": float(end / sr),
                **{k: _finite(v) for k, v in feat.items()},
            })
            signatures.append(signature)

        # Feature-space coherence. Use dB band levels rather than raw percentages
        # and apply a short median smoother so normal note-to-note changes do not
        # become 'coherence breaks'.
        feature_names = [
            "rms_dbfs", "crest_db", "lr_correlation",
            "bass_dbfs", "mid_dbfs", "presence_dbfs", "hf_dbfs",
            "spectral_centroid_hz", "spectral_flatness", "spectral_entropy",
            "spectral_flux", "transient_density_hz",
        ]
        A = np.asarray([[p[n] for n in feature_names] for p in timeline], dtype=np.float64)
        # Log-transform positive wide-range features.
        A[:, 7] = np.log1p(np.maximum(A[:, 7], 0.0))
        A[:, 11] = np.log1p(np.maximum(A[:, 11], 0.0))
        scale_floors = [1.5, 1.0, .05, 2.5, 2.5, 2.5, 3.0, .18, .035, .035, .006, .20]
        Z = np.zeros_like(A)
        for j in range(A.shape[1]):
            med, sc = _robust_center_scale(A[:, j], floor=scale_floors[j])
            Z[:, j] = (A[:, j] - med) / sc
        Zs = _median_smooth(Z, width=5)

        raw_dist = np.zeros(len(timeline), dtype=np.float64)
        smooth_dist = np.zeros(len(timeline), dtype=np.float64)
        if len(timeline) > 1:
            raw_dist[1:] = np.sqrt(np.mean(np.square(np.diff(Z, axis=0)), axis=1))
            smooth_dist[1:] = np.sqrt(np.mean(np.square(np.diff(Zs, axis=0)), axis=1))
        dmed, dsc = _robust_center_scale(smooth_dist[1:] if len(smooth_dist) > 1 else smooth_dist, floor=.08)
        q95 = float(np.percentile(smooth_dist[1:], 95)) if len(smooth_dist) > 2 else dmed
        sens_factor = float(np.interp(coherence_sensitivity, [0, 100], [4.8, 2.6]))
        transition_threshold = max(q95, dmed + sens_factor * dsc, .70)
        anomaly_threshold = max(transition_threshold * 1.45, dmed + (sens_factor + 1.4) * dsc, 1.05)

        # Coherence score is continuous and no longer collapses because a normal
        # chorus/verse boundary is large. It measures local stability relative to
        # the track's own movement distribution.
        ref = max(q95, .35)
        for i, p in enumerate(timeline):
            d = float(smooth_dist[i])
            p["coherence_distance"] = d
            p["coherence_raw_distance"] = float(raw_dist[i])
            p["coherence_score"] = float(np.clip(100.0 * math.exp(-max(0.0, d - dmed) / (ref * 1.8)), 0.0, 100.0))

        # Global robust baselines for marker interpretation.
        stats = {}
        stat_fields = [
            "rms_dbfs", "crest_db", "lr_correlation", "bass_dbfs", "mid_dbfs",
            "presence_dbfs", "hf_dbfs", "noise_likelihood_percent", "spectral_flatness",
            "spectral_entropy", "spectral_flux"
        ]
        floors = {"rms_dbfs": 1.0, "crest_db": 1.0, "lr_correlation": .03,
                  "bass_dbfs": 2.0, "mid_dbfs": 2.0, "presence_dbfs": 2.0,
                  "hf_dbfs": 2.5, "noise_likelihood_percent": 4.0,
                  "spectral_flatness": .02, "spectral_entropy": .02, "spectral_flux": .004}
        for n in stat_fields:
            med, sc = _robust_center_scale(np.asarray([p[n] for p in timeline]), floor=floors.get(n, 1e-6))
            stats[n] = {"median": med, "scale": sc}

        zthr = float(np.interp(marker_sensitivity, [0, 100], [5.2, 3.0]))
        markers = []

        def add(p, typ, cat, score, msg, metrics=None, severity=None, relevance="MEDIUM", confidence=75.0, observation=False):
            markers.append({
                "start_seconds": float(p["start_seconds"]),
                "end_seconds": float(p["end_seconds"]),
                "severity": severity or _severity(score),
                "category": cat,
                "type": typ,
                "score": float(np.clip(score, 0, 100)),
                "message": msg,
                "metrics": metrics or {},
                "listener_relevance": relevance,
                "confidence": float(np.clip(confidence, 0, 100)),
                "observation": bool(observation),
            })

        # First pass: hard/technical issues and conservative spectral events.
        npts = len(timeline)
        for i, p in enumerate(timeline):
            edge = p["time"] < max(4.0, duration * .025) or p["time"] > duration - max(4.0, duration * .025)

            if p["rms_dbfs"] < -58:
                add(p, "DIGITAL_OR_NEAR_SILENCE", "LEVEL", 94 if not edge else 55,
                    f"Window level is {p['rms_dbfs']:.1f} dBFS.", severity="WARNING" if edge else "CRITICAL",
                    relevance="HIGH" if not edge else "LOW", confidence=96)
            elif p["rms_dbfs"] < -45 and not edge:
                add(p, "NEAR_SILENCE", "LEVEL", 62, f"Unusually quiet interior section at {p['rms_dbfs']:.1f} dBFS.",
                    severity="REVIEW", relevance="MEDIUM", confidence=88)

            if p["clip_ratio"] > .0005:
                ratio = p["clip_ratio"] * 100.0
                sev = "CRITICAL" if ratio > .10 else "WARNING"
                add(p, "CLIPPING", "TECHNICAL", min(100, 74 + ratio * 80),
                    f"{ratio:.3f}% of samples are at/above 0.999.", {"clip_ratio": p["clip_ratio"]}, sev, "HIGH", 98)

            if p["lr_level_delta_db"] > 24:
                add(p, "CHANNEL_DROPOUT_RISK", "STEREO", 94,
                    f"L/R level difference reached {p['lr_level_delta_db']:.1f} dB.",
                    {"lr_level_delta_db": p["lr_level_delta_db"]}, "CRITICAL", "HIGH", 96)

            if p["lr_correlation"] < -.25:
                add(p, "STEREO_PHASE_ANOMALY", "STEREO", min(100, 78 + abs(p['lr_correlation']) * 30),
                    f"Stereo correlation dropped to {p['lr_correlation']:.3f}.",
                    {"lr_correlation": p["lr_correlation"]}, "WARNING", "HIGH", 92)

            if p["noise_likelihood_percent"] >= 82:
                add(p, "BROADBAND_NOISE_RISK", "CONTENT", p["noise_likelihood_percent"],
                    f"Noise-like spectral behavior is {p['noise_likelihood_percent']:.0f}%.",
                    {"noise_likelihood_percent": p["noise_likelihood_percent"]}, "CRITICAL", "HIGH", 90)
            elif p["noise_likelihood_percent"] >= 68:
                add(p, "NOISE_LIKE_SECTION", "CONTENT", p["noise_likelihood_percent"],
                    f"Section is unusually noise-like ({p['noise_likelihood_percent']:.0f}%).",
                    {"noise_likelihood_percent": p["noise_likelihood_percent"]}, "WARNING", "MEDIUM", 80)

            if i > 0:
                q = timeline[i - 1]
                dl = abs(p["rms_dbfs"] - q["rms_dbfs"])
                dc = abs(p["crest_db"] - q["crest_db"])
                if dl > 7.0:
                    add(p, "LOUDNESS_DISCONTINUITY", "LEVEL", min(90, 52 + dl * 4),
                        f"Window RMS changed {dl:.1f} dB between adjacent analysis points.",
                        {"delta_rms_db": dl}, "REVIEW" if dl < 10 else "WARNING", "MEDIUM", 82)
                if dc > 7.0:
                    add(p, "DYNAMIC_DISCONTINUITY", "DYNAMICS", min(88, 50 + dc * 3.5),
                        f"Crest factor changed {dc:.1f} dB abruptly.",
                        {"delta_crest_db": dc}, "REVIEW" if dc < 10 else "WARNING", "MEDIUM", 80)

            # Spectral events use absolute band level + dB departure from the track
            # baseline. A tiny HF percentage can no longer become a 'critical burst'
            # simply because the median HF percentage is also tiny.
            for field, typ_hi, typ_lo, abs_hi, hi_delta, lo_delta in [
                ("hf_dbfs", "HF_BURST", "HF_COLLAPSE", -27.0, 9.0, 14.0),
                ("presence_dbfs", "PRESENCE_SURGE", "PRESENCE_COLLAPSE", -16.0, 8.0, 13.0),
                ("bass_dbfs", "LOW_END_SURGE", "LOW_END_COLLAPSE", -8.0, 9.0, 13.0),
            ]:
                med, sc = stats[field]["median"], stats[field]["scale"]
                delta = p[field] - med
                z = delta / sc
                if delta > hi_delta and p[field] > abs_hi and z > max(2.5, zthr * .72):
                    score = min(88, 48 + delta * 3.2)
                    add(p, typ_hi, "SPECTRAL", score,
                        f"{field.replace('_dbfs','').replace('_',' ').title()} rose {delta:.1f} dB above the track baseline ({p[field]:.1f} dBFS).",
                        {field: p[field], "baseline_dbfs": med, "delta_db": delta, "robust_z": z},
                        "REVIEW" if score < 72 else "WARNING", "MEDIUM", min(92, 65 + abs(z) * 4))
                elif delta < -lo_delta and not edge and z < -max(2.5, zthr * .72):
                    # A band disappearing can be completely intentional (breakdown,
                    # sparse verse, filtered section). Surface it visually, but do
                    # not penalize the song unless another detector corroborates it.
                    score = min(58, 38 + abs(delta) * 1.25)
                    add(p, typ_lo, "SPECTRAL", score,
                        f"{field.replace('_dbfs','').replace('_',' ').title()} fell {abs(delta):.1f} dB below the track baseline; review as a tonal/arrangement change rather than an automatic fault.",
                        {field: p[field], "baseline_dbfs": med, "delta_db": delta, "robust_z": z},
                        "INFO", "LOW", min(88, 58 + abs(z) * 3), observation=True)

            if p["crest_db"] > max(25.0, stats["crest_db"]["median"] + 5.0 * stats["crest_db"]["scale"]) and p["sample_peak_dbfs"] > -5:
                add(p, "IMPULSE_ANOMALY", "ARTIFACT", 78,
                    f"Very high crest ({p['crest_db']:.1f} dB) with peak at {p['sample_peak_dbfs']:.1f} dBFS.",
                    {"crest_db": p["crest_db"], "sample_peak_dbfs": p["sample_peak_dbfs"]}, "WARNING", "HIGH", 88)

        # Structural transitions vs. coherence anomalies. Large musical changes are
        # observations if the new state settles; only unstable/returning changes are
        # penalized as coherence breaks.
        transition_indices = []
        last_transition = -999
        for i in range(2, npts - 3):
            d = smooth_dist[i]
            if d < transition_threshold or i - last_transition < max(2, int(round(2.0 / hop_s))):
                continue
            pre = np.mean(Zs[max(0, i - 3):i], axis=0)
            post = np.mean(Zs[i:min(npts, i + 3)], axis=0)
            before_internal = float(np.mean(np.sqrt(np.mean(np.square(np.diff(Zs[max(0, i - 3):i], axis=0)), axis=1)))) if i >= 3 else dmed
            post_slice = Zs[i:min(npts, i + 4)]
            post_internal = float(np.mean(np.sqrt(np.mean(np.square(np.diff(post_slice, axis=0)), axis=1)))) if len(post_slice) > 1 else dmed
            state_change = float(np.sqrt(np.mean(np.square(post - pre))))
            return_dist = float(np.sqrt(np.mean(np.square(Zs[min(npts - 1, i + 3)] - pre))))
            settled = post_internal <= max(q95 * 1.15, dmed + 2.2 * dsc)
            returns = return_dist < max(state_change * .55, .45)
            corroborated = any(
                m["start_seconds"] <= timeline[i]["end_seconds"] and m["end_seconds"] >= timeline[i]["start_seconds"]
                and m["category"] in {"TECHNICAL", "ARTIFACT", "STEREO", "LEVEL", "CONTENT"}
                and m["severity"] in {"WARNING", "CRITICAL"}
                for m in markers
            )

            if d >= anomaly_threshold and (returns or not settled or corroborated):
                score = min(96, 60 + (d / max(anomaly_threshold, EPS)) * 18 + (10 if corroborated else 0))
                sev = "WARNING" if score < 90 or not corroborated else "CRITICAL"
                add(timeline[i], "COHERENCE_BREAK", "STRUCTURE", score,
                    f"Abrupt local change does not settle like a normal section transition (novelty {d:.2f}, threshold {anomaly_threshold:.2f}).",
                    {"coherence_distance": d, "threshold": anomaly_threshold, "settled": settled, "returns": returns, "corroborated": corroborated},
                    sev, "HIGH" if corroborated else "MEDIUM", 84 if corroborated else 72)
            else:
                score = min(68, 38 + (d / max(transition_threshold, EPS)) * 14)
                add(timeline[i], "STRUCTURAL_TRANSITION", "STRUCTURE", score,
                    f"Large but stable musical change detected; the following windows form a coherent new state.",
                    {"coherence_distance": d, "threshold": transition_threshold, "settled": settled, "state_change": state_change},
                    "INFO", "LOW", 82, observation=True)
                transition_indices.append(i)
            last_transition = i

        # Repetition remains a review aid, not a verdict. Repeated choruses are
        # musical; only long, near-identical spectral sequences are surfaced.
        sig = np.asarray(signatures)
        min_lag = max(2, int(round(8 / hop_s)))
        max_lag = min(len(sig) // 2, max(min_lag + 1, int(round(60 / hop_s))))
        min_run = max(4, int(round(20 / hop_s)))
        reps = []
        for lag in range(min_lag, max_lag + 1):
            sims = np.sum(sig[lag:] * sig[:-lag], axis=1)
            good = sims > .9992
            st = None
            for k, ok in enumerate(np.r_[good, False]):
                if ok and st is None:
                    st = k
                elif not ok and st is not None:
                    if k - st >= min_run:
                        reps.append((st + lag, k + lag - 1, lag, float(np.mean(sims[st:k]))))
                    st = None
        reps.sort(key=lambda r: (r[1] - r[0], r[3]), reverse=True)
        occ = []
        for a, b, lag, sim in reps[:5]:
            if any(not (b < x or a > y) for x, y in occ):
                continue
            occ.append((a, b))
            p, q = timeline[a], timeline[b]
            dur = q["end_seconds"] - p["start_seconds"]
            if dur >= 20:
                add({"start_seconds": p["start_seconds"], "end_seconds": q["end_seconds"]},
                    "REPETITION_REVIEW", "STRUCTURE", min(64, 48 + (sim - .9992) * 7000),
                    f"Very similar spectral sequence persists for {dur:.1f}s (lag ≈ {lag * hop_s:.1f}s, similarity {sim * 100:.2f}%). Review only; repeated musical sections may be intentional.",
                    {"duration_seconds": dur, "lag_seconds": lag * hop_s, "similarity": sim},
                    "REVIEW", "LOW", 70, observation=True)

        markers = _merge(markers, hop_s)

        # Non-overlapping structural section boundaries for visual/report use.
        boundary_times = [0.0]
        for idx in transition_indices:
            t = float(timeline[idx]["time"])
            if t - boundary_times[-1] >= 6.0:
                boundary_times.append(t)
        if duration - boundary_times[-1] < 6.0 and len(boundary_times) > 1:
            boundary_times[-1] = duration
        elif boundary_times[-1] < duration:
            boundary_times.append(duration)
        sections = []
        for a, b in zip(boundary_times[:-1], boundary_times[1:]):
            if b > a:
                sections.append({"index": len(sections) + 1, "start_seconds": float(a), "end_seconds": float(b), "duration_seconds": float(b - a)})
        if not sections:
            sections = [{"index": 1, "start_seconds": 0.0, "end_seconds": float(duration), "duration_seconds": float(duration)}]

        # Listener-oriented scoring: observations do not penalize. Counts are
        # normalized per minute so a long track is not punished simply for length.
        severity_pen = {"INFO": 0.0, "REVIEW": 1.0, "WARNING": 4.0, "CRITICAL": 10.0}
        by_cat = {}
        hard_failures = 0
        audible_concerns = 0
        observations = 0
        for m in markers:
            if m.get("observation"):
                observations += 1
                continue
            p = severity_pen.get(m["severity"], 0.0)
            by_cat[m["category"]] = by_cat.get(m["category"], 0.0) + p
            if m.get("listener_relevance") == "HIGH" and m["severity"] in {"WARNING", "CRITICAL"}:
                audible_concerns += 1
            if m["severity"] == "CRITICAL" and m["category"] in {"TECHNICAL", "ARTIFACT", "CONTENT", "STEREO"}:
                hard_failures += 1

        minutes = max(duration / 60.0, 1.0)
        def cat_pen(cat, factor):
            return min(45.0, (by_cat.get(cat, 0.0) / minutes) * factor)

        coh_values = np.asarray([p["coherence_score"] for p in timeline], dtype=np.float64)
        med_coh = float(np.median(coh_values))
        low_coh = float(np.percentile(coh_values, 20))
        noise = float(np.percentile([p["noise_likelihood_percent"] for p in timeline], 85))
        phase_bad = float(np.mean([p["lr_correlation"] < -.20 for p in timeline]) * 100.0)
        clip_bad = float(np.mean([p["clip_ratio"] > .0005 for p in timeline]) * 100.0)

        subs = {
            "content_coherence": float(np.clip(0.55 * med_coh + 0.45 * low_coh - cat_pen("STRUCTURE", 2.2), 0, 100)),
            "spectral_consistency": float(np.clip(100 - cat_pen("SPECTRAL", 2.3) - max(0, noise - 60) * .45, 0, 100)),
            "dynamic_integrity": float(np.clip(100 - cat_pen("DYNAMICS", 2.4) - cat_pen("LEVEL", 1.0), 0, 100)),
            "stereo_integrity": float(np.clip(100 - cat_pen("STEREO", 2.8) - phase_bad * .8, 0, 100)),
            "artifact_safety": float(np.clip(100 - cat_pen("ARTIFACT", 3.2) - cat_pen("TECHNICAL", 3.2) - clip_bad * 1.2, 0, 100)),
            "level_continuity": float(np.clip(100 - cat_pen("LEVEL", 2.5), 0, 100)),
            "structural_integrity": float(np.clip(100 - cat_pen("STRUCTURE", 2.5), 0, 100)),
            "technical_integrity": float(np.clip(100 - cat_pen("TECHNICAL", 3.0) - cat_pen("STEREO", .9), 0, 100)),
        }
        weights = {
            "content_coherence": .18, "spectral_consistency": .14, "dynamic_integrity": .12,
            "stereo_integrity": .12, "artifact_safety": .16, "level_continuity": .10,
            "structural_integrity": .12, "technical_integrity": .06,
        }
        score = float(np.clip(sum(subs[k] * weights[k] for k in weights), 0, 100))

        # Only strong, sustained evidence creates a hard score ceiling.
        if noise >= 88:
            score = min(score, 35.0)
        elif noise >= 76:
            score = min(score, 58.0)
        if hard_failures >= 2:
            score = min(score, 55.0)

        warning_count = sum(m["severity"] == "WARNING" and not m.get("observation") for m in markers)
        critical_count = sum(m["severity"] == "CRITICAL" and not m.get("observation") for m in markers)
        review_count = sum(m["severity"] == "REVIEW" and not m.get("observation") for m in markers)

        if noise >= 88 or hard_failures >= 2 or score < 40:
            verdict = "REJECT"
        elif hard_failures or score < 62:
            verdict = "POOR"
        elif critical_count or warning_count >= 4 or score < 80:
            verdict = "REVIEW"
        elif score < 92:
            verdict = "GOOD"
        else:
            verdict = "EXCELLENT"
        grade = _grade(score)

        mono = x.mean(axis=0)
        trms = _db(math.sqrt(float(np.mean(mono * mono)) + EPS))
        tpk = _db(float(np.abs(mono).max()) + EPS)
        tcorr = _corr(x[0], x[1]) if channels >= 2 else 1.0
        bands = {
            "bass_20_250_hz": float(np.median([p["bass_percent"] for p in timeline])),
            "mid_250_2000_hz": float(np.median([p["mid_percent"] for p in timeline])),
            "presence_2000_6000_hz": float(np.median([p["presence_percent"] for p in timeline])),
            "hf_6000_plus_hz": float(np.median([p["hf_percent"] for p in timeline])),
        }

        report = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "inspector_version": VERSION,
            "provenance": {
                "report_id": str(uuid.uuid4()),
                "created_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "software": "Nova Track Inspector",
                "inspector_version": VERSION,
                "analysis_resolution": analysis_resolution,
                "analysis_strategy": "WHOLE_TRACK_LISTENING_AID_V2",
            },
            "identity": {
                "source_pcm_sha256": _pcm_sha256(x_t),
                "sample_rate_hz": sr,
                "channels": channels,
                "samples": samples,
                "duration_seconds": duration,
            },
            "settings": {
                "analysis_resolution": analysis_resolution,
                "window_seconds": window_s,
                "hop_seconds": hop_s,
                "marker_sensitivity": float(marker_sensitivity),
                "coherence_sensitivity": float(coherence_sensitivity),
                "spectral_window_strategy": "5-frame whole-window averaged power spectrum",
            },
            "summary": {
                "track_integrity_score": score,
                "grade": grade,
                "verdict": verdict,
                "noise_likelihood_percent": noise,
                "marker_count": len(markers),
                "critical_markers": critical_count,
                "warning_markers": warning_count,
                "review_markers": review_count,
                "observation_markers": observations,
                "audible_concerns": audible_concerns,
                "hard_failures": hard_failures,
                "section_count": len(sections),
            },
            "track_metrics": {
                "rms_dbfs": trms,
                "sample_peak_dbfs": tpk,
                "crest_db": tpk - trms,
                "lr_correlation": tcorr,
                "bands_percent_median": bands,
                "coherence_score_median": med_coh,
                "coherence_score_p20": low_coh,
                "transition_threshold": transition_threshold,
                "anomaly_threshold": anomaly_threshold,
            },
            "subscores": subs,
            "sections": sections,
            "markers": markers,
            "timeline": {
                "window_seconds": window_s,
                "hop_seconds": hop_s,
                "points": timeline,
                "waveform_envelope": _waveform_envelope(x, sr),
            },
            "interpretation": {
                "note": "Track Integrity is a deterministic listening aid, not an aesthetic verdict. Stable musical transitions are observations rather than faults; penalties are reserved for inconsistent, artifact-like, or corroborated anomalies. Final musical judgement remains with the listener.",
                "baseline_tuning": "v0.2.0 reduces false positives from normal instrumentation/section changes by using whole-window spectral averaging, absolute band levels, persistent-state transition logic and listener-relevance scoring.",
            },
        }
        report["identity"]["report_payload_sha256"] = _canonical_sha256(report)
        markers_payload = {
            "schema": "nova.track_inspector.markers", "schema_version": 2,
            "source_pcm_sha256": report["identity"]["source_pcm_sha256"],
            "duration_seconds": duration, "markers": markers,
        }
        timeline_payload = {
            "schema": "nova.track_inspector.timeline", "schema_version": 2,
            "source_pcm_sha256": report["identity"]["source_pcm_sha256"],
            "duration_seconds": duration, **report["timeline"],
        }
        return (
            audio,
            json.dumps(report, ensure_ascii=False, separators=(",", ":")),
            json.dumps(markers_payload, ensure_ascii=False, separators=(",", ":")),
            json.dumps(timeline_payload, ensure_ascii=False, separators=(",", ":")),
            score,
            verdict,
        )

NODE_CLASS_MAPPINGS = {"NovaTrackInspector": NovaTrackInspector}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaTrackInspector": "Nova Track Inspector 🔬"}
