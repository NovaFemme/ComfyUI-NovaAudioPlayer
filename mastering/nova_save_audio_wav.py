"""
nova_save_audio_wav.py — WAV writer for PCM16 / PCM24 / FLOAT32.

Ported from ComfyUI-SoundHub (https://github.com/Yuan-ManX/ComfyUI-SoundHub),
MIT licensed, Copyright (c) 2024 Yuan-Man. The WAV writers below are that
project's code, carried over so this pack does not depend on another custom
node being installed and so local changes are not lost when SoundHub updates.

    MIT License
    Copyright (c) 2024 Yuan-Man
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

ComfyUI-SoundHub itself is left completely untouched: its files are not edited,
its node is not unregistered, and both Save Audio nodes can coexist. Interfering
with another custom node's installation or operation is prohibited by the Comfy
Registry standards.

Changes from the original:
  * class renamed, categorised into this pack's Delivery & Metadata group;
  * the optional `sample_rate` input used SoundHub's private SAMPLE_RATE link
    type, which would have made this node depend on that pack being installed.
    It is now a plain INT override where 0 means "use the rate in the AUDIO
    payload", which is what almost every graph wants anyway;
  * messages renamed so a failure names the node you actually placed.

The writers are deliberately pure struct/numpy: no torchaudio, no TorchCodec,
no external binary. That is what makes 24-bit and float32 output work on a
ROCm box where torchaudio's encoders are unavailable.
"""

import os
import struct
from datetime import datetime

import numpy as np
import torch

import folder_paths

try:
    from ..nova_categories import DELIVERY
except ImportError:  # imported as a module rather than as part of the pack
    from nova_categories import DELIVERY

VERSION = "1.0.0"


