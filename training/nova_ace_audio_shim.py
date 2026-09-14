"""
nova_ace_audio_shim.py — keep ACE-Step's preprocessing able to decode audio on
machines where torchaudio's decoder backend cannot load.

WHY THIS EXISTS
---------------
torchaudio >= 2.9 no longer decodes anything itself; ``torchaudio.load()``
delegates to **torchcodec**, and torchcodec ships as separate wheels per
compute backend. The wheel published on PyPI is the CUDA build: its shared
objects link against ``libc10_cuda.so``, ``libtorch_cuda.so``, ``libcudart``
and ``libnvrtc``. On a ROCm (or Intel, or CPU-only) PyTorch install those
libraries do not exist, so every torchcodec ``.so`` fails to load and
``torchaudio.load()`` dies with:

    Could not load this library: .../torchcodec/libtorchcodec_image.so

ACE-Step already anticipates this — ``dataset_builder_modules/audio_io.py``
calls torchcodec optionally and falls back to soundfile, with the comment
"torchcodec is optional on ROCM/Intel platforms due to CUDA dependencies".
But ``dataset_builder_modules/preprocess_audio.load_audio_stereo`` — the
function ``training_v2/preprocess.py`` uses for Pass 1 — calls
``torchaudio.load()`` with no fallback. So preprocessing fails on every file
while the models themselves load perfectly.

WHAT THIS DOES
--------------
Nothing at all when torchcodec works. When it is provably broken, it replaces
that one function with a decode path that uses libraries ACE-Step already
depends on (soundfile, then PyAV), resampling with ``torchaudio.transforms``,
which is pure torch and needs no codec. The replacement matches the original's
contract exactly: stereo float tensor ``[2, N]`` at the target rate, truncated
to ``max_duration``, returned alongside the *source* sample rate.

Scope and honesty, per the pack's standards:
  * The patch is applied to ``acestep`` only, only after a probe proves the
    decoder is broken, and it is announced in the node's log — never silent.
  * It is idempotent and reversible: the original stays on the module as
    ``_nova_original_load_audio_stereo``.
  * Nothing is installed or downloaded. The permanent environment fix is
    printed for the user to run themselves.
  * ``load_audio_stereo`` is INTERNAL ACE-Step API with no stability promise.
    If upstream renames it the probe simply reports that it could not patch,
    and the node still runs — it just fails the way it does today.
"""

import importlib
import importlib.util
import os
import sys
from typing import List, Optional, Tuple

_CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def _install_command() -> str:
    """The right incantation for THIS environment — pip, or uv when a uv-made
    venv has no pip in it (which is the common ComfyUI layout now)."""
    exe = sys.executable
    venv = os.path.dirname(exe)
    if importlib.util.find_spec("pip") is not None:
        return (f"    {exe} -m pip install --no-deps --force-reinstall \\\n"
                f"        --index-url {_CPU_INDEX} torchcodec")
    uv = os.path.join(venv, "uv")
    uv = uv if os.path.exists(uv) else "uv"
    return (f"    {uv} pip install --python {exe} --no-deps --reinstall \\\n"
            f"        --index-url {_CPU_INDEX} torchcodec")


#: Printed for the user to run — this node never installs anything itself
#: (Comfy Registry standards, no runtime package installation).
TORCHCODEC_FIX = (
    "Permanent fix, so the shim is never needed (run it yourself — this node\n"
    "installs nothing), then restart ComfyUI:\n"
    + _install_command() + "\n"
    "  The torchcodec on PyPI is a CUDA build: its shared objects need\n"
    "  libtorch_cuda / libcudart / libnvrtc, which a ROCm (or Intel, or\n"
    "  CPU-only) PyTorch does not ship, so none of them load. The +cpu build\n"
    "  links only against libtorch and libc10, which every PyTorch provides.\n"
    "  Decoding happens on the CPU either way — the GPU never decoded audio."
)


def probe_torchaudio_decoder() -> Optional[str]:
    """Return None if audio decoding works, else a one-line reason."""
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
    except Exception as exc:                      # pragma: no cover
        return f"torchaudio is not importable ({exc})"

    try:
        from torchcodec.decoders import AudioDecoder  # noqa: F401
    except ImportError:
        return "torchcodec is not installed"
    except Exception as exc:
        first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
        return f"torchcodec will not load ({first})"
    return None


# --------------------------------------------------------------------------
# Replacement decoder
# --------------------------------------------------------------------------

