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

try:
    from ..nova_categories import ANALYSIS
except ImportError:  # imported as a module rather than as part of the pack
    from nova_categories import ANALYSIS

try:
    from . import nova_master_archive_index as archive_index
except ImportError:  # imported as a module rather than as part of the pack
    import nova_master_archive_index as archive_index

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

VERSION = "0.3.1"
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



def _resolve_output_relative_dir(path_value: str, default_relative: str = "") -> Path:
    """Turn a node path widget into a real directory.

    A blank value means ComfyUI's output folder itself (or default_relative
    under it). An absolute path is taken as given. Anything else is relative to
    the output folder, tolerating a leading "output/" from older graphs without
    producing ".../output/output/...".
    """
    output_root = Path(folder_paths.get_output_directory()).resolve()
    path_text = str(path_value or "").strip()
    if not path_text:
        return (output_root / default_relative).resolve() if default_relative else output_root

    expanded = Path(os.path.expandvars(os.path.expanduser(path_text)))
    if expanded.is_absolute():
        return expanded.resolve()
    parts = expanded.parts
    if parts and parts[0].lower() == "output":
        expanded = Path(*parts[1:]) if len(parts) > 1 else Path()
    return (output_root / expanded).resolve()


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
    """Name the reference report after the archive it belongs to.

    The report is named from the archive stem alone, with no format suffix,
    so that the report and the mastered WAV share one name:

        Audio/01_J_Nine-Hours-North_1.0_24-48.wav
        Reports/01_J_Nine-Hours-North_1.0_24-48.json

    The archive name already carries the delivery format (``24-48``), so a
    separate suffix only added a second widget that had to be set identically
    at save time and at lookup time, and silently broke the lookup when it
    was not. ``reference_format`` is kept in the signature because it is still
    reported in the validation payload, and because older archives named with
    a ``_PCM16``/``_PCM24``/``_FLOAT32`` suffix are still resolved on load.
    """
    # Explicit filename input has highest priority. It may be fed directly
    # from Nova Master Identity's archival filename output, or discovered
    # from the upstream Load Audio node during a standalone validation.
    explicit_name = str(filename_value or "").strip()
    if explicit_name:
        return _safe_filename(_strip_soundhub_archive_suffix(explicit_name)) + ".json"

    identity = report.get("identity", {}) if isinstance(report, dict) else {}
    archive = report.get("archive", {}) if isinstance(report, dict) else {}
    provenance = report.get("provenance", {}) if isinstance(report, dict) else {}
    archive_name = archive.get("archive_name") or identity.get("archive_name")
    if archive_name:
        return _safe_filename(_strip_soundhub_archive_suffix(str(archive_name))) + ".json"
    report_id = provenance.get("report_id")
    if report_id:
        return "NovaMasterReference_" + _safe_filename(report_id) + ".json"
    return "NovaMasterReference.json"


def _save_reference_report(report: Dict[str, Any], path_value: str, filename_value: str = "", reference_format: str = "PCM_16") -> str:
    target_dir = _resolve_output_relative_dir(path_value)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / _reference_report_filename(report, filename_value, reference_format)
    target.write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8"
    )
    if not target.exists() or target.stat().st_size <= 0:
        raise RuntimeError(f"Reference report was not written successfully: {target}")
    return str(target)

_ARCHIVE_EXTENSIONS = (
    ".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac",
    ".aif", ".aiff", ".opus", ".wma", ".json",
)


