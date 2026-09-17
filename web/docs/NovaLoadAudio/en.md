# Nova Load Audio

Loads one audio file and reports everything it can tell you about it. A single
file, in contrast to Nova Batch Load Audio's folder.

![Nova Load Audio with the upload button](images/nova-load-audio.png)
*The dropdown lists ComfyUI's `input/` folder; `file_path` below it overrides
that with any path on disk.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `audio` | first file found | Dropdown of files in ComfyUI's `input/`, with an upload button. |
| `file_path` | empty | Full path to any file anywhere. **Overrides the dropdown when not empty.** |
| `channel_mode` | `native` | `native` keeps the file's channels, `mono` downmixes, `stereo` duplicates mono or keeps the first two. |
| `start_seconds` | `0.0` | Skip this many seconds. `0` = from the beginning. |
| `duration_seconds` | `0.0` | Length to keep after `start_seconds`. `0` = to the end. |

## Outputs

`audio`, `filename` (without its extension), `sample_rate`, `duration`, `type`
(the extension, lowercase, no dot), `metadata` (JSON) and `bit_depth`.

## `file_path` wins

The dropdown only lists ComfyUI's `input/` folder. When you have a file
elsewhere — a master on another drive, a render in an output folder — put the
full path in `file_path` and the dropdown is ignored entirely. The dropdown
still shows whatever it was last set to; that is not a sign it is being used.

## Trimming happens on load

`start_seconds` and `duration_seconds` cut before anything downstream sees the
waveform, and `duration` reports the length of what you actually get, not of the
source file. Both default to `0`, which means the whole file.

## `bit_depth` is `0` for lossy sources

An MP3, AAC or Opus file has no bits-per-sample to report — the format does not
store samples that way. `0` there means "not applicable", not "failed to read".
Check `type` if you need to know why.

## Decoding

Tries soundfile, then torchaudio, then PyAV, and uses the first that is
available and succeeds. `av` and `torchaudio` both ship with ComfyUI, so the
decode path works on a fresh install with no extra packages.

Everything is CPU-only float32: no GPU kernels, no `torch.compile`, no
half-precision. That is deliberate, and it is why this node behaves identically
on AMD ROCm and on CUDA. The backend that was actually used is recorded in
`metadata`.

## Notes

- The `AUDIO` payload is `[1, channels, samples]`, the shape ComfyUI's audio
  nodes expect.
- `metadata` is a JSON string covering file, format, audio, source, processing,
  levels and any embedded tags. Wire it into Nova Console to read it.
- `web/nova_load_audio.js` adds the upload button; uploaded files land in
  ComfyUI's `input/` and appear in the dropdown.