def _read_wav_file(path):
    """Read back a RIFF/WAVE file as (waveform [channels, samples] float32, rate,
    bits, is_float).

    Deliberately hand-rolled rather than handed to soundfile or PyAV. The point
    of the reload switch is to see EXACTLY what landed on disk — the quantised
    samples, nothing resampled, dithered or normalised on the way back in. A
    parser that mirrors the writers above is the only way to be sure of that,
    and it keeps the node free of decode dependencies.

    Handles what these writers emit (PCM 16/24, float32) plus PCM 8/32 and
    float64 for completeness, including WAVE_FORMAT_EXTENSIBLE.
    """
    with open(path, "rb") as handle:
        data = handle.read()

    if len(data) < 12 or data[0:4] not in (b"RIFF", b"RF64") or data[8:12] != b"WAVE":
        raise ValueError(f"not a RIFF/WAVE file: {path}")

    fmt_tag = channels = rate = bits = None
    payload = None
    pos, end = 12, len(data)
    while pos + 8 <= end:
        chunk_id = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if chunk_id == b"fmt " and body + 16 <= end:
            fmt_tag, channels, rate, _byte_rate, _align, bits = struct.unpack(
                "<HHIIHH", data[body:body + 16]
            )
            if fmt_tag == 0xFFFE and body + 40 <= end:      # EXTENSIBLE
                valid = struct.unpack("<H", data[body + 18:body + 20])[0]
                fmt_tag = struct.unpack("<H", data[body + 24:body + 26])[0]
                if valid:
                    bits = valid
        elif chunk_id == b"data":
            payload = data[body:body + size]
        pos = body + size + (size & 1)

    if fmt_tag is None or payload is None:
        raise ValueError(f"WAV file has no fmt/data chunk: {path}")
    channels = max(1, int(channels))

    if fmt_tag == 3:                                        # IEEE float
        dtype, scale = ("<f4", 1.0) if bits == 32 else ("<f8", 1.0)
        flat = np.frombuffer(payload, dtype=dtype).astype(np.float32)
    elif fmt_tag == 1 and bits == 24:
        # 24-bit has no numpy dtype: take three bytes little-endian and
        # sign-extend through the unused top byte.
        raw = np.frombuffer(payload, dtype=np.uint8)
        usable = (len(raw) // 3) * 3
        triples = raw[:usable].reshape(-1, 3).astype(np.int32)
        ints = triples[:, 0] | (triples[:, 1] << 8) | (triples[:, 2] << 16)
        ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
        flat = (ints.astype(np.float32) / 8388608.0)
    elif fmt_tag == 1 and bits == 16:
        flat = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
    elif fmt_tag == 1 and bits == 32:
        flat = np.frombuffer(payload, dtype="<i4").astype(np.float32) / 2147483648.0
    elif fmt_tag == 1 and bits == 8:
        flat = (np.frombuffer(payload, dtype="<u1").astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(
            f"unsupported WAV encoding in {os.path.basename(path)}: "
            f"format tag {fmt_tag}, {bits} bits"
        )

    frames = flat.size // channels
    interleaved = flat[: frames * channels].reshape(frames, channels)
    waveform = torch.from_numpy(np.ascontiguousarray(interleaved.T))
    return waveform, int(rate), int(bits), fmt_tag == 3


class NovaAudioSaveWAV:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "The audio to save."}),
                "filename_prefix": ("STRING", {
                    "default": "NovaAudio",
                    "tooltip": "The prefix for the file to save. Subfolders are supported."
                }),
                "format": (["wav"], {
                    "default": "wav",
                    "tooltip": "WAV only in this build — written directly, without TorchCodec."
                }),
                "filename_mode": (["exact (overwrite)", "prefix + encoding + timestamp"], {
                    "default": "exact (overwrite)",
                    "tooltip": (
                        "exact (overwrite): filename_prefix IS the path and file name to "
                        "write; an existing file is replaced and the log says so.\n"
                        "prefix + encoding + timestamp: appends _PCM24_<timestamp>_00001.wav "
                        "to the prefix and never overwrites."
                    ),
                }),
                "reload_after_save": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "Off: the audio output passes the input through untouched.\n"
                        "On: the file is read back off disk and that is what leaves the "
                        "audio output — the real quantised samples, for verifying a "
                        "24-bit or 16-bit render rather than trusting it."
                    ),
                }),
                "wav_encoding": (["PCM_16", "PCM_24", "FLOAT_32"], {
                    "default": "PCM_24",
                    "tooltip": "PCM_16 = 16-bit PCM, PCM_24 = 24-bit delivery/master WAV, FLOAT_32 = 32-bit IEEE float archival WAV."
                }),
            },
            "optional": {
                "sample_rate": ("INT", {
                    "default": 0, "min": 0, "max": 768000, "step": 1,
                    "tooltip": "Override the rate carried in the AUDIO payload. 0 = use the payload's own rate.",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("audio", "file_path")
    OUTPUT_TOOLTIPS = (
        "With reload_after_save on, the file read back off disk — the actual "
        "quantised samples. With it off, the input audio passed straight through.",
        "Absolute path of the file that was written.",
    )
    FUNCTION = "save_audio"
    OUTPUT_NODE = True
    CATEGORY = DELIVERY
    DESCRIPTION = (
        f"Save Audio WAV v{VERSION} — archival WAV writer for PCM16, PCM24 and "
        "32-bit float. Pure struct/numpy, so 24-bit and float output work on ROCm "
        "where torchaudio's encoders are unavailable. Ported from ComfyUI-SoundHub "
        "(MIT, Yuan-Man)."
    )

    def _extract_waveform(self, audio, sample_rate):
        waveform = audio
        sr = sample_rate

        if isinstance(audio, dict):
            if "waveform" not in audio:
                raise ValueError(
                    "Nova Save Audio WAV received an AUDIO dictionary without a 'waveform' key."
                )
            waveform = audio["waveform"]

            if (sr is None or int(sr) <= 0) and "sample_rate" in audio:
                sr = audio["sample_rate"]

        if not isinstance(waveform, torch.Tensor):
            raise TypeError(
                "Nova Save Audio WAV expected AUDIO waveform to be a torch.Tensor, "
                f"received {type(waveform).__name__}."
            )

        if waveform.dim() == 3:
            if waveform.shape[0] != 1:
                raise ValueError(
                    "Nova Save Audio WAV currently supports one audio item per node. "
                    f"Received batch size {waveform.shape[0]}."
                )
            waveform = waveform[0]

        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)

        if waveform.dim() != 2:
            raise ValueError(
                "Nova Save Audio WAV expected audio shape [channels, samples] "
                "or [1, channels, samples]. "
                f"Received shape {tuple(waveform.shape)}."
            )

        sr = int(sr)
        if sr <= 0:
            raise ValueError(f"Invalid sample rate: {sr}")

        waveform = waveform.detach().to(device="cpu", dtype=torch.float32).contiguous()
        return waveform, sr

    def _write_pcm16_wav(self, full_path, waveform, sample_rate):
        channels = int(waveform.shape[0])
        interleaved = (
            waveform
            .clamp(-1.0, 1.0 - (1.0 / 32768.0))
            .transpose(0, 1)
            .contiguous()
            .numpy()
            .astype(np.float64, copy=False)
        )

        ints = np.rint(interleaved * 32768.0)
        ints = np.clip(ints, -32768, 32767).astype("<i2", copy=False)
        data = ints.tobytes(order="C")

        bits_per_sample = 16
        block_align = channels * 2
        byte_rate = sample_rate * block_align
        fmt_chunk = struct.pack(
            "<HHIIHH",
            1,
            channels,
            sample_rate,
            byte_rate,
            block_align,
            bits_per_sample,
        )

        data_pad = b"\x00" if (len(data) & 1) else b""
        riff_size = 4 + (8 + len(fmt_chunk)) + (8 + len(data) + len(data_pad))

        with open(full_path, "wb") as f:
            f.write(b"RIFF")
            f.write(struct.pack("<I", riff_size))
            f.write(b"WAVE")
            f.write(b"fmt ")
            f.write(struct.pack("<I", len(fmt_chunk)))
            f.write(fmt_chunk)
            f.write(b"data")
            f.write(struct.pack("<I", len(data)))
            f.write(data)
            if data_pad:
                f.write(data_pad)

    def _write_pcm24_wav(self, full_path, waveform, sample_rate):
        """
        Deterministic RIFF/WAVE PCM 24-bit writer.
        waveform shape: [channels, samples], float32 nominally in [-1, 1].
        """
        channels = int(waveform.shape[0])
        frames = int(waveform.shape[1])

        interleaved = (
            waveform
            .clamp(-1.0, 1.0 - (1.0 / 8388608.0))
            .transpose(0, 1)
            .contiguous()
            .numpy()
            .astype(np.float64, copy=False)
        )

        # Map float PCM to signed 24-bit integer PCM.
        ints = np.rint(interleaved * 8388608.0)
        ints = np.clip(ints, -8388608, 8388607).astype(np.int32, copy=False)

        # Convert signed int32 two's-complement to packed little-endian 24-bit.
        unsigned = ints.astype(np.uint32, copy=False) & np.uint32(0x00FFFFFF)
        packed = np.empty((frames, channels, 3), dtype=np.uint8)
        packed[..., 0] = (unsigned & 0xFF).astype(np.uint8)
        packed[..., 1] = ((unsigned >> 8) & 0xFF).astype(np.uint8)
        packed[..., 2] = ((unsigned >> 16) & 0xFF).astype(np.uint8)
        data = packed.tobytes(order="C")

        bits_per_sample = 24
        block_align = channels * 3
        byte_rate = sample_rate * block_align
        fmt_chunk = struct.pack(
            "<HHIIHH",
            1,                  # WAVE_FORMAT_PCM
            channels,
            sample_rate,
            byte_rate,
            block_align,
            bits_per_sample,
        )

        data_pad = b"\x00" if (len(data) & 1) else b""
        riff_size = (
            4
            + (8 + len(fmt_chunk))
            + (8 + len(data) + len(data_pad))
        )

        with open(full_path, "wb") as f:
            f.write(b"RIFF")
            f.write(struct.pack("<I", riff_size))
            f.write(b"WAVE")
            f.write(b"fmt ")
            f.write(struct.pack("<I", len(fmt_chunk)))
            f.write(fmt_chunk)
            f.write(b"data")
            f.write(struct.pack("<I", len(data)))
            f.write(data)
            if data_pad:
                f.write(data_pad)

    def _write_float32_wav(self, full_path, waveform, sample_rate):
        """
        Deterministic RIFF/WAVE IEEE float32 writer.
        Preserves Nova's canonical float32 samples.
        """
        channels = int(waveform.shape[0])
        frames = int(waveform.shape[1])

        interleaved = (
            waveform
            .transpose(0, 1)
            .contiguous()
            .numpy()
            .astype("<f4", copy=False)
        )
        data = interleaved.tobytes(order="C")

        bits_per_sample = 32
        block_align = channels * 4
        byte_rate = sample_rate * block_align

        fmt_chunk = struct.pack(
            "<HHIIHH",
            3,                  # WAVE_FORMAT_IEEE_FLOAT
            channels,
            sample_rate,
            byte_rate,
            block_align,
            bits_per_sample,
        )

        # fact chunk is appropriate for non-PCM WAVE formats.
        fact_data = struct.pack("<I", frames)

        data_pad = b"\x00" if (len(data) & 1) else b""
        riff_size = (
            4
            + (8 + len(fmt_chunk))
            + (8 + len(fact_data))
            + (8 + len(data) + len(data_pad))
        )

        with open(full_path, "wb") as f:
            f.write(b"RIFF")
            f.write(struct.pack("<I", riff_size))
            f.write(b"WAVE")
            f.write(b"fmt ")
            f.write(struct.pack("<I", len(fmt_chunk)))
            f.write(fmt_chunk)
            f.write(b"fact")
            f.write(struct.pack("<I", len(fact_data)))
            f.write(fact_data)
            f.write(b"data")
            f.write(struct.pack("<I", len(data)))
            f.write(data)
            if data_pad:
                f.write(data_pad)

    def _encoding_suffix(self, wav_encoding):
        mapping = {
            "PCM_16": "PCM16",
            "PCM_24": "PCM24",
            "FLOAT_32": "FLOAT32",
        }
        return mapping.get(str(wav_encoding), "PCM24")

    def save_audio(
        self,
        audio,
        sample_rate=0,
        filename_prefix="NovaAudio",
        filename_mode="exact (overwrite)",
        reload_after_save=False,
        format="wav",
        wav_encoding="PCM_24",
        prompt=None,
        extra_pnginfo=None
    ):
        if format != "wav":
            raise ValueError(
                "Nova Save Audio WAV writes WAV only in this build."
            )

        if wav_encoding not in ("PCM_16", "PCM_24", "FLOAT_32"):
            raise ValueError(f"Unsupported WAV encoding: {wav_encoding}")

        # 0 (the widget default) means "whatever the AUDIO payload says".
        requested_rate = int(sample_rate or 0) or None
        waveform, sample_rate = self._extract_waveform(audio, requested_rate)

        filename_prefix = (filename_prefix or "NovaAudio") + self.prefix_append
        normalized_prefix = filename_prefix.replace("\\", "/")
        subfolder = os.path.dirname(normalized_prefix)
        base_prefix = os.path.basename(normalized_prefix) or "NovaAudio"

        full_output_folder = (
            os.path.join(self.output_dir, subfolder)
            if subfolder
            else self.output_dir
        )
        os.makedirs(full_output_folder, exist_ok=True)

        replaced = False
        if filename_mode.startswith("exact"):
            # filename_prefix IS the file to write. The upstream path already
            # carries ".wav"; only add one when it does not, and never decorate
            # the stem — that decoration is exactly what made
            # "…_Master_24-48.wav" land as "…_Master_24-48.wav_PCM24_<stamp>_00001.wav".
            file = base_prefix
            if not file.lower().endswith(".wav"):
                file += ".wav"
            full_path = os.path.join(full_output_folder, file)
            replaced = os.path.exists(full_path)
        else:
            current_time = datetime.now().strftime("%Y%m%d-%H%M%S")
            encoding_suffix = self._encoding_suffix(wav_encoding)
            filename_base = f"{base_prefix}_{encoding_suffix}_{current_time}"

            counter = 1
            while True:
                file = f"{filename_base}_{counter:05}.wav"
                full_path = os.path.join(full_output_folder, file)
                if not os.path.exists(full_path):
                    break
                counter += 1

        if wav_encoding == "PCM_16":
            self._write_pcm16_wav(full_path, waveform, sample_rate)
            encoding_label = "PCM 16-bit"
        elif wav_encoding == "PCM_24":
            self._write_pcm24_wav(full_path, waveform, sample_rate)
            encoding_label = "PCM 24-bit"
        else:
            self._write_float32_wav(full_path, waveform, sample_rate)
            encoding_label = "IEEE float32"

        if not os.path.isfile(full_path):
            raise RuntimeError(
                f"Nova Save Audio WAV did not create the expected file: {full_path}"
            )

        file_size = os.path.getsize(full_path)
        if file_size <= 0:
            raise RuntimeError(
                f"Nova Save Audio WAV created an empty file: {full_path}"
            )

        if replaced:
            print(f"[Nova Save Audio WAV] Overwrote existing file: {full_path}")
        print(
            f"[Nova Save Audio WAV] Saved: {full_path} "
            f"({file_size:,} bytes, {sample_rate} Hz, "
            f"{waveform.shape[0]} ch, {waveform.shape[1]:,} samples, "
            f"{encoding_label})"
        )

        # The audio output. Off by default: reading a long master back costs
        # real time, and most graphs end here.
        out_audio = audio
        if reload_after_save:
            reloaded, read_rate, read_bits, read_float = _read_wav_file(full_path)
            out_audio = {
                "waveform": reloaded.unsqueeze(0),
                "sample_rate": int(read_rate),
            }
            drift = float((reloaded - waveform[:, : reloaded.shape[1]]).abs().max()) \
                if reloaded.shape == waveform.shape else float("nan")
            print(
                f"[Nova Save Audio WAV] Reloaded: {read_bits}-bit "
                f"{'float' if read_float else 'PCM'}, {read_rate} Hz, "
                f"{reloaded.shape[0]} ch, {reloaded.shape[1]:,} samples"
                + (f", max quantisation error {drift:.3e}" if drift == drift else "")
            )

        result = {
            "filename": file,
            "subfolder": subfolder,
            "type": self.type,
            "format": "wav",
            "wav_encoding": wav_encoding,
        }

        return {"ui": {"audio": result}, "result": (out_audio, full_path)}

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("nan")


NODE_CLASS_MAPPINGS = {"NovaAudioSaveWAV": NovaAudioSaveWAV}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaAudioSaveWAV": "Save Audio WAV PCM16|PCM24|FLOAT32 ⬇️"
}