def _strip_soundhub_archive_suffix(filename: str) -> str:
    """Reduce a file name to the archive stem the report is filed under.

    Drops any directory part, one known audio/report extension, and the
    SoundHub numbering that a Save Audio node appends:

      02_GC_Redline-Masters_Master_24-48_20260907-170906_00001.wav
      -> 02_GC_Redline-Masters_Master_24-48

    The extension is matched against a known list rather than taken from
    ``Path.stem``, because an archive name carries a version number and
    ``Path("01_J_Track_1.0_24-48").stem`` silently truncates it to
    ``01_J_Track_1``. That produced a lookup miss on a report that was
    present, whenever the name was passed without its extension.
    """
    name = Path(str(filename or "").strip()).name
    lowered = name.lower()
    for extension in _ARCHIVE_EXTENSIONS:
        if lowered.endswith(extension) and len(name) > len(extension):
            name = name[: -len(extension)]
            break
    return re.sub(r"_\d{8}-\d{6}_\d{5}$", "", name)


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

    report_dir = _resolve_output_relative_dir(path_value, "NovaAudioMasters/Reports")

    report_stem = _safe_filename(_strip_soundhub_archive_suffix(candidate_filename))

    # Current naming: the report carries the archive stem and nothing else.
    report_path = report_dir / f"{report_stem}.json"

    # Archives written by v0.3.0 and earlier appended the reference format.
    # Try every suffix, not just the one currently selected, so an archive
    # still resolves when the format widget no longer matches how it was
    # saved. The report itself states the format it was mastered at.
    legacy_paths = [
        report_dir / f"{report_stem}_{s}.json"
        for s in ("PCM24", "PCM16", "FLOAT32")
    ]
    preferred = report_dir / f"{report_stem}_{_reference_format_suffix(reference_format)}.json"
    if preferred in legacy_paths:
        legacy_paths.remove(preferred)
    legacy_paths.insert(0, preferred)

    if not report_path.is_file():
        for legacy in legacy_paths:
            if legacy.is_file():
                report_path = legacy
                break
        else:
            searched = "\n".join(f"  {c}" for c in [report_dir / f"{report_stem}.json"] + legacy_paths)
            raise FileNotFoundError(
                "Matching Nova mastering report was not found.\n"
                f"Candidate file: {candidate_filename}\n"
                f"Archive stem:   {report_stem}\n"
                f"Report folder:  {report_dir}\n"
                f"Looked for:\n{searched}"
            )

    return report_path.read_text(encoding="utf-8"), str(report_path)


