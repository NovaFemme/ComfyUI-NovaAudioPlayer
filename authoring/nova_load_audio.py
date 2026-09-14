"""
Nova Audio Load — standalone audio file loader node for ComfyUI.

No dependency on a sibling ``analysis`` module: the only hard requirement is
``torch`` (which ComfyUI already provides). Every decoding and metadata backend
is optional and probed at runtime, so the node degrades gracefully instead of
failing to register. The single relative import, for the menu category, is
guarded so the module still imports outside the package.

THE BACKEND THAT IS NOT HERE. Decoding tries soundfile, then torchaudio, then
PyAV, and stops. An earlier version had a fourth: shelling out to ffprobe and
ffmpeg. That was left out, and the reason stands on its own regardless of the
registry argument that once surrounded it: PyAV *is* ffmpeg's libraries, linked
in rather than spawned, and it ships with ComfyUI. Anything ffmpeg could decode,
PyAV already decodes, so a fourth backend would buy a process spawn and nothing
else.

AMD / ROCm notes (tested target: Radeon RX 9070 XT, gfx1201)
-----------------------------------------------------------
* All decoding and tensor work happens on the CPU in float32. Nothing here
  calls ``.cuda()``, ``torch.cuda.*``, ``.half()``, autocast, or any custom
  CUDA extension, so there is nothing for HIP to translate and nothing that
  can trip the ROCm allocator.
* ComfyUI's AUDIO payload convention is a CPU float32 tensor shaped
  ``[batch, channels, samples]``; downstream nodes move it to the accelerator
  themselves if they need to. Keeping the loader CPU-only is both the
  ComfyUI-correct behaviour and the most portable one across CUDA / ROCm /
  DirectML / MPS builds.
* No torchaudio GPU kernels, no ``torch.compile``, no channels-last or fp16
  paths — all of which are the usual sources of RDNA4 breakage.

Outputs
-------
audio        AUDIO    {"waveform": [1, C, N] float32 CPU, "sample_rate": int}
filename     STRING   file stem (name without extension)
sample_rate  INT      samples per second
duration     FLOAT    seconds of the returned audio
type         STRING   file extension, lowercase, no dot (e.g. "wav")
metadata     STRING   JSON: file / format / audio / tags / levels
bit_depth    INT      bits per sample (0 when lossy or undeterminable)
"""


import json
import math
import os
import struct
import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import torch

VERSION = "1.0.0"

try:
    from ..nova_categories import UTILITY_IO
except ImportError:  # direct execution / test harness
    from nova_categories import UTILITY_IO

CATEGORY = UTILITY_IO

# ---------------------------------------------------------------------------
# ComfyUI integration (optional, so the module also imports standalone)
# ---------------------------------------------------------------------------

try:
    import folder_paths  # type: ignore
except Exception:  # pragma: no cover - outside ComfyUI
    folder_paths = None


AUDIO_EXTENSIONS = (
    ".wav", ".wave", ".bwf",
    ".flac",
    ".mp3",
    ".m4a", ".mp4", ".aac", ".alac",
    ".ogg", ".oga", ".opus",
    ".aif", ".aiff", ".aifc",
    ".wma",
    ".w64", ".rf64",
    ".caf",
    ".au", ".snd",
    ".mka", ".webm",
    ".ape", ".wv", ".tta", ".mpc", ".dsf", ".dff",
)

NO_FILES_SENTINEL = "  (no audio files in ComfyUI/input)  "


def _input_directory() -> str:
    if folder_paths is not None:
        try:
            return folder_paths.get_input_directory()
        except Exception:
            pass
    return os.path.join(os.getcwd(), "input")


def _list_input_audio() -> List[str]:
    directory = _input_directory()
    found: List[str] = []
    try:
        for name in os.listdir(directory):
            full = os.path.join(directory, name)
            if not os.path.isfile(full):
                continue
            if os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS:
                found.append(name)
    except Exception:
        pass
    found.sort(key=lambda s: s.lower())
    return found or [NO_FILES_SENTINEL]


def _resolve_path(audio_file: str, file_path: str) -> str:
    """``file_path`` always wins when it is non-empty."""
    override = (file_path or "").strip().strip('"').strip("'")
    if override:
        return os.path.abspath(os.path.expanduser(os.path.expandvars(override)))

    picked = (audio_file or "").strip()
    if not picked or picked == NO_FILES_SENTINEL:
        raise ValueError(
            "Nova Load Audio: no file selected. Put an audio file in "
            "ComfyUI/input (or use the upload button), or type a path into "
            "the 'file_path' widget."
        )

    if folder_paths is not None:
        try:
            return folder_paths.get_annotated_filepath(picked)
        except Exception:
            pass
    return os.path.join(_input_directory(), picked)


