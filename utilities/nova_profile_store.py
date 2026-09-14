"""
nova_profile_store.py — named path profiles, one JSON file per profile.

Same shape as madow/presets.py and for the same reasons: a profile that can be
opened in a text editor, committed to git and shared with a collaborator is
worth more than one locked in a database or in browser storage.

Names become filenames, so they are validated rather than trusted — this data
can arrive over HTTP through the read-only listing route.

Writes are atomic (temp file in the same directory, fsync, os.replace), so an
interrupted save leaves either the old profile or the new one, never half of
either.
"""

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 1

# Conservative on purpose, and identical to the pack's preset rule: the set of
# characters safe in a filename on every platform this pack might run on is
# smaller than the set that merely looks harmless.
_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$")

PROFILE_DIRNAME = os.path.join("profiles", "namepath")

NONE_LABEL = "— none —"


def profile_dir() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, PROFILE_DIRNAME)
    os.makedirs(path, exist_ok=True)
    return path


def valid_name(name: Any) -> bool:
    """A name that is safe as a filename and cannot escape the profile dir."""
    if not isinstance(name, str) or not _NAME_PATTERN.match(name):
        return False
    # Belt and braces: the pattern already excludes separators and dot-dot, but
    # this is the check that actually matters and it costs nothing.
    return name not in (".", "..") and "/" not in name and "\\" not in name


def _path_for(name: str) -> str:
    return os.path.join(profile_dir(), f"{name}.json")


def list_profiles() -> List[str]:
    try:
        names = [
            os.path.splitext(f)[0]
            for f in os.listdir(profile_dir())
            if f.endswith(".json") and not f.startswith(".")
        ]
    except OSError:
        return []
    return sorted((n for n in names if valid_name(n)), key=str.lower)


def combo_choices() -> List[str]:
    """Profile names for a COMBO widget; never empty, so the widget renders."""
    return [NONE_LABEL, *list_profiles()]


def load(name: str) -> Optional[Dict[str, Any]]:
    if not valid_name(name):
        return None
    try:
        with open(_path_for(name), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    values = data.get("values")
    return values if isinstance(values, dict) else None


def save(name: str, values: Dict[str, Any]) -> bool:
    if not valid_name(name) or not isinstance(values, dict):
        return False
    payload = {
        "schema": "nova.namepath.profile",
        "schema_version": SCHEMA_VERSION,
        "name": name,
        "saved_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "values": values,
    }
    target = _path_for(name)
    directory = os.path.dirname(target)
    try:
        handle_fd, tmp_path = tempfile.mkstemp(
            dir=directory, prefix=f".{name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, target)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError:
        return False
    return True
