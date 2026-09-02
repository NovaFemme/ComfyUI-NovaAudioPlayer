"""Preset storage — one JSON file per preset, on disk beside the package.

NOT the database, deliberately. Presets want to be shareable, git-trackable and
hand-editable; runs want to be queryable. Different data, different lifecycle,
and a preset that can be edited in a text editor and picked up on reload is
worth more to a human than one locked in a table.

Names are used as filenames, so they are validated rather than trusted: this
data arrives over HTTP.
"""

import json
import os
import re
from datetime import datetime, timezone

SCHEMA_VER = 1

# Conservative on purpose. A preset name becomes a filename, and the set of
# characters that are safe in a filename on every platform the pack might run
# on is smaller than the set that looks harmless.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$")

PRESET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "presets")


def _dir():
    d = os.path.abspath(PRESET_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def valid_name(name):
    """A name that is safe as a filename and cannot escape the preset dir."""
    if not isinstance(name, str) or not _NAME_RE.match(name):
        return False
    # Belt and braces: the regex already excludes separators and dot-dot, but
    # this is the check that actually matters and it is cheap.
    return name not in (".", "..") and "/" not in name and "\\" not in name


def _path(name):
    if not valid_name(name):
        return None
    d = _dir()
    p = os.path.abspath(os.path.join(d, f"{name}.json"))
    # Even with a validated name, confirm the resolved path stayed inside.
    if os.path.commonpath([d, p]) != d:
        return None
    return p


def list_presets():
    """[{name, note, created}] — sorted, and tolerant of a bad file.

    One unparseable preset must not hide every other one from the dropdown.
    """
    out = []
    try:
        names = os.listdir(_dir())
    except OSError:
        return out
    for fn in sorted(names):
        if not fn.endswith(".json"):
            continue
        name = fn[:-5]
        try:
            with open(os.path.join(_dir(), fn), "r", encoding="utf-8") as f:
                data = json.load(f)
            out.append({
                "name": data.get("name", name),
                "note": data.get("note", ""),
                "created": data.get("created", ""),
            })
        except Exception:                                     # noqa: BLE001
            out.append({"name": name, "note": "(unreadable)", "created": ""})
    return out


def load(name):
    """Full preset JSON, or None. Read fresh every time, never cached.

    Hand-editing a preset file and reloading is a supported workflow; a cache
    would silently serve the old values and make that look broken.
    """
    p = _path(name)
    if not p or not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:                                  # noqa: BLE001
        print(f"[MadowInputs] preset '{name}' is unreadable: {exc}")
        return None


def save(name, params, note="", excludes=None):
    """Write a preset. Returns (ok, message)."""
    if not valid_name(name):
        return False, ("Name must be 1-64 characters, letters/digits first, "
                       "then letters, digits, spaces, dot, dash or underscore")
    if not isinstance(params, dict) or not params:
        return False, "No parameters to save"
    p = _path(name)
    if p is None:
        return False, "Invalid preset name"
    body = {
        "schema_ver": SCHEMA_VER,
        "name": name,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": str(note or ""),
        "params": params,
        "excludes": list(excludes) if excludes is not None else [],
    }
    try:
        # Write-then-rename, so an interrupted save cannot leave a truncated
        # file where a working preset used to be.
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2, ensure_ascii=False)
        os.replace(tmp, p)
    except OSError as exc:
        return False, f"Could not write preset: {exc}"
    return True, f"Saved '{name}'"


def delete(name):
    p = _path(name)
    if p is None:
        return False, "Invalid preset name"
    if not os.path.exists(p):
        return False, f"No preset named '{name}'"
    try:
        os.remove(p)
    except OSError as exc:
        return False, f"Could not delete preset: {exc}"
    return True, f"Deleted '{name}'"