# ---------------------------------------------------------------------------
# Container header probes — dependency-free bit depth / rate for lossless files
# ---------------------------------------------------------------------------

def _read_head(path: str, size: int = 1 << 20) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(size)


def _aiff_extended_to_float(raw: bytes) -> float:
    """Decode an 80-bit IEEE 754 extended precision float (AIFF sample rate)."""
    if len(raw) < 10:
        return 0.0
    exponent = struct.unpack(">H", raw[0:2])[0]
    mantissa = struct.unpack(">Q", raw[2:10])[0]
    sign = -1.0 if exponent & 0x8000 else 1.0
    exponent &= 0x7FFF
    if exponent == 0 and mantissa == 0:
        return 0.0
    if exponent == 0x7FFF:
        return 0.0
    return sign * mantissa * (2.0 ** (exponent - 16383 - 63))


def _probe_wav(data: bytes) -> Optional[Dict[str, Any]]:
    if len(data) < 12 or data[0:4] not in (b"RIFF", b"RF64") or data[8:12] != b"WAVE":
        return None
    pos, end = 12, len(data)
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        try:
            csize = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        except struct.error:
            break
        body = pos + 8
        if cid == b"fmt " and body + 16 <= end:
            tag, channels, rate, _byte_rate, _align, bits = struct.unpack(
                "<HHIIHH", data[body:body + 16]
            )
            if tag == 0xFFFE and body + 40 <= end:  # WAVE_FORMAT_EXTENSIBLE
                valid_bits = struct.unpack("<H", data[body + 18:body + 20])[0]
                sub_tag = struct.unpack("<H", data[body + 24:body + 26])[0]
                if valid_bits:
                    bits = valid_bits
                tag = sub_tag
            encodings = {1: "PCM", 3: "IEEE_FLOAT", 6: "A_LAW", 7: "MU_LAW", 0x11: "IMA_ADPCM"}
            return {
                "container": "RIFF/WAVE" if data[0:4] == b"RIFF" else "RF64/WAVE",
                "encoding": encodings.get(tag, f"FORMAT_TAG_{tag}"),
                "format_tag": int(tag),
                "bit_depth": int(bits),
                "sample_rate": int(rate),
                "channels": int(channels),
                "is_float": tag == 3,
            }
        pos = body + csize + (csize & 1)
    return None


def _probe_aiff(data: bytes) -> Optional[Dict[str, Any]]:
    if len(data) < 12 or data[0:4] != b"FORM" or data[8:12] not in (b"AIFF", b"AIFC"):
        return None
    is_aifc = data[8:12] == b"AIFC"
    pos, end = 12, len(data)
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        try:
            csize = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        except struct.error:
            break
        body = pos + 8
        if cid == b"COMM" and body + 18 <= end:
            channels, frames, bits = struct.unpack(">HIH", data[body:body + 8])
            rate = _aiff_extended_to_float(data[body + 8:body + 18])
            comp = "sowt/PCM"
            if is_aifc and body + 22 <= end:
                comp = data[body + 18:body + 22].decode("ascii", "replace")
            return {
                "container": "AIFC" if is_aifc else "AIFF",
                "encoding": comp,
                "bit_depth": int(bits),
                "sample_rate": int(round(rate)),
                "channels": int(channels),
                "frames": int(frames),
                "is_float": comp.lower().startswith("fl"),
            }
        pos = body + csize + (csize & 1)
    return None


def _probe_flac(data: bytes) -> Optional[Dict[str, Any]]:
    if len(data) < 42 or data[0:4] != b"fLaC":
        return None
    # First metadata block must be STREAMINFO (type 0), 34 bytes of payload.
    block = data[8:42]
    if len(block) < 34:
        return None
    packed = int.from_bytes(block[10:18], "big")
    sample_rate = (packed >> 44) & 0xFFFFF
    channels = ((packed >> 41) & 0x7) + 1
    bits = ((packed >> 36) & 0x1F) + 1
    total = packed & 0xFFFFFFFFF
    return {
        "container": "FLAC",
        "encoding": "FLAC",
        "bit_depth": int(bits),
        "sample_rate": int(sample_rate),
        "channels": int(channels),
        "frames": int(total),
        "is_float": False,
    }


