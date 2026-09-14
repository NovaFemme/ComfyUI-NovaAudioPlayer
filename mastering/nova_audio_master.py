import math
import json
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, List
import torch

try:
    from ..nova_categories import MASTERING
except ImportError:  # imported as a module rather than as part of the pack
    from nova_categories import MASTERING

try:
    from ..analysis import (
        integrated_lufs, true_peak_db, sample_peak_db, rms_db,
        crest_db, lr_correlation, dc_offset, band_energy_percentages
    )
except ImportError:
    from analysis import (
        integrated_lufs, true_peak_db, sample_peak_db, rms_db,
        crest_db, lr_correlation, dc_offset, band_energy_percentages
    )

VERSION = "0.2.7.7-fix4"


def _db_to_gain(db: float) -> float:
    return 10.0 ** (db / 20.0)


def _true_peak_limit(x: torch.Tensor, sr: int, ceiling_dbtp: float):
    tp = true_peak_db(x, sr, oversample=4)
    if tp <= ceiling_dbtp:
        return x, 0.0
    gr = tp - ceiling_dbtp
    return x * _db_to_gain(-gr), gr





def _frame_rms_db(x: torch.Tensor, sr: int, win_ms: float = 60.0, hop_ms: float = 10.0):
    import torch.nn.functional as F
    power = torch.mean(x.float() * x.float(), dim=0, keepdim=True).unsqueeze(0)
    win = max(1, int(round(sr * win_ms / 1000.0)))
    hop = max(1, int(round(sr * hop_ms / 1000.0)))
    ms = F.avg_pool1d(power, kernel_size=win, stride=hop, ceil_mode=True).view(-1)
    return 10.0 * torch.log10(torch.clamp(ms, min=1e-12)), hop


def _smooth_control(values: torch.Tensor, detector_rate: float, attack_ms: float, release_ms: float):
    attack = math.exp(-1.0 / max(1.0, detector_rate * attack_ms / 1000.0))
    release = math.exp(-1.0 / max(1.0, detector_rate * release_ms / 1000.0))
    smooth = torch.empty_like(values)
    env = 0.0
    for i in range(values.numel()):
        target = float(values[i].item())
        coeff = attack if target > env else release
        env = coeff * env + (1.0 - coeff) * target
        smooth[i] = env
    return smooth


def _transient_headroom_stage(x: torch.Tensor, sr: int, strength01: float, max_gr_db: float):
    import torch.nn.functional as F
    frame = max(1, int(round(sr * 0.0015)))
    detector = torch.max(torch.abs(x.float()), dim=0).values
    rem = detector.numel() % frame
    if rem:
        detector = F.pad(detector, (0, frame - rem))
    peaks = detector.reshape(-1, frame).amax(dim=1)
    level_db = 20.0 * torch.log10(torch.clamp(peaks, min=1e-12))
    threshold = float(torch.quantile(level_db, 0.88).item()) - (0.25 + 0.75 * strength01)
    ratio = 2.2 + 2.3 * strength01
    over = level_db - threshold
    desired = torch.where(over > 0, over * (1.0 - 1.0 / ratio), torch.zeros_like(over))
    desired = torch.clamp(desired, 0.0, float(max_gr_db))
    rate = sr / float(frame)
    smooth = _smooth_control(desired, rate, 0.6, 32.0)
    gr_audio = F.interpolate(smooth.view(1,1,-1), size=x.shape[-1], mode="linear", align_corners=False).view(-1)
    y = x * torch.pow(10.0, -gr_audio / 20.0).unsqueeze(0)
    return y, {
        "peak_gr_db": float(torch.max(smooth).item()) if smooth.numel() else 0.0,
        "avg_gr_db": float(torch.mean(smooth).item()) if smooth.numel() else 0.0,
        "threshold_db": threshold,
        "ratio": ratio,
    }


def _body_recovery_stage(x: torch.Tensor, sr: int, strength01: float, max_lift_db: float):
    import torch.nn.functional as F
    frames_db, hop = _frame_rms_db(x, sr, 60.0, 10.0)
    anchor = float(torch.quantile(frames_db, 0.60).item())
    floor = anchor - 11.0
    depth = torch.clamp((anchor - frames_db) / 8.0, 0.0, 1.0)
    gate = torch.clamp((frames_db - floor) / 4.5, 0.0, 1.0)
    desired = depth * gate * float(max_lift_db) * float(strength01)
    rate = sr / float(hop)
    smooth = _smooth_control(desired, rate, 40.0, 240.0)
    lift_audio = F.interpolate(smooth.view(1,1,-1), size=x.shape[-1], mode="linear", align_corners=False).view(-1)
    y = x * torch.pow(10.0, lift_audio / 20.0).unsqueeze(0)
    return y, {
        "peak_lift_db": float(torch.max(smooth).item()) if smooth.numel() else 0.0,
        "avg_lift_db": float(torch.mean(smooth).item()) if smooth.numel() else 0.0,
        "anchor_db": anchor,
    }


def _measure_dyn(x: torch.Tensor, sr: int):
    return {
        "lufs": float(integrated_lufs(x, sr)),
        "rms": float(rms_db(x)),
        "crest": float(crest_db(x)),
        "tp": float(true_peak_db(x, sr, oversample=4)),
    }


def _limiter_budget_class(gr_db: float) -> str:
    if gr_db <= 1.5:
        return "PREFERRED"
    if gr_db <= 2.0:
        return "ACCEPTABLE"
    if gr_db <= 3.0:
        return "WARNING"
    return "HEAVY"


def _progressive_dyn_score(lufs, crest, limiter_gr_db, target_lufs, target_crest_db):
    pref_hi = float(target_crest_db) + 2.0
    pref_lo = max(6.5, float(target_crest_db) - 1.75)
    if crest > pref_hi:
        crest_penalty = (crest - pref_hi) * 1.55
    elif crest < pref_lo:
        crest_penalty = (pref_lo - crest) * 2.8
    else:
        crest_penalty = 0.0
    loudness_penalty = max(0.0, float(target_lufs) - lufs) * 0.60
    if limiter_gr_db <= 1.5:
        limiter_penalty = 0.0
    elif limiter_gr_db <= 2.0:
        limiter_penalty = (limiter_gr_db - 1.5) * 0.8
    elif limiter_gr_db <= 3.0:
        limiter_penalty = 0.4 + (limiter_gr_db - 2.0) * 1.4
    else:
        limiter_penalty = 1.8 + (limiter_gr_db - 3.0) * 2.2
    return float(crest_penalty + loudness_penalty + limiter_penalty)


def _simulate_final_chain(x, sr, target_lufs, target_true_peak_dbtp):
    """Run the same loudness/TP end-chain used by master(), without changing x."""
    pre_lufs = float(integrated_lufs(x, sr))
    trim = max(-2.0, min(4.0, float(target_lufs) - pre_lufs))
    y = x * _db_to_gain(trim) if abs(trim) > 1e-8 else x
    y, limiter_gr = _true_peak_limit(y, sr, float(target_true_peak_dbtp))
    m = _measure_dyn(y, sr)
    return {
        "audio": y,
        "pre_lufs": pre_lufs,
        "trim_db": float(trim),
        "limiter_gr_db": float(limiter_gr),
        "limiter_budget": _limiter_budget_class(float(limiter_gr)),
        **m,
    }


def _limiter_budget_rank(name: str) -> int:
    return {"PREFERRED": 0, "ACCEPTABLE": 1, "WARNING": 2, "HEAVY": 3}.get(name, 4)



def _adaptive_safe_crest_target(
    profile: str,
    source_crest_db: float,
    post_correction_crest_db: float,
    requested_target_db: float,
    strength01: float,
):
    """Choose a profile-aware safe crest target for this specific source.

    The user target remains the reference/ideal target. The adaptive target is
    intentionally conservative when tonal/stereo correction has materially raised
    crest or when the source itself is naturally dynamic.
    """
    profile_floor = {
        "Metal": 10.5,
        "EDM-Trance": 11.5,
        "K-Pop": 10.5,
        "Balanced": 11.5,
    }[profile]

    requested = float(requested_target_db)
    source = float(source_crest_db)
    corrected = float(post_correction_crest_db)

    correction_increase = max(0.0, corrected - source)

    # Start from a conservative fraction of the distance between requested and
    # post-correction crest. Stronger settings allow more convergence, but never
    # force an unsafe one-pass destination.
    convergence_fraction = 0.26 + 0.24 * float(strength01)
    provisional = corrected - max(0.0, corrected - requested) * convergence_fraction

    # If tonal correction itself raised crest substantially, retain more dynamics.
    provisional += min(1.25, correction_increase * 0.22)

    # Never set an adaptive target below the profile floor or more than 2.0 dB
    # below the original source crest in this stage of development.
    lower_bound = max(profile_floor, source - 2.0, requested)
    adaptive = max(lower_bound, provisional)

    # Adaptive target should never exceed current post-correction crest.
    adaptive = min(adaptive, corrected)

    return {
        "reference_target_db": requested,
        "source_crest_db": source,
        "post_correction_crest_db": corrected,
        "correction_crest_increase_db": correction_increase,
        "adaptive_target_db": float(adaptive),
        "profile_floor_db": float(profile_floor),
        "convergence_fraction": float(convergence_fraction),
    }


def _crest_convergence_percent(post_correction_crest: float, adaptive_target: float, final_crest: float) -> float:
    required = max(0.0, float(post_correction_crest) - float(adaptive_target))
    if required <= 1e-9:
        return 100.0
    achieved = max(0.0, float(post_correction_crest) - float(final_crest))
    return max(0.0, min(100.0, 100.0 * achieved / required))


def _crest_convergence_status(final_crest: float, adaptive_target: float, convergence_pct: float) -> str:
    delta = float(final_crest) - float(adaptive_target)
    if delta <= 0.25:
        return "TARGET_REACHED"
    if delta <= 0.75:
        return "NEAR_TARGET"
    if convergence_pct >= 60.0:
        return "GOOD_PROGRESS"
    if convergence_pct >= 30.0:
        return "PARTIAL_PROGRESS"
    return "LIMITED_PROGRESS"


