"""
nova_tag_reader.py — read tags back off a NOVA_FILES batch.

The node form of tags_read_flac.py. Same purpose — prove the tags actually
landed — but it reads whatever the file really carries rather than assuming a
fixed set of Vorbis keys, so a missing field reports as missing instead of
raising KeyError halfway through the listing.

Chain it straight after Nova Tag Writer (which passes its batch through) to
verify a write in the same run.
"""

import json
import os
from typing import Any, Dict, List

try:
    from .nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, FILES_TYPE,
        banner, file_paths, render_value,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, FILES_TYPE,
        banner, file_paths, render_value,
    )

DEFAULT_FIELDS = "tracknumber, title, artist, album, date, genre, comment, copyright, encodedby, lyrics"

# Reverse of the writer's mapping, so an ID3 or MP4 file reports under the same
# names a FLAC would.
NORMALISE = {
    "tit2": "title", "tpe1": "artist", "talb": "album", "tdrc": "date",
    "tcon": "genre", "trck": "tracknumber", "tpos": "discnumber",
    "tcop": "copyright", "tenc": "encodedby", "tpe2": "albumartist",
    "tcom": "composer", "comm": "comment", "uslt": "lyrics",
    "\xa9nam": "title", "\xa9art": "artist", "\xa9alb": "album",
    "\xa9day": "date", "\xa9gen": "genre", "\xa9cmt": "comment",
    "\xa9lyr": "lyrics", "cprt": "copyright", "\xa9too": "encodedby",
    "aart": "albumartist", "\xa9wrt": "composer", "trkn": "tracknumber",
}


def _normalise_key(key: str) -> str:
    text = str(key).strip().lower()
    if text.startswith("----:com.apple.itunes:"):
        text = text.split(":")[-1]
    base = text.split(":")[0]
    return NORMALISE.get(base, NORMALISE.get(text, text))


def _flatten(value: Any) -> str:
    """MP4 stores trkn/disk as (number, total) pairs; show them the way a
    Vorbis or ID3 file would."""
    if isinstance(value, tuple):
        parts = [p for p in value if isinstance(p, int)]
        if len(parts) == 2:
            return f"{parts[0]}/{parts[1]}" if parts[1] else str(parts[0])
        return "/".join(str(p) for p in parts) if parts else str(value)
    return str(value)


def _read_one(path: str) -> Dict[str, Any]:
    import mutagen

    handle = mutagen.File(path)
    if handle is None:
        raise ValueError("mutagen has no reader for this container")

    tags: Dict[str, Any] = {}
    raw = getattr(handle, "tags", None)
    if raw:
        try:
            items = raw.items()
        except Exception:
            items = []
        for key, value in items:
            name = _normalise_key(key)
            if name in ("apic", "covr", "metadata_block_picture"):
                tags[name] = "<embedded picture>"
                continue
            if isinstance(value, list):
                cleaned = [_flatten(v) for v in value]
                tags[name] = cleaned[0] if len(cleaned) == 1 else cleaned
            else:
                tags[name] = _flatten(value)

    info = getattr(handle, "info", None)
    technical = {}
    if info is not None:
        for attr in ("length", "channels", "sample_rate", "bits_per_sample", "bitrate"):
            if hasattr(info, attr):
                technical[attr] = getattr(info, attr)
    return {"tags": tags, "info": technical}


class NovaTagReader:
    CATEGORY = AUTHORING_CATEGORY
    FUNCTION = "read"
    RETURN_TYPES = ("STRING", "STRING", "INT", FILES_TYPE)
    RETURN_NAMES = ("console", "tags_json", "file_count", "files")
    OUTPUT_TOOLTIPS = (
        "Formatted tag listing — wire this into Nova Console.",
        "Every tag found, per file, as JSON.",
        "How many files were read.",
        "The same batch, passed through.",
    )
    DESCRIPTION = (
        f"Nova Tag Reader v{AUTHORING_VERSION} — lists the tags actually stored on "
        "each file in the batch."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "files": (FILES_TYPE, {"tooltip": "Batch from Nova Batch Load Audio, or passed through from Nova Tag Writer."}),
                "fields": ("STRING", {
                    "default": DEFAULT_FIELDS,
                    "multiline": False,
                    "tooltip": "Comma-separated tag names to list, in this order. Use * to list every tag the file carries.",
                }),
                "show_missing": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Report requested fields the file does not carry, instead of quietly omitting them.",
                }),
                "max_value_chars": ("INT", {
                    "default": 160, "min": 0, "max": 100000, "step": 10,
                    "tooltip": "Truncate long values (lyrics!) in the console text. 0 = no limit. tags_json is never truncated.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # always re-read; the files may have just been written

    def read(self, files, fields, show_missing, max_value_chars, **kwargs):
        paths = file_paths(files)
        requested = [f.strip().lower() for f in (fields or "").split(",") if f.strip()]
        want_all = not requested or "*" in requested

        log: List[str] = [banner(f"NOVA TAG READER v{AUTHORING_VERSION}")]
        log.append(f"Batch : {(files or {}).get('root', '(none)')}  ({len(paths)} file(s))")
        log.append("")

        payload: Dict[str, Any] = {}
        read_count = 0

        if not paths:
            log.append("Nothing to do: the batch has no files.")
            return ("\n".join(log), "{}", 0, files)

        for path in paths:
            name = os.path.basename(path)
            if not os.path.isfile(path):
                log.append(f"File not found: {path}")
                log.append("")
                continue
            try:
                result = _read_one(path)
            except Exception as exc:
                log.append(f"Could not read tags, skipping: {name} ({exc})")
                log.append("")
                continue

            tags = result["tags"]
            payload[name] = result
            read_count += 1

            log.append(f"--- {name}")
            names = sorted(tags) if want_all else requested
            for field in names:
                if field in tags:
                    label = field.title() if field.islower() else field
                    log.append(f"{label}: {render_value(tags[field], max_value_chars)}")
                elif show_missing and not want_all:
                    log.append(f"{field.title()}: <not set>")

            info = result["info"]
            if info.get("length"):
                log.append(f"Length: {float(info['length']):.2f}s "
                           f"(from the audio stream, not a tag)")
            log.append(f"Successfully read tags: {name}")
            log.append("")

        log.append(f"Processing complete!  read={read_count}  of {len(paths)} file(s)")

        text = "\n".join(log)
        print(text)
        return (
            text,
            json.dumps(payload, indent=2, ensure_ascii=False, default=str),
            read_count,
            files,
        )


NODE_CLASS_MAPPINGS = {"NovaTagReader": NovaTagReader}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaTagReader": "Nova Tag Reader 🔖"}