def _probe_header(path: str) -> Dict[str, Any]:
    try:
        head = _read_head(path, 1 << 16)
    except Exception:
        return {}
    for probe in (_probe_wav, _probe_aiff, _probe_flac):
        try:
            result = probe(head)
        except Exception:
            result = None
        if result:
            return result
    return {}


# ---------------------------------------------------------------------------
# Decoding backends (each returns waveform [C, N] float32, sample_rate, info)
# ---------------------------------------------------------------------------

def _as_float32_cpu(wav: torch.Tensor) -> torch.Tensor:
    wav = wav.detach().to(device="cpu", dtype=torch.float32)
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    return wav.contiguous()


def _decode_soundfile(path: str) -> Tuple[torch.Tensor, int, Dict[str, Any]]:
    import soundfile as sf  # type: ignore

    data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T.copy())
    info: Dict[str, Any] = {"backend": "soundfile"}
    try:
        probe = sf.info(path)
        info.update({
            "container": str(probe.format),
            "codec": str(probe.format),
            "encoding": str(probe.subtype),          # libsndfile subtype
            "container_description": str(probe.format_info),
            "codec_description": str(probe.format_info),
            "encoding_description": str(probe.subtype_info),
        })
    except Exception:
        pass
    return _as_float32_cpu(wav), int(sample_rate), info


def _decode_torchaudio(path: str) -> Tuple[torch.Tensor, int, Dict[str, Any]]:
    import torchaudio  # type: ignore

    wav, sample_rate = torchaudio.load(path)
    info: Dict[str, Any] = {"backend": "torchaudio"}
    try:
        meta = torchaudio.info(path)
        encoding = str(getattr(meta, "encoding", "") or "")
        info.update({
            "encoding": encoding,
            "codec": encoding,
            "bits_per_sample": int(getattr(meta, "bits_per_sample", 0) or 0),
        })
    except Exception:
        pass
    return _as_float32_cpu(wav), int(sample_rate), info


def _decode_pyav(path: str) -> Tuple[torch.Tensor, int, Dict[str, Any]]:
    import av  # type: ignore
    import numpy as np

    chunks: List["np.ndarray"] = []
    info: Dict[str, Any] = {"backend": "pyav"}

    with av.open(path) as container:
        if not container.streams.audio:
            raise ValueError("no audio stream in container")
        stream = container.streams.audio[0]
        try:
            stream.thread_type = "AUTO"
        except Exception:
            pass

        ctx = stream.codec_context
        sample_rate = int(getattr(ctx, "sample_rate", 0) or getattr(stream, "rate", 0) or 0)
        channels = int(getattr(ctx, "channels", 0) or 0)
        if not channels:
            try:
                channels = int(stream.layout.nb_channels)
            except Exception:
                channels = 2

        info.update({
            "container": str(getattr(container.format, "name", "") or ""),
            "container_description": str(getattr(container.format, "long_name", "") or ""),
            "encoding": str(getattr(ctx, "name", "") or ""),
            "codec": str(getattr(ctx, "name", "") or ""),
            "codec_description": str(getattr(getattr(ctx, "codec", None), "long_name", "") or ""),
            "encoding_description": str(getattr(getattr(ctx, "codec", None), "long_name", "") or ""),
            "bits_per_raw_sample": int(getattr(ctx, "bits_per_raw_sample", 0) or 0),
            "bit_rate_bps": int(getattr(ctx, "bit_rate", 0) or 0),
        })
        try:
            info["sample_format"] = str(ctx.format.name)
            info["sample_format_bits"] = int(ctx.format.bits)
        except Exception:
            pass

        layout = "mono" if channels == 1 else ("stereo" if channels == 2 else None)
        try:
            resampler = av.audio.resampler.AudioResampler(
                format="fltp",
                layout=stream.layout if layout is None else layout,
                rate=sample_rate or None,
            )
        except Exception:
            resampler = av.audio.resampler.AudioResampler(format="fltp", layout="stereo")

        def _emit(frame):
            out = resampler.resample(frame)
            if out is None:
                return
            if not isinstance(out, (list, tuple)):
                out = [out]
            for item in out:
                if item is None:
                    continue
                arr = item.to_ndarray()
                if arr.ndim == 1:
                    arr = arr.reshape(1, -1)
                chunks.append(arr)

        for frame in container.decode(stream):
            _emit(frame)
        try:
            _emit(None)  # flush
        except Exception:
            pass

    if not chunks:
        raise ValueError("PyAV decoded zero audio frames")

    width = max(c.shape[0] for c in chunks)
    fixed = [c if c.shape[0] == width else np.repeat(c[:1], width, axis=0) for c in chunks]
    data = np.concatenate(fixed, axis=1)
    return _as_float32_cpu(torch.from_numpy(data.copy())), int(sample_rate or 44100), info


