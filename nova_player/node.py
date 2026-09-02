"""
NovaPlayerNode — the ComfyUI node itself.

Deliberately small: it renders audio to a temp WAV, computes peaks and
loudness, and hands the front end a tiny payload.  Everything else lives
elsewhere (audio_io.py for the DSP, routes.py for HTTP, config_manager.py for
settings).

The `ui` payload stays small on purpose — no peaks, no base64 audio.  Peaks go
through their own HTTP route so a long file cannot blow the websocket message
limit, and they are also written to a sidecar JSON so a browser refresh after a
server restart can still restore the widget.
"""

import os
import uuid

import folder_paths

from .audio_io import build_peaks, compute_bench, compute_lufs, save_wav
from .panel_info import audio_sha256, build_panel_info
from .config_manager import manager
from .peaks_cache import cache_peaks, write_peaks_sidecar


class NovaPlayerNode:
    CATEGORY = "▶️ Nova Audio"
    FUNCTION = "run"

    # Still an OUTPUT_NODE — it draws the player whether or not panel_info is
    # wired to anything — but it now also returns, so the bench figures can
    # reach a display node or a database without being re-measured by a second
    # node using different conventions. That divergence is the whole reason the
    # bench panel exists; handing the numbers out keeps it from coming back.
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("panel_info",)
    OUTPUT_NODE = True

    PANEL_FORMATS = ["json", "text", "csv_row"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "panel_format": (cls.PANEL_FORMATS, {
                    "default": "json",
                    "tooltip": "Shape of the panel_info output. "
                               "json: structured, for a database or a parser. "
                               "text: the bench strip as it reads on screen. "
                               "csv_row: one comma-separated row, fixed column "
                               "order, for appending to a log.",
                }),
            },
            "optional": {
                # Opaque. Copied into panel_info verbatim and never parsed, so
                # this node's signature stays decoupled from whatever generator
                # feeds it — ACE-Step's parameter set will keep changing, and
                # a typed input would have to change with it.
                # NOT multiline. A multiline STRING renders as a ~300px
                # textarea, and this one is normally fed by a wire from Madow
                # Inputs rather than typed — so it swallowed a third of the
                # node's height to display an empty box, squeezing the
                # visualisation it sits above. A single-line widget still
                # accepts a connection and costs one row.
                "context": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Wire Madow Inputs' context here, or paste "
                               "anything you want carried into panel_info "
                               "alongside the measurements. Copied verbatim.",
                }),
            },
        }

    # panel_format defaults here too, so a workflow saved before this widget
    # existed still executes instead of raising on a missing argument.
    def run(self, audio, panel_format="json", context=""):
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])

        if waveform.dim() == 3:
            n_ch, n_samples = waveform.shape[1], waveform.shape[2]
        else:
            n_ch, n_samples = waveform.shape[0], waveform.shape[1]

        duration = round(n_samples / sample_rate, 3)
        stereo = n_ch >= 2
        lufs = compute_lufs(waveform)

        # Measured BEFORE save_wav, which clamps to +/-1.0: a generation that
        # overshoots full scale should report the peak it actually produced,
        # not the ceiling the file writer flattened it to.
        bench = compute_bench(waveform, sample_rate)

        filename = f"nova_player_{uuid.uuid4().hex[:8]}.wav"
        filepath = os.path.join(folder_paths.get_temp_directory(), filename)
        save_wav(waveform, sample_rate, filepath)

        num_bars = int(
            manager.system_config.get("ui_defaults", {}).get("peak_bars", 120)
        )
        peaks = build_peaks(waveform, num_bars=num_bars)
        cache_peaks(filename, peaks)
        write_peaks_sidecar(filepath, peaks)

        try:
            filesize = os.path.getsize(filepath)
        except OSError:
            filesize = None

        print(f"[NovaPlayer] {n_ch}ch {sample_rate}Hz {duration}s -> {filename}")
        if bench.get("over_fs"):
            print(f"[NovaPlayer] WARNING: {bench['over_fs']} samples exceed full "
                  f"scale (peak {bench['peak_db']:+.2f} dBFS) and are clipped by "
                  f"the WAV write. Lower the level upstream to keep them.")

        payload = {
            "filename": filename,
            # Identifies the exact bytes every downstream instrument measured.
            "audio_sha256": audio_sha256(filepath),
            "context": context or None,
            "duration": duration,
            "sample_rate": sample_rate,
            "stereo": stereo,
            "lufs": lufs,
            "bench": bench,
            "filesize": filesize,
        }

        # One payload, two consumers: the front end draws it and
        # build_panel_info() renders the same numbers as a string. They cannot
        # drift, because there is nothing for them to drift from.
        panel_info = build_panel_info(payload, panel_format)

        return {
            "ui": {"nova_player": [payload]},
            "result": (panel_info,),
        }


NODE_CLASS_MAPPINGS = {"NovaPlayerNode": NovaPlayerNode}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaPlayerNode": "Nova Player 🔊"}
