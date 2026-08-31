"""
Peak-data cache, shared between the node (writer) and the routes (reader).

Two tiers, both cheap:

  * an in-memory dict — the fast path, valid for the life of the process;
  * a `.peaks.json` sidecar written next to the temp WAV — survives a ComfyUI
    restart, so reopening a saved workflow still restores the waveform as long
    as the temp file itself is still there.

Lives in its own module so node.py and routes.py can both reach it without
importing each other.
"""

import json
import logging
import os
from typing import Dict, Optional

logger = logging.getLogger("NovaAudioPlayer")

_peaks_cache: Dict[str, dict] = {}


def cache_peaks(filename: str, peaks: dict) -> None:
    _peaks_cache[filename] = peaks


def get_cached_peaks(filename: str) -> Optional[dict]:
    return _peaks_cache.get(filename)


def sidecar_path_for(wav_path: str) -> str:
    base, _ = os.path.splitext(wav_path)
    return base + ".peaks.json"


def write_peaks_sidecar(wav_path: str, peaks: dict) -> bool:
    try:
        with open(sidecar_path_for(wav_path), "w", encoding="utf-8") as f:
            json.dump(peaks, f)
        return True
    except OSError as e:
        logger.warning("[NovaAudioPlayer] Could not write peaks sidecar: %s", e)
        return False


def read_peaks_sidecar(wav_path: str) -> Optional[dict]:
    path = sidecar_path_for(wav_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("[NovaAudioPlayer] Could not read peaks sidecar %s: %s", path, e)
        return None
