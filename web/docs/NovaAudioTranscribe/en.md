# Nova Audio Transcribe

Speech-to-text on any `AUDIO` input, using Whisper through Hugging Face
`transformers`. Built for judging whether a vocal actually sings the words you
wrote — wire it into Nova Lyric Score to get that measured.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `audio` | — | The audio to transcribe. |
| `model` | `whisper-large-v3` | Most accurate. `large-v3-turbo` is much faster for a small accuracy cost; `medium`/`small`/`base`/`tiny` for quick tests. |
| `task` | `transcribe` | `transcribe` keeps the language; `translate` renders it into English. |
| `language` | `auto` | Detect, or force with a code or name — `en`, `english`. |
| `timestamps` | `segment` | Granularity in the JSON. `word` is slower. `none` returns no segments. |

Optional:

| Widget | Default | Purpose |
|---|---|---|
| `vocal_isolation` | `off` | `htdemucs` or `htdemucs_ft` separates the voice from the music first. **Turn this on for songs.** |
| `device` | `auto` | On ROCm choose `cuda` — that is what torch calls the GPU there. `auto` finds it anyway. |
| `precision` | `auto` | fp16 on GPU, fp32 on CPU. |
| `beam_size` | `1` | 1 is greedy and fast. 5 buys a little accuracy for real time. |
| `long_form` | `auto` | How audio over 30 s is handled. Leave it alone — see below. |
| `chunk_length_s` | `30` | Chunked mode only. 30 is Whisper's native window. |
| `batch_size` | `8` | Chunked mode only. Windows decoded in parallel: the main speed lever, bounded by VRAM. |
| `initial_prompt` | empty | Bias the spelling of names and coined words. Best-effort — if it causes a generation error the node retries once without it. |
| `keep_model_loaded` | keep in VRAM | Cache the pipeline for fast re-runs, or free it after the run. |

## Outputs

| Output | Notes |
|---|---|
| `text` | The full transcript. This is what Nova Lyric Score's `transcript` wants. |
| `json` | Transcript, detected language, task, model, duration, and timestamped segments. |
| `audio` | **The audio that was transcribed** — the isolated vocal stem when `vocal_isolation` is on, otherwise the input passed through. |

That third output is worth knowing about: with isolation on it is an acapella.
Wire it to Nova Player to hear what Whisper actually heard, or to a save node to
keep the stem.

## Songs need vocal isolation

Whisper is a speech model. A full music mix transcribes badly — garbled lines,
dropped words, and invented ones. Separating the voice first is the single
biggest accuracy win available here, worth far more than moving from
`large-v3-turbo` to `large-v3`.

`htdemucs` is the sensible default. `htdemucs_ft` is more accurate and roughly
**four times slower**, and on a constrained card the combination of
`htdemucs_ft` and `large-v3` is what tips a machine into out-of-memory — or, on
some ROCm stacks, a driver reset.

## Demucs is freed before Whisper loads

Both models are large, and holding them on the GPU at once can overcommit VRAM
and hang it. So the node isolates the vocals, releases Demucs and empties the
cache, and only then loads Whisper. The cost is a few seconds reloading Demucs
from disk on the next run; the benefit is that the two never fight for the card.

If you are tight on VRAM, the levers in order of cheapest first: a smaller model,
`htdemucs` over `htdemucs_ft`, a lower `batch_size`, `keep_model_loaded` off,
and `device = cpu` as a last resort.

## Long audio just works

Whisper's decoder has a 448-token limit that its native sequential mode can
overflow on a long file. `auto` uses sequential decoding for clips under about
28 seconds and chunks anything longer, and if a sequential run overflows anyway
it falls back to chunked by itself. Leave `long_form` on `auto` unless you have
a specific reason not to.

## Nothing touches the disk

Audio is read straight from the tensor — batch item 0, downmixed to mono,
resampled to 16 kHz. No temporary file is written and no external decoder runs.

The node re-runs when the audio changes: `IS_CHANGED` hashes the waveform
itself, not just the node's settings.

## Dependencies

`torch`, `transformers` and `torchaudio` — almost always already in ComfyUI.
`demucs` only if you use isolation. **The node installs nothing.** If something
is missing it raises an error naming the exact interpreter and the pip command
to run.

Whisper weights download from Hugging Face on first use of each model and are
cached after that: roughly 3 GB for `large-v3`, 1.6 GB for `large-v3-turbo`.

## Where it sits in the chain

    Load Audio ──audio──> Nova Audio Transcribe ──text──> Nova Lyric Score
                                    └──json──> Nova Lyric Report (timed view)
