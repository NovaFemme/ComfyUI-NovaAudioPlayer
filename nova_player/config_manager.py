"""
NovaConfigManager — loads, validates, caches and persists the two JSON config
files, and serves them to the front end.

Design rules, in priority order:

1. A missing, empty or malformed config file must NEVER stop the node from
   loading.  Every read deep-merges over the built-in defaults in defaults.py,
   so the worst case is "you get the defaults and a loud log line".
2. Writes are atomic (temp file + os.replace) and serialised behind a lock.
   A half-written color_config.json from an interrupted save is a bad way to
   lose a theme.
3. Every write bumps `version`.  The front end polls GET .../config/version
   (a few bytes) rather than re-fetching the whole blob, so live reload is
   effectively free.
4. Colour values are validated before anything touches the disk.  An invalid
   role value is rejected with a message naming the role, not silently stored
   for the front end to choke on later.

Threading: the aiohttp handlers in routes.py run on the server's event loop;
NovaPlayerNode.run() runs on a ComfyUI worker thread.  All mutation goes
through this class behind `self._lock`, and only route handlers mutate.
"""

import copy
import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .defaults import (
    BASE_THEME,
    CONFIG_VERSION,
    DEFAULT_COLOR_CONFIG,
    DEFAULT_SYSTEM_CONFIG,
)

logger = logging.getLogger("NovaAudioPlayer")

# #rgb | #rgba | #rrggbb | #rrggbbaa
_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
# rgb(r,g,b) | rgba(r,g,b,a) — permissive about whitespace and float alpha
_RGB_RE = re.compile(
    r"^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$"
)


def is_color(value: Any) -> bool:
    """True when `value` is a colour string this stack can parse.

    Kept deliberately in sync with parse() in web/core/color.js — if you widen
    one, widen the other, or the panel will accept values the renderer drops.
    """
    if not isinstance(value, str):
        return False
    v = value.strip()
    return bool(_HEX_RE.match(v) or _RGB_RE.match(v))