def _build_progressive_candidate(
    x, sr, target_lufs, target_crest_db, target_true_peak_dbtp,
    strength01, transient_gr_request_db, body_lift_request_db
):
    # Candidate DSP is kept pre-final. We simulate the exact final loudness/TP
    # chain for scoring, then only commit the pre-final candidate when accepted.
    processed, transient = _transient_headroom_stage(
        x, sr, strength01, transient_gr_request_db
    )
    processed, body = _body_recovery_stage(
        processed, sr, strength01, body_lift_request_db
    )

    sim = _simulate_final_chain(
        processed, sr, target_lufs, target_true_peak_dbtp
    )
    score = _progressive_dyn_score(
        sim["lufs"], sim["crest"], sim["limiter_gr_db"],
        target_lufs, target_crest_db
    )
    return {
        "audio": processed,
        "transient_request_db": float(transient_gr_request_db),
        "body_request_db": float(body_lift_request_db),
        "transient_peak_gr_db": transient["peak_gr_db"],
        "transient_avg_gr_db": transient["avg_gr_db"],
        "body_peak_lift_db": body["peak_lift_db"],
        "body_avg_lift_db": body["avg_lift_db"],
        "makeup_db": float(sim["trim_db"]),
        "final_chain_trim_db": float(sim["trim_db"]),
        "limiter_gr_db": float(sim["limiter_gr_db"]),
        "limiter_budget": sim["limiter_budget"],
        "lufs": float(sim["lufs"]),
        "rms": float(sim["rms"]),
        "crest": float(sim["crest"]),
        "tp": float(sim["tp"]),
        "score": float(score),
    }


def _adaptive_dynamics_stage(
    x, sr, target_lufs, target_crest_db, target_true_peak_dbtp, strength01
):
    y = x
    accepted = rejected = 0
    history = []
    transient_peak = transient_avg_sum = 0.0
    body_peak = body_avg_sum = 0.0
    makeup_total = limiter_total = 0.0

    specs = [(1.4, 0.7), (2.0, 1.1), (2.6, 1.5)]

    for pass_index in range(3):
        base_pre = _measure_dyn(y, sr)
        base = _simulate_final_chain(
            y, sr, target_lufs, target_true_peak_dbtp
        )
        base_score = _progressive_dyn_score(
            base["lufs"], base["crest"], base["limiter_gr_db"],
            target_lufs, target_crest_db
        )

        if (
            base["crest"] <= target_crest_db + 2.0
            and base["lufs"] >= target_lufs - 1.0
            and base["limiter_gr_db"] <= 2.0
        ):
            break

        candidates = [
            _build_progressive_candidate(
                y, sr, target_lufs, target_crest_db, target_true_peak_dbtp,
                strength01, transient_db, body_db
            )
            for transient_db, body_db in specs
        ]
        best = min(candidates, key=lambda c: c["score"])

        crest_gain = float(base["crest"] - best["crest"])
        limiter_gain = float(base["limiter_gr_db"] - best["limiter_gr_db"])
        loudness_delta = float(best["lufs"] - base["lufs"])
        budget_improved = (
            _limiter_budget_rank(best["limiter_budget"])
            < _limiter_budget_rank(base["limiter_budget"])
        )

        crest_improved = crest_gain >= 0.10
        limiter_improved = limiter_gain >= 0.25
        score_improved = best["score"] <= base_score - 0.03
        loudness_not_catastrophic = loudness_delta >= -0.75
        safe_floor = best["crest"] >= max(
            6.5, float(target_crest_db) - 2.0
        )
        true_peak_safe = best["tp"] <= float(target_true_peak_dbtp) + 0.10

        # v0.2.7.3: multi-objective acceptance. A useful crest reduction is
        # accepted when the final-chain simulation is safe and either limiter
        # workload, limiter budget class, or aggregate score also improves.
        secondary_improvement = (
            limiter_improved or budget_improved or score_improved
        )
        accept = (
            crest_improved
            and secondary_improvement
            and loudness_not_catastrophic
            and safe_floor
            and true_peak_safe
        )

        def snapshot(c):
            keys = (
                "transient_request_db", "body_request_db",
                "transient_peak_gr_db", "transient_avg_gr_db",
                "body_peak_lift_db", "body_avg_lift_db",
                "makeup_db", "final_chain_trim_db",
                "limiter_gr_db", "limiter_budget",
                "lufs", "rms", "crest", "tp", "score"
            )
            return {k: c[k] for k in keys}

        record = {
            "pass": pass_index + 1,
            "evaluation_mode": "FINAL_CHAIN_SIMULATION",
            "source_pre_final": base_pre,
            "source": {
                "lufs": float(base["lufs"]),
                "rms": float(base["rms"]),
                "crest": float(base["crest"]),
                "tp": float(base["tp"]),
                "final_chain_trim_db": float(base["trim_db"]),
                "estimated_final_limiter_gr_db": float(base["limiter_gr_db"]),
                "limiter_budget": base["limiter_budget"],
                "score": float(base_score),
            },
            "candidates": [snapshot(c) for c in candidates],
            "selected": {
                **snapshot(best),
                "crest_improvement_db": crest_gain,
                "loudness_improvement_lu": loudness_delta,
                "limiter_reduction_db": limiter_gain,
                "limiter_budget_transition":
                    f'{base["limiter_budget"]}->{best["limiter_budget"]}',
                "budget_class_improved": bool(budget_improved),
            },
            "acceptance": {
                "crest_improved": bool(crest_improved),
                "limiter_improved": bool(limiter_improved),
                "budget_class_improved": bool(budget_improved),
                "score_improved": bool(score_improved),
                "secondary_improvement": bool(secondary_improvement),
                "loudness_not_catastrophic": bool(loudness_not_catastrophic),
                "safe_floor": bool(safe_floor),
                "true_peak_safe": bool(true_peak_safe),
            },
        }

        if accept:
            record["status"] = "ACCEPTED"
            record["acceptance_reason"] = (
                "Crest improved and final-chain simulation showed a safe "
                "secondary improvement in limiter workload/budget or score."
            )
            y = best["audio"]
            accepted += 1
            transient_peak = max(
                transient_peak, best["transient_peak_gr_db"]
            )
            transient_avg_sum += best["transient_avg_gr_db"]
            body_peak = max(body_peak, best["body_peak_lift_db"])
            body_avg_sum += best["body_avg_lift_db"]
            makeup_total += best["final_chain_trim_db"]
            limiter_total += best["limiter_gr_db"]
        else:
            record["status"] = "ROLLED_BACK"
            record["rejection_reason"] = record["acceptance"].copy()
            rejected += 1
            history.append(record)
            break

        history.append(record)

    last_rejected = next(
        (h for h in reversed(history) if h["status"] == "ROLLED_BACK"), None
    )
    final_sim = _simulate_final_chain(
        y, sr, target_lufs, target_true_peak_dbtp
    )
    return {
        "audio": y,
        "accepted_passes": accepted,
        "rejected_passes": rejected,
        "transient_peak_gr_db": transient_peak,
        "transient_avg_gr_db":
            transient_avg_sum / accepted if accepted else 0.0,
        "body_peak_lift_db": body_peak,
        "body_avg_lift_db":
            body_avg_sum / accepted if accepted else 0.0,
        "makeup_db": makeup_total,
        "limiter_gr_db": limiter_total,
        "history": history,
        "last_rejected_candidate": last_rejected,
        "final_chain_preview": {
            "lufs": float(final_sim["lufs"]),
            "rms": float(final_sim["rms"]),
            "crest": float(final_sim["crest"]),
            "tp": float(final_sim["tp"]),
            "trim_db": float(final_sim["trim_db"]),
            "limiter_gr_db": float(final_sim["limiter_gr_db"]),
            "limiter_budget": final_sim["limiter_budget"],
        },
        "final": _measure_dyn(y, sr),
    }




def _limiter_release_score(gr_db: float):
    budget = _limiter_budget_class(float(gr_db))
    if budget == "PREFERRED":
        return budget, 100.0
    if budget == "ACCEPTABLE":
        return budget, 92.0
    if budget == "WARNING":
        return budget, 68.0
    return budget, 38.0


def _adaptive_crest_validation(
    profile: str,
    reference_target_db: float,
    adaptive_target_db: float,
    achieved_crest_db: float,
    post_correction_crest_db: float,
    convergence_percent: float,
    limiter_gr_db: float,
    limiter_budget: str,
):
    reference_delta = float(achieved_crest_db) - float(reference_target_db)
    adaptive_delta = float(achieved_crest_db) - float(adaptive_target_db)
    reduction = float(post_correction_crest_db) - float(achieved_crest_db)

    if reference_delta <= 0.50:
        reference_status = "PASS"
    elif reference_delta <= 2.00:
        reference_status = "NEAR"
    else:
        reference_status = "NOT_REACHED"

    # Adaptive achievement describes safe improvement; it does not rewrite the
    # user's reference target.
    if adaptive_delta <= 0.35:
        adaptive_status, score = "TARGET_REACHED", 100.0
    elif adaptive_delta <= 1.00 and convergence_percent >= 50.0:
        adaptive_status, score = "GOOD_PROGRESS", 85.0
    elif reduction >= 0.75 and convergence_percent >= 30.0:
        adaptive_status, score = "IMPROVED", 72.0
    elif reduction > 0.15:
        adaptive_status, score = "LIMITED_PROGRESS", 58.0
    else:
        adaptive_status, score = "NO_PROGRESS", 35.0

    if limiter_budget == "PREFERRED":
        score += 7.0
    elif limiter_budget == "ACCEPTABLE":
        score += 5.0
    elif limiter_budget == "HEAVY":
        score -= 10.0

    # Safety ceiling: adaptive scoring must not reward tiny improvements in a
    # still-extreme result.
    safe = (
        achieved_crest_db <= adaptive_target_db + 2.0
        and limiter_gr_db <= 3.0
        and limiter_budget != "HEAVY"
    )
    if not safe:
        score = min(score, 60.0)

    score = max(0.0, min(100.0, score))
    if adaptive_status in ("TARGET_REACHED", "GOOD_PROGRESS") and safe:
        interpretation = "ACCEPTABLE_DYNAMIC"
    elif adaptive_status == "IMPROVED" and safe:
        interpretation = "IMPROVED_DYNAMIC"
    else:
        interpretation = "REVIEW_DYNAMIC"

    return {
        "reference_status": reference_status,
        "adaptive_status": adaptive_status,
        "release_interpretation": interpretation,
        "score": float(score),
        "reference_delta_db": float(reference_delta),
        "adaptive_delta_db": float(adaptive_delta),
        "crest_reduction_db": float(reduction),
        "convergence_percent": float(convergence_percent),
        "safe": bool(safe),
        "limiter_budget": limiter_budget,
        "limiter_gr_db": float(limiter_gr_db),
    }


