"""Content-addressed index over a folder of archived Nova mastering reports.

A mastering report is filed under whatever the audio was called at the time,
and working names lie. In one real archive folder the same master is stored
under four different names, and a release title ("Nine Hours North") bears no
resemblance to the working name the render engine suggested ("Northbound A").
A suspect file's own name is worth even less.

The report does not lie. It carries the canonical PCM SHA-256 of the master it
describes, together with every measurement taken when that master was made.
This module reads a folder of reports and answers two questions without
consulting a filename, the candidate's metadata, or anything embedded in the
suspect file:

    find_by_identity()  -- "which archive is <title / ISRC / identity id>?"
    match_by_content()  -- "which archive is THIS audio?"

Nothing here writes, renames or modifies anything on disk.
"""

import json
import math
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

REPORT_SCHEMA = "nova.audio_master.report"
BATCH_SCHEMA = "nova.audio_master.batch_report"

# How far apart two DIFFERENT masters typically sit on each measurement.
# These are matching scales, not validation tolerances: they decide how fast
# similarity falls away when picking an archive, and never decide whether a
# candidate passes or fails. Validation tolerances stay where they are, in the
# reference report.
MATCH_SCALES: Dict[str, float] = {
    "duration_seconds": 1.0,
    "integrated_lufs": 1.0,
    "true_peak_dbtp": 1.0,
    "sample_peak_dbfs": 1.0,
    "rms_dbfs": 1.0,
    "crest_db": 1.5,
    "lr_correlation": 0.05,
    "band_energy_percent": 2.0,
}

MATCH_WEIGHTS: Dict[str, float] = {
    "duration_seconds": 3.0,
    "integrated_lufs": 1.5,
    "true_peak_dbtp": 1.0,
    "sample_peak_dbfs": 0.5,
    "rms_dbfs": 1.5,
    "crest_db": 1.5,
    "lr_correlation": 1.0,
    "band_energy_percent": 0.75,
}

# Below this margin between the best and second-best archive, the answer is
# not trustworthy enough to act on and the caller is told so instead.
AMBIGUOUS_MARGIN = 4.0


def _normalise(value: Any) -> str:
    """Casefold and reduce to single-spaced alphanumerics.

    Lets "Nine Hours North", "nine-hours-north" and "Nine_Hours_North" all
    compare equal, without matching across genuinely different titles.
    """
    text = re.sub(r"[^0-9a-z]+", " ", str(value or "").strip().lower())
    return re.sub(r"\s+", " ", text).strip()


def _similarity(delta: float, scale: float) -> float:
    """1.0 at no difference, falling smoothly to 0 as the gap grows."""
    try:
        ratio = float(delta) / max(float(scale), 1e-9)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(ratio):
        return 0.0
    return math.exp(-(ratio * ratio))


def _unwrap(obj: Any) -> Optional[Dict[str, Any]]:
    """Return a single mastering report, unwrapping a one-entry batch."""
    if not isinstance(obj, dict):
        return None
    if obj.get("schema") == BATCH_SCHEMA:
        reports = obj.get("reports") or []
        if len(reports) == 1 and isinstance(reports[0], dict):
            obj = reports[0]
        else:
            return None
    return obj if obj.get("schema") == REPORT_SCHEMA else None


def _entry_identity(report: Dict[str, Any]) -> Dict[str, str]:
    """Publication identity, when Nova Master Identity wrote one into the report."""
    publication = report.get("publication_identity")
    publication = publication if isinstance(publication, dict) else {}
    recording = publication.get("recording_identity")
    recording = recording if isinstance(recording, dict) else {}
    archive = report.get("archive")
    archive = archive if isinstance(archive, dict) else {}
    return {
        "identity_id": str(publication.get("identity_id", "")),
        "isrc": str(recording.get("isrc", "")),
        "track_title": str(recording.get("track_title", "")),
        "artist_name": str(recording.get("artist_name", "")),
        "album_title": str(recording.get("album_title", "")),
        "catalog_number": str(recording.get("catalog_number", "")),
        "version": str(recording.get("version", "")),
        "archive_name": str(archive.get("archive_name", "")),
    }


def _selector_keys(entry: Dict[str, Any]) -> List[str]:
    """Every string this archive may legitimately be asked for by."""
    identity = entry["identity"]
    keys = [
        identity["identity_id"], identity["isrc"], identity["track_title"],
        identity["catalog_number"], identity["archive_name"],
        entry["report_id"], entry["master_pcm_sha256"], entry["stem"],
    ]
    title, version = identity["track_title"], identity["version"]
    if title and version:
        keys.append(f"{title} {version}")
    artist = identity["artist_name"]
    if title and artist:
        keys.append(f"{artist} {title}")
    return [k for k in keys if k]