def deep_merge(base: Dict, over: Dict) -> Dict:
    """Recursively merge `over` onto a DEEP copy of `base`.

    Dicts merge key-wise; every other type (including lists — a ramp is
    replaced wholesale, never element-merged) is overwritten.

    The deep copy is not optional.  A shallow `dict(base)` hands out live
    references to the nested dicts in defaults.py, so the first save_theme()
    would mutate the built-in defaults in place and the "fall back to defaults"
    path would then serve whatever the user had last saved.
    """
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class NovaConfigManager:
    """Singleton-ish holder for the package's configuration.

    Instantiate once (see the module-level `manager` at the bottom) and import
    that instance; constructing a second one is harmless but pointless.
    """

    def __init__(self, root_dir: Optional[Path] = None):
        # nova_player/config_manager.py -> package root is one level up
        self.root_dir = Path(root_dir) if root_dir else Path(__file__).resolve().parent.parent
        self.config_dir = self.root_dir / "config"
        self.color_config_path = self.config_dir / "color_config.json"
        self.system_config_path = self.config_dir / "system_config.json"

        self._lock = threading.RLock()
        self.version = 0
        self.color_config: Dict[str, Any] = {}
        self.system_config: Dict[str, Any] = {}

        self.reload_all()

    # ------------------------------------------------------------------
    # Disk I/O
    # ------------------------------------------------------------------

    def _safe_read_json(self, file_path: Path) -> Optional[Dict]:
        """Read one JSON file, returning None on any failure.

        Every failure path logs enough to act on — a malformed file reports the
        line and column, which is the difference between "config broken" and
        "trailing comma on line 34".
        """
        if not file_path.exists():
            logger.info("[NovaAudioPlayer] Config not found, using defaults: %s", file_path.name)
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                logger.warning(
                    "[NovaAudioPlayer] %s is valid JSON but not an object — ignoring",
                    file_path.name,
                )
                return None
            return data
        except json.JSONDecodeError as e:
            logger.error(
                "[NovaAudioPlayer] Malformed JSON in %s (line %d, col %d): %s — using defaults",
                file_path.name, e.lineno, e.colno, e.msg,
            )
            return None
        except OSError as e:
            logger.error(
                "[NovaAudioPlayer] File read error on %s: %s — using defaults",
                file_path.name, e,
            )
            return None

    def _safe_write_json(self, file_path: Path, data: Dict) -> bool:
        """Write JSON atomically. Returns True on success.

        Writes to a temp file in the same directory (so os.replace stays on one
        filesystem and is therefore atomic), fsyncs, then replaces.  A crash at
        any point leaves either the old file or the new one — never a partial.
        """
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(
                dir=str(self.config_dir), prefix=f".{file_path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, file_path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            return True
        except OSError as e:
            logger.error("[NovaAudioPlayer] File write error on %s: %s", file_path.name, e)
            return False

    # ------------------------------------------------------------------
    # Load / reload
    # ------------------------------------------------------------------

    def reload_all(self) -> None:
        """Re-read both files from disk and rebuild the merged config.

        Safe to call at any time; the front end triggers it implicitly by
        polling the version endpoint after an external edit.
        """
        with self._lock:
            on_disk_color = self._safe_read_json(self.color_config_path) or {}
            on_disk_system = self._safe_read_json(self.system_config_path) or {}

            self.color_config = deep_merge(DEFAULT_COLOR_CONFIG, on_disk_color)
            self.system_config = deep_merge(DEFAULT_SYSTEM_CONFIG, on_disk_system)

            # An activeTheme naming a theme that no longer exists would leave
            # the front end with nothing to resolve — fall back rather than 404.
            themes = self.color_config.get("themes", {})
            active = self.color_config.get("activeTheme")
            if active not in themes:
                fallback = BASE_THEME if BASE_THEME in themes else (
                    next(iter(themes), BASE_THEME)
                )
                if active is not None:
                    logger.warning(
                        "[NovaAudioPlayer] activeTheme '%s' not found — falling back to '%s'",
                        active, fallback,
                    )
                self.color_config["activeTheme"] = fallback

            self.version += 1

    def ensure_files_exist(self) -> None:
        """Write the defaults to disk the first time the package runs.

        Gives the user a real file to edit by hand instead of an empty folder
        and a wiki page.  Never overwrites an existing file.
        """
        with self._lock:
            if not self.color_config_path.exists():
                self._safe_write_json(self.color_config_path, DEFAULT_COLOR_CONFIG)
            if not self.system_config_path.exists():
                self._safe_write_json(self.system_config_path, DEFAULT_SYSTEM_CONFIG)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """Everything the front end needs, in one round trip."""
        with self._lock:
            return {
                "status": "success",
                "configVersion": CONFIG_VERSION,
                "version": self.version,
                "baseTheme": BASE_THEME,
                "activeTheme": self.color_config.get("activeTheme", BASE_THEME),
                "themes": self.color_config.get("themes", {}),
                "renderers": self.system_config.get("renderers", {}),
                "system": {
                    k: v for k, v in self.system_config.items() if k != "renderers"
                },
            }

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    @staticmethod
    def validate_theme(theme: Any) -> Tuple[bool, str]:
        """Check a theme object before it is allowed near the disk."""
        if not isinstance(theme, dict):
            return False, "Theme must be a JSON object"

        roles = theme.get("roles", {})
        if not isinstance(roles, dict):
            return False, "'roles' must be an object"
        for name, value in roles.items():
            if not is_color(value):
                return False, f"Role '{name}' is not a valid colour: {value!r}"

        ramps = theme.get("ramps", {})
        if not isinstance(ramps, dict):
            return False, "'ramps' must be an object"
        for ramp_name, stops in ramps.items():
            if not isinstance(stops, list) or not stops:
                return False, f"Ramp '{ramp_name}' must be a non-empty array"
            for stop in stops:
                if (not isinstance(stop, (list, tuple)) or len(stop) != 2):
                    return False, f"Ramp '{ramp_name}' stops must be [position, colour]"
                pos, col = stop
                if not isinstance(pos, (int, float)) or not (0 <= pos <= 255):
                    return False, f"Ramp '{ramp_name}' position {pos!r} out of range 0-255"
                if not is_color(col):
                    return False, f"Ramp '{ramp_name}' colour {col!r} is not valid"

        return True, ""

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def save_theme(self, name: str, theme: Dict, make_active: bool = False) -> Tuple[bool, str]:
        """Create or replace one named theme.

        Merges over any existing theme of the same name so a panel that only
        sends changed roles does not wipe the rest.
        """
        if not isinstance(name, str) or not name.strip():
            return False, "Theme name must be a non-empty string"

        ok, msg = self.validate_theme(theme)
        if not ok:
            return False, msg

        with self._lock:
            themes = self.color_config.setdefault("themes", {})
            existing = themes.get(name, {})
            themes[name] = deep_merge(existing, theme)
            if make_active:
                self.color_config["activeTheme"] = name

            payload = {
                "activeTheme": self.color_config.get("activeTheme", BASE_THEME),
                "themes": themes,
            }
            if not self._safe_write_json(self.color_config_path, payload):
                return False, "Failed to write color_config.json to disk"

            self.version += 1
            return True, f"Theme '{name}' saved"

    def delete_theme(self, name: str) -> Tuple[bool, str]:
        """Remove a theme. The base theme can never be deleted."""
        with self._lock:
            themes = self.color_config.get("themes", {})
            if name == BASE_THEME:
                return False, f"'{BASE_THEME}' is the base theme and cannot be deleted"
            if name not in themes:
                return False, f"No such theme: {name}"

            del themes[name]
            if self.color_config.get("activeTheme") == name:
                self.color_config["activeTheme"] = BASE_THEME

            payload = {
                "activeTheme": self.color_config.get("activeTheme", BASE_THEME),
                "themes": themes,
            }
            if not self._safe_write_json(self.color_config_path, payload):
                return False, "Failed to write color_config.json to disk"

            self.version += 1
            return True, f"Theme '{name}' deleted"

    def set_active_theme(self, name: str) -> Tuple[bool, str]:
        with self._lock:
            if name not in self.color_config.get("themes", {}):
                return False, f"No such theme: {name}"
            self.color_config["activeTheme"] = name
            payload = {
                "activeTheme": name,
                "themes": self.color_config.get("themes", {}),
            }
            if not self._safe_write_json(self.color_config_path, payload):
                return False, "Failed to write color_config.json to disk"
            self.version += 1
            return True, f"Active theme set to '{name}'"

    def save_renderer_params(self, renderer_id: str, params: Dict) -> Tuple[bool, str]:
        """Persist one renderer's parameter values.

        Only numbers, booleans and strings are accepted — a renderer param is a
        panel control value, never a nested structure.
        """
        if not isinstance(params, dict):
            return False, "Params must be a JSON object"
        for k, v in params.items():
            if not isinstance(v, (int, float, bool, str)):
                return False, f"Param '{k}' must be a number, boolean or string"

        with self._lock:
            renderers = self.system_config.setdefault("renderers", {})
            renderers[renderer_id] = deep_merge(renderers.get(renderer_id, {}), params)

            if not self._safe_write_json(self.system_config_path, self.system_config):
                return False, "Failed to write system_config.json to disk"

            self.version += 1
            return True, f"Renderer '{renderer_id}' updated"

    def save_appearance(self, values: Dict) -> Tuple[bool, str]:
        """Persist app-level appearance preferences (text scale, colour mixing).

        These are display preferences, not theme content: text size tracks the
        monitor you are sitting in front of, and switching theme must not
        change it. So they live in system_config.json alongside the other
        app-level settings rather than inside a theme.
        """
        if not isinstance(values, dict):
            return False, "Appearance must be a JSON object"

        allowed = {
            "text_scale": (float, 0.6, 2.5),
            "bar_relief": (float, 0.0, 1.0),
            "color_mixing": (str, None, None),
        }
        clean: Dict[str, Any] = {}
        for k, v in values.items():
            if k not in allowed:
                return False, f"Unknown appearance key '{k}'"
            kind, lo, hi = allowed[k]
            if kind is float:
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    return False, f"'{k}' must be a number"
                clean[k] = max(lo, min(hi, float(v)))
            else:
                if not isinstance(v, str):
                    return False, f"'{k}' must be a string"
                clean[k] = v

        with self._lock:
            appearance = self.system_config.setdefault("appearance", {})
            appearance.update(clean)

            if not self._safe_write_json(self.system_config_path, self.system_config):
                return False, "Failed to write system_config.json to disk"

            self.version += 1
            return True, "Appearance updated"


# The instance everything else imports.
manager = NovaConfigManager()
