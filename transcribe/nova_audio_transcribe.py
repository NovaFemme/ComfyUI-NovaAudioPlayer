"""
nova_audio_transcribe.py — transcribe a ComfyUI AUDIO input to text + JSON.

A standalone speech-to-text node for the Nova pack. Takes a ComfyUI ``AUDIO``
signal and returns the transcript both as plain text and as a JSON string with
per-segment (or per-word) timestamps.

ENGINE — accuracy first
-----------------------
Uses OpenAI **Whisper** through Hugging Face ``transformers`` (pure PyTorch),
defaulting to **whisper-large-v3** — the most accurate open Whisper. Because it
runs on torch it uses the GPU on **both** CUDA and ROCm (AMD), and falls back to
CPU when there is no GPU. ``large-v3-turbo`` is offered for a big speed-up at a
small accuracy cost, and the smaller models for quick tests.

The audio is fed straight from the ComfyUI tensor (downmixed to mono, resampled
to 16 kHz) — nothing is written to disk and no external decoder is touched, so
this side-steps the torchaudio/torchcodec decode issue the preprocess node
works around.

INSTALLS / DOWNLOADS
--------------------
Installs nothing at runtime (Comfy Registry standard). ``transformers`` and
``torch`` must already be in ComfyUI's Python — they almost always are. The
Whisper weights download from Hugging Face on first use (like any HF model) and
are then cached; the node reports the model it is loading.

NOTE for sung lyrics: Whisper is a speech model, so music vocals are hard. This
node can isolate the vocal stem first with **Demucs** (``vocal_isolation``) and
transcribe that, which is the single biggest accuracy win on music; the
``initial_prompt`` field can also bias spelling/vocabulary.
"""
import gc
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

try:
    from ..nova_categories import ANALYSIS
except ImportError:  # direct execution / test harness
    from nova_categories import ANALYSIS

# -- optional Nova pack integration (banner + category), with safe fallbacks --
try:
    from ..authoring.nova_authoring_common import banner          # type: ignore
except Exception:
    try:
        from nova_authoring_common import banner                  # type: ignore
    except Exception:
        def banner(title: str) -> str:
            bar = "=" * max(12, len(title) + 4)
            return f"{bar}\n  {title}\n{bar}"

VERSION = "1.0.0"
# Change this one line to file the node elsewhere in the menu.
CATEGORY = ANALYSIS

MODELS = [
    "openai/whisper-large-v3",
    "openai/whisper-large-v3-turbo",
    "openai/whisper-medium",
    "openai/whisper-small",
    "openai/whisper-base",
    "openai/whisper-tiny",
]

TARGET_SR = 16000

# Loaded pipelines / demucs separators are cached across runs.
_PIPELINES: Dict[Tuple[str, str, str], Any] = {}
_SEPARATORS: Dict[Tuple[str, str], Any] = {}


