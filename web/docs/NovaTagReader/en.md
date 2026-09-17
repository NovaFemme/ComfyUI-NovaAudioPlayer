# Nova Tag Reader

Lists the tags each file in a batch actually carries. Use it to verify a write,
or to see what a folder arrived with.

![Tag Reader output in Nova Console](images/tag-reader-console.png)
*Chained straight after the loader. `max_value_chars` is 0 here, which is why
the full lyric sheet prints instead of being trimmed.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `files` | — | A batch, or the pass-through from Nova Tag Writer. |
| `fields` | the ten common tags | Comma-separated tag names, in this order. `*` lists everything. |
| `show_missing` | on | Report requested fields the file does not carry. |
| `max_value_chars` | `160` | Truncate long values in the **console text** only. `0` = no limit. |

`fields` defaults to `tracknumber, title, artist, album, date, genre, comment,
copyright, encodedby, lyrics`.

## Outputs

`console`, `tags_json`, `file_count`, and `files` passed through.

## Chain it after the writer to verify

Nova Tag Writer passes its batch out unchanged, so:

    Nova Tag Writer ──files──> Nova Tag Reader ──console──> Nova Console

reads back what was just written, in the same run, from the files on disk. This
is the cheapest way to confirm a `column_map` did what you meant.

## Formats are normalised

ID3 frames and MP4 atoms are reported under the **same names a FLAC would use**
— `TIT2` and `©nam` both come back as `title`. So a mixed folder produces
comparable output and one `fields` list works across all of it.

## `max_value_chars` never touches your data

It trims the console text so a set of lyrics does not bury the rest of the
report. `tags_json` is always complete and untruncated — take that output if
you are feeding another node rather than reading with your eyes.

## Leave `show_missing` on

With it on, a field you asked for that the file does not carry is reported as
missing. With it off it is quietly omitted, which looks identical to a field
you forgot to list — exactly the ambiguity you do not want when checking
whether a write landed.

## Notes

- Read-only. This node opens files for reading and never writes.
- `*` in `fields` lists every tag the file carries, in the file's own order —
  useful for finding the real name of a tag some other tool wrote.
- Requires `mutagen`, declared in the pack's `pyproject.toml`.
