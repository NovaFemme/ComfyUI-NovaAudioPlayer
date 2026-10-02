"""
Recorded setting sequences for decorative renderers.

A sequence is a macro: the user presses Record, plays with a renderer's
settings, presses Stop, and the player can later replay those changes with the
same timing — once, N times, or in a loop — while the music plays. Only
renderers that declare `sequences: true` in their module offer it (see
web/renderers/_template.js); the storage here knows nothing about any renderer
in particular.

WHERE THE FILES LIVE

    <ComfyUI>/user/nova_player/sequences/<renderer id>/<name>.json

ComfyUI's `user` folder, not the package: a reinstall or update replaces the
package directory and would take the user's recordings with it. `user` is
also where ComfyUI keeps workflows, so it is already what people back up. If
it is unavailable, `output` is used, then the package as a last resort. One
folder per renderer, because a sequence is a list of that renderer's settings
and means nothing to another one.

Users may copy files in and out by hand. So nothing here trusts a file's
contents beyond "it is JSON": the front end validates every setting against
the renderer's schema at play time and skips what does not fit.

FORMAT (version 1)

    {
      "format":   "nova-player-sequence",
      "version":  1,
      "renderer": "halo",
      "name":     "Spinning Fury",
      "created":  "2026-09-30T20:25:00+02:00",
      "start":    { "<setting>": <value>, ... },    # settings when Start was pressed
      "steps":    [ { "wait_ms": 1200, "key": "tilt", "value": 35 }, ... ],
      "end_ms":   3000                              # hold after the last change
    }

`wait_ms` is the time since the previous change (or since Start), which is how
the user thinks about it and what makes a file easy to edit by hand.

NAMES

A sequence's name is its filename. Names are cleaned to a safe character set
(letters, digits, space and - _ . ( ) ' & ,), and never allowed to escape the
folder: every path is resolved and checked to stay inside it. A save never
overwrites — a clash becomes "Name (2)" — so a copied-in file with the same
name as a new recording is never lost.
"""

import json
import logging
import os
import re
import tempfile
import threading
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("NovaAudioPlayer")

FORMAT = "nova-player-sequence"
VERSION = 1

MAX_FILE_BYTES = 2 * 1024 * 1024      # a sequence is small; this is a sanity cap
MAX_STEPS = 50_000                     # hours of fiddling, far beyond real use
MAX_NAME = 80

_RENDERER_ID = r"^[a-z0-9_]{1,40}$"
_NAME_BAD = r"[^0-9A-Za-z _\-.()'&,]"


def clean_name(name: Any) -> str:
    """A filename-safe version of a sequence name, or "" if nothing is left."""
    text = re.sub(_NAME_BAD, "", str(name or ""))
    text = re.sub(r"\s+", " ", text).strip().strip(".")
    return text[:MAX_NAME].strip()


def valid_renderer_id(renderer_id: Any) -> bool:
    return isinstance(renderer_id, str) and bool(re.match(_RENDERER_ID, renderer_id))


def default_root() -> str:
    """The sequences root: ComfyUI's user folder, then output, then the package."""
    override = os.environ.get("NOVA_SEQUENCES_DIR")
    if override:
        return override
    try:
        import folder_paths  # only exists inside ComfyUI (stubbed by the devserver)
        for getter in ("get_user_directory", "get_output_directory"):
            try:
                base = getattr(folder_paths, getter)()
                if base and os.path.isdir(base):
                    return os.path.join(base, "nova_player", "sequences")
            except Exception:
                continue
    except ImportError:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "sequences")


def summarise(data: Any) -> Dict[str, Any]:
    """Step count and total length, tolerating anything a hand-edited file holds."""
    steps = data.get("steps") if isinstance(data, dict) else None
    steps = steps if isinstance(steps, list) else []
    total = 0.0
    for s in steps:
        w = s.get("wait_ms") if isinstance(s, dict) else None
        if isinstance(w, (int, float)) and not isinstance(w, bool) and w > 0:
            total += w
    end = data.get("end_ms") if isinstance(data, dict) else None
    if isinstance(end, (int, float)) and not isinstance(end, bool) and end > 0:
        total += end
    return {"steps": len(steps), "duration_ms": int(total)}


