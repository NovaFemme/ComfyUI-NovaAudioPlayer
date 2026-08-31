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
from .config_manager import manager
from .peaks_cache import cache_peaks, write_peaks_sidecar


class NovaPlayerNode:
    CATEGORY = " 🎛️ Nova Audio"
    FUNCTION = "run"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    def run(self, audio):
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

        return {
            "ui": {"nova_player": [{
                "filename": filename,
                "duration": duration,
                "sample_rate": sample_rate,
                "stereo": stereo,
                "lufs": lufs,
                "bench": bench,
                "filesize": filesize,
            }]},
            "result": (),
        }


NODE_CLASS_MAPPINGS = {"NovaPlayerNode": NovaPlayerNode}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaPlayerNode": "Nova Player ▶️"}