def _adaptive_release_status(
    peak_status: str,
    adaptive_loudness: Dict[str, Any],
    adaptive_crest: Dict[str, Any],
    stereo_status: str,
    adaptive_tonal: Dict[str, Any],
    limiter_budget: str,
    dc: float,
):
    if peak_status == "FAIL" or stereo_status == "FAIL" or abs(dc) > 0.003:
        return "FAIL", "One or more release-safety checks failed."

    if limiter_budget == "HEAVY":
        return "WARNING", "Release safety is not failed, but final limiter dependence is heavy."

    severe = (
        not adaptive_loudness["safe"]
        or not adaptive_crest["safe"]
        or not adaptive_tonal["safe"]
    )
    if severe:
        return "WARNING", "One or more non-destructive release-quality checks still require review."

    reference_missed = (
        adaptive_loudness["reference_status"] != "PASS"
        or adaptive_crest["reference_status"] != "PASS"
        or adaptive_tonal["reference_status"] != "PASS"
    )
    adaptive_good = adaptive_crest["adaptive_status"] in {
        "TARGET_REACHED", "GOOD_PROGRESS", "IMPROVED"
    }

    tonal_good = adaptive_tonal["correction_status"] in {
        "STRONG_IMPROVEMENT", "GOOD_IMPROVEMENT", "IMPROVED"
    }

    loudness_good = adaptive_loudness["status"] in {"TARGET_REACHED","NEAR_TARGET","SAFE_BELOW_TARGET"}

    if reference_missed and adaptive_good and tonal_good and loudness_good:
        return (
            "CONDITIONAL_PASS",
            "Technically release-safe; one or more reference targets were not fully reached, "
            "but adaptive loudness, crest and tonal decisions preserved the safer overall master without forcing destructive processing."
        )

    # v0.2.7.7-fix1:
    # `loudness_status` belonged to the pre-adaptive validator and was removed
    # when v0.2.7.7 switched to the adaptive_loudness object.  This fallback
    # branch is only reached when the earlier reference-miss path did not return.
    # Use the adaptive status directly.
    if (
        adaptive_loudness["status"] == "NEAR_TARGET"
        or str(stereo_status).startswith("ACCEPTABLE")
        or adaptive_tonal["release_interpretation"] == "IMPROVED_CORRECTED"
    ):
        return "CONDITIONAL_PASS", "Technically release-safe with one or more acceptable, non-preferred metrics."

    return "PASS", "Selected release-safety and adaptive quality checks are inside preferred ranges."


def _crest_classification(profile: str, crest: float):
    cfg = {
        "Metal":      (7.5, 8.5, 11.0, 14.5, 16.5),
        "EDM-Trance": (6.5, 7.0, 9.5, 11.5, 13.5),
        "K-Pop":      (6.5, 7.0, 9.5, 11.5, 13.5),
        "Balanced":   (7.5, 8.5, 11.5, 14.5, 16.5),
    }[profile]
    floor, pref_lo, pref_hi, acceptable_hi, warning_hi = cfg

    if crest < floor:
        return "OVER_COMPRESSED", "Below the profile dynamic floor; transient impact may be reduced.", 35.0
    if pref_lo <= crest <= pref_hi:
        return "PREFERRED", "Inside the preferred crest range for this profile.", 100.0
    if crest <= acceptable_hi:
        return "ACCEPTABLE_DYNAMIC", "More dynamic than preferred, but still acceptable when the track sounds controlled.", 82.0
    if crest <= warning_hi:
        return "WARNING_DYNAMIC", "High crest; review for under-density or transient dominance.", 60.0
    return "TOO_DYNAMIC", "Substantially above the profile range; likely under-dense for release mastering.", 35.0



def _adaptive_loudness_validation(achieved_lufs, target_lufs, achieved_tp, target_tp,
                                  final_trim_db, max_trim_db, limiter_gr_db, limiter_budget):
    legacy_status, legacy_note, legacy_score = _loudness_classification(
        achieved_lufs, target_lufs, achieved_tp, target_tp)
    delta=float(achieved_lufs)-float(target_lufs)
    ad=abs(delta)
    gain_maxed=final_trim_db >= max_trim_db-0.05
    peak_safe=achieved_tp <= target_tp+0.10
    limiter_safe=limiter_budget in {"PREFERRED","ACCEPTABLE"}

    ref="PASS" if ad<=0.5 else ("NEAR" if ad<=1.0 else "NOT_REACHED")

    if not peak_safe:
        status,interp,score,safe="FAIL","UNSAFE_PEAK",25.0,False
    elif delta>1.0:
        status,interp,score,safe="WARNING_HOT","ABOVE_TARGET",50.0,False
    elif ad<=0.5 and limiter_safe:
        status,interp,score,safe="TARGET_REACHED","TARGET_REACHED",100.0,True
    elif delta < -0.5 and gain_maxed and limiter_safe:
        status,interp,score,safe="SAFE_BELOW_TARGET","LIMITED_BY_GAIN_BUDGET",90.0,True
    elif delta < -0.5 and limiter_budget=="WARNING":
        status,interp,score,safe="SAFE_BELOW_TARGET","LIMITED_BY_PEAK_BUDGET",78.0,True
    elif delta < -1.0:
        status,interp,score,safe="WARNING_LOW","BELOW_TARGET",58.0,False
    else:
        status,interp,score,safe="NEAR_TARGET","NEAR_TARGET",85.0,True

    return {
        "reference_status":ref,"status":status,"release_interpretation":interp,
        "score":float(score),"safe":bool(safe),"target_lufs":float(target_lufs),
        "achieved_lufs":float(achieved_lufs),"delta_lu":float(delta),
        "true_peak_dbtp":float(achieved_tp),"true_peak_ceiling_dbtp":float(target_tp),
        "peak_safe":bool(peak_safe),"final_chain_trim_db":float(final_trim_db),
        "max_trim_db":float(max_trim_db),"gain_budget_used":bool(gain_maxed),
        "limiter_gr_db":float(limiter_gr_db),"limiter_budget":limiter_budget,
        "legacy_status":legacy_status,"legacy_note":legacy_note,"legacy_score":float(legacy_score)
    }


def _loudness_classification(lufs: float, target: float, tp: float, tp_target: float):
    d = lufs - target
    if abs(d) <= 0.5:
        return "PREFERRED", "Within ±0.5 LU of target.", 100.0
    if -1.5 <= d < -0.5:
        if tp >= tp_target - 0.15:
            return "ACCEPTABLE_CEILING_LIMITED", "Below target because extra gain would conflict with the true-peak ceiling.", 88.0
        return "ACCEPTABLE", "Modestly below target.", 82.0
    if d < -1.5:
        return "WARNING_LOW", "Materially below the selected loudness target.", 55.0
    if d <= 1.0:
        return "ACCEPTABLE_HOT", "Slightly above target.", 78.0
    return "WARNING_HOT", "Materially above target.", 50.0


def _peak_classification(tp: float, target: float):
    d = tp - target
    if d <= 0.10:
        return "PASS", "At or below the configured true-peak ceiling.", 100.0
    if d <= 0.30:
        return "WARNING", "Slightly above the configured true-peak ceiling.", 70.0
    return "FAIL", "True peak materially exceeds the configured ceiling.", 25.0


def _stereo_classification(corr: float):
    if corr < 0.0:
        return "FAIL", "Negative L/R correlation; mono compatibility risk.", 20.0
    if corr < 0.10:
        return "WARNING", "Very wide / phase-sensitive image; verify in mono.", 55.0
    if corr <= 0.95:
        return "PASS", "Positive correlation in a generally safe range.", 100.0
    return "ACCEPTABLE", "Highly correlated/narrow, but mono-safe.", 85.0



