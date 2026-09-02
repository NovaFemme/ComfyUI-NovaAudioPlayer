"""MadowInputs — one node holding every ACE-Step generation parameter.

WHY THIS EXISTS. Parameters live scattered across four nodes today, which makes
a run hard to set up and impossible to record: nothing downstream knows what
produced the audio it is measuring. That gap has already produced several
measurement-attribution incidents, and `context` closes it.

WHAT THIS NODE DOES NOT DO — and both are deliberate:

  - It does not generate a run id. Doing so would need IS_CHANGED returning
    NaN to guarantee freshness, which marks the graph HEAD dirty and forces a
    full re-render on every queue, including cache hits. A five-minute render
    on every press of Queue is too high a price for an identifier. The terminal
    logging node owns identity; it is at the tail, where being always-dirty
    costs nothing.

  - It never substitutes preset values at execution time. Loading a preset is a
    frontend operation that writes the real widgets. If the backend swapped
    values in from a preset name, the saved workflow would record the NAME
    without recording what actually ran, ComfyUI's cache would not see the
    change, and every logged row would be a lie. The backend only ever READS a
    preset, to compare against the widgets for `preset_dirty`.
"""

import os

from .comfy_types import BUNDLE_SCHEMA_VER, BUNDLE_TYPE, kind_for
from .context import build_json
from .naming import build_file_path
from .params import (ARG, DEFAULTS, KEYS, NON_AUDIO_KEYS, PARAMS, SEED_KEY,
                     TRIMMED_KEYS)
from . import presets as preset_store
from .validate import validate

PACK_VERSION = "0.1.0"

class MadowInputs:
    CATEGORY = "▶️ Nova Audio"
    FUNCTION = "run"
    DESCRIPTION = ("Every ACE-Step generation parameter in one node, with "
                   "named presets, cross-field validation, and a `context` "
                   "blob that carries the exact parameters into panel_info.")

    # The 27 typed parameter outputs live on Madow Unpack, not here. This node
    # emits the bundle instead: 4 slots rather than 30, which is half the
    # node's height moved alongside instead of below.
    #
    # file_path stays on BOTH. It is one string, it saves a wire when Unpack is
    # not placed, and it is carried rather than recomputed so there is only one
    # implementation of the assembly.
    RETURN_TYPES = (BUNDLE_TYPE, "STRING", "STRING", "STRING")
    RETURN_NAMES = ("madow", "file_path", "context", "validation")

    @classmethod
    def INPUT_TYPES(cls):
        required = {}
        for key, _group, _out, _kind_name, default, spec in PARAMS:
            opts = dict(spec)
            opts["default"] = default
            t = kind_for(key)
            # A combo is passed as the list itself; everything else as a type
            # name plus its options dict.
            required[ARG[key]] = (t,) if isinstance(t, list) else (t, opts)
            if isinstance(t, list):
                required[ARG[key]] = (t, {"default": default})
        return {
            "required": required,
            "optional": {
                # Written by the frontend when a preset is loaded, so `context`
                # can name it and compute preset_dirty. Never used to supply
                # parameter VALUES — see the module docstring.
                "preset_name": ("STRING", {
                    "default": "",
                    "tooltip": "Set by the preset bar. Recorded in context so "
                               "a run can be traced to the preset it came "
                               "from; never used to supply values.",
                }),
                # EmptyAceStepLatentAudio `seconds`, when it is wired in. The
                # duration check is skipped rather than guessed at when absent.
                "latent_seconds": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 3600.0,
                    "forceInput": True,
                    "tooltip": "Optional. Wire EmptyAceStepLatentAudio's "
                               "seconds here to check it against duration.",
                }),
            },
        }

    def run(self, preset_name="", latent_seconds=None, **kw):
        # Widgets arrive under their underscored names; the namespaced key is
        # what everything downstream uses.
        params = {k: kw.get(ARG[k], DEFAULTS[k]) for k in KEYS}

        # Trim the free-text fields ONCE, here, before anything reads them.
        # Everything downstream — the outputs, the bundle, the hashes, the
        # preset comparison — takes the trimmed value, so what was sent to the
        # model and what was hashed are the same string by construction rather
        # than by agreement between two code paths.
        for k in TRIMMED_KEYS:
            v = params.get(k)
            if isinstance(v, str):
                params[k] = v.strip()

        # A latent of 0 means "not wired", not "zero seconds".
        latent = latent_seconds if latent_seconds else None
        warnings = validate(params, latent_seconds=latent)

        loaded = preset_store.load(preset_name) if preset_name else None

        file_path = build_file_path(
            prefix=params.get("file.prefix"),
            name=params.get("file.name"),
            folder=params.get("file.folder"),
            separator=params.get("file.separator"),
        )

        context = build_json(
            params, warnings, SEED_KEY,
            preset_name=preset_name or None,
            preset_params=(loaded or {}).get("params"),
            excludes=(loaded or {}).get("excludes"),
            env=_env(),
            non_audio=NON_AUDIO_KEYS,
            file_path=file_path,
        )

        # Printed as well as returned: a conflict the user does not notice on
        # the node body is a conflict that costs a render.
        for w in warnings:
            print(f"[MadowInputs] {w}")

        validation = "\n".join(warnings) if warnings else "no conflicts found"

        bundle = {
            "schema_ver": BUNDLE_SCHEMA_VER,
            "params": params,
            "file_path": file_path,
        }

        return (bundle, file_path, context, validation)


def _env():
    """What this node can honestly report about its environment.

    model_file and vae_file are deliberately absent: they live on other nodes
    and this one cannot see them. The terminal logging node receives the whole
    API-format graph through its hidden PROMPT input and can capture them
    properly — guessing here would put a plausible wrong value in the log,
    which is worse than a missing one.
    """
    env = {"pack_version": PACK_VERSION}
    try:
        import comfy
        v = getattr(comfy, "__version__", None)
        if v:
            env["comfyui_version"] = str(v)
    except Exception:                                         # noqa: BLE001
        pass
    if "comfyui_version" not in env:
        # comfy exposes no version constant on every build; the repo's own
        # marker file is the next most reliable source.
        try:
            root = os.path.abspath(os.path.join(
                os.path.dirname(__file__), "..", "..", ".."))
            p = os.path.join(root, "comfyui_version.py")
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        if "__version__" in line and "=" in line:
                            env["comfyui_version"] = line.split("=", 1)[1].strip().strip('"\'')
                            break
        except Exception:                                     # noqa: BLE001
            pass
    return env


NODE_CLASS_MAPPINGS = {"MadowInputs": MadowInputs}
NODE_DISPLAY_NAME_MAPPINGS = {"MadowInputs": "Madow Inputs 🎚️"}
