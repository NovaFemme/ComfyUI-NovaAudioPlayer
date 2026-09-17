# Nova Tag Writer

Writes each database row onto its audio file. Takes a `NOVA_TABLE` from Nova
SQLite Reader and a `NOVA_FILES` batch from Nova Batch Load Audio.

![The reader and loader feeding Nova Tag Writer](images/tag-chain.png)
*Worth studying: the `column_map` box shows grey placeholder text, so it was
EMPTY when this ran. The proof is the log's own `Tags :` line —
`EncodedBy -> encodedby`, `Comment -> comment`, the automatic mapping, not the
`encoded-by` / `description` the box appears to ask for.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `table` | — | Rows from Nova SQLite Reader. |
| `files` | — | Batch from Nova Batch Load Audio. |
| `filename_column` | `FileName` | The column holding the file name each row belongs to. |
| `skip_columns` | `Length` | Comma-separated columns to leave out. |
| `column_map` | empty | One `Column = tagname` per line, overriding the automatic mapping. |
| `skip_empty_values` | on | Empty/NULL cells leave the existing tag alone. |
| `dry_run` | off | Report what would be written without opening any file for writing. |

## Outputs

`console`, `written_count`, `skipped_count`, and `files` — the batch passed
straight through, so chaining Nova Tag Reader after it verifies the write in
the same run.

## Run it with `dry_run` on first

**This node edits your files in place.** With `dry_run` on it produces the
exact same log — every file, every tag, every value — and opens nothing for
writing. Read that log, then turn it off.

## How columns become tags

A column name is lowercased with separators removed: `Track Number` →
`tracknumber`, `EncodedBy` → `encodedby`. Four things are exempt:

- **`Length`** — skipped by default. Duration comes from the audio stream; it
  is not a settable text field.
- **the filename column** — it is the match key, not a tag.
- anything in **`skip_columns`**.
- anything remapped in **`column_map`**. `Column = skip` drops it (`-` and
  `none` work too).

## The `column_map` placeholder is not a value

The box shows greyed example text:

    EncodedBy = encoded-by
    Comment = description
    Copyright = skip

That is a hint. While it looks filled in, the field is empty and the automatic
mapping is used. Click in and type to make it real.

The giveaway that a map never took effect is this node's own log: the `Tags :`
line lists the mapping it actually used. `Comment -> comment` where you
expected `Comment -> description` means the box was empty when it ran.

## Matching rows to files

Rows match files by the `filename_column` value, treating case, spaces and
underscores as equivalent. `No Cage But Mine.flac`, `No_Cage_But_Mine.flac` and
`NO CAGE BUT MINE.FLAC` are one and the same file.

Files in the batch with no matching row are listed at the end of the log and
left completely untouched — a partial database does not damage the rest of the
folder.

## It writes, it never removes

The write is per-tag: setting `title` replaces `title` and leaves every other
tag on the file alone. That is safe, and it has one consequence worth knowing.

Renaming a tag through `column_map` — `EncodedBy = encoded-by` on a file that
already carries `ENCODEDBY` — **adds the new key beside the old one** rather
than moving it. You end up with both. Cleaning up the leftover needs a separate
step; this node has no way to express a deletion today.

## Formats

FLAC and Ogg get native Vorbis comments. MP4/M4A gets its atoms. MP3 and other
ID3 carriers get proper frames — `COMM` for comment, `USLT` for lyrics, `TXXX`
for anything without a standard frame. Formats mutagen cannot tag are reported
in the log and left alone.

Requires `mutagen`, declared in the pack's `pyproject.toml`.
