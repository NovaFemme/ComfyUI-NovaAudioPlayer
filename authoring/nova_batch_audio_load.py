"""
nova_batch_audio_load.py — enumerate a folder of audio files as one batch.

The sibling of Nova Load Audio: same decoding stack (soundfile → torchaudio →
PyAV) and the same header/tag probing, but pointed at a folder rather than a
single file, and with decoding OFF by default.

That default matters. The authoring nodes downstream write and read tags, which
needs file paths and nothing else — decoding a folder of FLACs into RAM first
would be pure waste. Flip `decode_audio` on only when you actually want the
batched AUDIO output.

Batching caveat, unavoidable in ComfyUI: an AUDIO payload is a single
[batch, channels, samples] tensor, so files must agree on sample rate and be
padded to the longest. Files whose sample rate differs from the first decoded
file are left out of the tensor (they stay in the file list) and the exclusion
is recorded in `metadata`.
"""

import fnmatch
import json
import os
from typing import Any, Dict, List

import torch

try:
    from .nova_authoring_common import (
        UTILITY_CATEGORY, AUTHORING_VERSION, FILES_TYPE, describe_file, make_files,
    )
    from .nova_load_audio import (
        AUDIO_EXTENSIONS, _channel_layout, _decode, _hms, _probe_header,
        _read_tags, _resolve_bit_depth,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        UTILITY_CATEGORY, AUTHORING_VERSION, FILES_TYPE, describe_file, make_files,
    )
    from nova_load_audio import (
        AUDIO_EXTENSIONS, _channel_layout, _decode, _hms, _probe_header,
        _read_tags, _resolve_bit_depth,
    )

try:
    import folder_paths  # type: ignore
except Exception:  # pragma: no cover - outside ComfyUI
    folder_paths = None

SILENT_AUDIO = {"waveform": torch.zeros(1, 1, 1, dtype=torch.float32), "sample_rate": 44100}


def _default_root() -> str:
    if folder_paths is not None:
        try:
            return folder_paths.get_input_directory()
        except Exception:
            pass
    return os.path.join(os.getcwd(), "input")


def _matches(name: str, patterns: List[str]) -> bool:
    if not patterns:
        return os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, p) for p in patterns)


def _scan(root: str, patterns: List[str], recursive: bool) -> List[str]:
    found: List[str] = []
    if recursive:
        for base, _dirs, names in os.walk(root):
            for name in names:
                if _matches(name, patterns):
                    found.append(os.path.join(base, name))
    else:
        try:
            for name in os.listdir(root):
                full = os.path.join(root, name)
                if os.path.isfile(full) and _matches(name, patterns):
                    found.append(full)
        except OSError as exc:
            raise FileNotFoundError(
                f"Nova Batch Load Audio: cannot list {root} — {exc}"
            ) from exc
    return found


def _probe(path: str) -> Dict[str, Any]:
    """Header/tag level facts only — no decoding, so this stays cheap."""
    info: Dict[str, Any] = {}
    try:
        header = _probe_header(path)
        tags, tag_info, _source = _read_tags(path)
        bit_depth, label, lossy, _origin = _resolve_bit_depth(header, {}, tag_info)
        info["bit_depth"] = int(bit_depth)
        info["bit_depth_label"] = label
        info["lossy"] = bool(lossy)
        rate = header.get("sample_rate") or tag_info.get("sample_rate")
        if rate:
            info["sample_rate"] = int(rate)
        channels = header.get("channels") or tag_info.get("channels")
        if channels:
            info["channels"] = int(channels)
            info["channel_layout"] = _channel_layout(int(channels))
        length = tag_info.get("length")
        if length:
            info["duration_seconds"] = round(float(length), 6)
            info["duration_hms"] = _hms(float(length))
        elif header.get("frames") and rate:
            seconds = float(header["frames"]) / float(rate)
            info["duration_seconds"] = round(seconds, 6)
            info["duration_hms"] = _hms(seconds)
        if tags:
            info["tags"] = tags
    except Exception as exc:  # never let a probe failure lose the file
        info["probe_error"] = f"{type(exc).__name__}: {exc}"
    return info


def _stack(decoded: List[Dict[str, Any]], warnings: List[str]):
    """Pad to the longest and unify channels; drop sample-rate outliers."""
    if not decoded:
        return SILENT_AUDIO, []
    rate = decoded[0]["sample_rate"]
    usable, excluded = [], []
    for item in decoded:
        (usable if item["sample_rate"] == rate else excluded).append(item)
    for item in excluded:
        warnings.append(
            f"{os.path.basename(item['path'])} is {item['sample_rate']} Hz, batch is "
            f"{rate} Hz — kept in the file list, left out of the AUDIO tensor."
        )
    if not usable:
        return SILENT_AUDIO, []

    channels = max(i["waveform"].shape[0] for i in usable)
    samples = max(i["waveform"].shape[-1] for i in usable)
    batch = torch.zeros(len(usable), channels, samples, dtype=torch.float32)
    for index, item in enumerate(usable):
        wav = item["waveform"]
        if wav.shape[0] == 1 and channels > 1:
            wav = wav.repeat(channels, 1)          # mono fans out to every channel
        batch[index, : wav.shape[0], : wav.shape[-1]] = wav[:channels, :samples]
    return {"waveform": batch, "sample_rate": int(rate)}, [i["path"] for i in usable]