def build_index(
    report_dir: Path,
    metrics_fn: Callable[[Dict[str, Any]], Dict[str, Any]],
    recursive: bool = True,
) -> Dict[str, Any]:
    """Read every Nova mastering report under report_dir into one index.

    Entries are collapsed by master_pcm_sha256, so a master archived four
    times under four names appears once, carrying all four names as aliases.
    metrics_fn extracts the comparable metric block from a report; the
    validator passes its own so the index and the comparison always read a
    report the same way.
    """
    report_dir = Path(report_dir)
    entries: List[Dict[str, Any]] = []
    by_hash: Dict[str, Dict[str, Any]] = {}
    skipped: List[Dict[str, str]] = []

    if not report_dir.is_dir():
        return {"report_dir": str(report_dir), "entries": [], "skipped": [],
                "file_count": 0, "error": f"Report folder does not exist: {report_dir}"}

    paths = sorted(report_dir.rglob("*.json") if recursive else report_dir.glob("*.json"))
    for path in paths:
        try:
            report = _unwrap(json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:
            skipped.append({"path": str(path), "reason": f"unreadable: {exc}"})
            continue
        if report is None:
            skipped.append({"path": str(path), "reason": "not a nova.audio_master.report"})
            continue
        if not isinstance(report.get("mastered"), dict):
            skipped.append({"path": str(path), "reason": "no mastered metrics"})
            continue
        try:
            metrics = metrics_fn(report)
        except Exception as exc:
            skipped.append({"path": str(path), "reason": f"metrics unreadable: {exc}"})
            continue

        ident = report.get("identity", {}) if isinstance(report.get("identity"), dict) else {}
        provenance = report.get("provenance", {}) if isinstance(report.get("provenance"), dict) else {}
        master_hash = str(ident.get("master_pcm_sha256", ""))

        existing = by_hash.get(master_hash) if master_hash else None
        if existing is not None:
            existing["aliases"].append(path.name)
            continue

        entry = {
            "path": str(path),
            "filename": path.name,
            "stem": path.stem,
            "aliases": [path.name],
            "report_id": str(provenance.get("report_id", "")),
            "master_version": str(report.get("master_version", "")),
            "processing_mode": str(provenance.get("processing_mode", report.get("mode", ""))),
            "mastering_bypassed": bool(provenance.get("mastering_bypassed", False)),
            "release_status": str(report.get("release", {}).get("status", "")),
            "master_pcm_sha256": master_hash,
            "source_pcm_sha256": str(ident.get("source_pcm_sha256", "")),
            "sample_rate_hz": int(ident.get("sample_rate_hz", 0) or 0),
            "channels": int(ident.get("channels", 0) or 0),
            "samples": int(ident.get("samples", 0) or 0),
            "duration_seconds": float(ident.get("duration_seconds", 0.0) or 0.0),
            "has_identity": bool(isinstance(report.get("publication_identity"), dict)),
            "identity": _entry_identity(report),
            "metrics": metrics,
        }
        entries.append(entry)
        if master_hash:
            by_hash[master_hash] = entry

    return {
        "report_dir": str(report_dir),
        "file_count": len(paths),
        "entries": entries,
        "skipped": skipped,
        "duplicate_count": sum(len(e["aliases"]) - 1 for e in entries),
    }


def find_by_identity(index: Dict[str, Any], selector: str) -> Dict[str, Any]:
    """Resolve a release title, ISRC, identity id, catalog number or hash."""
    wanted = _normalise(selector)
    if not wanted:
        return {"matches": [], "reason": "no identity selector supplied"}

    exact, partial = [], []
    for entry in index.get("entries", []):
        keys = [_normalise(k) for k in _selector_keys(entry)]
        if wanted in keys:
            exact.append(entry)
        elif any(wanted in k for k in keys if k):
            partial.append(entry)

    matches = exact or partial
    return {
        "matches": matches,
        "match_kind": "exact" if exact else ("partial" if partial else "none"),
        "reason": "" if matches else f"no archived report matches identity {selector!r}",
    }


def score_entry(entry: Dict[str, Any], candidate: Dict[str, Any], duration_seconds: float) -> Dict[str, Any]:
    """Score one archive against measured candidate audio, 0..100."""
    reference = entry["metrics"]
    terms: List[Tuple[str, float, float]] = []

    if entry["duration_seconds"] > 0.0 and duration_seconds > 0.0:
        terms.append((
            "duration_seconds",
            _similarity(duration_seconds - entry["duration_seconds"], MATCH_SCALES["duration_seconds"]),
            MATCH_WEIGHTS["duration_seconds"],
        ))

    for name in ("integrated_lufs", "true_peak_dbtp", "sample_peak_dbfs",
                 "rms_dbfs", "crest_db", "lr_correlation"):
        try:
            delta = float(candidate[name]) - float(reference[name])
        except (KeyError, TypeError, ValueError):
            continue
        terms.append((name, _similarity(delta, MATCH_SCALES[name]), MATCH_WEIGHTS[name]))

    for band in ("bass", "mid", "presence", "hf"):
        try:
            delta = float(candidate["bands_percent"][band]) - float(reference["bands_percent"][band])
        except (KeyError, TypeError, ValueError):
            continue
        terms.append((f"band_{band}",
                      _similarity(delta, MATCH_SCALES["band_energy_percent"]),
                      MATCH_WEIGHTS["band_energy_percent"]))

    total_weight = sum(w for _, _, w in terms)
    score = 100.0 * sum(s * w for _, s, w in terms) / total_weight if total_weight else 0.0
    return {
        "entry": entry,
        "score": float(score),
        "duration_delta": float(duration_seconds - entry["duration_seconds"]),
        "terms": {name: round(sim, 4) for name, sim, _ in terms},
    }


def match_by_content(
    index: Dict[str, Any],
    candidate_metrics: Dict[str, Any],
    duration_seconds: float,
    candidate_pcm_sha256: str = "",
    top_n: int = 3,
) -> Dict[str, Any]:
    """Identify which archived master a piece of audio is, by measurement.

    An exact canonical-PCM hash match is definitive and returned immediately.
    Otherwise every archive is scored and the best is returned together with
    the runner-up, so a caller can refuse to act on a close call rather than
    silently picking one of two near-identical archives.
    """
    entries = index.get("entries", [])
    if not entries:
        return {"resolved": False, "method": "none", "candidates": [],
                "reason": f"no archived reports found in {index.get('report_dir', '?')}"}

    if candidate_pcm_sha256:
        for entry in entries:
            if entry["master_pcm_sha256"] and entry["master_pcm_sha256"] == candidate_pcm_sha256:
                return {
                    "resolved": True, "method": "pcm_sha256", "entry": entry,
                    "score": 100.0, "runner_up": None, "margin": 100.0,
                    "ambiguous": False, "candidates": [],
                    "reason": "canonical PCM SHA-256 of the candidate equals this archive's master hash",
                }

    scored = sorted(
        (score_entry(e, candidate_metrics, duration_seconds) for e in entries),
        key=lambda r: r["score"], reverse=True,
    )
    best = scored[0]
    runner_up = scored[1] if len(scored) > 1 else None
    margin = best["score"] - runner_up["score"] if runner_up else 100.0
    ambiguous = margin < AMBIGUOUS_MARGIN

    # Everything too close to the leader to separate. Two renders of one master
    # -- a 24-bit and a float32 save of the same audio, say -- measure
    # identically to four decimal places and differ only in canonical PCM hash,
    # so measurement alone genuinely cannot choose between them. Saying which
    # kind of tie this is turns a dead end into a decision the user can make.
    tied = [r for r in scored if best["score"] - r["score"] < AMBIGUOUS_MARGIN]
    tied_sources = {r["entry"]["source_pcm_sha256"] for r in tied if r["entry"]["source_pcm_sha256"]}
    shared_source = len(tied) > 1 and len(tied_sources) == 1
    tie_note = ""
    if ambiguous:
        if shared_source:
            tie_note = (" They share one source_pcm_sha256, so they are different renders or "
                        "saves of the same audio and only the canonical PCM hash separates them.")
        else:
            tie_note = " They do not share a source, so these are distinct masters that happen to measure alike."

    return {
        "resolved": not ambiguous,
        "method": "measurement",
        "entry": best["entry"],
        "score": best["score"],
        "runner_up": runner_up["entry"] if runner_up else None,
        "runner_up_score": runner_up["score"] if runner_up else None,
        "margin": float(margin),
        "ambiguous": bool(ambiguous),
        "candidates": [
            {"filename": r["entry"]["filename"], "score": round(r["score"], 2),
             "duration_delta": round(r["duration_delta"], 3),
             "track_title": r["entry"]["identity"]["track_title"]}
            for r in scored[:max(1, int(top_n))]
        ],
        "tied_count": len(tied),
        "shared_source": bool(shared_source),
        "reason": (
            f"top {len(tied)} archives are within {margin:.2f} points, too close to choose between."
            + tie_note
            if ambiguous else "best measurement match, clear of the runner-up"
        ),
    }


def describe_entry(entry: Dict[str, Any]) -> str:
    """One-line human description, preferring identity over filename."""
    identity = entry["identity"]
    if identity["track_title"]:
        label = identity["track_title"]
        if identity["version"]:
            label += f" ({identity['version']})"
        if identity["isrc"]:
            label += f" [{identity['isrc']}]"
        return f"{label} -> {entry['filename']}"
    return entry["filename"]


__all__ = [
    "build_index", "find_by_identity", "match_by_content", "score_entry",
    "describe_entry", "MATCH_SCALES", "MATCH_WEIGHTS", "AMBIGUOUS_MARGIN",
]