def _adaptive_tonal_validation(
    profile: str,
    source_bands: Dict[str, float],
    mastered_bands: Dict[str, float],
    profile_error_before: float,
    profile_error_after: float,
    rolled_back: bool,
):
    legacy_status, legacy_notes, legacy_score = _tonal_classification(profile, mastered_bands)

    before = float(profile_error_before)
    after = float(profile_error_after)
    improvement = max(0.0, before - after)
    reduction_pct = (100.0 * improvement / before) if before > 1e-9 else 0.0

    if legacy_status == "PREFERRED":
        reference_status = "PASS"
    elif legacy_status == "ACCEPTABLE":
        reference_status = "NEAR"
    else:
        reference_status = "NOT_REACHED"

    if rolled_back:
        correction_status, score = "ROLLED_BACK", min(legacy_score, 45.0)
    elif reduction_pct >= 55.0 and improvement >= 10.0:
        correction_status, score = "STRONG_IMPROVEMENT", 90.0
    elif reduction_pct >= 35.0 and improvement >= 6.0:
        correction_status, score = "GOOD_IMPROVEMENT", 82.0
    elif reduction_pct >= 15.0 and improvement >= 2.0:
        correction_status, score = "IMPROVED", 72.0
    elif improvement > 0.25:
        correction_status, score = "LIMITED_IMPROVEMENT", 58.0
    else:
        correction_status, score = "NO_IMPROVEMENT", 35.0

    # Never let adaptive achievement hide a truly poor residual spectrum.
    # Legacy score remains a useful absolute reference and acts as a soft cap
    # only at the extreme low end.
    if legacy_score < 25.0:
        score = min(score, 68.0)

    score = max(0.0, min(100.0, score))

    if correction_status == "STRONG_IMPROVEMENT" and not rolled_back:
        interpretation = "ACCEPTABLE_CORRECTED"
    elif correction_status in {"GOOD_IMPROVEMENT", "IMPROVED"} and not rolled_back:
        interpretation = "IMPROVED_CORRECTED"
    else:
        interpretation = "REVIEW_TONAL"

    safe = bool(
        not rolled_back
        and after <= before + 1e-6
        and correction_status not in {"NO_IMPROVEMENT", "ROLLED_BACK"}
    )

    return {
        "reference_status": reference_status,
        "correction_status": correction_status,
        "release_interpretation": interpretation,
        "score": float(score),
        "safe": safe,
        "profile_error_before": before,
        "profile_error_after": after,
        "profile_error_improvement": float(improvement),
        "profile_error_reduction_percent": float(reduction_pct),
        "legacy_status": legacy_status,
        "legacy_score": float(legacy_score),
        "legacy_notes": list(legacy_notes),
        "source_bands": {k: float(source_bands[k]) for k in ("bass","mid","presence","hf")},
        "mastered_bands": {k: float(mastered_bands[k]) for k in ("bass","mid","presence","hf")},
    }


def _tonal_classification(profile: str, b):
    limits = {
        "Metal":      {"bass": (43,56), "mid": (22,32), "presence": (14,23), "hf": (3,9)},
        "EDM-Trance": {"bass": (48,60), "mid": (17,28), "presence": (13,22), "hf": (4,11)},
        "K-Pop":      {"bass": (38,52), "mid": (22,32), "presence": (16,25), "hf": (5,12)},
        "Balanced":   {"bass": (40,56), "mid": (22,32), "presence": (14,23), "hf": (4,10)},
    }[profile]

    score, notes = 100.0, []
    for k in ("bass","mid","presence","hf"):
        lo, hi = limits[k]
        v = b[k]
        if v < lo:
            notes.append(f"{k.capitalize()} below profile range ({v:.1f}% < {lo:.1f}%).")
            score -= min(18.0, (lo-v)*2.0)
        elif v > hi:
            notes.append(f"{k.capitalize()} above profile range ({v:.1f}% > {hi:.1f}%).")
            score -= min(18.0, (v-hi)*2.0)

    score = max(0.0, score)
    status = "PREFERRED" if score >= 90 else ("ACCEPTABLE" if score >= 75 else "REVIEW")
    if not notes:
        notes = ["Whole-take spectral balance is inside the profile guidance ranges."]
    return status, notes, score


def _release_status(states, dc):
    if "FAIL" in states or abs(dc) > 0.003:
        return "FAIL", "One or more release-safety checks failed."
    if any(s in {"WARNING","WARNING_LOW","WARNING_HOT","WARNING_DYNAMIC","TOO_DYNAMIC","REVIEW"} for s in states):
        return "WARNING", "Usable for review, but one or more metrics deserve attention."
    if any(str(s).startswith("ACCEPTABLE") for s in states):
        return "ACCEPTABLE", "Technically safe and suitable for release review."
    return "PASS", "All selected profile checks are inside preferred ranges."


def _grade(score):
    if score >= 95: return "A+"
    if score >= 90: return "A"
    if score >= 85: return "B+"
    if score >= 80: return "B"
    if score >= 70: return "C"
    return "D"



def _canonical_json_sha256(value: Dict[str, Any]) -> str:
    raw = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _pcm_sha256(x: torch.Tensor) -> str:
    """Exact hash of Nova's canonical decoded PCM representation.

    Canonical form:
      - channels-first
      - float32
      - little-endian
      - contiguous C-order bytes
    """
    pcm = x.detach().to(device="cpu", dtype=torch.float32).contiguous().numpy()
    pcm = pcm.astype("<f4", copy=False)
    return hashlib.sha256(pcm.tobytes(order="C")).hexdigest()


def _reproduction_fingerprint(after: Dict[str, Any]):
    return {
        "algorithm": "nova-reproduction-fingerprint",
        "algorithm_version": 5,
        "metrics": {
            "integrated_lufs": float(after["lufs"]),
            "true_peak_dbtp": float(after["tp"]),
            "sample_peak_dbfs": float(after["sp"]),
            "rms_dbfs": float(after["rms"]),
            "crest_db": float(after["crest"]),
            "lr_correlation": float(after["corr"]),
            "dc_offset": float(after["dc"]),
            "bands_percent": {
                "bass_20_250_hz": float(after["bands"]["bass"]),
                "mid_250_2000_hz": float(after["bands"]["mid"]),
                "presence_2000_6000_hz": float(after["bands"]["presence"]),
                "hf_6000_plus_hz": float(after["bands"]["hf"]),
            },
        },
        "tolerances": {
            "integrated_lufs": 0.10,
            "true_peak_dbtp": 0.10,
            "sample_peak_dbfs": 0.10,
            "rms_dbfs": 0.10,
            "crest_db": 0.15,
            "lr_correlation": 0.01,
            "band_energy_percent": 0.50,
        },
        "status_vocabulary": [
            "EXACT",
            "MATCH",
            "WITHIN_TOLERANCE",
            "DRIFT",
            "FAIL",
        ],
    }


PROFILE_DEFAULT_SETTINGS = {
    "Metal": {
        "strength": 70.0,
        "target_lufs": -11.5,
        "target_true_peak_dbtp": -1.0,
        "target_crest_db": 9.5,
        "high_pass_hz": 30.0,
        "bass_db": 0.0,
        "low_mid_db": 0.0,
        "mid_db": 0.0,
        "presence_db": 0.0,
        "air_db": 0.0,
        "stereo_width_percent": 100.0,
        "mono_below_hz": 120.0,
    },
    "EDM-Trance": {
        "strength": 70.0,
        "target_lufs": -11.0,
        "target_true_peak_dbtp": -1.0,
        "target_crest_db": 10.5,
        "high_pass_hz": 28.0,
        "bass_db": 0.0,
        "low_mid_db": 0.0,
        "mid_db": 0.0,
        "presence_db": 0.0,
        "air_db": 0.0,
        "stereo_width_percent": 100.0,
        "mono_below_hz": 120.0,
    },
    "K-Pop": {
        "strength": 70.0,
        "target_lufs": -10.5,
        "target_true_peak_dbtp": -1.0,
        "target_crest_db": 9.5,
        "high_pass_hz": 28.0,
        "bass_db": 0.0,
        "low_mid_db": 0.0,
        "mid_db": 0.0,
        "presence_db": 0.0,
        "air_db": 0.0,
        "stereo_width_percent": 100.0,
        "mono_below_hz": 100.0,
    },
    "Balanced": {
        "strength": 60.0,
        "target_lufs": -12.0,
        "target_true_peak_dbtp": -1.0,
        "target_crest_db": 11.0,
        "high_pass_hz": 25.0,
        "bass_db": 0.0,
        "low_mid_db": 0.0,
        "mid_db": 0.0,
        "presence_db": 0.0,
        "air_db": 0.0,
        "stereo_width_percent": 100.0,
        "mono_below_hz": 100.0,
    },
}

PROFILE_TARGETS = {
    "Metal": {"bands":{"bass":49.5,"mid":27.0,"presence":18.5,"hf":5.0}, "corr":(0.30,0.80)},
    "EDM-Trance": {"bands":{"bass":54.0,"mid":22.5,"presence":17.0,"hf":6.5}, "corr":(0.25,0.80)},
    "K-Pop": {"bands":{"bass":45.0,"mid":27.0,"presence":20.0,"hf":8.0}, "corr":(0.20,0.75)},
    "Balanced": {"bands":{"bass":48.0,"mid":27.0,"presence":18.0,"hf":7.0}, "corr":(0.25,0.85)},
}

def _smooth_band(freqs, lo, hi, edge):
    w=torch.zeros_like(freqs); core=(freqs>=lo)&(freqs<=hi); w[core]=1.0
    if edge>0:
        left=(freqs>=max(0.0,lo-edge))&(freqs<lo)
        if torch.any(left):
            t=(freqs[left]-(lo-edge))/edge; w[left]=0.5-0.5*torch.cos(math.pi*t)
        right=(freqs>hi)&(freqs<=hi+edge)
        if torch.any(right):
            t=(freqs[right]-hi)/edge; w[right]=0.5+0.5*torch.cos(math.pi*t)
    return w

def _apply_tonal_eq(x,sr,hpf,eq):
    n=x.shape[-1]; spec=torch.fft.rfft(x.float(),dim=-1); freqs=torch.fft.rfftfreq(n,d=1.0/sr).to(x.device); gain=torch.ones_like(freqs)
    if hpf>0:
        f=torch.clamp(freqs,min=1.0); hp=1.0/torch.sqrt(1.0+(float(hpf)/f)**8); hp[0]=0.0; gain*=hp
    defs={"bass":(20,250,35),"mid":(250,2000,180),"presence":(2000,6000,450),"hf":(6000,min(sr/2-1,20000),900)}
    for k,(lo,hi,edge) in defs.items():
        db=float(eq.get(k,0.0))
        if abs(db)<1e-7: continue
        shape=_smooth_band(freqs,lo,hi,edge); g=_db_to_gain(db); gain*=1.0+(g-1.0)*shape
    return torch.fft.irfft(spec*gain.unsqueeze(0),n=n,dim=-1)

