import hashlib
import json
import os
import re
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import torch
import folder_paths

from ..nova_categories import ANALYSIS

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

VERSION = "0.3.0-fix8"
SCHEMA_VERSION = 1

DEFAULT_TOLERANCES = {
    "integrated_lufs": 0.10,
    "true_peak_dbtp": 0.10,
    "sample_peak_dbfs": 0.10,
    "rms_dbfs": 0.10,
    "crest_db": 0.15,
    "lr_correlation": 0.01,
    "band_energy_percent": 0.50,
}

BAND_MAP = {
    "bass": "bass_20_250_hz",
    "mid": "mid_250_2000_hz",
    "presence": "presence_2000_6000_hz",
    "hf": "hf_6000_plus_hz",
}


def _pcm_sha256(x: torch.Tensor) -> str:
    y = x.detach().to("cpu", dtype=torch.float32).contiguous()
    return hashlib.sha256(y.numpy().astype("<f4", copy=False).tobytes(order="C")).hexdigest()


def _canonical_json_sha256(value: Dict[str, Any]) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()



def _safe_filename(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    return value.strip("._") or "NovaMasterReference"


def _reference_format_suffix(reference_format: str) -> str:
    mapping = {
        "PCM_16": "PCM16",
        "PCM_24": "PCM24",
        "FLOAT_32": "FLOAT32",
    }
    return mapping.get(str(reference_format or "PCM_16"), "PCM16")


def _reference_report_filename(
    report: Dict[str, Any],
    filename_value: str = "",
    reference_format: str = "PCM_16",
) -> str:
    # Explicit filename input has highest priority. It may be fed directly
    # from Nova Master Identity's archival filename output.
    suffix = _reference_format_suffix(reference_format)

    explicit_name = str(filename_value or "").strip()
    if explicit_name:
        stem = Path(explicit_name).stem
        return _safe_filename(stem) + f"_{suffix}.json"

    identity = report.get("identity", {}) if isinstance(report, dict) else {}
    provenance = report.get("provenance", {}) if isinstance(report, dict) else {}
    archive_name = identity.get("archive_name")
    if archive_name:
        return _safe_filename(Path(str(archive_name)).stem) + f"_{suffix}.json"
    report_id = provenance.get("report_id")
    if report_id:
        return "NovaMasterReference_" + _safe_filename(report_id) + f"_{suffix}.json"
    return f"NovaMasterReference_{suffix}.json"


def _save_reference_report(report: Dict[str, Any], path_value: str, filename_value: str = "", reference_format: str = "PCM_16") -> str:
    path_text = str(path_value or "").strip()
    output_root = Path(folder_paths.get_output_directory()).resolve()

    if not path_text:
        target_dir = output_root
    else:
        expanded = Path(os.path.expandvars(os.path.expanduser(path_text)))

        if expanded.is_absolute():
            target_dir = expanded.resolve()
        else:
            # Paths entered in the node are relative to ComfyUI's output folder.
            # Accept an old-style "output/..." value too, without creating
            # ".../output/output/...".
            parts = expanded.parts
            if parts and parts[0].lower() == "output":
                expanded = Path(*parts[1:]) if len(parts) > 1 else Path()

            target_dir = (output_root / expanded).resolve()

    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / _reference_report_filename(report, filename_value, reference_format)
    target.write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8"
    )
    if not target.exists() or target.stat().st_size <= 0:
        raise RuntimeError(f"Reference report was not written successfully: {target}")
    return str(target)



def _strip_soundhub_archive_suffix(filename: str) -> str:
    """
    Convert SoundHub output:
      02_GC_Redline-Masters_Master_24-48_20260907-170906_00001.wav
    to reference stem:
      02_GC_Redline-Masters_Master_24-48
    """
    stem = Path(str(filename or "")).stem
    return re.sub(r"_\d{8}-\d{6}_\d{5}$", "", stem)


