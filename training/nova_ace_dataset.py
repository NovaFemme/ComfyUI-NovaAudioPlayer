"""
nova_ace_dataset.py — build and review an ACE-Step training dataset from tagged audio.

Nova Tag Writer has already put the useful text ON the files: a rich
description in `comment`, the words in `lyrics`, plus genre and date. That is
exactly what ACE-Step wants per sample, so the dataset is built by reading the
files back rather than by re-deriving anything or asking an LLM to guess.

Two nodes:
  Nova ACE Dataset Builder  tags   -> dataset JSON (+ optional sidecars)
  Nova ACE Dataset Review   JSON   -> a verdict, before you spend GPU hours
"""

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

try:
    from .nova_ace_common import (
        ACE_VERSION, DATASET_TYPE, INSTRUMENTAL, TRAINING_CATEGORY, normalise_sample,
    )
    from ..authoring.nova_authoring_common import FILES_TYPE, banner, file_paths
except ImportError:  # direct execution / test harness
    from nova_ace_common import (
        ACE_VERSION, DATASET_TYPE, INSTRUMENTAL, TRAINING_CATEGORY, normalise_sample,
    )
    from nova_authoring_common import FILES_TYPE, banner, file_paths


def _read_tags(path: str) -> Tuple[Dict[str, str], float, int, int]:
    """(lowercased tags, duration seconds, sample rate, channels)."""
    import mutagen

    handle = mutagen.File(path)
    if handle is None:
        raise ValueError("mutagen has no reader for this container")

    tags: Dict[str, str] = {}
    raw = getattr(handle, "tags", None)
    if raw:
        try:
            items = list(raw.items())
        except Exception:
            items = []
        for key, value in items:
            name = str(key).strip().lower().split(":")[0]
            if isinstance(value, list):
                value = value[0] if len(value) == 1 else ", ".join(str(v) for v in value)
            tags[name] = str(value)

    info = getattr(handle, "info", None)
    return (
        tags,
        float(getattr(info, "length", 0.0) or 0.0),
        int(getattr(info, "sample_rate", 0) or 0),
        int(getattr(info, "channels", 0) or 0),
    )


def _first_tag(tags: Dict[str, str], names: str) -> str:
    for name in [n.strip().lower() for n in (names or "").split(",") if n.strip()]:
        value = tags.get(name, "").strip()
        if value:
            return value
    return ""


def _to_bpm(text: str):
    try:
        value = float(str(text).strip())
    except (TypeError, ValueError):
        return None
    return int(round(value)) if value > 0 else None