def _read_soundfile(path: str, max_frames: Optional[int]):
    import numpy as np
    import soundfile as sf

    with sf.SoundFile(path) as handle:
        rate = int(handle.samplerate)
        frames = handle.read(
            frames=-1 if max_frames is None else max_frames,
            dtype="float32",
            always_2d=True,
        )
    return np.ascontiguousarray(frames.T), rate      # [C, N]


def _read_pyav(path: str, max_frames: Optional[int]):
    import av
    import numpy as np

    chunks: List["np.ndarray"] = []
    rate = 0
    have = 0
    with av.open(path) as container:
        stream = container.streams.audio[0]
        rate = int(stream.codec_context.sample_rate or stream.rate or 0)
        resampler = av.AudioResampler(format="fltp", layout=stream.layout.name, rate=rate)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                block = out.to_ndarray()             # [C, N] planar float
                chunks.append(block)
                have += block.shape[-1]
            if max_frames is not None and have >= max_frames:
                break
    if not chunks:
        raise RuntimeError("PyAV decoded no audio frames")
    data = np.concatenate(chunks, axis=-1)
    if data.ndim == 1:
        data = data[None, :]
    return np.ascontiguousarray(data), rate


def nova_load_audio_stereo(audio_path: str, target_sample_rate: int, max_duration: float):
    """Drop-in replacement for ACE-Step's ``load_audio_stereo``.

    Same contract: returns ``(tensor[2, N] float32 at target_sample_rate,
    source_sample_rate)`` truncated to ``max_duration``.
    """
    import torch
    import torchaudio

    # Read only what we need, plus a second of margin so the resampler's
    # filter tail never lands inside the region we keep.
    try:
        import soundfile as sf
        source_rate = int(sf.info(audio_path).samplerate)
    except Exception:
        source_rate = 0
    max_frames = None
    if source_rate and max_duration and max_duration > 0:
        max_frames = int((float(max_duration) + 1.0) * source_rate)

    errors: List[str] = []
    data = None
    rate = 0
    for name, reader in (("soundfile", _read_soundfile), ("pyav", _read_pyav)):
        try:
            data, rate = reader(audio_path, max_frames)
            if rate:
                break
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            data = None
    if data is None or not rate:
        raise RuntimeError(
            "Nova decode shim could not read " + audio_path + " — " + "; ".join(errors)
        )

    audio = torch.from_numpy(data).to(torch.float32)

    if rate != target_sample_rate:
        audio = torchaudio.transforms.Resample(rate, target_sample_rate)(audio)

    if audio.shape[0] == 1:
        audio = audio.repeat(2, 1)
    elif audio.shape[0] > 2:
        audio = audio[:2, :]

    max_samples = int(float(max_duration) * target_sample_rate)
    if max_samples > 0 and audio.shape[1] > max_samples:
        audio = audio[:, :max_samples]

    return audio.contiguous(), rate


# --------------------------------------------------------------------------
# Patch application
# --------------------------------------------------------------------------

_TARGET_MODULE = "acestep.training.dataset_builder_modules.preprocess_audio"


def apply_decode_shim() -> Tuple[bool, List[str]]:
    """Patch ACE-Step's Pass 1 decoder when torchaudio cannot decode.

    Returns ``(patched, log_lines)``. Never raises: a failure to patch is
    reported, not fatal — the run then fails the way it would have anyway,
    which is information the user needs rather than a mask over it.
    """
    reason = probe_torchaudio_decoder()
    if reason is None:
        return False, []

    lines = [
        "Audio decode  : torchaudio cannot decode on this install —",
        f"                {reason}.",
    ]

    try:
        module = importlib.import_module(_TARGET_MODULE)
    except Exception as exc:
        lines.append(f"                Could not reach {_TARGET_MODULE} to patch it ({exc}).")
        lines.append("                Pass 1 will fail. " + TORCHCODEC_FIX.splitlines()[0])
        return False, lines

    original = getattr(module, "load_audio_stereo", None)
    if original is None:
        lines.append("                ACE-Step no longer exposes load_audio_stereo; not patching.")
        return False, lines

    if getattr(module, "_nova_shim_active", False):
        lines.append("                Nova decode shim already active (soundfile -> PyAV).")
        return True, lines

    module._nova_original_load_audio_stereo = original
    module.load_audio_stereo = nova_load_audio_stereo
    module._nova_shim_active = True

    lines.append("                Using the Nova decode shim instead (soundfile -> PyAV,")
    lines.append("                resampling with torchaudio.transforms — no codec needed).")
    lines.append("                Results are identical; only the decoder changes.")
    return True, lines
