"""Per-profile weights for Nova Track Inspector.

WHY THESE ARE NOT STORED IN THE MADOW PRESET FILE
-------------------------------------------------
The obvious design is to add a "track_inspector" block to the Madow preset and
be done. It does not survive: ``madow/presets.py::save`` rebuilds the file body
from six fixed keys (schema_ver, name, created, note, params, excludes), so any
extra top-level key is dropped the first time the user saves that preset from
Madow's UI. The weights would work until they silently vanished.

So the NAMES are shared and the VALUES are not. The dropdown is built from
Madow's preset directory, so the two lists cannot drift apart, while the weights
live in profiles/track_inspector/<name>.json, which Madow never writes.

A profile holds only the keys it wants to override. Anything absent falls back
to the node's own widget value, so a profile can carry a single number without
having to restate the other eight.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

NONE_LABEL = "— none —"
SCHEMA_VER = 1

_PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MADOW_PRESETS = os.path.join(_PACK, "presets")
_WEIGHTS_DIR = os.path.join(_PACK, "profiles", "track_inspector")

#: The nine controls a profile may override. Anything else in the file is
#: ignored rather than trusted — a typo must not silently become a weight.
KEYS = (
    "consistency_threshold", "consistency_weight",
    "excursion_seconds", "excursion_weight", "repeat_allowance",
    "step_z_threshold", "step_weight",
    "loudness_weight", "provisional_authority",
)

#: Deliberately one character WIDER than Madow's save pattern: '#' is excluded
#: there, but 80 bulk-generated presets are named for sharp keys (C# major,
#: F# minor) and Madow's dropdown lists them because it does not validate on
#: read. Matching that keeps the two lists identical, which is the whole point
#: of sharing the names. '#' has no meaning to the filesystem, and the real
#: guard against a crafted name is the containment check in _path(), not this.
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-#]{0,63}$")

_LIMITS = {
    "consistency_threshold": (0.0, 0.5), "consistency_weight": (0.0, 1.0),
    "excursion_seconds": (0.0, 120.0), "excursion_weight": (0.0, 1.0),
    "repeat_allowance": (0.0, 1.0), "step_z_threshold": (0.0, 20.0),
    "step_weight": (0.0, 1.0), "loudness_weight": (0.0, 1.0),
    "provisional_authority": (0.0, 1.0),
}


def valid_name(name: Any) -> bool:
    return (isinstance(name, str) and bool(_NAME.match(name))
            and name not in (".", "..") and "/" not in name and "\\" not in name)


def profile_names() -> List[str]:
    """Madow's preset names, by filename only.

    Deliberately does NOT parse the files. Madow's own list_presets() opens all
    of them to read their notes; this runs inside INPUT_TYPES, which ComfyUI
    calls on every node-definition refresh, and there are several hundred.
    """
    try:
        names = [f[:-5] for f in os.listdir(_MADOW_PRESETS) if f.endswith(".json")]
    except OSError:
        return []
    return sorted(n for n in names if valid_name(n))


def combo_choices() -> List[str]:
    return [NONE_LABEL] + profile_names()


def _path(name: str) -> Optional[str]:
    if not valid_name(name):
        return None
    root = os.path.abspath(_WEIGHTS_DIR)
    p = os.path.abspath(os.path.join(root, f"{name}.json"))
    # The name pattern already excludes separators; this is the check that
    # actually decides, and it costs nothing.
    if os.path.commonpath([root, p]) != root:
        return None
    return p


def load(name: str) -> Dict[str, float]:
    """Overrides for `name`, or {} when there are none.

    A malformed file yields {} rather than raising: a bad profile must not stop
    a track being inspected, it must only fail to change anything.
    """
    if not name or name == NONE_LABEL:
        return {}
    p = _path(name)
    if not p or not os.path.isfile(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:                                          # noqa: BLE001
        return {}
    weights = data.get("weights") if isinstance(data, dict) else None
    if not isinstance(weights, dict):
        return {}
    out: Dict[str, float] = {}
    for k in KEYS:
        if k not in weights:
            continue
        try:
            v = float(weights[k])
        except (TypeError, ValueError):
            continue
        lo, hi = _LIMITS[k]
        out[k] = float(min(max(v, lo), hi))
    return out


def save(name: str, values: Dict[str, Any]) -> bool:
    """Write the nine controls for `name`. Returns True on success."""
    p = _path(name)
    if not p:
        return False
    body = {
        "schema_ver": SCHEMA_VER,
        "name": name,
        "note": "Nova Track Inspector weights. Shares its name with the Madow "
                "preset of the same name; Madow never reads or writes this file.",
        "weights": {k: float(values[k]) for k in KEYS if k in values},
    }
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2, ensure_ascii=False)
        os.replace(tmp, p)                 # never leave a truncated profile
        return True
    except OSError:
        return False