class SequenceStore:
    def __init__(self, root: Optional[str] = None):
        self._root = root
        self._lock = threading.Lock()

    @property
    def root(self) -> str:
        return self._root or default_root()

    # -- paths -------------------------------------------------------------

    def folder(self, renderer_id: str) -> str:
        return os.path.join(self.root, renderer_id)

    def _path(self, renderer_id: str, name: str) -> Optional[str]:
        """The file for a name, or None if the id/name is unusable or escapes."""
        if not valid_renderer_id(renderer_id):
            return None
        cleaned = clean_name(name)
        if not cleaned or cleaned != str(name).strip():
            return None
        folder = os.path.realpath(self.folder(renderer_id))
        path = os.path.realpath(os.path.join(folder, cleaned + ".json"))
        if os.path.dirname(path) != folder:
            return None
        return path

    # -- operations ----------------------------------------------------------

    def list(self, renderer_id: str) -> Tuple[bool, Any]:
        if not valid_renderer_id(renderer_id):
            return False, "Invalid renderer id"
        folder = self.folder(renderer_id)
        items: List[Dict[str, Any]] = []
        try:
            names = os.listdir(folder)
        except FileNotFoundError:
            names = []
        except OSError as e:
            return False, f"Cannot read {folder}: {e}"
        for fname in names:
            if not fname.lower().endswith(".json") or fname.startswith("."):
                continue
            name = fname[:-5]
            path = os.path.join(folder, fname)
            item: Dict[str, Any] = {"name": name}
            try:
                item["modified"] = int(os.path.getmtime(path))
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    raise ValueError("file too large")
                with open(path, "r", encoding="utf-8") as f:
                    item.update(summarise(json.load(f)))
            except (OSError, ValueError) as e:
                # Listed anyway, so a broken file can still be seen and deleted.
                item["error"] = str(e)[:120]
            items.append(item)
        items.sort(key=lambda i: i["name"].lower())
        return True, {"folder": folder, "items": items}

    def read(self, renderer_id: str, name: str) -> Tuple[bool, Any]:
        path = self._path(renderer_id, name)
        if not path:
            return False, "Invalid name"
        try:
            if os.path.getsize(path) > MAX_FILE_BYTES:
                return False, "File too large"
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return False, "Not found"
        except (OSError, ValueError) as e:
            return False, f"Unreadable: {e}"
        if not isinstance(data, dict):
            return False, "Not a sequence (expected a JSON object)"
        return True, data

    def save(self, renderer_id: str, name: str, data: Any) -> Tuple[bool, Any]:
        if not valid_renderer_id(renderer_id):
            return False, "Invalid renderer id"
        base = clean_name(name)
        if not base:
            return False, "Please give the sequence a name"
        if not isinstance(data, dict):
            return False, "Sequence must be a JSON object"
        steps = data.get("steps")
        if not isinstance(steps, list):
            return False, "Sequence has no steps list"
        if len(steps) > MAX_STEPS:
            return False, f"Too many steps ({len(steps)} > {MAX_STEPS})"

        doc = dict(data)
        doc.update({"format": FORMAT, "version": VERSION, "renderer": renderer_id})
        body = json.dumps(doc, indent=1, ensure_ascii=False)
        if len(body.encode("utf-8")) > MAX_FILE_BYTES:
            return False, "Sequence is too large to save"

        folder = self.folder(renderer_id)
        with self._lock:
            try:
                os.makedirs(folder, exist_ok=True)
            except OSError as e:
                return False, f"Cannot create {folder}: {e}"
            final = base
            n = 2
            while os.path.exists(os.path.join(folder, final + ".json")):
                suffix = f" ({n})"
                final = base[:MAX_NAME - len(suffix)].rstrip() + suffix
                n += 1
            doc["name"] = final
            body = json.dumps(doc, indent=1, ensure_ascii=False)
            path = self._path(renderer_id, final)
            if not path:
                return False, "Invalid name"
            try:
                fd, tmp = tempfile.mkstemp(dir=folder, prefix=".seq.", suffix=".tmp")
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(body)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
            except OSError as e:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
                return False, f"Could not write the file: {e}"
        logger.info("[NovaAudioPlayer] saved sequence %s/%s", renderer_id, final)
        return True, {"name": final, "folder": folder}

    def delete(self, renderer_id: str, name: str) -> Tuple[bool, str]:
        path = self._path(renderer_id, name)
        if not path:
            return False, "Invalid name"
        with self._lock:
            try:
                os.remove(path)
            except FileNotFoundError:
                return False, "Not found"
            except OSError as e:
                return False, f"Could not delete: {e}"
        return True, "Deleted"


store = SequenceStore()