DECODERS = (
    ("soundfile", _decode_soundfile),
    ("torchaudio", _decode_torchaudio),
    ("pyav", _decode_pyav),
)


def _decode(path: str) -> Tuple[torch.Tensor, int, Dict[str, Any], List[str]]:
    attempts: List[str] = []
    for name, fn in DECODERS:
        try:
            wav, sample_rate, info = fn(path)
        except ImportError:
            attempts.append(f"{name}: not installed")
            continue
        except Exception as exc:
            attempts.append(f"{name}: {type(exc).__name__}: {exc}")
            continue
        if wav.numel() == 0:
            attempts.append(f"{name}: decoded 0 samples")
            continue
        info["decoder_attempts"] = attempts
        return wav, sample_rate, info, attempts

    detail = ("  " + "\n  ".join(attempts)) if attempts else "  (no backend was available)"
    raise RuntimeError(
        f"Nova Load Audio could not decode '{os.path.basename(path)}'.\n"
        f"{detail}\n"
        "Decoding goes through soundfile, torchaudio and PyAV. torchaudio and av "
        "ship with ComfyUI, so a healthy install should not reach this error — "
        "if it does, the file itself is most likely damaged or not audio. "
        "Reinstall the pack through ComfyUI Manager if the backends are missing."
    )


# ---------------------------------------------------------------------------
# Bit depth
# ---------------------------------------------------------------------------

_SUBTYPE_BITS = {
    "PCM_S8": 8, "PCM_U8": 8, "PCM_16": 16, "PCM_24": 24, "PCM_32": 32,
    "FLOAT": 32, "DOUBLE": 64,
    "ALAW": 8, "ULAW": 8,
    "DPCM_8": 8, "DPCM_16": 16,
    "DWVW_12": 12, "DWVW_16": 16, "DWVW_24": 24,
}

# Codecs with no meaningful source bit depth. Anything a decoder reports as
# "bits per sample" for these describes the decode buffer, not the recording,
# so it must never be surfaced as the file's bit depth. Compared lowercase.
_LOSSY_CODECS = {
    # ffmpeg / PyAV codec names
    "mp3", "mp3float", "mp2", "mp1", "aac", "aac_latm", "aac_fixed",
    "vorbis", "libvorbis", "opus", "libopus", "wmav1", "wmav2", "wmavoice",
    "wmapro", "ac3", "eac3", "dts", "atrac1", "atrac3", "atrac3p",
    "amrnb", "amrwb", "musepack7", "musepack8", "speex", "gsm", "qdm2",
    "cook", "sipr", "ra_144", "ra_288", "nellymoser", "adpcm_ima_wav",
    "adpcm_ms", "g722", "g726",
    # libsndfile subtype names
    "mpeg_layer_i", "mpeg_layer_ii", "mpeg_layer_iii",
    "vorbis", "opus", "ms_adpcm", "ima_adpcm", "gsm610", "g721_32",
    "g723_24", "g723_40", "vox_adpcm", "nms_adpcm_16", "nms_adpcm_24",
    "nms_adpcm_32",
    # our own WAV header tags
    "a_law", "mu_law",
}

_LOSSLESS_CODECS = {
    "flac", "alac", "wavpack", "tta", "tak", "shorten", "ape", "monkeys audio",
    "mlp", "truehd", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le",
    "pcm_f64le", "pcm_s16be", "pcm_s24be", "pcm_s32be", "pcm_u8", "pcm_s8",
}

_FLOAT_FORMATS = {"flt", "fltp", "dbl", "dblp"}


def _is_lossy_codec(codec: str) -> bool:
    name = (codec or "").strip().lower()
    if not name:
        return False
    if name in _LOSSLESS_CODECS or name.startswith("pcm_"):
        return False
    if name in _LOSSY_CODECS:
        return True
    # Catch-all for variants like "mpeg_layer_iii", "aac_he", "opus (libopus)".
    return any(token in name for token in (
        "mpeg", "mp3", "aac", "vorbis", "opus", "wma", "adpcm", "a_law",
        "u_law", "mu_law", "alaw", "ulaw", "ac3", "dts", "amr", "speex",
    ))