def _derive_auto_eq(bands,profile,s):
    target=PROFILE_TARGETS[profile]["bands"]; cfg={"bass":(0.16,5.0),"mid":(0.10,3.0),"presence":(0.11,3.0),"hf":(0.10,2.5)}; out={}
    for k,(scale,cap) in cfg.items(): out[k]=max(-cap,min(cap,(target[k]-bands[k])*scale))*s
    return out

def _manual_eq(bass,lowmid,mid,pres,air): return {"bass":float(bass),"mid":float(mid)+0.55*float(lowmid),"presence":float(pres),"hf":float(air)}

def _tonal_error(b,profile):
    t=PROFILE_TARGETS[profile]["bands"]; return abs(b["bass"]-t["bass"])*1.25+abs(b["mid"]-t["mid"])+abs(b["presence"]-t["presence"])+abs(b["hf"]-t["hf"])*0.75

def _derive_auto_width(corr,profile,s):
    lo,hi=PROFILE_TARGETS[profile]["corr"]
    if corr>hi: return 1.0+min(0.35,(corr-hi)*1.75)*s
    if corr<lo: return 1.0-min(0.18,(lo-corr)*0.8)*s
    return 1.0

def _apply_fd_width(x,sr,mono_below,width):
    if x.shape[0]<2: return x
    l,r=x[0].float(),x[1].float(); mid=(l+r)*0.5; side=(l-r)*0.5; n=x.shape[-1]; ss=torch.fft.rfft(side); f=torch.fft.rfftfreq(n,d=1.0/sr).to(x.device)
    a=max(20.0,mono_below*0.70); b=max(a+1.0,mono_below*1.35); t=torch.clamp((f-a)/(b-a),0.0,1.0); low=0.5-0.5*torch.cos(math.pi*t)
    m=torch.ones_like(f); m*=1.0+(width-1.0)*0.35*_smooth_band(f,250,2000,250); m*=1.0+(width-1.0)*0.80*_smooth_band(f,2000,6000,500); m*=1.0+(width-1.0)*_smooth_band(f,6000,min(sr/2-1,20000),900); m*=low
    so=torch.fft.irfft(ss*m,n=n); y=x.clone().float(); y[0]=mid+so; y[1]=mid-so; return y

def _stereo_class(c,profile):
    lo,hi=PROFILE_TARGETS[profile]["corr"]
    if c<0:return "PHASE_RISK"
    if c<0.10:return "VERY_WIDE"
    if c<lo:return "WIDE"
    if c<=hi:return "BALANCED"
    if c<=0.90:return "NARROW"
    return "VERY_NARROW"


