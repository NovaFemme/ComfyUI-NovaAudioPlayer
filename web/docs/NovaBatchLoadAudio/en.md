# Nova Batch Load Audio

Scans a folder into one `NOVA_FILES` batch — the input both tag nodes expect.

![The reader and loader feeding Nova Tag Writer](images/tag-chain.png)
*Set up for tagging: `decode_audio` off, `limit` 0, `file_filter` `*.flac`.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `folder_path` | empty | Folder to scan. Empty falls back to ComfyUI's `input/`. |
| `file_filter` | `*.flac` | Comma-separated globs. Empty matches every known audio extension. |
| `recursive` | off | Include sub-folders. |
| `sort_by` | `name` | Batch order: name, modified or size. |
| `limit` | `0` | Stop after N files. `0` means no limit. |
| `decode_audio` | **off** | Off: paths and metadata only. On: also decode into `audio`. |

## Outputs

`files`, `audio`, `file_count`, `filenames` (a genuine list output, one string
per file), `metadata`.

## Leave `decode_audio` off for tagging

The tag nodes work on file paths. They never look at a waveform, so decoding a
folder of FLACs to write tags onto them is pure cost — minutes of CPU and a few
GB of RAM for a result nothing reads.

With it off, `audio` is a one-sample silent placeholder and `metadata` says so
plainly. That placeholder exists only so the output slot is always a valid
`AUDIO` payload; do not wire it into a player and expect sound.

Turn it on when you actually want the batch as a tensor — feeding a masterer,
an analyser, or anything that processes samples.

## What decoding does to a mixed folder

Files are padded with silence to the length of the longest, and mono files fan
out across the channel count. A file whose **sample rate** differs from the
first decoded file cannot be stacked: it stays in the file list, so it still
gets tagged, but it is left out of the tensor and the exclusion is listed under
`warnings` in `metadata`. Wire `metadata` into Nova Console if a batch comes
back smaller than you expected.

## `limit` is easy to forget

It defaults to `0`, meaning no cap, which is what you want. A non-zero value
truncates the batch **silently** — no warning, no error. Set it to 3 while
testing a tag mapping, then remember it is there when the dataset grows to
sixty files and only three come out tagged.

## Notes

- `sort_by` is for your convenience only. Tag rows are matched to files by
  name, never by position, so reordering the batch cannot mis-assign a row.
- `filenames` is a real list output. Nova Console declares `INPUT_IS_LIST` and
  shows it as a single listing rather than running once per file.
- The folder is only read. Nothing here writes, moves or renames.
