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

from .comfy_types import kind_for
from .params import DEFAULTS, KEYS

SCHEMA_VER = 1

# Conservative on purpose. A preset name becomes a filename, and the set of
# characters that are safe in a filename on every platform the pack might run
# on is smaller than the set that looks harmless.
# A string, matched through the module function — see the note above
# _HEX_PATTERN in nova_player/config_manager.py.
_NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$"

PRESET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "presets")


def _dir():
    d = os.path.abspath(PRESET_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def valid_name(name):
    """A name that is safe as a filename and cannot escape the preset dir."""
    if not isinstance(name, str) or not re.match(_NAME_PATTERN, name):
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


# Presets written before `timesignature`, `language` and `keyscale` became
# combo parameters hold values ACE-Step's encoder will not accept: the integer
# 4, the word "english", an empty key. They are still perfectly good presets,
# so they are migrated on read rather than rejected -- but only where the
# intent is unambiguous.
#
# Full English names are mapped because that is what a human writes, and
# because a preset saying "english" plainly meant `en`. Anything else falls
# back to the parameter default and says so: a preset carrying a value the
# encoder would refuse is not worth preserving faithfully.
_LANGUAGE_ALIASES = {
    "english": "en", "japanese": "ja", "chinese": "zh", "mandarin": "zh",
    "spanish": "es", "german": "de", "french": "fr", "portuguese": "pt",
    "russian": "ru", "italian": "it", "dutch": "nl", "polish": "pl",
    "turkish": "tr", "vietnamese": "vi", "czech": "cs", "persian": "fa",
    "farsi": "fa", "indonesian": "id", "korean": "ko", "ukrainian": "uk",
    "hungarian": "hu", "arabic": "ar", "swedish": "sv", "romanian": "ro",
    "greek": "el",
}


def _coerce_one(key, value):
    """(value, note) — a value inside the parameter's combo domain."""
    options = kind_for(key)
    if not isinstance(options, list):
        return value, None
    if isinstance(value, str) and value in options:
        return value, None

    # The integer 4 and the string "4" are the same time signature.
    text = str(value).strip()
    if text in options:
        return text, f"{key}: {value!r} -> {text!r}"

    lowered = text.lower()
    alias = _LANGUAGE_ALIASES.get(lowered)
    if alias and alias in options:
        return alias, f"{key}: {value!r} -> {alias!r}"

    # Case and spacing only, for key names: "d minor" is D minor.
    squashed = lowered.replace(" ", "")
    for opt in options:
        if opt.lower().replace(" ", "") == squashed:
            return opt, f"{key}: {value!r} -> {opt!r}"

    fallback = DEFAULTS[key]
    return fallback, (f"{key}: {value!r} is not one of ACE-Step's options "
                      f"— using {fallback!r}")


def coerce(params):
    """(params, notes) with every combo parameter inside its domain.

    Returns a NEW dict; the caller's is not mutated, because the same preset
    body is compared against the widgets for `preset_dirty` and quietly
    rewriting it under the comparison would make a clean preset look dirty.
    """
    out = dict(params or {})
    notes = []
    for key in KEYS:
        if key not in out:
            continue
        value, note = _coerce_one(key, out[key])
        out[key] = value
        if note:
            notes.append(note)
    return out, notes


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
            data = json.load(f)
        if isinstance(data.get("params"), dict):
            data["params"], notes = coerce(data["params"])
            if notes:
                data["coerced"] = notes
                print(f"[MadowInputs] preset '{name}' migrated: "
                      + "; ".join(notes))
        return data
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