class NovaBatchLoadAudio:
    CATEGORY = UTILITY_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = (FILES_TYPE, "AUDIO", "INT", "STRING", "STRING")
    RETURN_NAMES = ("files", "audio", "file_count", "filenames", "metadata")
    OUTPUT_IS_LIST = (False, False, False, True, False)
    OUTPUT_TOOLTIPS = (
        "The batch of files, for Nova Tag Writer / Nova Tag Reader.",
        "Batched waveform [files, channels, samples] — only meaningful with decode_audio on.",
        "How many files were matched.",
        "File names, as a list output (one string per file).",
        "JSON: per-file facts, the scan settings, and any warnings.",
    )
    DESCRIPTION = (
        f"Nova Batch Load Audio v{AUTHORING_VERSION} — lists a folder of audio files "
        "as one batch with per-file metadata. Decoding is off by default; the tag "
        "nodes only need paths."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Folder of audio files (empty = ComfyUI/input)",
                    "tooltip": "Folder to scan. Empty falls back to ComfyUI's input directory.",
                }),
                "file_filter": ("STRING", {
                    "default": "*.flac",
                    "multiline": False,
                    "tooltip": "Comma-separated glob patterns, e.g. *.flac, *.wav. Empty matches every known audio extension.",
                }),
                "recursive": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Include sub-folders.",
                }),
                "sort_by": (["name", "modified", "size"], {
                    "default": "name",
                    "tooltip": "Batch order. Tag rows are matched by file name, not by position, so this is for your convenience.",
                }),
                "limit": ("INT", {
                    "default": 0, "min": 0, "max": 100000, "step": 1,
                    "tooltip": "Stop after this many files. 0 = no limit.",
                }),
                "decode_audio": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Off: paths + metadata only (fast). On: also decode every file into the batched AUDIO output.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, folder_path, file_filter, recursive, sort_by, limit, decode_audio, **kwargs):
        root = (folder_path or "").strip() or _default_root()
        patterns = [p.strip().lower() for p in (file_filter or "").split(",") if p.strip()]
        try:
            names = sorted(
                f"{p}:{os.stat(p).st_mtime_ns}:{os.stat(p).st_size}"
                for p in _scan(root, patterns, bool(recursive))
            )
            stamp = "|".join(names)
        except Exception:
            stamp = f"unscannable:{root}"
        return f"{stamp}|{sort_by}|{limit}|{decode_audio}"

    def load(self, folder_path, file_filter, recursive, sort_by, limit, decode_audio, **kwargs):
        raw_root = (folder_path or "").strip().strip('"').strip("'")
        root = os.path.abspath(os.path.expanduser(os.path.expandvars(raw_root))) if raw_root else _default_root()
        if not os.path.isdir(root):
            raise NotADirectoryError(f"Nova Batch Load Audio: {root} is not a folder.")

        patterns = [p.strip().lower() for p in (file_filter or "").split(",") if p.strip()]
        paths = _scan(root, patterns, bool(recursive))

        if sort_by == "modified":
            paths.sort(key=lambda p: (os.path.getmtime(p), p.lower()))
        elif sort_by == "size":
            paths.sort(key=lambda p: (os.path.getsize(p), p.lower()))
        else:
            paths.sort(key=lambda p: p.lower())
        if int(limit) > 0:
            paths = paths[: int(limit)]

        warnings: List[str] = []
        entries: List[Dict[str, Any]] = [describe_file(p, _probe(p)) for p in paths]

        audio = SILENT_AUDIO
        decoded_paths: List[str] = []
        if decode_audio and paths:
            decoded: List[Dict[str, Any]] = []
            for path in paths:
                try:
                    wav, rate, _info, _attempts = _decode(path)
                    decoded.append({"path": path, "waveform": wav, "sample_rate": int(rate)})
                except Exception as exc:
                    warnings.append(f"{os.path.basename(path)}: could not decode — {exc}")
            audio, decoded_paths = _stack(decoded, warnings)
        elif decode_audio:
            warnings.append("decode_audio is on but no files matched.")
        else:
            warnings.append(
                "decode_audio is off — the AUDIO output is a one-sample silent "
                "placeholder. Turn it on if you need real waveforms."
            )

        if not paths:
            warnings.append(
                f"No files matched {file_filter or '(any audio extension)'} in {root}."
            )

        metadata = {
            "schema": "nova.authoring.batch_load",
            "schema_version": 1,
            "node_version": AUTHORING_VERSION,
            "scan": {
                "root": root,
                "file_filter": file_filter,
                "patterns": patterns or ["<any known audio extension>"],
                "recursive": bool(recursive),
                "sort_by": sort_by,
                "limit": int(limit),
            },
            "decode": {
                "requested": bool(decode_audio),
                "decoded_files": len(decoded_paths),
                "batch_shape": list(audio["waveform"].shape),
                "sample_rate": int(audio["sample_rate"]),
                "padded_to_longest": bool(decoded_paths),
            },
            "file_count": len(entries),
            "files": entries,
            "warnings": warnings,
        }

        print(f"[Nova Batch Load Audio] {len(entries)} file(s) from {root}"
              + (f", {len(decoded_paths)} decoded" if decode_audio else ""))

        return (
            make_files(root, entries, decoded=bool(decoded_paths)),
            audio,
            len(entries),
            [e["name"] for e in entries],
            json.dumps(metadata, indent=2, ensure_ascii=False, allow_nan=False),
        )


NODE_CLASS_MAPPINGS = {"NovaBatchLoadAudio": NovaBatchLoadAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaBatchLoadAudio": "Nova Batch Load Audio 🎼"}