def _resolve_bit_depth(
    header: Dict[str, Any],
    decode_info: Dict[str, Any],
    tag_info: Dict[str, Any],
) -> Tuple[int, str, bool, str]:
    """Return (bit_depth, label, is_lossy, source_of_truth).

    Precedence is deliberately "most authoritative about the SOURCE first":
    our own container header, then the tag reader, then the decoder's own
    report, and only then the decode buffer format. Lossy codecs short-circuit
    to 0 because any bit depth a decoder reports for them belongs to the
    decoded float/int buffer rather than to the file.
    """
    encoding = str(decode_info.get("encoding") or header.get("encoding") or "").strip()
    codec = str(decode_info.get("codec") or "").strip() or encoding
    lossy = _is_lossy_codec(encoding) or _is_lossy_codec(codec)

    # 1. Container header we parsed ourselves (most trustworthy for lossless).
    bits = int(header.get("bit_depth") or 0)
    if bits and not lossy:
        is_float = bool(header.get("is_float"))
        label = f"{bits}-bit float" if is_float else f"{bits}-bit integer PCM"
        return bits, label, False, "container_header"

    # 2. libsndfile subtype — exact for everything libsndfile opens.
    subtype = str(decode_info.get("encoding") or "").upper()
    if subtype in _SUBTYPE_BITS and not lossy:
        bits = _SUBTYPE_BITS[subtype]
        if subtype in ("FLOAT", "DOUBLE"):
            return bits, f"{bits}-bit float", False, "soundfile.subtype"
        return bits, f"{bits}-bit integer PCM", False, "soundfile.subtype"

    # 3. Tag reader (mutagen) — accurate for FLAC / WAV / AIFF / ALAC / WavPack.
    if not lossy:
        for key in ("bits_per_sample", "bits_per_raw_sample"):
            bits = int(tag_info.get(key) or 0)
            if bits:
                return bits, f"{bits}-bit integer PCM", False, f"mutagen.{key}"

    # 4. torchaudio.info / PyAV codec context raw sample size.
    if not lossy:
        for key, origin in (
            ("bits_per_sample", "torchaudio.info"),
            ("bits_per_raw_sample", "codec_context"),
        ):
            bits = int(decode_info.get(key) or 0)
            if bits:
                return bits, f"{bits}-bit integer PCM", False, origin

    # 5. Decoder sample format — describes the decode buffer, flagged as such.
    if not lossy:
        fmt = str(decode_info.get("sample_format") or "").lower()
        if fmt:
            if fmt in _FLOAT_FORMATS:
                bits = 64 if fmt.startswith("dbl") else 32
                return bits, f"{bits}-bit float (from decoder format)", False, "sample_format"
            fmt_bits = int(decode_info.get("sample_format_bits") or 0)
            if fmt_bits:
                return fmt_bits, f"{fmt_bits}-bit (from decoder format)", False, "sample_format"

    if lossy:
        return 0, f"not applicable — lossy/compressed ({encoding or codec})", True, "codec"
    return 0, f"unknown ({codec or 'unidentified codec'})", False, "none"


# ---------------------------------------------------------------------------
# Embedded tags
# ---------------------------------------------------------------------------

def _stringify(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (list, tuple)):
        cleaned = [_stringify(v) for v in value]
        return cleaned[0] if len(cleaned) == 1 else cleaned
    return str(value)