def _archive_identity_line(report: Dict[str, Any]) -> str:
    """One line naming the archived master by identity, not by file name."""
    publication = report.get("publication_identity")
    publication = publication if isinstance(publication, dict) else {}
    recording = publication.get("recording_identity")
    recording = recording if isinstance(recording, dict) else {}
    title = str(recording.get("track_title", "")).strip()
    if not title:
        return ("no publication identity in this archive "
                "(wire identity_json from Nova Master Identity when archiving)")
    bits = [title]
    if recording.get("version"):
        bits.append(f"v{str(recording['version']).strip()}")
    if recording.get("artist_name"):
        bits.append(f"by {str(recording['artist_name']).strip()}")
    if recording.get("isrc"):
        bits.append(f"ISRC {str(recording['isrc']).strip()}")
    if publication.get("identity_id"):
        bits.append(f"id {str(publication['identity_id'])[:8]}")
    return " | ".join(bits)


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
    RETURN_TYPES = ("AUDIO", "SAMPLE_RATE", "STRING", "STRING", "STRING","STRING","STRING")
    RETURN_NAMES = ("candidate_audio", "sample_rate", "validation_report", "validation_json", "verdict","archive_audio_path","archive_report_path")
    DESCRIPTION = "Nova Final Master Validator v0.3.1: bit-exact and measurement-based reproduction/integrity validation."

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
                    "tooltip": "Delivery format recorded in the validation report. Archives written by v0.3.0 and earlier were named with this format, and are still found whatever it is set to, so it no longer has to match to locate a report."
                }),
                "save_reference_json": ("BOOLEAN", {"default": False}),
                "archive_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Archive name, normally wired from Nova Master Identity. On a mastering pass it names the saved reference JSON. On a validation pass it selects which archived report to load; leave it empty and the candidate's own filename is used instead."
                }),
                "report_path": ("STRING", {
                    "default": "NovaAudioMasters/Reports",
                    "multiline": False,
                    "tooltip": "Folder relative to ComfyUI/output. Save location for reference JSON, leave blank to save directly in output."
                }),
                "audio_path": ("STRING", {
                    "default": "NovaAudioMasters/Audio",
                    "multiline": False,
                    "tooltip": "Folder relative to ComfyUI/output. Save location for mastered Audio, leave blank to save directly in output."
                }),
                "identity_selector": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Which archived master to validate against, by identity rather than by file name: release title, ISRC, catalog number, identity ID, report ID or master PCM SHA-256. Names in the archive folder are working names and cannot be trusted; this is matched against the identity recorded inside each report."
                }),
                "lookup_mode": (["auto", "identity", "content scan", "archive name"], {
                    "default": "auto",
                    "tooltip": (
                        "How the reference archive is found when reference_report_json is empty.\n"
                        "auto: identity_selector if set, else archive_name, else content scan.\n"
                        "identity: identity_selector only.\n"
                        "content scan: ignore every name, measure the candidate and find the archive it matches.\n"
                        "archive name: the old file-name lookup."
                    ),
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def _resolve_reference(self, lookup, report_path, identity_selector, archive_name,
                           reference_format, candidate_metrics, candidate_duration,
                           candidate_pcm_sha256, prompt, unique_id):
        """Find the archived reference report, recording how it was found.

        File names in an archive folder are working names: the same master is
        routinely stored under several of them, and a release title bears no
        relation to whatever the render engine suggested. So a name is only
        ever used when explicitly asked for. `lookup` is filled in as a side
        effect so the validation report can state exactly which archive was
        chosen and why.
        """
        mode = str(lookup.get("mode") or "auto").strip().lower()
        selector = str(identity_selector or "").strip()
        wired_name = str(archive_name or "").strip()

        def index_folder():
            report_dir = _resolve_output_relative_dir(report_path, "NovaAudioMasters/Reports")
            index = archive_index.build_index(report_dir, _reference_metrics)
            lookup["archive_folder"] = index["report_dir"]
            lookup["archive_count"] = len(index["entries"])
            lookup["duplicate_count"] = index.get("duplicate_count", 0)
            if index.get("error"):
                raise FileNotFoundError(index["error"])
            if not index["entries"]:
                raise FileNotFoundError(
                    f"No Nova mastering reports found in {index['report_dir']}\n"
                    f"({index['file_count']} JSON file(s) present, none usable as a reference)."
                )
            return index

        def by_identity():
            index = index_folder()
            found = archive_index.find_by_identity(index, selector)
            matches = found["matches"]
            if not matches:
                known = sorted({
                    e["identity"]["track_title"] or e["filename"] for e in index["entries"]
                })[:12]
                raise FileNotFoundError(
                    f"No archived master matches identity {selector!r}.\n"
                    f"Folder: {index['report_dir']}\n"
                    f"Archives available: {len(index['entries'])}\n"
                    "Known identities (first 12):\n" + "\n".join(f"  {k}" for k in known)
                )
            if len(matches) > 1:
                raise ValueError(
                    f"Identity {selector!r} matches {len(matches)} archived masters:\n"
                    + "\n".join(f"  {archive_index.describe_entry(m)}" for m in matches)
                    + "\nUse a more specific identity, such as the ISRC or identity ID."
                )
            entry = matches[0]
            lookup.update(resolved_by=f"identity ({found['match_kind']} match)",
                          matched_archive=entry["filename"],
                          matched_description=archive_index.describe_entry(entry),
                          match_score=100.0)
            return Path(entry["path"]).read_text(encoding="utf-8"), entry["path"]

        def by_content():
            index = index_folder()
            result = archive_index.match_by_content(
                index, candidate_metrics, candidate_duration, candidate_pcm_sha256
            )
            if not result.get("entry"):
                raise FileNotFoundError(result.get("reason", "no archive matched"))
            if result["ambiguous"]:
                rows = "\n".join(
                    f"  {c['score']:6.2f}  Δdur {c['duration_delta']:+7.3f}s  "
                    f"{c['track_title'] or c['filename']}"
                    for c in result["candidates"]
                )
                raise ValueError(
                    "Content scan could not identify this audio with confidence.\n"
                    f"{result['reason']}.\nClosest archives:\n{rows}\n"
                    "Set identity_selector to choose deliberately."
                )
            entry = result["entry"]
            lookup.update(
                resolved_by=f"content scan ({result['method']})",
                matched_archive=entry["filename"],
                matched_description=archive_index.describe_entry(entry),
                match_score=round(float(result["score"]), 2),
                match_margin=round(float(result["margin"]), 2),
                runner_up=(result["runner_up"] or {}).get("filename", ""),
                runner_up_score=(round(float(result["runner_up_score"]), 2)
                                 if result.get("runner_up_score") is not None else None),
                candidates=result["candidates"],
                match_reason=result["reason"],
            )
            return Path(entry["path"]).read_text(encoding="utf-8"), entry["path"]

        def by_name():
            name = wired_name
            if not name:
                name = _find_upstream_load_audio_filename(prompt, unique_id)
                lookup["candidate_source_filename"] = name
            text, path = _load_matching_reference_report(report_path, name, reference_format)
            lookup.update(resolved_by=f"archive name ({name})", matched_archive=Path(path).name)
            return text, path

        if mode == "identity":
            if not selector:
                raise ValueError(
                    "lookup_mode is 'identity' but identity_selector is empty. "
                    "Enter a release title, ISRC, catalog number or identity ID."
                )
            return by_identity()
        if mode == "content scan":
            return by_content()
        if mode == "archive name":
            return by_name()

        # auto: deliberate choice first, wired name second, measurement last.
        if selector:
            return by_identity()
        if wired_name:
            return by_name()
        return by_content()

    def validate(self, candidate_audio, reference_report_json, tolerance_multiplier=1.0,
                 reference_format="PCM_16", save_reference_json=False, archive_name="",
                 report_path="", audio_path="", identity_selector="", lookup_mode="auto",
                 prompt=None, unique_id=None):
        # The candidate is measured BEFORE the reference is chosen, because
        # identifying which archive a suspect file belongs to is itself a
        # measurement problem. Nothing below reads the candidate's filename or
        # its embedded metadata.
        waveform = candidate_audio["waveform"]
        sr = int(candidate_audio["sample_rate"])
        if waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        if waveform.shape[0] != 1:
            raise ValueError(f"Nova Final Master Validator v{VERSION} accepts one candidate track per node.")
        x = waveform[0].float().contiguous()

        cand = _measure(x, sr)
        candidate_hash = _pcm_sha256(x)
        candidate_duration = float(x.shape[-1] / sr)

        supplied_reference_json = str(reference_report_json or "").strip()
        auto_loaded_reference_path = ""
        candidate_source_filename = ""
        lookup = {
            "mode": str(lookup_mode or "auto"),
            "resolved_by": "connected input" if supplied_reference_json else "",
            "identity_selector": str(identity_selector or "").strip(),
        }

        if not supplied_reference_json:
            supplied_reference_json, auto_loaded_reference_path = self._resolve_reference(
                lookup=lookup,
                report_path=report_path,
                identity_selector=identity_selector,
                archive_name=archive_name,
                reference_format=reference_format,
                candidate_metrics=cand,
                candidate_duration=candidate_duration,
                candidate_pcm_sha256=candidate_hash,
                prompt=prompt,
                unique_id=unique_id,
            )
            candidate_source_filename = lookup.get("candidate_source_filename", "")
            print(
                "[NovaFinalMasterValidator] Reference resolved by "
                f"{lookup['resolved_by']}: {auto_loaded_reference_path}"
            )

        report = _parse_report(supplied_reference_json)

        # Prefer the archive's own identity for naming, falling back to the
        # wired archive_name. A working file name is the last resort, never
        # the first.
        archived_identity = report.get("archive", {}) if isinstance(report.get("archive"), dict) else {}
        save_filename = (
            str(archive_name or "").strip()
            or str(archived_identity.get("archive_name", "")).strip()
            or candidate_source_filename
        )
        archive_stem = _safe_filename(_strip_soundhub_archive_suffix(save_filename)) if save_filename else ""
        saved_reference_path = ""
        # Planned archive locations, relative to ComfyUI/output, matching the
        # names _save_reference_report actually writes. These leave the node on
        # archive_report_path / archive_audio_path so a Save Audio node can be
        # driven from the same name the report is filed under.
        report_file_name = Path(report_path) / f"{archive_stem}.json" if archive_stem else ""
        audio_file_name = Path(audio_path) / f"{archive_stem}.wav" if archive_stem else ""

        if bool(save_reference_json):
            saved_reference_path = _save_reference_report(report, report_path, save_filename, reference_format)
            print(f"[NovaFinalMasterValidator] Saved reference JSON: {saved_reference_path}")

        ref = _reference_metrics(report)
        tol = _tolerances(report, tolerance_multiplier)
        comparison, confidence = _compare(ref, cand, tol)
        fmt = _format_validation(report, x, sr)

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

        # A reference produced with mastering bypassed describes the untouched
        # input, so matching it proves the file is unaltered, not that it is the
        # master. Say so rather than letting a 100/100 BIT_EXACT imply otherwise.
        ref_provenance = report.get("provenance", {}) if isinstance(report, dict) else {}
        reference_warnings = []
        if bool(ref_provenance.get("mastering_bypassed")) or str(report.get("mode", "")).strip().lower() == "off":
            reference_warnings.append(
                "Reference report was produced with mastering bypassed (mode Off). It "
                "describes the unprocessed audio, so a match confirms the candidate is "
                "unaltered, not that it reproduces a master."
            )
        if not isinstance(report.get("validation_reference"), dict):
            reference_warnings.append(
                "Reference report carries no validation_reference block, so default "
                "tolerances were used instead of the tolerances recorded at mastering time."
            )

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
                "lookup": lookup,
                "save_enabled": bool(save_reference_json),
                "saved_path": saved_reference_path,
                "reference_format": reference_format,
                "format_suffix": _reference_format_suffix(reference_format),
                "filename": _reference_report_filename(
                    report,
                    archive_name or candidate_source_filename,
                    reference_format
                ) if bool(save_reference_json) else "",
                "source_filename_input": str(archive_name or ""),
            },
            "reference": {
                "report_id": reference_report_id,
                "master_version": report.get("master_version", ""),
                "report_schema_version": report.get("schema_version"),
                "master_pcm_sha256": reference_hash,
                "reproduction_fingerprint_sha256": reference_fp,
                "release_status": report.get("release", {}).get("status", ""),
                "reference_warnings": reference_warnings,
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
            f"REFERENCE FOUND BY: {lookup.get('resolved_by') or 'connected input'}"
            + (f" | {lookup['matched_description']}" if lookup.get("matched_description") else "")
            + (f" | match {lookup['match_score']:.2f}" if isinstance(lookup.get("match_score"), (int, float)) else "")
            + (f", runner-up {lookup['runner_up_score']:.2f} (margin {lookup['match_margin']:.2f})"
               if lookup.get("runner_up_score") is not None else ""),
            f"REFERENCE JSON SOURCE: {auto_loaded_reference_path if auto_loaded_reference_path else 'connected input'}",
            f"REFERENCE JSON ARCHIVE: {saved_reference_path if saved_reference_path else 'not saved (save_reference_json is off)'}",
            f"REFERENCE AUDIO ARCHIVE: {audio_file_name or 'no archive name available'} (written by the Save Audio node, not by this node)",
            "",
            f"ARCHIVE IDENTITY: {_archive_identity_line(report)}",
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
        if reference_warnings:
            lines += ["", "REFERENCE WARNINGS:"] + [f"- {n}" for n in reference_warnings]
        lines += [
            "",
            f"RESULT: {verdict} | Confidence {confidence:.2f}/100",
            f"VALIDATION SHA-256: {payload['validation_payload_sha256']}",
        ]

        return candidate_audio, sr, "\n".join(lines), json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False), verdict, audio_file_name, report_file_name

NODE_CLASS_MAPPINGS = {"NovaFinalMasterValidator": NovaFinalMasterValidator}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaFinalMasterValidator": "Nova Final Master Validator"}