def _find_upstream_load_audio_filename(prompt: Any, unique_id: Any) -> str:
    """
    Follow candidate_audio upstream through the execution prompt until the
    selected Load Audio filename is found. This removes the need for a
    separate JSON/file-open node in a standalone validation workflow.
    """
    if not isinstance(prompt, dict):
        return ""

    node_id = str(unique_id)
    visited = set()

    def walk(nid: str) -> str:
        if nid in visited:
            return ""
        visited.add(nid)

        node = prompt.get(str(nid))
        if not isinstance(node, dict):
            return ""

        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            return ""

        for key in ("audio", "filename", "file", "audio_file"):
            value = inputs.get(key)
            if isinstance(value, str) and value.lower().endswith(
                (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac")
            ):
                return value

        for key in ("candidate_audio", "audio"):
            value = inputs.get(key)
            if (
                isinstance(value, (list, tuple))
                and len(value) >= 1
                and isinstance(value[0], (str, int))
            ):
                found = walk(str(value[0]))
                if found:
                    return found

        # Fallback through any linked adapter/pass-through node.
        for value in inputs.values():
            if (
                isinstance(value, (list, tuple))
                and len(value) >= 1
                and isinstance(value[0], (str, int))
            ):
                found = walk(str(value[0]))
                if found:
                    return found

        return ""

    return walk(node_id)


def _load_matching_reference_report(path_value: str, candidate_filename: str, reference_format: str = "PCM_16"):
    """
    Load the report matching the selected candidate WAV from the Validator's
    configured report folder.
    """
    if not candidate_filename:
        raise ValueError(
            "Could not determine the selected candidate WAV filename from the workflow."
        )

    path_text = str(path_value or "").strip()
    output_root = Path(folder_paths.get_output_directory()).resolve()

    if not path_text:
        report_dir = output_root / "NovaAudioMasters" / "Reports"
    else:
        expanded = Path(os.path.expandvars(os.path.expanduser(path_text)))
        if expanded.is_absolute():
            report_dir = expanded.resolve()
        else:
            parts = expanded.parts
            if parts and parts[0].lower() == "output":
                expanded = Path(*parts[1:]) if len(parts) > 1 else Path()
            report_dir = (output_root / expanded).resolve()

    report_stem = _strip_soundhub_archive_suffix(candidate_filename)
    suffix = _reference_format_suffix(reference_format)

    report_path = report_dir / f"{_safe_filename(report_stem)}_{suffix}.json"

    # Backward compatibility for reports created before format-specific naming.
    legacy_report_path = report_dir / f"{_safe_filename(report_stem)}.json"

    if not report_path.is_file():
        if legacy_report_path.is_file():
            report_path = legacy_report_path
        else:
            raise FileNotFoundError(
                "Matching Nova mastering report was not found.\n"
                f"Candidate WAV: {candidate_filename}\n"
                f"Selected format: {reference_format}\n"
                f"Expected report: {report_path}\n"
                f"Legacy fallback: {legacy_report_path}"
            )

    return report_path.read_text(encoding="utf-8"), str(report_path)


def _parse_report(report_json: str) -> Dict[str, Any]:
    try:
        obj = json.loads(report_json)
    except Exception as e:
        raise ValueError(f"reference_report_json is not valid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise ValueError("reference_report_json must contain a JSON object")
    if obj.get("schema") == "nova.audio_master.batch_report":
        reports = obj.get("reports") or []
        if len(reports) != 1:
            raise ValueError("Batch reports must contain exactly one report for v0.3.0 validation.")
        obj = reports[0]
    if obj.get("schema") != "nova.audio_master.report":
        raise ValueError("Expected schema 'nova.audio_master.report'.")
    if not isinstance(obj.get("mastered"), dict):
        raise ValueError("Reference report does not contain mastered metrics.")
    return obj


def _reference_metrics(report: Dict[str, Any]) -> Dict[str, Any]:
    vr = report.get("validation_reference", {})
    metrics = vr.get("metrics") if isinstance(vr, dict) else None
    if isinstance(metrics, dict):
        bands = metrics.get("bands_percent", {})
        return {
            "integrated_lufs": float(metrics["integrated_lufs"]),
            "true_peak_dbtp": float(metrics["true_peak_dbtp"]),
            "sample_peak_dbfs": float(metrics.get("sample_peak_dbfs", report["mastered"].get("sample_peak_dbfs", 0.0))),
            "rms_dbfs": float(metrics["rms_dbfs"]),
            "crest_db": float(metrics["crest_db"]),
            "lr_correlation": float(metrics["lr_correlation"]),
            "dc_offset": float(metrics.get("dc_offset", report["mastered"].get("dc_offset", 0.0))),
            "bands_percent": {
                "bass": float(bands["bass"]),
                "mid": float(bands["mid"]),
                "presence": float(bands["presence"]),
                "hf": float(bands["hf"]),
            },
        }
    m = report["mastered"]
    b = m["bands_percent"]
    return {
        "integrated_lufs": float(m["integrated_lufs"]),
        "true_peak_dbtp": float(m["true_peak_dbtp"]),
        "sample_peak_dbfs": float(m["sample_peak_dbfs"]),
        "rms_dbfs": float(m["rms_dbfs"]),
        "crest_db": float(m["crest_db"]),
        "lr_correlation": float(m["lr_correlation"]),
        "dc_offset": float(m.get("dc_offset", 0.0)),
        "bands_percent": {k: float(b[v]) for k, v in BAND_MAP.items()},
    }


def _tolerances(report: Dict[str, Any], multiplier: float) -> Dict[str, float]:
    src = {}
    vr = report.get("validation_reference", {})
    if isinstance(vr, dict):
        src = vr.get("tolerances", {}) or {}
    if not src:
        fp = report.get("reproduction_fingerprint", {})
        src = fp.get("tolerances", {}) if isinstance(fp, dict) else {}
    out = dict(DEFAULT_TOLERANCES)
    for k in out:
        if k in src:
            out[k] = float(src[k])
    return {k: float(v) * float(multiplier) for k, v in out.items()}


def _measure(x: torch.Tensor, sr: int) -> Dict[str, Any]:
    bands = band_energy_percentages(x, sr)
    return {
        "integrated_lufs": float(integrated_lufs(x, sr)),
        "true_peak_dbtp": float(true_peak_db(x, sr, oversample=4)),
        "sample_peak_dbfs": float(sample_peak_db(x)),
        "rms_dbfs": float(rms_db(x)),
        "crest_db": float(crest_db(x)),
        "lr_correlation": float(lr_correlation(x)),
        "dc_offset": float(dc_offset(x)),
        "bands_percent": {k: float(bands[k]) for k in ("bass", "mid", "presence", "hf")},
    }


def _metric_status(delta: float, tolerance: float) -> str:
    a = abs(float(delta))
    t = max(float(tolerance), 1e-12)
    if a <= t * 0.10:
        return "MATCH"
    if a <= t:
        return "WITHIN_TOLERANCE"
    if a <= t * 3.0:
        return "DRIFT"
    return "FAIL"


def _compare(ref: Dict[str, Any], cand: Dict[str, Any], tol: Dict[str, float]) -> Tuple[Dict[str, Any], float]:
    result = {}
    weighted = []
    specs = [
        ("integrated_lufs", tol["integrated_lufs"], 1.5),
        ("true_peak_dbtp", tol["true_peak_dbtp"], 1.5),
        ("sample_peak_dbfs", tol["sample_peak_dbfs"], 0.5),
        ("rms_dbfs", tol["rms_dbfs"], 1.0),
        ("crest_db", tol["crest_db"], 1.0),
        ("lr_correlation", tol["lr_correlation"], 1.0),
    ]
    status_score = {"MATCH": 1.0, "WITHIN_TOLERANCE": 0.92, "DRIFT": 0.55, "FAIL": 0.0}
    for name, t, w in specs:
        d = float(cand[name]) - float(ref[name])
        st = _metric_status(d, t)
        result[name] = {"reference": float(ref[name]), "candidate": float(cand[name]), "delta": d, "tolerance": t, "status": st}
        weighted.append((status_score[st], w))
    bands = {}
    for k in ("bass", "mid", "presence", "hf"):
        d = cand["bands_percent"][k] - ref["bands_percent"][k]
        st = _metric_status(d, tol["band_energy_percent"])
        bands[k] = {"reference": ref["bands_percent"][k], "candidate": cand["bands_percent"][k],
                    "delta": d, "tolerance": tol["band_energy_percent"], "status": st}
        weighted.append((status_score[st], 0.625))
    result["bands_percent"] = bands
    confidence = 100.0 * sum(v*w for v,w in weighted) / sum(w for _,w in weighted)
    return result, float(confidence)


def _format_validation(report: Dict[str, Any], x: torch.Tensor, sr: int) -> Dict[str, Any]:
    ident = report.get("identity", {})
    ref_sr = int(ident.get("sample_rate_hz", sr))
    ref_ch = int(ident.get("channels", x.shape[0]))
    ref_samples = int(ident.get("samples", x.shape[-1]))
    cand_ch, cand_samples = int(x.shape[0]), int(x.shape[-1])
    duration_delta = (cand_samples / sr) - float(ident.get("duration_seconds", ref_samples / ref_sr))
    return {
        "sample_rate_hz": {"reference": ref_sr, "candidate": sr, "status": "MATCH" if sr == ref_sr else "DIFFERENT"},
        "channels": {"reference": ref_ch, "candidate": cand_ch, "status": "MATCH" if cand_ch == ref_ch else "DIFFERENT"},
        "samples": {"reference": ref_samples, "candidate": cand_samples, "delta": cand_samples-ref_samples,
                    "status": "MATCH" if cand_samples == ref_samples else "DIFFERENT"},
        "duration_seconds_delta": float(duration_delta),
    }


def _drift_attribution(comparison: Dict[str, Any], fmt: Dict[str, Any]) -> List[str]:
    notes = []
    if fmt["sample_rate_hz"]["status"] == "DIFFERENT":
        notes.append("Sample-rate conversion or a different render format is present.")
    if fmt["channels"]["status"] == "DIFFERENT":
        notes.append("Channel-layout change detected.")
    if fmt["samples"]["status"] == "DIFFERENT":
        notes.append("Sample-count difference indicates trimming, padding, resampling, or a derivative encode.")
    l = comparison["integrated_lufs"]
    r = comparison["rms_dbfs"]
    tp = comparison["true_peak_dbtp"]
    c = comparison["lr_correlation"]
    hf = comparison["bands_percent"]["hf"]
    if abs(l["delta"]) > l["tolerance"] and abs(r["delta"]) > r["tolerance"] and (l["delta"] * r["delta"]) > 0:
        notes.append("Broad loudness/RMS movement is consistent with a gain or level-processing change.")
    if c["status"] in {"DRIFT", "FAIL"}:
        notes.append("Stereo correlation drift indicates stereo-image alteration.")
    if hf["status"] in {"DRIFT", "FAIL"} and l["status"] in {"MATCH", "WITHIN_TOLERANCE"}:
        notes.append("High-frequency drift with stable loudness may be consistent with codec/transcode or filtering effects.")
    if tp["status"] in {"DRIFT", "FAIL"} and l["status"] in {"MATCH", "WITHIN_TOLERANCE"}:
        notes.append("Peak behavior changed more than integrated loudness; limiting, encoding, or reconstruction may be involved.")
    return notes


class NovaFinalMasterValidator:
    CATEGORY = ANALYSIS
    FUNCTION = "validate"
    RETURN_TYPES = ("AUDIO", "SAMPLE_RATE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("candidate_audio", "sample_rate", "validation_report", "validation_json", "verdict")
    DESCRIPTION = "Nova Final Master Validator v0.3.0: bit-exact and measurement-based reproduction/integrity validation."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "candidate_audio": ("AUDIO",),
                "reference_report_json": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Optional. Leave empty to auto-load the matching report JSON from Path using the selected WAV filename."
                }),
            },
            "optional": {
                "tolerance_multiplier": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 5.0, "step": 0.1}),
                "reference_format": (["PCM_16", "PCM_24", "FLOAT_32"], {
                    "default": "PCM_16",
                    "tooltip": "Format identity used when naming/saving/fetching the matching mastering report."
                }),
                "save_reference_json": ("BOOLEAN", {"default": False}),
                "path": ("STRING", {
                    "default": "NovaAudioMasters/Reports",
                    "multiline": False,
                    "tooltip": "Folder relative to ComfyUI/output. Leave blank to save directly in output."
                }),
                "filename": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Archival filename used when saving a reference JSON during the mastering workflow."
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def validate(self, candidate_audio, reference_report_json, tolerance_multiplier=1.0, reference_format="PCM_16", save_reference_json=False, path="", filename="", prompt=None, unique_id=None):
        supplied_reference_json = str(reference_report_json or "").strip()
        auto_loaded_reference_path = ""
        candidate_source_filename = ""

        if not supplied_reference_json:
            candidate_source_filename = _find_upstream_load_audio_filename(prompt, unique_id)
            supplied_reference_json, auto_loaded_reference_path = _load_matching_reference_report(
                path,
                candidate_source_filename,
                reference_format,
            )
            print(
                "[NovaFinalMasterValidator] Auto-loaded matching reference JSON: "
                f"{auto_loaded_reference_path}"
            )

        report = _parse_report(supplied_reference_json)

        saved_reference_path = ""
        if bool(save_reference_json):
            save_filename = filename or candidate_source_filename
            saved_reference_path = _save_reference_report(report, path, save_filename, reference_format)
            print(f"[NovaFinalMasterValidator] Saved reference JSON: {saved_reference_path}")

        waveform = candidate_audio["waveform"]
        sr = int(candidate_audio["sample_rate"])
        if waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        if waveform.shape[0] != 1:
            raise ValueError("Nova Final Master Validator v0.3.0 accepts one candidate track per node.")
        x = waveform[0].float().contiguous()

        ref = _reference_metrics(report)
        cand = _measure(x, sr)
        tol = _tolerances(report, tolerance_multiplier)
        comparison, confidence = _compare(ref, cand, tol)
        fmt = _format_validation(report, x, sr)

        candidate_hash = _pcm_sha256(x)
        reference_hash = str(report.get("identity", {}).get("master_pcm_sha256", ""))
        exact = bool(reference_hash) and candidate_hash == reference_hash

        all_metric_statuses = [comparison[k]["status"] for k in (
            "integrated_lufs","true_peak_dbtp","sample_peak_dbfs","rms_dbfs","crest_db","lr_correlation"
        )]
        all_metric_statuses += [v["status"] for v in comparison["bands_percent"].values()]
        any_fail = "FAIL" in all_metric_statuses
        any_drift = "DRIFT" in all_metric_statuses
        format_exact = all(fmt[k]["status"] == "MATCH" for k in ("sample_rate_hz","channels","samples"))

        if exact:
            verdict = "BIT_EXACT"
            confidence = 100.0
        elif not any_fail and not any_drift and format_exact:
            verdict = "REPRODUCTION_MATCH"
        elif not any_fail and not any_drift:
            verdict = "ACCEPTABLE_DERIVATIVE"
            confidence = min(confidence, 96.0)
        elif any_fail:
            verdict = "VALIDATION_FAIL"
            confidence = min(confidence, 69.0)
        else:
            verdict = "DRIFT_DETECTED"
            confidence = min(confidence, 84.0)

        drift = _drift_attribution(comparison, fmt)
        reference_report_id = report.get("provenance", {}).get("report_id", "")
        reference_fp = report.get("identity", {}).get("reproduction_fingerprint_sha256", "")
        created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        payload = {
            "schema": "nova.final_master.validation",
            "schema_version": SCHEMA_VERSION,
            "validator_version": VERSION,
            "validation_id": str(uuid.uuid4()),
            "created_utc": created,
            "reference_archive": {
                "auto_loaded": bool(auto_loaded_reference_path),
                "auto_loaded_path": auto_loaded_reference_path,
                "candidate_source_filename": candidate_source_filename,
                "save_enabled": bool(save_reference_json),
                "saved_path": saved_reference_path,
                "reference_format": reference_format,
                "format_suffix": _reference_format_suffix(reference_format),
                "filename": _reference_report_filename(
                    report,
                    filename or candidate_source_filename,
                    reference_format
                ) if bool(save_reference_json) else "",
                "source_filename_input": str(filename or ""),
            },
            "reference": {
                "report_id": reference_report_id,
                "master_version": report.get("master_version", ""),
                "report_schema_version": report.get("schema_version"),
                "master_pcm_sha256": reference_hash,
                "reproduction_fingerprint_sha256": reference_fp,
                "release_status": report.get("release", {}).get("status", ""),
                "release_confidence": report.get("release", {}).get("confidence"),
                "metrics": ref,
                "tolerances": tol,
            },
            "candidate": {
                "pcm_sha256": candidate_hash,
                "sample_rate_hz": sr,
                "channels": int(x.shape[0]),
                "samples": int(x.shape[-1]),
                "duration_seconds": float(x.shape[-1] / sr),
                "metrics": cand,
            },
            "identity": {
                "pcm_status": "EXACT" if exact else "DIFFERENT",
                "format_exact": bool(format_exact),
            },
            "format_comparison": fmt,
            "metric_comparison": comparison,
            "drift_attribution": drift,
            "result": {
                "verdict": verdict,
                "confidence": round(float(confidence), 2),
                "bit_exact": bool(exact),
                "measurement_match": bool(not any_fail and not any_drift),
            },
        }
        payload["validation_payload_sha256"] = _canonical_json_sha256(payload)

        lines = [
            f"NOVA FINAL MASTER VALIDATOR v{VERSION}",
            "Reproduction / Integrity Validation Report",
            "",
            f"REFERENCE REPORT: {reference_report_id or '[no report id]'}",
            f"REFERENCE MASTER: Nova Audio Master {report.get('master_version','unknown')} | Release {report.get('release',{}).get('status','unknown')}",
            f"REFERENCE FORMAT: {reference_format} [{_reference_format_suffix(reference_format)}]",
            f"REFERENCE JSON SOURCE: {auto_loaded_reference_path if auto_loaded_reference_path else 'connected input'}",
            f"REFERENCE JSON ARCHIVE: {saved_reference_path if saved_reference_path else 'not saved'}",
            "",
            f"IDENTITY: PCM SHA-256 {'EXACT' if exact else 'DIFFERENT'}",
            f"FORMAT: Sample Rate {fmt['sample_rate_hz']['reference']}->{fmt['sample_rate_hz']['candidate']} [{fmt['sample_rate_hz']['status']}] | "
            f"Channels {fmt['channels']['reference']}->{fmt['channels']['candidate']} [{fmt['channels']['status']}] | "
            f"Samples {fmt['samples']['reference']}->{fmt['samples']['candidate']} [{fmt['samples']['status']}]",
            "",
            "AUDIO METRICS:",
        ]
        labels = {
            "integrated_lufs":"Integrated LUFS","true_peak_dbtp":"True Peak dBTP",
            "sample_peak_dbfs":"Sample Peak dBFS","rms_dbfs":"RMS dBFS",
            "crest_db":"Crest dB","lr_correlation":"L/R Correlation",
        }
        for k in ("integrated_lufs","true_peak_dbtp","sample_peak_dbfs","rms_dbfs","crest_db","lr_correlation"):
            q=comparison[k]
            lines.append(f"- {labels[k]}: {q['reference']:.4f} -> {q['candidate']:.4f} | Δ {q['delta']:+.4f} | Tol ±{q['tolerance']:.4f} [{q['status']}]")
        lines += ["", "TONAL BANDS:"]
        for k in ("bass","mid","presence","hf"):
            q=comparison["bands_percent"][k]
            lines.append(f"- {k.upper()}: {q['reference']:.3f}% -> {q['candidate']:.3f}% | Δ {q['delta']:+.3f} pp | Tol ±{q['tolerance']:.3f} [{q['status']}]")
        if drift:
            lines += ["", "DRIFT ATTRIBUTION:"] + [f"- {n}" for n in drift]
        lines += [
            "",
            f"RESULT: {verdict} | Confidence {confidence:.2f}/100",
            f"VALIDATION SHA-256: {payload['validation_payload_sha256']}",
        ]
        return candidate_audio, sr, "\n".join(lines), json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False), verdict

NODE_CLASS_MAPPINGS = {"NovaFinalMasterValidator": NovaFinalMasterValidator}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaFinalMasterValidator": "Nova Final Master Validator"}