class NovaAudioMaster:
    CATEGORY = MASTERING
    FUNCTION = "master"
    RETURN_TYPES = ("AUDIO", "AUDIO", "STRING", "STRING")
    RETURN_NAMES = ("mastered_audio", "original_audio", "report", "report_json")
    DESCRIPTION = "Nova Audio Master v0.2.7.7-fix4: frozen mastering DSP, run control, profile defaults, and true Off pass-through mode."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "run_count": ("INT", {
                "default": 1,
                "min": 0,
                "max": 2147483647,
                "step": 1,
                "tooltip": "Increment this value to force Nova Audio Master and all downstream nodes to execute as a new mastering run."
            }),
            "mode": (["Auto","Assist","Manual","Off"], {"default":"Auto"}),
            "profile": (["Metal","EDM-Trance","K-Pop","Balanced"], {"default":"Metal"}),
            "strength": ("FLOAT", {"default":70.0,"min":0.0,"max":100.0,"step":1.0}),
            "target_lufs": ("FLOAT", {"default":-11.5,"min":-18.0,"max":-8.0,"step":0.1}),
            "target_true_peak_dbtp": ("FLOAT", {"default":-1.0,"min":-3.0,"max":-0.1,"step":0.1}),
            "target_crest_db": ("FLOAT", {"default":9.5,"min":6.0,"max":16.0,"step":0.1}),
            "high_pass_hz": ("FLOAT", {"default":30.0,"min":0.0,"max":80.0,"step":1.0}),
            "bass_db": ("FLOAT", {"default":0.0,"min":-6.0,"max":6.0,"step":0.1}),
            "low_mid_db": ("FLOAT", {"default":0.0,"min":-6.0,"max":6.0,"step":0.1}),
            "mid_db": ("FLOAT", {"default":0.0,"min":-6.0,"max":6.0,"step":0.1}),
            "presence_db": ("FLOAT", {"default":0.0,"min":-6.0,"max":6.0,"step":0.1}),
            "air_db": ("FLOAT", {"default":0.0,"min":-6.0,"max":6.0,"step":0.1}),
            "stereo_width_percent": ("FLOAT", {"default":100.0,"min":0.0,"max":180.0,"step":1.0}),
            "mono_below_hz": ("FLOAT", {"default":120.0,"min":0.0,"max":300.0,"step":5.0}),
        }}

    def master(self, audio: Dict[str, Any], run_count, mode, profile, strength, target_lufs,
               target_true_peak_dbtp, target_crest_db, high_pass_hz, bass_db,
               low_mid_db, mid_db, presence_db, air_db, stereo_width_percent,
               mono_below_hz):
        waveform=audio["waveform"]; sr=int(audio["sample_rate"])
        if waveform.dim()==2: waveform=waveform.unsqueeze(0)
        original=waveform.clone(); outs=[]; reports=[]; json_reports=[]; s=max(0.0,min(1.0,float(strength)/100.0))
        for b in range(waveform.shape[0]):
            x=waveform[b].float().clone()
            before={"lufs":integrated_lufs(x,sr),"tp":true_peak_db(x,sr),"sp":sample_peak_db(x),"rms":rms_db(x),"crest":crest_db(x),"corr":lr_correlation(x),"dc":dc_offset(x),"bands":band_energy_percentages(x,sr)}
            # Off = true transparent pass-through. Analyze and report only.
            if mode=="Off":
                y=x.clone()
                after=before
                settings={"strength":float(strength),"target_lufs":float(target_lufs),"target_true_peak_dbtp":float(target_true_peak_dbtp),"target_crest_db":float(target_crest_db),"high_pass_hz":float(high_pass_hz),"bass_db":float(bass_db),"low_mid_db":float(low_mid_db),"mid_db":float(mid_db),"presence_db":float(presence_db),"air_db":float(air_db),"stereo_width_percent":float(stereo_width_percent),"mono_below_hz":float(mono_below_hz)}
                rd={
                    "schema":"nova.audio_master.report",
                    "schema_version":10,
                    "master_version":VERSION,
                    "provenance":{
                        "report_id":str(uuid.uuid4()),
                        "created_utc":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
                        "software":"Nova Audio Master",
                        "master_version":VERSION,
                        "analysis_version":"1.0",
                        "schema_version":10,
                        "processing_mode":"Off",
                        "processing_profile":profile,
                        "run_count":int(run_count),
                        "mastering_bypassed":True
                    },
                    "mode":"Off",
                    "profile":profile,
                    "settings":settings,
                    "identity":{
                        "source_pcm_sha256":_pcm_sha256(x),
                        "master_pcm_sha256":_pcm_sha256(y),
                        "canonical_pcm_format":"channels-first float32 little-endian",
                        "sample_rate_hz":int(sr),
                        "channels":int(x.shape[0]),
                        "samples":int(x.shape[-1]),
                        "duration_seconds":float(x.shape[-1]/sr)
                    },
                    "source":{
                        "integrated_lufs":float(before["lufs"]),
                        "true_peak_dbtp":float(before["tp"]),
                        "sample_peak_dbfs":float(before["sp"]),
                        "rms_dbfs":float(before["rms"]),
                        "crest_db":float(before["crest"]),
                        "lr_correlation":float(before["corr"]),
                        "dc_offset":float(before["dc"]),
                        "bands_percent":{
                            "bass_20_250_hz":float(before["bands"]["bass"]),
                            "mid_250_2000_hz":float(before["bands"]["mid"]),
                            "presence_2000_6000_hz":float(before["bands"]["presence"]),
                            "hf_6000_plus_hz":float(before["bands"]["hf"])
                        }
                    },
                    "mastered":{
                        "integrated_lufs":float(before["lufs"]),
                        "true_peak_dbtp":float(before["tp"]),
                        "sample_peak_dbfs":float(before["sp"]),
                        "rms_dbfs":float(before["rms"]),
                        "crest_db":float(before["crest"]),
                        "lr_correlation":float(before["corr"]),
                        "dc_offset":float(before["dc"]),
                        "bands_percent":{
                            "bass_20_250_hz":float(before["bands"]["bass"]),
                            "mid_250_2000_hz":float(before["bands"]["mid"]),
                            "presence_2000_6000_hz":float(before["bands"]["presence"]),
                            "hf_6000_plus_hz":float(before["bands"]["hf"])
                        }
                    },
                    "correction":{
                        "bypassed":True,
                        "reason":"Mode Off: no mastering DSP applied."
                    },
                    "classification":{
                        "true_peak":{"status":"OBSERVATION_ONLY","score":100.0},
                        "loudness":{"status":"OBSERVATION_ONLY","score":100.0},
                        "crest":{"status":"OBSERVATION_ONLY","score":100.0},
                        "stereo":{"status":"OBSERVATION_ONLY","score":100.0},
                        "tonal_balance":{"status":"OBSERVATION_ONLY","score":100.0}
                    },
                    "release":{
                        "status":"OBSERVATION_ONLY",
                        "confidence":100.0,
                        "grade":"N/A",
                        "summary":"Mastering bypassed. Audio passed through unchanged for observation/conversion."
                    }
                }
                report=(
                    f"NOVA AUDIO MASTER v{VERSION}\n"
                    f"Observation / Pass-Through Report\n"
                    f"RUN COUNT: {int(run_count)}\n\n"
                    f"MODE: OFF | MASTERING: BYPASSED | AUDIO: PASS_THROUGH\n"
                    f"PROFILE: {profile} (reference only; not applied)\n\n"
                    f"SOURCE / OUTPUT: LUFS {before['lufs']:.2f} | TP {before['tp']:.2f} dBTP | "
                    f"RMS {before['rms']:.2f} dBFS | Crest {before['crest']:.2f} dB | "
                    f"Corr {before['corr']:.3f}\n"
                    f"BANDS: Bass {before['bands']['bass']:.2f}% | Mid {before['bands']['mid']:.2f}% | "
                    f"Presence {before['bands']['presence']:.2f}% | HF {before['bands']['hf']:.2f}%\n\n"
                    f"PROCESSING: none\n"
                    f"PCM IDENTITY: {'EXACT' if rd['identity']['source_pcm_sha256']==rd['identity']['master_pcm_sha256'] else 'DIFFERENT'}\n"
                    f"RELEASE: OBSERVATION_ONLY\n"
                    f"- No HPF, EQ, stereo, dynamics, loudness trim, limiter, or other mastering DSP was applied."
                )
                reports.append(report); json_reports.append(rd); outs.append(y)
                continue
            auto=_derive_auto_eq(before["bands"],profile,s); man=_manual_eq(bass_db,low_mid_db,mid_db,presence_db,air_db)
            eq=auto if mode=="Auto" else ({k:auto[k]+man[k] for k in auto} if mode=="Assist" else man)
            eq={"bass":max(-6,min(6,eq["bass"])),"mid":max(-4,min(4,eq["mid"])),"presence":max(-4,min(4,eq["presence"])),"hf":max(-3,min(3,eq["hf"]))}
            err0=_tonal_error(before["bands"],profile); ec=_apply_tonal_eq(x,sr,high_pass_hz,eq); eb=band_energy_percentages(ec,sr); err1=_tonal_error(eb,profile); tonal_rb=err1>err0+0.25; y=x.clone() if tonal_rb else ec
            corr0=lr_correlation(y); aw=_derive_auto_width(corr0,profile,s); mw=float(stereo_width_percent)/100.0; width=aw if mode=="Auto" else (aw*mw if mode=="Assist" else mw); width=max(0.65,min(1.45,width))
            sc=_apply_fd_width(y,sr,float(mono_below_hz),width); corr1=lr_correlation(sc); lo,hi=PROFILE_TARGETS[profile]["corr"]; d0=0 if lo<=corr0<=hi else min(abs(corr0-lo),abs(corr0-hi)); d1=0 if lo<=corr1<=hi else min(abs(corr1-lo),abs(corr1-hi)); stereo_rb=corr1<0.05 or d1>d0+0.01
            if not stereo_rb:y=sc
            dynamics_before={"lufs":integrated_lufs(y,sr),"rms":rms_db(y),"crest":crest_db(y)}
            adaptive_crest=_adaptive_safe_crest_target(
                profile,
                before["crest"],
                dynamics_before["crest"],
                float(target_crest_db),
                s,
            )
            dyn=_adaptive_dynamics_stage(
                y,
                sr,
                float(target_lufs),
                float(adaptive_crest["adaptive_target_db"]),
                float(target_true_peak_dbtp),
                s
            )
            y=dyn["audio"]
            dynamics_after={"lufs":integrated_lufs(y,sr),"rms":rms_db(y),"crest":crest_db(y)}
            crest_convergence_pct=_crest_convergence_percent(
                adaptive_crest["post_correction_crest_db"],
                adaptive_crest["adaptive_target_db"],
                dynamics_after["crest"],
            )
            crest_convergence_status=_crest_convergence_status(
                dynamics_after["crest"],
                adaptive_crest["adaptive_target_db"],
                crest_convergence_pct,
            )
            pre=integrated_lufs(y,sr); trim=max(-2.0,min(4.0,float(target_lufs)-pre)); y=y*_db_to_gain(trim) if abs(trim)>1e-8 else y; y,limiter_gr=_true_peak_limit(y,sr,float(target_true_peak_dbtp))
            after={"lufs":integrated_lufs(y,sr),"tp":true_peak_db(y,sr),"sp":sample_peak_db(y),"rms":rms_db(y),"crest":crest_db(y),"corr":lr_correlation(y),"dc":dc_offset(y),"bands":band_energy_percentages(y,sr)}
            effects={}; targets=PROFILE_TARGETS[profile]["bands"]
            for k in ("bass","mid","presence","hf"):
                req=float(eq[k]); delta=float(after["bands"][k]-before["bands"][k]); status="ROLLED_BACK" if tonal_rb else ("NOT_REQUESTED" if abs(req)<0.05 else ("EFFECTIVE" if ((req<0 and delta<=-0.20) or (req>0 and delta>=0.20)) else "INEFFECTIVE")); effects[k]={"requested_db":req,"source_percent":float(before["bands"][k]),"output_percent":float(after["bands"][k]),"measured_delta_percent":delta,"target_percent":float(targets[k]),"status":status}
            cdelta=float(after["corr"]-before["corr"]); stereo_status="ROLLED_BACK" if stereo_rb else ("NOT_REQUESTED" if abs(width-1.0)<0.01 else ("INEFFECTIVE" if abs(cdelta)<0.005 else "EFFECTIVE")); src_class=_stereo_class(before["corr"],profile); out_class=_stereo_class(after["corr"],profile)
            legacy_crest_s,legacy_crest_n,legacy_crest_score=_crest_classification(profile,after["crest"])
            legacy_loud_s,legacy_loud_n,legacy_loud_score=_loudness_classification(after["lufs"],target_lufs,after["tp"],target_true_peak_dbtp)
            peak_s,peak_n,peak_score=_peak_classification(after["tp"],target_true_peak_dbtp)
            stereo_s,stereo_n,stereo_score=_stereo_classification(after["corr"])
            legacy_tonal_s,legacy_tonal_notes,legacy_tonal_score=_tonal_classification(profile,after["bands"])
            adaptive_tonal_validation=_adaptive_tonal_validation(
                profile,
                before["bands"],
                after["bands"],
                float(err0),
                float(err1),
                bool(tonal_rb),
            )
            tonal_s=adaptive_tonal_validation["release_interpretation"]
            tonal_notes=list(adaptive_tonal_validation["legacy_notes"])
            tonal_score=float(adaptive_tonal_validation["score"])
            final_limiter_budget=_limiter_budget_class(float(limiter_gr))
            limiter_budget,limiter_score=_limiter_release_score(float(limiter_gr))
            adaptive_loudness_validation=_adaptive_loudness_validation(
                after["lufs"],target_lufs,after["tp"],target_true_peak_dbtp,
                trim,4.0,limiter_gr,final_limiter_budget)
            loud_s=adaptive_loudness_validation["status"]
            loud_n=(f"Reference {adaptive_loudness_validation['reference_status']}; "
                    f"{adaptive_loudness_validation['release_interpretation']} with "
                    f"{adaptive_loudness_validation['delta_lu']:+.2f} LU target delta.")
            loud_score=float(adaptive_loudness_validation["score"])
            adaptive_crest_validation=_adaptive_crest_validation(
                profile,
                float(adaptive_crest["reference_target_db"]),
                float(adaptive_crest["adaptive_target_db"]),
                float(after["crest"]),
                float(adaptive_crest["post_correction_crest_db"]),
                float(crest_convergence_pct),
                float(limiter_gr),
                final_limiter_budget,
            )
            crest_s=adaptive_crest_validation["release_interpretation"]
            crest_n=(
                f"Reference {adaptive_crest_validation['reference_status']}; "
                f"adaptive {adaptive_crest_validation['adaptive_status']} at "
                f"{adaptive_crest_validation['convergence_percent']:.1f}% convergence."
            )
            crest_score=float(adaptive_crest_validation["score"])
            release_s,release_n=_adaptive_release_status(
                peak_s,adaptive_loudness_validation,adaptive_crest_validation,stereo_s,adaptive_tonal_validation,
                final_limiter_budget,after["dc"]
            )
            confidence=max(0,min(100,
                peak_score*.25 +
                loud_score*.20 +
                crest_score*.20 +
                stereo_score*.15 +
                tonal_score*.15 +
                limiter_score*.05
            ))
            if peak_s=="FAIL":
                confidence=min(confidence,49.0)
            if final_limiter_budget=="HEAVY":
                confidence=min(confidence,74.0)
            if release_s=="FAIL":
                confidence=min(confidence,59.0)
            grade=_grade(confidence)
            warnings=[]
            if tonal_rb:warnings.append("Tonal correction rolled back because profile error worsened.")
            if stereo_rb:warnings.append("Stereo correction rolled back for safety/profile regression.")
            if src_class=="VERY_NARROW" and stereo_status=="INEFFECTIVE":warnings.append("Source is VERY_NARROW and M/S widening was ineffective; insufficient side information may be present.")
            if dyn["rejected_passes"]>0 and dyn["accepted_passes"]==0:warnings.append("Adaptive dynamics candidate was rolled back because final-chain-aware acceptance criteria were not met.")
            if dynamics_after["crest"]>adaptive_crest["adaptive_target_db"]+1.0:
                warnings.append("Crest remains above Nova's adaptive safe target after adaptive dynamics.")
            elif crest_convergence_status == "PARTIAL_PROGRESS":
                warnings.append("Adaptive crest convergence was only partial and did not fully reach the safe target.")
            if final_limiter_budget=="HEAVY":warnings.append("Final limiter dependence is HEAVY (>3.0 dB GR); dynamics stage should carry more crest reduction.")
            elif final_limiter_budget=="WARNING":warnings.append("Final limiter dependence exceeds preferred/acceptable budget (>2.0 dB GR).")
            if release_s=="CONDITIONAL_PASS":
                missed=[]
                if adaptive_loudness_validation["reference_status"]!="PASS": missed.append("loudness")
                if adaptive_crest_validation["reference_status"]!="PASS": missed.append("crest")
                if adaptive_tonal_validation["reference_status"]!="PASS": missed.append("tonal")
                if missed:
                    warnings.append(
                        "Reference " + " and ".join(missed) +
                        " target(s) were not fully reached; Nova preserved the safer adaptive result instead of forcing destructive correction."
                    )
            settings={"strength":float(strength),"target_lufs":float(target_lufs),"target_true_peak_dbtp":float(target_true_peak_dbtp),"target_crest_db":float(target_crest_db),"high_pass_hz":float(high_pass_hz),"bass_db":float(bass_db),"low_mid_db":float(low_mid_db),"mid_db":float(mid_db),"presence_db":float(presence_db),"air_db":float(air_db),"stereo_width_percent":float(stereo_width_percent),"mono_below_hz":float(mono_below_hz)}
            correction={"tonal":{"profile_error_before":float(err0),"profile_error_after_candidate":float(err1),"rolled_back":bool(tonal_rb),"bands":effects},"stereo":{"source_correlation":float(before["corr"]),"source_classification":src_class,"auto_width_factor":float(aw),"manual_width_factor":float(mw),"applied_width_factor":float(width),"output_correlation":float(after["corr"]),"output_classification":out_class,"correlation_delta":cdelta,"rolled_back":bool(stereo_rb),"status":stereo_status,"mono_below_hz":float(mono_below_hz)},"dynamics":{"source_lufs":float(dynamics_before["lufs"]),"source_rms_dbfs":float(dynamics_before["rms"]),"source_crest_db":float(dynamics_before["crest"]),"output_lufs":float(dynamics_after["lufs"]),"output_rms_dbfs":float(dynamics_after["rms"]),"output_crest_db":float(dynamics_after["crest"]),"crest_delta_db":float(dynamics_after["crest"]-dynamics_before["crest"]),"accepted_passes":int(dyn["accepted_passes"]),"rejected_passes":int(dyn["rejected_passes"]),"body_peak_lift_db":float(dyn["body_peak_lift_db"]),"body_avg_lift_db":float(dyn["body_avg_lift_db"]),"transient_peak_gr_db":float(dyn["transient_peak_gr_db"]),"transient_avg_gr_db":float(dyn["transient_avg_gr_db"]),"makeup_db":float(dyn["makeup_db"]),"cumulative_dynamics_makeup_db":float(dyn["makeup_db"]),"final_chain_trim_db":float(trim),"limiter_gr_db":float(dyn["limiter_gr_db"]),"cumulative_candidate_limiter_gr_db":float(dyn["limiter_gr_db"]),"final_chain_limiter_gr_db":float(limiter_gr),"history":dyn["history"],"last_rejected_candidate":dyn["last_rejected_candidate"],"final_chain_preview":dyn["final_chain_preview"],"crest_targeting":{"reference_target_db":float(adaptive_crest["reference_target_db"]),"source_crest_db":float(adaptive_crest["source_crest_db"]),"post_correction_crest_db":float(adaptive_crest["post_correction_crest_db"]),"correction_crest_increase_db":float(adaptive_crest["correction_crest_increase_db"]),"adaptive_target_db":float(adaptive_crest["adaptive_target_db"]),"profile_floor_db":float(adaptive_crest["profile_floor_db"]),"convergence_fraction":float(adaptive_crest["convergence_fraction"]),"achieved_crest_db":float(dynamics_after["crest"]),"crest_reduction_db":float(adaptive_crest["post_correction_crest_db"]-dynamics_after["crest"]),"convergence_percent":float(crest_convergence_pct),"convergence_status":crest_convergence_status},"status":("EFFECTIVE" if dyn["accepted_passes"]>0 else ("ROLLED_BACK" if dyn["rejected_passes"]>0 else "NOT_NEEDED"))},"loudness":{"trim_db":float(trim),"true_peak_limiter_gr_db":float(limiter_gr),"limiter_budget":final_limiter_budget}}
            rd={"schema":"nova.audio_master.report","schema_version":10,"master_version":VERSION,"provenance":{"report_id":str(uuid.uuid4()),"created_utc":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),"software":"Nova Audio Master","master_version":VERSION,"analysis_version":"1.0","schema_version":10,"processing_mode":mode,"processing_profile":profile,"run_count":int(run_count)},"mode":mode,"profile":profile,"settings":settings,"identity":{"source_pcm_sha256":_pcm_sha256(x),"master_pcm_sha256":_pcm_sha256(y),"canonical_pcm_format":"channels-first float32 little-endian","sample_rate_hz":int(sr),"channels":int(x.shape[0]),"samples":int(x.shape[-1]),"duration_seconds":float(x.shape[-1]/sr)},"source":{"integrated_lufs":float(before["lufs"]),"true_peak_dbtp":float(before["tp"]),"sample_peak_dbfs":float(before["sp"]),"rms_dbfs":float(before["rms"]),"crest_db":float(before["crest"]),"lr_correlation":float(before["corr"]),"dc_offset":float(before["dc"]),"bands_percent":{k:float(before["bands"][n]) for k,n in [("bass_20_250_hz","bass"),("mid_250_2000_hz","mid"),("presence_2000_6000_hz","presence"),("hf_6000_plus_hz","hf")]}},"mastered":{"integrated_lufs":float(after["lufs"]),"true_peak_dbtp":float(after["tp"]),"sample_peak_dbfs":float(after["sp"]),"rms_dbfs":float(after["rms"]),"crest_db":float(after["crest"]),"lr_correlation":float(after["corr"]),"dc_offset":float(after["dc"]),"bands_percent":{k:float(after["bands"][n]) for k,n in [("bass_20_250_hz","bass"),("mid_250_2000_hz","mid"),("presence_2000_6000_hz","presence"),("hf_6000_plus_hz","hf")]}},"correction":correction,"classification":{"true_peak":{"status":peak_s,"note":peak_n,"score":float(peak_score)},"loudness":{"status":loud_s,"note":loud_n,"score":float(loud_score),"reference":{"target_lufs":float(target_lufs),"achieved_lufs":float(after["lufs"]),"status":adaptive_loudness_validation["reference_status"],"delta_lu":float(adaptive_loudness_validation["delta_lu"])},"adaptive":{"status":adaptive_loudness_validation["status"],"interpretation":adaptive_loudness_validation["release_interpretation"],"safe":bool(adaptive_loudness_validation["safe"]),"gain_budget_used":bool(adaptive_loudness_validation["gain_budget_used"]),"max_trim_db":float(adaptive_loudness_validation["max_trim_db"]),"final_chain_trim_db":float(trim),"limiter_gr_db":float(limiter_gr),"limiter_budget":final_limiter_budget},"legacy_profile_classification":{"status":legacy_loud_s,"note":legacy_loud_n,"score":float(legacy_loud_score)}},"crest":{"status":crest_s,"note":crest_n,"score":float(crest_score),"reference":{"target_db":float(adaptive_crest["reference_target_db"]),"achieved_db":float(after["crest"]),"status":adaptive_crest_validation["reference_status"],"delta_db":float(adaptive_crest_validation["reference_delta_db"])},"adaptive":{"target_db":float(adaptive_crest["adaptive_target_db"]),"achieved_db":float(after["crest"]),"status":adaptive_crest_validation["adaptive_status"],"delta_db":float(adaptive_crest_validation["adaptive_delta_db"]),"convergence_percent":float(adaptive_crest_validation["convergence_percent"]),"crest_reduction_db":float(adaptive_crest_validation["crest_reduction_db"]),"safe":bool(adaptive_crest_validation["safe"])},"legacy_profile_classification":{"status":legacy_crest_s,"note":legacy_crest_n,"score":float(legacy_crest_score)}},"stereo":{"status":stereo_s,"note":stereo_n,"score":float(stereo_score),"source_image":src_class,"output_image":out_class},"tonal_balance":{"status":tonal_s,"notes":list(tonal_notes),"score":float(tonal_score),"reference":{"status":adaptive_tonal_validation["reference_status"],"profile":profile,"legacy_score":float(legacy_tonal_score)},"adaptive":{"status":adaptive_tonal_validation["correction_status"],"interpretation":adaptive_tonal_validation["release_interpretation"],"profile_error_before":float(adaptive_tonal_validation["profile_error_before"]),"profile_error_after":float(adaptive_tonal_validation["profile_error_after"]),"profile_error_improvement":float(adaptive_tonal_validation["profile_error_improvement"]),"profile_error_reduction_percent":float(adaptive_tonal_validation["profile_error_reduction_percent"]),"safe":bool(adaptive_tonal_validation["safe"])},"legacy_profile_classification":{"status":legacy_tonal_s,"notes":list(legacy_tonal_notes),"score":float(legacy_tonal_score)}},"limiter_dependency":{"status":limiter_budget,"gr_db":float(limiter_gr),"score":float(limiter_score)}},"validation":{"strategy":"ADAPTIVE_RELEASE_VALIDATION","strategy_version":3,"reference_compliance":{"loudness_status":adaptive_loudness_validation["reference_status"],"loudness_target_lufs":float(target_lufs),"loudness_achieved_lufs":float(after["lufs"]),"crest_status":adaptive_crest_validation["reference_status"],"reference_target_db":float(adaptive_crest["reference_target_db"]),"achieved_crest_db":float(after["crest"]),"tonal_status":adaptive_tonal_validation["reference_status"],"tonal_profile":profile},"adaptive_achievement":{"loudness":{"status":adaptive_loudness_validation["status"],"interpretation":adaptive_loudness_validation["release_interpretation"],"score":float(loud_score),"delta_lu":float(adaptive_loudness_validation["delta_lu"]),"gain_budget_used":bool(adaptive_loudness_validation["gain_budget_used"]),"limiter_budget":final_limiter_budget,"safe":bool(adaptive_loudness_validation["safe"])},"crest":{"status":adaptive_crest_validation["adaptive_status"],"score":float(crest_score),"adaptive_target_db":float(adaptive_crest["adaptive_target_db"]),"convergence_percent":float(crest_convergence_pct),"safe":bool(adaptive_crest_validation["safe"])},"tonal":{"status":adaptive_tonal_validation["correction_status"],"interpretation":adaptive_tonal_validation["release_interpretation"],"score":float(tonal_score),"profile_error_before":float(err0),"profile_error_after":float(err1),"profile_error_reduction_percent":float(adaptive_tonal_validation["profile_error_reduction_percent"]),"safe":bool(adaptive_tonal_validation["safe"])}},"release_safety":{"true_peak_status":peak_s,"stereo_status":stereo_s,"dc_offset":float(after["dc"])},"limiter_dependency":{"budget":final_limiter_budget,"gr_db":float(limiter_gr),"score":float(limiter_score)}},"release":{"status":release_s,"confidence":float(confidence),"grade":grade,"summary":release_n,"correction_warnings":warnings},"reproduction_fingerprint":_reproduction_fingerprint(after),"validation_reference":{"reference_role":"MASTER_OUTPUT","metrics":{"integrated_lufs":float(after["lufs"]),"true_peak_dbtp":float(after["tp"]),"sample_peak_dbfs":float(after["sp"]),"rms_dbfs":float(after["rms"]),"crest_db":float(after["crest"]),"lr_correlation":float(after["corr"]),"bands_percent":{"bass":float(after["bands"]["bass"]),"mid":float(after["bands"]["mid"]),"presence":float(after["bands"]["presence"]),"hf":float(after["bands"]["hf"])}},"tolerances":{"integrated_lufs":0.10,"true_peak_dbtp":0.10,"rms_dbfs":0.10,"crest_db":0.15,"lr_correlation":0.01,"band_energy_percent":0.50},"crest_reference_target_db":float(adaptive_crest["reference_target_db"]),"crest_adaptive_target_db":float(adaptive_crest["adaptive_target_db"]),"crest_achieved_db":float(dynamics_after["crest"]),"crest_convergence_percent":float(crest_convergence_pct),"crest_convergence_status":crest_convergence_status,"loudness_reference_status":adaptive_loudness_validation["reference_status"],"loudness_adaptive_status":adaptive_loudness_validation["status"],"loudness_target_lufs":float(target_lufs),"loudness_achieved_lufs":float(after["lufs"]),"loudness_delta_lu":float(adaptive_loudness_validation["delta_lu"]),"loudness_gain_budget_used":bool(adaptive_loudness_validation["gain_budget_used"]),"tonal_reference_status":adaptive_tonal_validation["reference_status"],"tonal_correction_status":adaptive_tonal_validation["correction_status"],"tonal_profile_error_before":float(err0),"tonal_profile_error_after":float(err1),"tonal_profile_error_reduction_percent":float(adaptive_tonal_validation["profile_error_reduction_percent"]),"comparison_note":"Current Nova Player top/bar LUFS is static during playback; compare against final archived/bench analysis when Player validator support is added."}}
            rd["identity"]["settings_sha256"]=_canonical_json_sha256(settings); rd["identity"]["reproduction_fingerprint_sha256"]=_canonical_json_sha256(rd["reproduction_fingerprint"]); rd["identity"]["report_payload_sha256"]=_canonical_json_sha256(rd)
            report=(f"NOVA AUDIO MASTER v{VERSION}\nCorrective Mastering / Validation Report\n"
                    f"RUN COUNT: {int(run_count)}\n\n"
                    f"SOURCE: LUFS {before['lufs']:.2f} | TP {before['tp']:.2f} dBTP | RMS {before['rms']:.2f} | Crest {before['crest']:.2f} | Corr {before['corr']:.3f} [{src_class}]\n"
                    f"SOURCE BANDS: Bass {before['bands']['bass']:.2f}% | Mid {before['bands']['mid']:.2f}% | Presence {before['bands']['presence']:.2f}% | HF {before['bands']['hf']:.2f}%\n\n"
                    f"TONAL: Bass {eq['bass']:+.2f}dB {effects['bass']['status']} | Mid {eq['mid']:+.2f}dB {effects['mid']['status']} | Presence {eq['presence']:+.2f}dB {effects['presence']['status']} | HF {eq['hf']:+.2f}dB {effects['hf']['status']} | Error {err0:.2f}->{err1:.2f} | Rollback {'YES' if tonal_rb else 'NO'}\n"
                    f"TONAL VALIDATION: Reference [{adaptive_tonal_validation['reference_status']}] | Correction [{adaptive_tonal_validation['correction_status']}] | Error Reduction {adaptive_tonal_validation['profile_error_reduction_percent']:.1f}% | Interpretation [{adaptive_tonal_validation['release_interpretation']}] | Adaptive Score {tonal_score:.1f}/100\n"
                    f"STEREO: {before['corr']:.3f} [{src_class}] -> {after['corr']:.3f} [{out_class}] | Auto {aw:.3f}x | Manual {mw:.3f}x | Applied {width:.3f}x | {stereo_status} | Rollback {'YES' if stereo_rb else 'NO'}\n"
                    f"DYNAMICS: Crest {dynamics_before['crest']:.2f}->{dynamics_after['crest']:.2f} dB | RMS {dynamics_before['rms']:.2f}->{dynamics_after['rms']:.2f} dBFS | Accepted {dyn['accepted_passes']} | Rejected {dyn['rejected_passes']} | Transient GR pk/avg {dyn['transient_peak_gr_db']:.2f}/{dyn['transient_avg_gr_db']:.2f} dB | Body Lift pk/avg {dyn['body_peak_lift_db']:.2f}/{dyn['body_avg_lift_db']:.2f} dB | Cumulative Pass Compensation {dyn['makeup_db']:+.2f} dB | {'EFFECTIVE' if dyn['accepted_passes']>0 else ('ROLLED_BACK' if dyn['rejected_passes']>0 else 'NOT_NEEDED')}\n"
                    f"DYNAMICS DIAGNOSTICS: Last rejected candidate preserved in report_json={'YES' if dyn['last_rejected_candidate'] else 'NO'}\n"
                    f"FINAL-CHAIN PREVIEW: LUFS {dyn['final_chain_preview']['lufs']:.2f} | Crest {dyn['final_chain_preview']['crest']:.2f} dB | Limiter {dyn['final_chain_preview']['limiter_gr_db']:.2f} dB [{dyn['final_chain_preview']['limiter_budget']}]\n"
                    f"CREST CONVERGENCE: Reference {adaptive_crest['reference_target_db']:.2f} dB | Adaptive Safe Target {adaptive_crest['adaptive_target_db']:.2f} dB | Post-Correction {adaptive_crest['post_correction_crest_db']:.2f} dB | Achieved {dynamics_after['crest']:.2f} dB | Reduction {adaptive_crest['post_correction_crest_db']-dynamics_after['crest']:.2f} dB | Convergence {crest_convergence_pct:.1f}% [{crest_convergence_status}]\n"
                    f"CREST VALIDATION: Reference [{adaptive_crest_validation['reference_status']}] | Adaptive [{adaptive_crest_validation['adaptive_status']}] | Interpretation [{adaptive_crest_validation['release_interpretation']}] | Adaptive Score {crest_score:.1f}/100\n"
                    f"LIMITER VALIDATION: {limiter_gr:.2f} dB GR [{final_limiter_budget}] | Score {limiter_score:.1f}/100\n"
                    f"BEST REJECTED: {('Crest '+format(dyn['last_rejected_candidate']['selected']['crest'],'.2f')+' dB | LUFS '+format(dyn['last_rejected_candidate']['selected']['lufs'],'.2f')+' | Transient GR '+format(dyn['last_rejected_candidate']['selected']['transient_peak_gr_db'],'.2f')+' dB | Body Lift '+format(dyn['last_rejected_candidate']['selected']['body_peak_lift_db'],'.2f')+' dB | Limiter '+format(dyn['last_rejected_candidate']['selected']['limiter_gr_db'],'.2f')+' dB ['+dyn['last_rejected_candidate']['selected']['limiter_budget']+']') if dyn['last_rejected_candidate'] else 'none'}\n"
                    f"LOUDNESS VALIDATION: Reference {target_lufs:.2f} LUFS [{adaptive_loudness_validation['reference_status']}] | Achieved {after['lufs']:.2f} LUFS | Delta {adaptive_loudness_validation['delta_lu']:+.2f} LU | Gain Budget {trim:+.2f}/{adaptive_loudness_validation['max_trim_db']:+.2f} dB | Interpretation [{adaptive_loudness_validation['release_interpretation']}] | Adaptive Score {loud_score:.1f}/100\n"
                    f"LOUDNESS: Final Chain Trim {trim:+.2f}dB | Limiter GR {limiter_gr:.2f}dB [{final_limiter_budget}] | Final {after['lufs']:.2f} LUFS / {after['tp']:.2f} dBTP\n"
                    f"MASTERED BANDS: Bass {after['bands']['bass']:.2f}% | Mid {after['bands']['mid']:.2f}% | Presence {after['bands']['presence']:.2f}% | HF {after['bands']['hf']:.2f}%\n"
                    f"RELEASE: {release_s} | Confidence {confidence:.1f}/100 | Grade {grade}\n" + ("\n".join('- '+w for w in warnings) if warnings else "- Corrective stages completed without correction warnings."))
            reports.append(report); json_reports.append(rd); outs.append(y)
        mastered={"waveform":torch.stack(outs,0).to(waveform.dtype),"sample_rate":sr}; original_audio={"waveform":original,"sample_rate":sr}; payload=json_reports[0] if len(json_reports)==1 else {"schema":"nova.audio_master.batch_report","schema_version":10,"master_version":VERSION,"reports":json_reports}
        return mastered, original_audio, "\n\n".join(reports), json.dumps(payload,indent=2,ensure_ascii=False,allow_nan=False)

NODE_CLASS_MAPPINGS = {"NovaAudioMaster": NovaAudioMaster}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaAudioMaster": "Nova Audio Master 🧾"}