class NovaACEDatasetBuilder:
    CATEGORY = TRAINING_CATEGORY
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", DATASET_TYPE, "INT", "STRING")
    RETURN_NAMES = ("dataset_json", "dataset", "sample_count", "console")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "Path of the dataset JSON written — feed this to Nova ACE Preprocess.",
        "The same dataset in memory, for Nova ACE Dataset Review.",
        "How many samples were written.",
        "Run log — wire into Nova Console.",
    )
    DESCRIPTION = (
        f"Nova ACE Dataset Builder v{ACE_VERSION} — turns a batch of tagged audio "
        "into the dataset JSON ACE-Step's preprocessor reads."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "files": (FILES_TYPE, {"tooltip": "Batch from Nova Batch Load Audio."}),
                "dataset_json_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "~/Datasets/my_lora/dataset.json",
                    "tooltip": "Where to write the dataset JSON. Parent folders are created.",
                }),
                "trigger_word": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "crazygecko",
                    "tooltip": "The LoRA trigger, written to every sample as custom_tag. Use a rare token you can type at inference.",
                }),
                "tag_position": (["prepend", "append", "replace"], {
                    "default": "prepend",
                    "tooltip": "Where ACE-Step puts the trigger relative to the caption. 'replace' trains on the trigger alone.",
                }),
                "prompt_source": (["caption", "genre"], {
                    "default": "caption",
                    "tooltip": "Which text ACE-Step trains against, written as prompt_override.",
                }),
                "caption_tags": ("STRING", {
                    "default": "comment, description, title",
                    "multiline": False,
                    "tooltip": "Tags to try, in order, for the caption. First non-empty wins.",
                }),
                "lyrics_tags": ("STRING", {
                    "default": "lyrics, unsyncedlyrics",
                    "multiline": False,
                    "tooltip": "Tags to try, in order, for lyrics. Empty means instrumental.",
                }),
                "write_sidecars": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Also write {stem}.lyrics.txt and {stem}.json beside each audio file, the layout ACE-Step's Gradio UI expects.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # writes files; never cache

    def build(self, files, dataset_json_path, trigger_word, tag_position,
              prompt_source, caption_tags, lyrics_tags, write_sidecars, **kwargs):
        paths = file_paths(files)
        log: List[str] = [banner(f"NOVA ACE DATASET BUILDER v{ACE_VERSION}")]

        target = (dataset_json_path or "").strip().strip('"').strip("'")
        if not target:
            raise ValueError("Nova ACE Dataset Builder: dataset_json_path is required.")
        target = os.path.abspath(os.path.expanduser(os.path.expandvars(target)))
        if not paths:
            raise ValueError("Nova ACE Dataset Builder: the batch has no files.")

        trigger = (trigger_word or "").strip()
        samples: List[Dict[str, Any]] = []
        skipped = 0
        instrumental = 0

        log.append(f"Batch   : {(files or {}).get('root', '')}  ({len(paths)} file(s))")
        log.append(f"Trigger : {trigger or '(none — the LoRA will have no trigger word)'}"
                   + (f"  [{tag_position}]" if trigger else ""))
        log.append(f"Prompt  : {prompt_source}")
        log.append("")

        for path in paths:
            name = os.path.basename(path)
            try:
                tags, duration, rate, channels = _read_tags(path)
            except Exception as exc:
                log.append(f"SKIPPED {name}: {type(exc).__name__}: {exc}")
                skipped += 1
                continue

            caption = _first_tag(tags, caption_tags)
            lyrics = _first_tag(tags, lyrics_tags)
            is_instrumental = not lyrics.strip()
            if is_instrumental:
                instrumental += 1

            sample = normalise_sample({
                "filename": name,
                "audio_path": path,
                "caption": caption,
                "lyrics": lyrics.strip() or INSTRUMENTAL,
                "genre": tags.get("genre", "").strip(),
                "bpm": _to_bpm(tags.get("bpm", "")),
                "keyscale": (tags.get("keyscale") or tags.get("key") or "").strip(),
                "timesignature": "",
                "duration": round(duration, 3),
                "is_instrumental": is_instrumental,
                "custom_tag": trigger,
                "prompt_override": prompt_source,
                "sample_rate": rate,
                "channels": channels,
            })
            samples.append(sample)

            flag = "" if caption else "   <- no caption"
            log.append(f"  {name:<44} {duration/60:5.2f} min  "
                       f"{'lyrics' if not is_instrumental else 'instrumental':<12}{flag}")

            if write_sidecars:
                stem = os.path.splitext(path)[0]
                try:
                    with open(f"{stem}.lyrics.txt", "w", encoding="utf-8") as handle:
                        handle.write(sample["lyrics"])
                    with open(f"{stem}.json", "w", encoding="utf-8") as handle:
                        json.dump({k: sample[k] for k in
                                   ("caption", "bpm", "keyscale", "timesignature", "genre")},
                                  handle, indent=2, ensure_ascii=False)
                except OSError as exc:
                    log.append(f"    sidecar write failed: {exc}")

        payload = {
            "schema": "nova.ace.dataset",
            "schema_version": 1,
            "node_version": ACE_VERSION,
            "created_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "trigger_word": trigger,
            "tag_position": tag_position,
            "samples": samples,
        }

        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)

        total_minutes = sum(s["duration"] for s in samples) / 60.0
        log.append("")
        log.append(f"Wrote {len(samples)} sample(s) to {target}")
        log.append(f"  total audio      : {total_minutes:.1f} min")
        log.append(f"  instrumental     : {instrumental}")
        log.append(f"  without a caption: {sum(1 for s in samples if not s['caption'])}")
        if skipped:
            log.append(f"  skipped          : {skipped}")

        text = "\n".join(log)
        print(text)
        return {"ui": {"text": [text]},
                "result": (target, payload, len(samples), text)}


