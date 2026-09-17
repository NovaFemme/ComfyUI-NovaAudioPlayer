# Nova Audio Transcribe 🎙️

Standalone speech-to-text node for the Nova pack. Takes a ComfyUI **AUDIO**
input and returns the transcript as **text** and as **JSON** (with timestamps),
plus the audio it actually transcribed.

## Inputs / outputs
- **audio** (AUDIO) → any audio signal (Load Audio, a decoder node, etc.).
- Outputs: **text** (STRING), **json** (STRING: transcript, language, model,
  duration, and timestamped `segments`), and **audio** (AUDIO: the isolated
  vocal stem when `vocal_isolation` is on, otherwise the input passed through —
  wire it to a save node to keep the acapella).

## Engine (accuracy first)
OpenAI **Whisper** via Hugging Face `transformers` (pure PyTorch), default
**whisper-large-v3** — the most accurate open Whisper. Runs on the GPU on **both
CUDA and ROCm (AMD)** and falls back to CPU. Audio is fed straight from the
ComfyUI tensor (mono, 16 kHz) — no files, no external decoder, so it avoids the
torchcodec/torchaudio decode issue the preprocess node works around.

Key options: `model` (large-v3 … tiny), `task` (transcribe/translate),
`language` (`auto` or a code), `timestamps` (segment/word/none), `long_form`
(**sequential** = most accurate, **chunked** = faster), `beam_size`,
`initial_prompt` (bias vocabulary/spelling), `keep_model_loaded`, and
**`vocal_isolation`** (see below).

## Requirements
`transformers`, `torch`, `torchaudio` in ComfyUI's Python (almost always
present). For **vocal isolation** you also need `demucs` (`pip install demucs`).
Installs nothing at runtime (Comfy Registry standard). Model weights download
from Hugging Face / Demucs on first use (~3 GB for whisper-large-v3, ~80 MB for
htdemucs) and are cached; the node prints which models it loads.

## Install into the pack
Drop `nova_audio_transcribe.py` into your custom-node pack folder (next to the
`nova_ace_*.py` files). If the pack's top-level `__init__.py` auto-discovers
modules, that's all. If it merges mappings explicitly, add:

```python
from .nova_audio_transcribe import (
    NODE_CLASS_MAPPINGS as _tx_classes,
    NODE_DISPLAY_NAME_MAPPINGS as _tx_names,
)
NODE_CLASS_MAPPINGS.update(_tx_classes)
NODE_DISPLAY_NAME_MAPPINGS.update(_tx_names)
```

It appears under **Nova Audio Player / Transcription** (change the `CATEGORY`
line near the top of the file to file it elsewhere).

## Sung lyrics — vocal isolation (built in)
Whisper is a speech model, so music vocals are hard. Set **`vocal_isolation`**
to `htdemucs` (or `htdemucs_ft` — more accurate, ~4x slower) and the node runs
**Demucs** first to separate the singing voice from the backing track, then
transcribes only that stem. This is the single biggest accuracy win on songs.
It needs the `demucs` package; leave it `off` for plain speech.
`initial_prompt` can further nudge spelling/vocabulary (names, stylised words).

## Validated
Confirmed end-to-end against real speech (LibriSpeech sample) with whisper-tiny:
sequential + chunked long-form, segment/word/none timestamps, beam search,
initial_prompt, free-after-run, IS_CHANGED caching, and Demucs vocal
isolation (isolate -> transcribe) all work.

---

# Nova Lyric Score 📊

Scores a transcript against your intended lyrics — how faithfully the generated
song sang the words.

**Inputs:** `reference_lyrics` (paste the lyrics you generated from) and
`transcript` (wire the **text** output of Nova Audio Transcribe). Pick a
`primary_metric` for the headline score.

**Outputs:** `score` (FLOAT 0–100), `grade` (A+…F), `report_json`, `report_text`
(with an aligned diff — wire into Nova Console).

**Metrics in the report:** word accuracy (1−WER), char accuracy (1−CER),
similarity (softer, order-tolerant), and a breakdown of correct / substituted /
missing / extra words, plus coverage (how much of the lyric was actually sung)
and an extra-words rate (ad-libs / hallucinations). The diff legend is:
`word` ok · `{ref>hyp}` wrong · `-missing-` · `+extra+`.

**Options:** `lowercase`, `strip_punctuation`, `remove_section_tags` (drops
`[Chorus]` / `[Verse 1]` / `[x2]` from the reference), `ignore_parentheticals`
(drop `(ad-libs)`). All stdlib — nothing to install.

### End-to-end wiring for grading generated songs
```
mastered AUDIO
   └─> Nova Audio Transcribe   (vocal_isolation = htdemucs, model = whisper-large-v3)
          └─ text ──> Nova Lyric Score  <── reference_lyrics (your generated lyrics)
                          └─ score / grade / report
```

Notes:
- If your reference writes the chorus once but the song repeats it, strict
  `word_accuracy` will penalise the "missing" repeats — either expand the
  reference to match the performance, or judge with `similarity`, which is more
  forgiving of structure.
- `remove_section_tags` is on by default so `[Chorus]`-style markers in your
  reference don't count against the score.
