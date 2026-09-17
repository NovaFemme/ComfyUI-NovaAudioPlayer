# Save Audio FLAC 24-bit

Writes an `AUDIO` input to the ComfyUI output folder as FLAC, at 24-bit by
default. It exists because the stock save node cannot.

## Why the built-in node gives you 16-bit

ComfyUI's helper builds the audio frame as `flt` and never sets a sample format
on the FLAC stream, so FFmpeg's flac encoder falls back to its default `s16` and
writes a 16-bit file. Nothing warns you; the file just quietly has eight fewer
bits than the master you fed it.

FFmpeg's flac encoder accepts only `s16` or `s32`. Given `s32` it records
`bits_per_raw_sample = 24` and shifts the samples right by 8 internally, which
is how a true 24-bit FLAC is produced. **There is no 32-bit FLAC path** — if you
want float for archival, save WAV float32 instead.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `audio` | — | The audio to write. Wire the master here. |
| `filename_prefix` | `audio/ComfyUI` | Path and name stem under `output/`. Supports the usual `%date%`-style tokens and `%batch_num%`. |
| `bit_depth` | `24` | `24` or `16`. 24 is the reason this node exists. |

## Outputs

None. It is an `OUTPUT_NODE`: it writes the file and shows a player on the node
face, so it runs as a graph endpoint with nothing wired after it.

## Round-tripping is bit-exact

Samples are scaled by `2**(bits-1)` — the same convention loaders use when they
normalise PCM to float — so an integer source that goes out through this node
and back in returns the values it started with. The one value that would
overflow by a single LSB (`+1.0`) is clamped rather than wrapped.

For 24-bit the value is left-aligned inside an int32 before encoding, because
the encoder shifts it back down by 8.

## Metadata and batches

The prompt and any `extra_pnginfo` are written as FLAC tags, unless ComfyUI was
started with `--disable-metadata`. A batch writes one file per item, with
`%batch_num%` substituted and the counter incremented, so nothing overwrites.

## Where it sits in the chain

Mastering → **Save Audio FLAC 24-bit** → Nova Tag Writer, if you are writing
release metadata onto the file afterwards. Save the FLAC first; the tag writer
edits files in place.