class NovaACEDatasetReview:
    CATEGORY = TRAINING_CATEGORY
    FUNCTION = "review"
    RETURN_TYPES = ("STRING", "BOOLEAN", "INT", "INT")
    RETURN_NAMES = ("console", "ready", "sample_count", "problem_count")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "The review — wire into Nova Console.",
        "True when nothing blocking was found.",
        "Samples in the dataset.",
        "Problems found.",
    )
    DESCRIPTION = (
        f"Nova ACE Dataset Review v{ACE_VERSION} — checks a dataset before you spend "
        "GPU hours on it. ACE-Step's own docs make manual review mandatory; this is that pass."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dataset": (DATASET_TYPE, {"tooltip": "From Nova ACE Dataset Builder."}),
                "max_duration": ("FLOAT", {
                    "default": 240.0, "min": 10.0, "max": 3600.0, "step": 10.0,
                    "tooltip": "Anything longer is truncated by the preprocessor. Match this to the preprocess node.",
                }),
                "min_duration": ("FLOAT", {
                    "default": 10.0, "min": 0.0, "max": 600.0, "step": 1.0,
                    "tooltip": "Very short clips teach the model little and skew the loss.",
                }),
                "require_caption": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Treat a missing caption as a problem. A sample with no caption trains against an empty prompt.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def review(self, dataset, max_duration, min_duration, require_caption, **kwargs):
        samples: List[Dict[str, Any]] = list((dataset or {}).get("samples") or [])
        log: List[str] = [banner(f"NOVA ACE DATASET REVIEW v{ACE_VERSION}")]
        problems: List[str] = []
        notes: List[str] = []

        if not samples:
            log.append("The dataset has no samples.")
            text = "\n".join(log)
            print(text)
            return {"ui": {"text": [text]}, "result": (text, False, 0, 1)}

        trigger = (dataset or {}).get("trigger_word", "")
        seen: Dict[str, int] = {}
        total = 0.0
        rates, channels = set(), set()

        for sample in samples:
            name = sample.get("filename", "?")
            seen[name] = seen.get(name, 0) + 1
            duration = float(sample.get("duration") or 0.0)
            total += duration

            path = sample.get("audio_path") or ""
            if not path or not os.path.isfile(path):
                problems.append(f"{name}: audio_path does not exist — {path!r}")
            if duration <= 0:
                problems.append(f"{name}: duration is 0 — the file may be unreadable")
            elif duration < min_duration:
                problems.append(f"{name}: {duration:.1f}s is below min_duration {min_duration:.0f}s")
            elif duration > max_duration:
                notes.append(f"{name}: {duration:.1f}s exceeds max_duration "
                             f"{max_duration:.0f}s and will be truncated")
            if require_caption and not str(sample.get("caption") or "").strip():
                problems.append(f"{name}: no caption")
            if not sample.get("is_instrumental") and \
                    str(sample.get("lyrics") or "").strip() in ("", INSTRUMENTAL):
                problems.append(f"{name}: marked as having lyrics but none are present")
            if sample.get("sample_rate"):
                rates.add(int(sample["sample_rate"]))
            if sample.get("channels"):
                channels.add(int(sample["channels"]))

        for name, count in seen.items():
            if count > 1:
                problems.append(f"{name}: appears {count} times — later entries overwrite earlier ones")

        if not trigger:
            notes.append("No trigger word — you will have no reliable way to invoke this LoRA.")
        if len(samples) < 10:
            notes.append(f"Only {len(samples)} samples; ACE-Step's guidance suggests more epochs "
                         "(around 800) for datasets of 10-20 songs.")
        if len(rates) > 1:
            notes.append(f"Mixed sample rates {sorted(rates)} — all are resampled to ACE-Step's "
                         "target, so this is informational.")
        if channels and channels != {2}:
            notes.append(f"Channel counts {sorted(channels)}; the preprocessor loads stereo.")

        log.append(f"Samples : {len(samples)}")
        log.append(f"Audio   : {total/60:.1f} min total, {total/len(samples):.1f}s average")
        log.append(f"Trigger : {trigger or '(none)'}")
        log.append(f"Rates   : {sorted(rates) or 'unknown'}   Channels: {sorted(channels) or 'unknown'}")
        log.append("")
        if problems:
            log.append(f"{len(problems)} problem(s):")
            log.extend(f"  ! {p}" for p in problems[:40])
            if len(problems) > 40:
                log.append(f"  … and {len(problems) - 40} more")
            log.append("")
        if notes:
            log.append(f"{len(notes)} note(s):")
            log.extend(f"  - {n}" for n in notes)
            log.append("")
        log.append("READY — nothing blocking found." if not problems
                   else "NOT READY — fix the problems above first.")

        text = "\n".join(log)
        print(text)
        return {"ui": {"text": [text]},
                "result": (text, not problems, len(samples), len(problems))}


NODE_CLASS_MAPPINGS = {
    "NovaACEDatasetBuilder": NovaACEDatasetBuilder,
    "NovaACEDatasetReview": NovaACEDatasetReview,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaACEDatasetBuilder": "Nova ACE Dataset Builder 🧱",
    "NovaACEDatasetReview": "Nova ACE Dataset Review 🔍",
}