def _read_tags(path: str) -> Tuple[Dict[str, Any], Dict[str, Any], str]:
    """Return (tags, technical_info, source)."""
    try:
        import mutagen  # type: ignore
    except Exception:
        return {}, {}, "unavailable (pip install mutagen)"

    try:
        handle = mutagen.File(path)
    except Exception as exc:
        return {}, {}, f"error: {type(exc).__name__}: {exc}"
    if handle is None:
        return {}, {}, "no reader for this container"

    tags: Dict[str, Any] = {}
    try:
        if handle.tags:
            for key, value in dict(handle.tags).items():
                name = str(key)
                if name.startswith("APIC") or name.startswith("covr"):
                    tags[name] = "<embedded picture omitted>"
                    continue
                text = _stringify(value)
                if isinstance(text, str) and len(text) > 4096:
                    text = text[:4096] + "…<truncated>"
                tags[name] = text
    except Exception:
        pass

    technical: Dict[str, Any] = {}
    info = getattr(handle, "info", None)
    if info is not None:
        for attr in (
            "length", "channels", "sample_rate", "bitrate", "bits_per_sample",
            "bitrate_mode", "codec", "codec_description", "encoder_info",
            "bits_per_raw_sample", "total_samples", "version", "layer",
        ):
            if hasattr(info, attr):
                technical[attr] = _stringify(getattr(info, attr))

    if getattr(handle, "pictures", None):
        try:
            technical["embedded_pictures"] = len(handle.pictures)
        except Exception:
            pass

    return tags, technical, "mutagen"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _hms(seconds: float) -> str:
    if not math.isfinite(seconds) or seconds < 0:
        return "00:00:00.000"
    whole = int(seconds)
    ms = int(round((seconds - whole) * 1000.0))
    if ms == 1000:
        whole, ms = whole + 1, 0
    return f"{whole // 3600:02d}:{(whole % 3600) // 60:02d}:{whole % 60:02d}.{ms:03d}"


def _channel_layout(channels: int) -> str:
    return {1: "mono", 2: "stereo", 3: "2.1", 4: "quad", 6: "5.1", 8: "7.1"}.get(
        channels, f"{channels} channels"
    )


def _db(value: float) -> float:
    return float(20.0 * math.log10(max(float(value), 1e-12)))


def _levels(wav: torch.Tensor) -> Dict[str, Any]:
    x = wav.float()
    peak = float(torch.max(torch.abs(x)).item()) if x.numel() else 0.0
    rms = float(torch.sqrt(torch.clamp(torch.mean(x * x), min=0.0)).item()) if x.numel() else 0.0
    clipped = int(torch.sum(torch.abs(x) >= 0.999969).item()) if x.numel() else 0
    per_channel = []
    for c in range(x.shape[0]):
        ch = x[c]
        per_channel.append({
            "channel": c,
            "peak_dbfs": round(_db(float(torch.max(torch.abs(ch)).item())), 3),
            "rms_dbfs": round(_db(float(torch.sqrt(torch.clamp(torch.mean(ch * ch), min=0.0)).item())), 3),
            "dc_offset": round(float(torch.mean(ch).item()), 8),
        })
    return {
        "peak_sample": round(peak, 8),
        "peak_dbfs": round(_db(peak), 3),
        "rms_dbfs": round(_db(rms), 3),
        "crest_factor_db": round(_db(peak) - _db(rms), 3),
        "dc_offset": round(float(torch.mean(x).item()) if x.numel() else 0.0, 8),
        "clipped_samples": clipped,
        "clipping_suspected": clipped > 8,
        "silent": peak < 1e-6,
        "per_channel": per_channel,
    }