def _free_separators() -> None:
    """Release any cached Demucs models from (V)RAM and empty the CUDA/ROCm cache.

    Whisper-large-v3 and Demucs are both large; keeping both resident on the GPU
    at once can overcommit VRAM and hang the GPU (driver TDR/reset), especially
    on new ROCm stacks and with ComfyUI's --disable-smart-memory. We isolate the
    vocals, then free Demucs before the Whisper model is loaded. Demucs reloads
    from the on-disk checkpoints on the next run (a few seconds).
    """
    _SEPARATORS.clear()
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _vram(tag: str) -> str:
    """One line of GPU memory, so a report says where the VRAM went.

    'It crashes' and 'that is normal' are both unfalsifiable. A number after
    each stage is not: if Demucs really was freed, allocated drops back to
    roughly nothing before Whisper loads, and if it did not, the line says so.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return ""
        free_b, total_b = torch.cuda.mem_get_info()
        gib = 1024 ** 3
        return (f"VRAM    : {tag:<22} allocated {torch.cuda.memory_allocated()/gib:5.2f} GiB | "
                f"reserved {torch.cuda.memory_reserved()/gib:5.2f} GiB | "
                f"free {free_b/gib:5.2f} of {total_b/gib:5.2f} GiB")
    except Exception:
        return ""


# Rough cost of one 30 s chunk of Whisper encoder + decoder KV cache, in GiB.
# The encoder attends over 1500 frames, so the batch dimension multiplies a
# large activation, not just the weights. Measured against a 16 GiB card that
# died at batch 8 on large-v3; deliberately pessimistic.
_CHUNK_GIB = ((".en", 0.35), ("tiny", 0.25), ("base", 0.35), ("small", 0.6),
              ("medium", 0.95), ("large", 1.6))

# Left for the compositor. A card that draws the desktop cannot be run to the
# last byte: at ~98% the display server stops responding and the machine locks
# up, which is worse than an honest OOM because it takes the log with it.
_DISPLAY_HEADROOM_GIB = 1.5


def _safe_batch(requested: int, model_name: str) -> Tuple[int, str]:
    """Cap batch_size by the VRAM actually free, before the first attempt.

    Opening at batch 8 on a 16 GiB card that also drives a monitor is how you
    get a desktop freeze rather than a recoverable error. Retrying downwards
    only helps if the first attempt leaves the machine alive.
    """
    requested = max(1, int(requested))
    try:
        import torch
        if not torch.cuda.is_available():
            return requested, ""
        free_b, _total = torch.cuda.mem_get_info()
    except Exception:
        return requested, ""

    gib = 1024 ** 3
    name = (model_name or "").lower()
    per_chunk = next((v for k, v in _CHUNK_GIB if k in name), 1.6)
    usable = (free_b / gib) - _DISPLAY_HEADROOM_GIB
    cap = max(1, int(usable / per_chunk))
    if cap >= requested:
        return requested, ""
    return cap, (
        f"Batch   : {requested} would not fit — {free_b/gib:.2f} GiB free, "
        f"{_DISPLAY_HEADROOM_GIB:.1f} GiB held back for the desktop, "
        f"~{per_chunk:.2f} GiB per chunk. Starting at {cap}."
    )


def _reclaim_vram(*held) -> None:
    """Actually give the GPU memory back before retrying after an OOM.

    `torch.cuda.empty_cache()` only returns memory the allocator holds with no
    live reference. Inside an `except` block the exception's __traceback__
    pins every frame of the failed forward pass, and those frames still
    reference the activations and the KV cache that caused the OOM — so the
    cache call frees almost nothing and the retry starts on a full card.
    Measured: a batch_size=8 failure left 14.16 GiB allocated, so the
    batch_size=1 retry died in 120 ms against a card that was already full.

    Drop the tracebacks, collect, then empty the cache.
    """
    import gc as _gc
    for obj in held:
        try:
            if isinstance(obj, BaseException):
                obj.__traceback__ = None
        except Exception:
            pass
    held = ()
    _gc.collect()
    try:
        import torch as _torch
        if _torch.cuda.is_available():
            _torch.cuda.empty_cache()
            _torch.cuda.ipc_collect()
    except Exception:
        pass


def _is_oom(err) -> bool:
    """True if an exception (or its message) is a GPU out-of-memory error.

    Covers torch.cuda.OutOfMemoryError (also raised on ROCm) and the
    'CUDA/HIP out of memory' message text.
    """
    if isinstance(err, BaseException) and type(err).__name__ == "OutOfMemoryError":
        return True
    return "out of memory" in str(err).lower()


# ---------------------------------------------------------------------------
# Audio + result helpers (kept import-light and unit-testable)
# ---------------------------------------------------------------------------

def to_mono_16k(audio: Dict[str, Any]):
    """ComfyUI AUDIO ({"waveform": [B,C,T], "sample_rate": int}) -> (np.float32 [T], 16000)."""
    import torch
    import torchaudio

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if not torch.is_tensor(waveform):
        waveform = torch.as_tensor(waveform)
    if waveform.dim() == 3:      # [B, C, T] -> take first item in the batch
        waveform = waveform[0]
    elif waveform.dim() == 1:    # [T] -> [1, T]
        waveform = waveform.unsqueeze(0)
    waveform = waveform.to(torch.float32)
    if waveform.shape[0] > 1:    # downmix to mono
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != TARGET_SR:
        waveform = torchaudio.functional.resample(waveform, sample_rate, TARGET_SR)
    array = waveform.squeeze(0).contiguous().cpu().numpy()
    return array, TARGET_SR


def format_result(result: Dict[str, Any], meta: Dict[str, Any]) -> Tuple[str, str]:
    """Turn a transformers ASR result into (plain_text, json_string)."""
    text = (result.get("text") or "").strip()
    segments: List[Dict[str, Any]] = []
    for chunk in (result.get("chunks") or []):
        ts = chunk.get("timestamp") or (None, None)
        start, end = (ts + (None, None))[:2] if isinstance(ts, (list, tuple)) else (None, None)
        segments.append({
            "start": start,
            "end": end,
            "text": (chunk.get("text") or "").strip(),
        })
    document = {
        "text": text,
        "language": meta.get("language"),
        "task": meta.get("task"),
        "model": meta.get("model"),
        "duration_seconds": meta.get("duration"),
        "timestamps": meta.get("granularity"),
        "segments": segments,
    }
    return text, json.dumps(document, ensure_ascii=False, indent=2)


def _pick_device(preference: str) -> str:
    import torch
    if preference == "cpu":
        return "cpu"
    has_gpu = torch.cuda.is_available()
    if preference == "cuda":
        return "cuda:0" if has_gpu else "cpu"
    return "cuda:0" if has_gpu else "cpu"   # auto


def _pick_dtype(device: str, precision: str):
    import torch
    if precision == "fp32":
        return torch.float32
    if precision == "fp16":
        return torch.float16 if device.startswith("cuda") else torch.float32
    # auto: half on GPU, full on CPU
    return torch.float16 if device.startswith("cuda") else torch.float32


def _build_pipeline(model_id: str, device: str, dtype):
    """Build a transformers ASR pipeline, tolerating the dtype/torch_dtype rename."""
    from transformers import pipeline
    try:
        return pipeline("automatic-speech-recognition", model=model_id, dtype=dtype, device=device)
    except TypeError:
        return pipeline("automatic-speech-recognition", model=model_id, torch_dtype=dtype, device=device)


def _get_pipeline(model_id: str, device: str, dtype):
    key = (model_id, device, str(dtype))
    pipe = _PIPELINES.get(key)
    if pipe is None:
        pipe = _build_pipeline(model_id, device, dtype)
        _PIPELINES[key] = pipe
    return pipe


# ---------------------------------------------------------------------------
# Vocal isolation (optional, Demucs)
# ---------------------------------------------------------------------------

def _get_separator(model_name: str, device: str):
    """Load a Demucs separator, working across Demucs versions.

    Returns (kind, handle):
      ("api",      Separator)              -> Demucs >= 4.0 high-level API
      ("lowlevel", (model, apply_model))  -> classic pretrained/apply path,
                                             available on installs without
                                             demucs.api (what other Demucs
                                             nodes use).
    """
    key = (model_name, "cuda" if device.startswith("cuda") else "cpu")
    sep = _SEPARATORS.get(key)
    if sep is not None:
        return sep

    # Preferred: Demucs >= 4.0 high-level API (if this install exposes it).
    try:
        from demucs.api import Separator
        sep = ("api", Separator(model=model_name, device=key[1], progress=False))
        _SEPARATORS[key] = sep
        return sep
    except Exception:
        pass  # fall back to the low-level API below

    # Fallback: low-level pretrained + apply. Present on every Demucs that can
    # separate at all, including installs without demucs.api.
    try:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except Exception as exc:
        raise RuntimeError(
            "Vocal isolation needs a working Demucs: neither demucs.api nor "
            "demucs.pretrained/apply could be imported. Repair it in ComfyUI's "
            "Python, e.g. (ROCm-safe):  python -m pip install -U --no-deps demucs"
        ) from exc

    model = get_model(model_name)
    model.to(key[1])
    model.eval()
    sep = ("lowlevel", (model, apply_model))
    _SEPARATORS[key] = sep
    return sep


def isolate_vocals(audio: Dict[str, Any], model_name: str, device: str) -> Dict[str, Any]:
    """Return a new AUDIO dict holding only the separated vocal stem."""
    import torch

    kind, handle = _get_separator(model_name, device)
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if not torch.is_tensor(waveform):
        waveform = torch.as_tensor(waveform)
    if waveform.dim() == 3:
        waveform = waveform[0]        # [C, T]
    elif waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    waveform = waveform.to(torch.float32)
    if waveform.shape[0] == 1:        # Demucs expects stereo
        waveform = waveform.repeat(2, 1)

    if kind == "api":
        separator = handle
        _origin, stems = separator.separate_tensor(waveform, sample_rate)
        vocals = stems["vocals"]      # [C, T] at the model's sample rate
        out_sr = int(getattr(separator, "samplerate", 44100))
    else:
        import torchaudio

        model, apply_model = handle
        dev = "cuda" if device.startswith("cuda") else "cpu"
        model_sr = int(getattr(model, "samplerate", 44100))
        want_ch = int(getattr(model, "audio_channels", 2))

        if sample_rate != model_sr:
            waveform = torchaudio.functional.resample(waveform, sample_rate, model_sr)
        ch = waveform.shape[0]
        if ch < want_ch:
            waveform = waveform.repeat(want_ch, 1)[:want_ch]
        elif ch > want_ch:
            waveform = waveform[:want_ch]

        # Match Demucs' own per-mix normalisation (mono reference, scalar mean/std).
        ref = waveform.mean(0)
        mean = ref.mean()
        std = ref.std().clamp_min(1e-8)
        mix = ((waveform - mean) / std).unsqueeze(0).to(dev)   # [1, C, T]

        sources = apply_model(
            model, mix, shifts=1, split=True, overlap=0.25,
            progress=False, device=dev,
        )[0]                                                    # [S, C, T]
        sources = sources * std + mean

        names = list(getattr(model, "sources", []))
        idx = names.index("vocals") if "vocals" in names else -1
        vocals = sources[idx].detach().cpu()                    # [C, T]
        out_sr = model_sr

    return {"waveform": vocals.unsqueeze(0), "sample_rate": out_sr}


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------

def _reject_placeholder_audio(audio) -> None:
    """Refuse an AUDIO payload that carries no actual audio.

    Nova Batch Load Audio emits a one-sample silent placeholder when
    decode_audio is off, because tagging works on file paths and decoding a
    folder of FLACs would cost minutes of CPU for a result nothing reads. Wired
    straight into this node it reaches Demucs, which fails a reflect-padding
    sanity check deep inside its own model and reports a bare AssertionError
    with no hint of the cause. One sentence here is worth more than that stack.
    """
    try:
        waveform = audio["waveform"] if isinstance(audio, dict) else None
        samples = int(waveform.shape[-1]) if waveform is not None else 0
        rate = int(audio.get("sample_rate", 0)) if isinstance(audio, dict) else 0
    except Exception:
        return                                  # let the normal path report it

    if waveform is None:
        return
    if samples < 1024:
        raise ValueError(
            "Nova Audio Transcribe received an AUDIO input with "
            f"{samples} sample(s) — there is nothing to transcribe.\n"
            "If it is wired to Nova Batch Load Audio, turn decode_audio ON: "
            "with it off that node's audio output is a one-sample silent "
            "placeholder, because tagging only needs file paths.\n"
            "Nova Load Audio always decodes and can be used instead."
        )
    if rate <= 0:
        raise ValueError(
            f"Nova Audio Transcribe received an AUDIO input with sample_rate {rate}. "
            "The upstream node did not decode the file."
        )


class NovaAudioTranscribe:
    CATEGORY = CATEGORY
    FUNCTION = "transcribe"
    RETURN_TYPES = ("STRING", "STRING", "AUDIO")
    RETURN_NAMES = ("text", "json", "audio")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "The full transcript as plain text.",
        "JSON: transcript, detected language, model, duration and timestamped segments.",
        "The audio that was transcribed: the isolated vocal stem when vocal_isolation "
        "is on, otherwise the input audio passed through. Wire to Save Audio / Nova Player.",
    )
    DESCRIPTION = (
        f"Nova Audio Transcribe v{VERSION} — Whisper speech-to-text on an AUDIO input, "
        "accuracy-first (whisper-large-v3), GPU on CUDA/ROCm with CPU fallback. "
        "Outputs plain text and timestamped JSON."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "Audio to transcribe (e.g. Load Audio)."}),
                "model": (MODELS, {
                    "default": "openai/whisper-large-v3",
                    "tooltip": "large-v3 = most accurate. large-v3-turbo = much faster, slightly less accurate. Smaller = quick tests.",
                }),
                "task": (["transcribe", "translate"], {
                    "default": "transcribe",
                    "tooltip": "transcribe = same language; translate = into English.",
                }),
                "language": ("STRING", {
                    "default": "auto",
                    "tooltip": "'auto' to detect, or a code/name like 'en' / 'english'.",
                }),
                "timestamps": (["segment", "word", "none"], {
                    "default": "segment",
                    "tooltip": "Granularity of timestamps in the JSON output. 'word' is slower.",
                }),
            },
            "optional": {
                "vocal_isolation": (["off", "htdemucs", "htdemucs_ft"], {
                    "default": "off",
                    "tooltip": "Separate the singing voice from the music with Demucs before transcribing (big accuracy win on songs). htdemucs_ft is more accurate but ~4x slower. Needs the 'demucs' package.",
                }),
                "device": (["auto", "cuda", "cpu"], {
                    "default": "auto",
                    "tooltip": "auto uses the GPU when present. On ROCm, 'cuda' is correct — that is what torch calls it.",
                }),
                "precision": (["auto", "fp16", "fp32"], {
                    "default": "auto",
                    "tooltip": "auto = fp16 on GPU, fp32 on CPU.",
                }),
                "beam_size": ("INT", {
                    "default": 1, "min": 1, "max": 10,
                    "tooltip": "Beam search width. 1 = greedy (fast). 5 can improve accuracy at a speed cost.",
                }),
                "long_form": (["auto", "chunked", "sequential"], {
                    "default": "auto",
                    "tooltip": "How audio longer than 30s is handled. auto = sequential for short clips, chunked for long ones (recommended). chunked = split into <=30s windows and batch (robust for any length). sequential = Whisper's native long-form (can hit the 448-token limit on long audio in some transformers versions).",
                }),
                "chunk_length_s": ("INT", {
                    "default": 30, "min": 5, "max": 30,
                    "tooltip": "chunked mode only: window length in seconds. 30 is Whisper's native window.",
                }),
                "batch_size": ("INT", {
                    "default": 8, "min": 1, "max": 64,
                    "tooltip": "chunked mode only: windows decoded in parallel. Higher is faster but uses more VRAM.",
                }),
                "initial_prompt": ("STRING", {
                    "default": "", "multiline": True,
                    "placeholder": "Optional: bias spelling/vocabulary, e.g. names or lyric terms.",
                    "tooltip": "Best-effort hint fed to Whisper. Ignored if the model rejects it.",
                }),
                "keep_model_loaded": ("BOOLEAN", {
                    "default": True, "label_on": "keep in VRAM", "label_off": "free after run",
                    "tooltip": "Keep the model cached for fast re-runs, or free it to reclaim VRAM.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, audio=None, **kwargs):
        h = hashlib.blake2b(digest_size=16)
        try:
            waveform = audio["waveform"]
            h.update(repr(tuple(waveform.shape)).encode())
            h.update(str(int(audio["sample_rate"])).encode())
            h.update(waveform.detach().cpu().contiguous().numpy().tobytes())
        except Exception:
            return float("nan")
        for key in sorted(kwargs):
            h.update(f"{key}={kwargs[key]}".encode())
        return h.hexdigest()

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _require_deps():
        import importlib.util
        missing = [m for m in ("torch", "transformers", "torchaudio")
                   if importlib.util.find_spec(m) is None]
        if missing:
            import sys
            raise ImportError(
                "Nova Audio Transcribe: missing " + ", ".join(missing) + " in "
                f"{sys.executable}.\n  This node installs nothing at runtime. Install, "
                "then restart ComfyUI:\n    " + sys.executable + " -m pip install "
                + " ".join(missing)
            )

    @staticmethod
    def _require_demucs():
        import importlib.util
        if importlib.util.find_spec("demucs") is None:
            import sys
            raise ImportError(
                "Nova Audio Transcribe: vocal_isolation needs the 'demucs' package, "
                f"not installed in {sys.executable}.\n  This node installs nothing at "
                "runtime. Install it, then restart ComfyUI:\n    "
                + sys.executable + " -m pip install demucs\n"
                "  Or set vocal_isolation to 'off'."
            )

    @staticmethod
    def _generate_kwargs(task, language, beam_size):
        gk: Dict[str, Any] = {"task": task}
        lang = (language or "").strip().lower()
        if lang and lang != "auto":
            gk["language"] = lang
        if int(beam_size) > 1:
            gk["num_beams"] = int(beam_size)
        return gk

    # -- main ---------------------------------------------------------------
    def transcribe(self, audio, model, task, language, timestamps,
                   device="auto", precision="auto", beam_size=1,
                   long_form="auto", chunk_length_s=30, batch_size=8,
                   initial_prompt="", keep_model_loaded=True,
                   vocal_isolation="off", **kwargs):
        self._require_deps()
        log: List[str] = [banner(f"NOVA AUDIO TRANSCRIBE v{VERSION}")]

        _reject_placeholder_audio(audio)

        dev = _pick_device(device)

        if vocal_isolation and vocal_isolation != "off":
            self._require_demucs()
            log.append(f"Vocals  : isolating with Demucs ({vocal_isolation})…")
            print("\n".join(log))
            try:
                audio = isolate_vocals(audio, vocal_isolation, dev)
            except Exception as exc:
                # If the GPU can't fit Demucs (common on 16 GB cards that also
                # drive the display), separate on CPU instead of failing.
                if dev != "cpu" and _is_oom(exc):
                    _free_separators()
                    log.append("Vocals  : GPU out of memory — separating on CPU "
                               "instead (slower, but frees VRAM for Whisper)…")
                    print(log[-1])
                    audio = isolate_vocals(audio, vocal_isolation, "cpu")
                else:
                    raise
            # Free Demucs from VRAM before Whisper loads, so the two big models
            # don't stack in GPU memory (a common cause of driver resets/TDR on
            # 16 GB cards, new ROCm builds, and with --disable-smart-memory).
            before = _vram("with Demucs resident")
            _free_separators()
            log.append("Vocals  : done; freed Demucs from VRAM.")
            for line in (before, _vram("after freeing Demucs")):
                if line:
                    log.append(line)
            print("\n".join(log[-3:]))

        array, sr = to_mono_16k(audio)
        duration = round(len(array) / float(sr), 3)

        dtype = _pick_dtype(dev, precision)

        log.append(f"Audio   : {duration:.1f}s @ {sr} Hz mono")
        log.append(f"Model   : {model}")
        log.append(f"Device  : {dev} / {str(dtype).replace('torch.', '')}")
        log.append(f"Task    : {task}   language: {language or 'auto'}   timestamps: {timestamps}   long-form: {long_form}")
        if int(beam_size) > 1:
            log.append(f"Beams   : {beam_size}")
        print("\n".join(log))

        pipe = _get_pipeline(model, dev, dtype)
        line = _vram("Whisper loaded")
        if line:
            log.append(line)
            print(line)

        want_word = timestamps == "word"
        want_none = timestamps == "none"

        gen_kwargs = self._generate_kwargs(task, language, beam_size)

        # Optional initial prompt: best-effort, never fatal.
        prompt = (initial_prompt or "").strip()
        if prompt:
            try:
                prompt_ids = pipe.tokenizer.get_prompt_ids(prompt, return_tensors="pt")
                gen_kwargs["prompt_ids"] = prompt_ids.to(pipe.model.device)
            except Exception as exc:
                log.append(f"Note    : initial_prompt ignored ({type(exc).__name__}: {exc}).")

        # auto: sequential is accurate but only safe within one 30s window;
        # anything longer goes to chunked so it cannot overflow Whisper's
        # 448-token decoder limit.
        effective = long_form
        if long_form == "auto":
            effective = "sequential" if duration <= 28.0 else "chunked"
        rt = "word" if want_word else (False if want_none else True)

        def _chunked_call(gk, batch=None):
            return dict(chunk_length_s=int(chunk_length_s), batch_size=int(batch or batch_size),
                        return_timestamps=(rt if rt else True) if want_none else rt,
                        generate_kwargs=gk, ignore_warning=True)

        def _sequential_call(gk):
            # sequential long-form needs timestamps internally
            return dict(return_timestamps=("word" if want_word else True), generate_kwargs=gk)

        # The audio is already mono 16 kHz, so hand the pipeline the bare array
        # (a plain numpy array is treated as 16 kHz audio) — avoids the dict path.
        audio_input = array

        def _run(call):
            return pipe(audio_input, **call)

        batch_size, note = _safe_batch(batch_size, model)
        if note:
            log.append(note)
            print(note)

        call = _chunked_call(gen_kwargs) if effective == "chunked" else _sequential_call(gen_kwargs)
        log.append(f"Long-form: {effective}" + ("  (auto)" if long_form == "auto" else ""))
        print("\n".join(log[-1:]))

        try:
            result = _run(call)
        except Exception as exc:
            msg = str(exc)
            result = None
            # (a) initial_prompt was the cause -> retry without it
            if "prompt_ids" in gen_kwargs:
                gen_kwargs.pop("prompt_ids", None)
                log.append("Note    : retrying without initial_prompt.")
                call["generate_kwargs"] = gen_kwargs
                try:
                    result = _run(call)
                except Exception as exc2:
                    msg = str(exc2); result = None
            # (b) sequential overflowed the 448-token limit -> fall back to chunked
            if result is None and effective != "chunked" and (
                "max_target_positions" in msg or "max_new_tokens" in msg or "448" in msg):
                log.append("Note    : sequential long-form hit Whisper's length limit; "
                           "falling back to chunked.")
                effective = "chunked"
                try:
                    result = _run(_chunked_call(gen_kwargs))
                except Exception as excb:
                    msg = str(excb); result = None
            # (c) GPU out of memory -> empty the cache and retry chunked with a
            # smaller batch (halved, then 1). Lets a 16 GB card finish instead of
            # dying when Whisper's batched activations don't fit.
            if result is None and _is_oom(msg):
                # Release the failed attempt before retrying. Without this the
                # retry runs against a card the previous failure is still
                # holding, and batch_size=1 fails as fast as batch_size=8 did.
                _reclaim_vram(exc, locals().get("exc2"), locals().get("excb"))
                seen = set()
                ladder = []
                for bs in (int(batch_size) // 2, int(batch_size) // 4, 2, 1):
                    bs = max(1, int(bs))
                    if bs < int(batch_size) and bs not in seen:
                        seen.add(bs); ladder.append(bs)
                for bs in ladder:
                    log.append(f"Note    : GPU out of memory; retrying chunked with batch_size={bs}.")
                    line = _vram("before retry")
                    if line:
                        log.append(line)
                    print("\n".join(log[-2:]))
                    try:
                        effective = "chunked"
                        result = _run(_chunked_call(gen_kwargs, batch=bs))
                        break
                    except Exception as excc:
                        oom = _is_oom(excc)
                        msg = str(excc); result = None
                        _reclaim_vram(excc)
                        if not oom:
                            break
            if result is None:
                raise

        if isinstance(result, dict) and want_none:
            result.pop("chunks", None)

        meta = {
            "language": gen_kwargs.get("language", "auto"),
            "task": task,
            "model": model,
            "duration": duration,
            "granularity": timestamps,
        }
        text, json_str = format_result(result if isinstance(result, dict) else {"text": str(result)}, meta)

        if not keep_model_loaded:
            _PIPELINES.pop((model, dev, str(dtype)), None)
            del pipe
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            log.append("Freed the model from memory (keep_model_loaded is off).")

        words = len(text.split())
        log.append(f"Done    : {words} words, {len(text)} chars.")
        preview = text if len(text) <= 4000 else text[:4000] + " …"
        log.append("")
        log.append(preview or "(no speech detected)")

        # `audio` here is the isolated vocal stem when vocal_isolation was on,
        # otherwise the untouched input — that's what the AUDIO output carries.
        audio_out = audio

        console = "\n".join(log)
        print(console)
        return {"ui": {"text": [console]}, "result": (text, json_str, audio_out)}


NODE_CLASS_MAPPINGS = {"NovaAudioTranscribe": NovaAudioTranscribe}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaAudioTranscribe": "Nova Audio Transcribe 🎙️"}
