# Save Audio WAV PCM16 | PCM24 | FLOAT32

Writes an AUDIO input to a RIFF/WAVE file in 16-bit PCM, 24-bit PCM or 32-bit
IEEE float.

The writers are pure `struct` and `numpy` — no torchaudio, no TorchCodec, no
external binary. That is the point: 24-bit and float32 WAV output work on a ROCm
machine where torchaudio's encoders are unavailable.

## Attribution

Ported from [ComfyUI-SoundHub](https://github.com/Yuan-ManX/ComfyUI-SoundHub),
MIT licensed, Copyright (c) 2024 Yuan-Man. The full licence text is in the
module header.

ComfyUI-SoundHub is not modified, not unregistered and not required. If you have
it installed, its own Save Audio node continues to work alongside this one.

## Inputs

| Widget | Purpose |
|---|---|
| `audio` | The AUDIO to write. |
| `filename_prefix` | Prefix for the file. Subfolders are supported. |
| `format` | WAV only in this build. |
| `wav_encoding` | `PCM_16`, `PCM_24` or `FLOAT_32`. |
| `filename_mode` | How `filename_prefix` becomes a file name. See below. |
| `reload_after_save` | Off by default. On, the written file is read back and that is what leaves the `audio` output. |
| `sample_rate` | Optional override. **0 = use the rate carried in the AUDIO payload**, which is what you normally want. |

The original node took its optional sample rate on SoundHub's private
`SAMPLE_RATE` link type. That would have made this node depend on that pack
being installed, so it is a plain INT here.

## Outputs

| Output | Type | Notes |
|---|---|---|
| `audio` | AUDIO | The reloaded file with `reload_after_save` on; the input passed through with it off. |
| `file_path` | STRING | Absolute path of the file that was written. |

## File naming

`filename_mode` decides how `filename_prefix` becomes a path, and both modes
resolve relative to ComfyUI's output directory. Subfolders are created as needed.

**`exact (overwrite)`** — the default. `filename_prefix` *is* the path and file
name to write. `.wav` is appended only when it is missing; nothing is added to
the stem:

    NovaAudioMasters/High Water Sessions/Audio/01_GC_Into-theGray_Master_24-48.wav
    ->  …/Audio/01_GC_Into-theGray_Master_24-48.wav

An existing file is **replaced**, and the log says
`Overwrote existing file: …` when that happens. This is what makes re-running a
mastering graph land on the same deliverable instead of accumulating versions.

**`prefix + encoding + timestamp`** — the original behaviour, kept for when you
want every render preserved:

    <prefix>_<ENCODING>_<YYYYMMDD-HHMMSS>_<counter>.wav

The counter increments until the name is free, so nothing is ever overwritten.

> Changed default: before this option existed, the node always decorated the
> name. A path ending in `.wav` therefore came out as
> `…_Master_24-48.wav_PCM24_20260911-153921_00001.wav`. Set
> `prefix + encoding + timestamp` to get that back.

## Reloading after save

With `reload_after_save` on, the file is read back off disk and the `audio`
output carries those samples — the actual quantised result, so a 24-bit or
16-bit render can be measured rather than assumed. The log reports what came
back and the largest difference from the input:

    Reloaded: 24-bit PCM, 48000 Hz, 2 ch, 72,000 samples,
              max quantisation error 5.960e-08

Reading is done by a parser in this module rather than by soundfile or PyAV,
so nothing can be resampled, dithered or normalised on the way back in. It
handles PCM 8/16/24/32, float 32/64 and WAVE_FORMAT_EXTENSIBLE.

It is **off by default** because reading a long master back costs real time and
most graphs end at this node.

## Encodings

| Value | Written as |
|---|---|
| `PCM_16` | 16-bit signed PCM, clamped just inside full scale |
| `PCM_24` | 24-bit signed PCM — the usual delivery/master format |
| `FLOAT_32` | 32-bit IEEE float, for archival |

## Limitations

- One audio item per node: a batch with more than one item is rejected rather
  than silently writing only the first.
- WAV only. For FLAC use **Save Audio FLAC 24-bit**.
- Samples outside [-1, 1] are clamped in the integer encodings; use `FLOAT_32`
  if you need to preserve overs.