def _quick_signature(path: str, size: int) -> str:
    """Cheap content fingerprint: size + first and last 1 MiB."""
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    try:
        block = 1 << 20
        with open(path, "rb") as fh:
            digest.update(fh.read(block))
            if size > block * 2:
                fh.seek(-block, os.SEEK_END)
                digest.update(fh.read(block))
    except Exception:
        return ""
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class NovaLoadAudio:
    CATEGORY = CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("AUDIO", "STRING", "INT", "FLOAT", "STRING", "STRING", "INT")
    RETURN_NAMES = (
        "audio", "filename", "sample_rate", "duration", "type", "metadata", "bit_depth",
    )
    OUTPUT_TOOLTIPS = (
        "ComfyUI AUDIO payload: CPU float32 waveform [1, channels, samples].",
        "File name without its extension.",
        "Sample rate in Hz.",
        "Duration of the returned audio in seconds.",
        "File extension, lowercase and without the dot (e.g. wav).",
        "JSON string: file, format, audio, source, processing, levels and embedded tags.",
        "Bits per sample of the source (0 when the source is lossy/compressed).",
    )
    DESCRIPTION = (
        f"Nova Load Audio v{VERSION} — standalone audio file loader. "
        "Decodes via soundfile / torchaudio / PyAV (first one available), "
        "and reports filename, sample rate, duration, extension, full metadata and "
        "bit depth. CPU-only float32, safe on AMD ROCm (RX 9070 XT) and CUDA alike."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": (_list_input_audio(), {
                    "tooltip": "Audio file in ComfyUI/input. Use the upload button to add one.",
                }),
                "file_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Optional: full path to any audio file (overrides the dropdown)",
                    "tooltip": "When not empty this path is used instead of the dropdown selection.",
                }),
                "channel_mode": (["native", "mono", "stereo"], {
                    "default": "native",
                    "tooltip": "native keeps the file's channel count; mono downmixes; stereo duplicates mono or keeps the first two channels.",
                }),
                "start_seconds": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01,
                    "tooltip": "Skip this many seconds from the start. 0 = from the beginning.",
                }),
                "duration_seconds": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01,
                    "tooltip": "Length to keep after start_seconds. 0 = to the end of the file.",
                }),
            },
        }

    # -- ComfyUI cache invalidation: re-run when the file itself changes -----
    @classmethod
    def IS_CHANGED(cls, audio, file_path, channel_mode, start_seconds, duration_seconds, **kwargs):
        try:
            path = _resolve_path(audio, file_path)
            stat = os.stat(path)
            stamp = f"{path}|{stat.st_size}|{stat.st_mtime_ns}"
        except Exception:
            stamp = f"unresolved|{audio}|{file_path}"
        stamp += f"|{channel_mode}|{start_seconds}|{duration_seconds}"
        return hashlib.sha256(stamp.encode("utf-8")).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, audio, file_path, channel_mode, start_seconds, duration_seconds, **kwargs):
        try:
            path = _resolve_path(audio, file_path)
        except Exception as exc:
            return str(exc)
        if not os.path.isfile(path):
            return f"Nova Load Audio: file not found — {path}"
        return True

    # ----------------------------------------------------------------------
    def load(self, audio, file_path, channel_mode, start_seconds, duration_seconds, **kwargs):
        path = _resolve_path(audio, file_path)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Nova Load Audio: file not found — {path}")

        warnings: List[str] = []

        wav, sample_rate, decode_info, attempts = _decode(path)
        if sample_rate <= 0:
            sample_rate = 44100
            warnings.append("Decoder reported no sample rate; assumed 44100 Hz.")

        source_channels = int(wav.shape[0])
        source_samples = int(wav.shape[-1])
        source_duration = source_samples / float(sample_rate)

        header = _probe_header(path)
        tags, tag_info, tag_source = _read_tags(path)
        bit_depth, bit_depth_label, is_lossy, bit_depth_source = _resolve_bit_depth(
            header, decode_info, tag_info
        )

        # -- trim ----------------------------------------------------------
        start_index = int(round(max(0.0, float(start_seconds)) * sample_rate))
        if start_index >= source_samples:
            start_index = max(0, source_samples - 1)
            warnings.append(
                "start_seconds is beyond the end of the file; clamped to the last sample."
            )
        if float(duration_seconds) > 0.0:
            end_index = start_index + int(round(float(duration_seconds) * sample_rate))
            end_index = min(end_index, source_samples)
        else:
            end_index = source_samples
        if end_index <= start_index:
            end_index = min(source_samples, start_index + 1)
        trimmed = (start_index != 0) or (end_index != source_samples)
        if trimmed:
            wav = wav[:, start_index:end_index].contiguous()

        # -- channels ------------------------------------------------------
        converted = False
        if channel_mode == "mono" and wav.shape[0] != 1:
            wav = torch.mean(wav, dim=0, keepdim=True)
            converted = True
        elif channel_mode == "stereo" and wav.shape[0] != 2:
            if wav.shape[0] == 1:
                wav = wav.repeat(2, 1)
            else:
                warnings.append(
                    f"Source has {wav.shape[0]} channels; kept the first two for stereo output."
                )
                wav = wav[:2]
            converted = True
        wav = wav.contiguous()

        if not torch.isfinite(wav).all():
            bad = int((~torch.isfinite(wav)).sum().item())
            wav = torch.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0)
            warnings.append(f"Replaced {bad} non-finite sample(s) with silence.")

        out_channels = int(wav.shape[0])
        out_samples = int(wav.shape[-1])
        duration = out_samples / float(sample_rate)

        # -- file facts ----------------------------------------------------
        stat = os.stat(path)
        base = os.path.basename(path)
        stem, ext = os.path.splitext(base)
        extension = ext[1:].lower()

        bit_rate = int(decode_info.get("bit_rate_bps") or 0)
        bit_rate_source = "container" if bit_rate else ""
        if not bit_rate and tag_info.get("bitrate"):
            try:
                bit_rate = int(tag_info["bitrate"])
                bit_rate_source = "mutagen"
            except Exception:
                bit_rate = 0
        if not bit_rate and bit_depth and not is_lossy:
            # No stored bitrate: report the uncompressed PCM equivalent and say so.
            bit_rate = int(sample_rate * source_channels * bit_depth)
            bit_rate_source = "computed_uncompressed_equivalent"
        if not bit_rate:
            bit_rate_source = "unknown"
        if not bit_rate_source:
            bit_rate_source = "container"

        if bit_depth == 0 and not is_lossy:
            warnings.append(
                "Bit depth could not be determined from this container; reported as 0."
            )

        metadata: Dict[str, Any] = {
            "schema": "nova.audio_load.metadata",
            "schema_version": 1,
            "node_version": VERSION,
            "read_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "file": {
                "path": path,
                "name": base,
                "stem": stem,
                "extension": extension,
                "size_bytes": int(stat.st_size),
                "size_mib": round(stat.st_size / (1024.0 * 1024.0), 4),
                "modified_utc": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat().replace("+00:00", "Z"),
                "quick_signature_sha256": _quick_signature(path, int(stat.st_size)),
            },
            "format": {
                "container": decode_info.get("container") or header.get("container") or extension.upper(),
                "container_description": decode_info.get("container_description", ""),
                "codec": decode_info.get("codec") or header.get("encoding")
                         or decode_info.get("encoding") or "",
                "codec_description": decode_info.get("codec_description", ""),
                "sample_encoding": decode_info.get("encoding") or header.get("encoding") or "",
                "sample_encoding_description": decode_info.get("encoding_description", ""),
                "lossy": bool(is_lossy),
                "bit_depth": int(bit_depth),
                "bit_depth_label": bit_depth_label,
                "bit_depth_source": bit_depth_source,
                "bit_rate_bps": int(bit_rate),
                "bit_rate_kbps": round(bit_rate / 1000.0, 2) if bit_rate else 0.0,
                "bit_rate_source": bit_rate_source,
                "decoder_backend": decode_info.get("backend", "unknown"),
                "decoder_sample_format": decode_info.get("sample_format", ""),
                "container_header_probe": header or None,
            },
            "audio": {
                "sample_rate": int(sample_rate),
                "channels": out_channels,
                "channel_layout": _channel_layout(out_channels),
                "samples_per_channel": out_samples,
                "total_samples": out_samples * out_channels,
                "duration_seconds": round(duration, 6),
                "duration_hms": _hms(duration),
                "dtype": "float32",
                "device": "cpu",
                "tensor_shape": [1, out_channels, out_samples],
            },
            "source": {
                "sample_rate": int(sample_rate),
                "channels": source_channels,
                "channel_layout": _channel_layout(source_channels),
                "samples_per_channel": source_samples,
                "duration_seconds": round(source_duration, 6),
                "duration_hms": _hms(source_duration),
            },
            "processing": {
                "channel_mode": channel_mode,
                "channels_converted": bool(converted),
                "start_seconds": round(float(start_seconds), 6),
                "requested_duration_seconds": round(float(duration_seconds), 6),
                "trimmed": bool(trimmed),
                "trim_sample_range": [start_index, end_index],
                "resampled": False,
                "gain_applied_db": 0.0,
                "note": "Decode only — no resampling, normalisation or filtering is applied.",
            },
            "levels": _levels(wav),
            "tags": tags,
            "tags_source": tag_source,
            "tag_technical_info": tag_info,
            "compatibility": {
                "torch_version": torch.__version__,
                "output_device": "cpu",
                "output_dtype": "float32",
                "gpu_agnostic": True,
                "note": "CPU float32 output; no CUDA/HIP-specific code paths. "
                        "Verified-safe pattern for AMD ROCm (RX 9070 XT / gfx1201).",
            },
            "decoder_attempts": attempts,
            "warnings": warnings,
        }

        audio_out = {
            "waveform": wav.unsqueeze(0),  # [1, C, N]
            "sample_rate": int(sample_rate),
        }

        return (
            audio_out,
            stem,
            int(sample_rate),
            float(duration),
            extension,
            json.dumps(metadata, indent=2, ensure_ascii=False, allow_nan=False),
            int(bit_depth),
        )

NODE_CLASS_MAPPINGS = {"NovaLoadAudio": NovaLoadAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaLoadAudio": "Nova Load Audio 🔄"}
