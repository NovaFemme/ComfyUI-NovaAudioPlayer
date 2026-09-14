"""
NovaAudioSaveFLAC24 — ComfyUI custom node

Saves an AUDIO input as FLAC with a selectable bit depth (24-bit by default).

Why the stock node gives you 16-bit:
    The built-in helper builds the frame as format="flt" and never sets a sample
    format on the FLAC stream, so FFmpeg's flac encoder falls back to its
    default s16 -> 16-bit output.

    FFmpeg's flac encoder only accepts s16 or s32. With s32 it writes
    bits_per_raw_sample = 24 (it shifts the samples right by 8 internally),
    which is how you get a true 24-bit FLAC. There is no 32-bit path.
"""

import json
import os
from io import BytesIO

import av
import numpy as np
import torch

import folder_paths

from ..nova_categories import DELIVERY

try:
    from comfy.cli_args import args
except Exception:  # pragma: no cover - very old ComfyUI
    class _A:
        disable_metadata = False
    args = _A()


# --- bit depth -> (stream sample_fmt, frame format, int dtype, scale, int_min, int_max, shift)
# Scale is 2**(bits-1) to match how loaders normalize PCM to float (int / 2**(bits-1)),
# so an integer source round-trips bit-exactly. The clip catches the single value
# (+1.0) that would otherwise overflow by 1 LSB.
_DEPTHS = {
    "24": ("s32", "s32", np.int32, 8388608.0, -8388608, 8388607, 8),
    "16": ("s16", "s16", np.int16, 32768.0, -32768, 32767, 0),
}


def _encode_flac(waveform: torch.Tensor, sample_rate: int, bit_depth: str, metadata: dict) -> bytes:
    """waveform: float tensor shaped (channels, samples), values in [-1, 1]."""
    sample_fmt, frame_fmt, dtype, scale, int_min, int_max, shift = _DEPTHS[bit_depth]
    layout = "mono" if waveform.shape[0] == 1 else "stereo"

    buffer = BytesIO()
    container = av.open(buffer, mode="w", format="flac")
    for key, value in metadata.items():
        container.metadata[key] = value

    stream = container.add_stream("flac", rate=int(sample_rate), layout=layout)
    # THE important line: force the encoder's sample format.
    stream.format = sample_fmt

    # Interleave to a single packed plane: (channels, samples) -> (1, samples*channels)
    interleaved = waveform.movedim(0, 1).reshape(1, -1).float().clamp(-1.0, 1.0).numpy()
    samples = np.clip(np.round(interleaved * scale), int_min, int_max).astype(dtype)
    if shift:
        # Left-align the 24-bit value inside int32; the encoder shifts it back by 8.
        samples = np.left_shift(samples, shift).astype(dtype)

    frame = av.AudioFrame.from_ndarray(samples, format=frame_fmt, layout=layout)
    frame.sample_rate = int(sample_rate)
    frame.pts = 0

    container.mux(stream.encode(frame))
    container.mux(stream.encode(None))  # flush
    container.close()

    buffer.seek(0)
    return buffer.getvalue()


class NovaAudioSaveFLAC24:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "filename_prefix": ("STRING", {"default": "audio/ComfyUI"}),
                "bit_depth": (["24", "16"], {"default": "24"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_flac"
    OUTPUT_NODE = True
    CATEGORY = DELIVERY
    DESCRIPTION = "Save audio as FLAC at 24-bit (or 16-bit) depth."


    def save_flac(self, audio, filename_prefix="audio/ComfyUI", bit_depth="24", prompt=None, extra_pnginfo=None):
        filename_prefix += self.prefix_append
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, self.output_dir
        )

        metadata = {}
        if not args.disable_metadata:
            if prompt is not None:
                metadata["prompt"] = json.dumps(prompt)
            if extra_pnginfo is not None:
                for key in extra_pnginfo:
                    metadata[key] = json.dumps(extra_pnginfo[key])

        sample_rate = int(audio["sample_rate"])
        results = []
        for batch_number, waveform in enumerate(audio["waveform"].cpu()):
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}.flac"
            data = _encode_flac(waveform, sample_rate, bit_depth, metadata)
            with open(os.path.join(full_output_folder, file), "wb") as f:
                f.write(data)
            results.append({"filename": file, "subfolder": subfolder, "type": self.type})
            counter += 1

        return {"ui": {"audio": results}}


NODE_CLASS_MAPPINGS = {"NovaAudioSaveFLAC24": NovaAudioSaveFLAC24}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaAudioSaveFLAC24": "Save Audio FLAC 24-bit ⬇️"}
