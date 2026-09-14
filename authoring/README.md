# ▶️ Nova Audio / Authoring

Metadata authoring for the Nova pack. Self-contained: nothing here imports from
`mastering/`, `nova_player/` or `madow/`, and none of those were changed.

## The chain

```
Nova SQLite Reader ──NOVA_TABLE──┐
                                 ├──> Nova Tag Writer ──console──> Nova Console
Nova Batch Load Audio ─NOVA_FILES┘           │
                                             └──files──> Nova Tag Reader ──console──> Nova Console
```

Nova Tag Writer passes its batch straight through, so chaining Nova Tag Reader
after it verifies a write in the same run.

## Nodes

| Node | Class | Category |
|---|---|---|
| Nova SQLite Reader 🗃️ | `NovaSQLiteReader` | ▶️ Nova Audio/Authoring |
| Nova Batch Load Audio 🎼 | `NovaBatchLoadAudio` | ▶️ Nova Audio/Authoring |
| Nova Tag Writer 🏷️ | `NovaTagWriter` | ▶️ Nova Audio/Authoring |
| Nova Tag Reader 🔖 | `NovaTagReader` | ▶️ Nova Audio/Authoring |
| Nova Console 🖥️ | `NovaConsole` | ▶️ Nova Audio/Authoring |
| Nova Load Audio 🔄 | `NovaLoadAudio` | ▶️ Nova Audio (unchanged) |

`nova_load_audio.py` moved here from `../mastering/` but deliberately keeps its
original top-level category, so saved workflows and the node menu are unaffected.

### Nova SQLite Reader

Opens an existing database **read-only** and returns one table.

- `database_path` — full path to an existing `.db`.
- `table_name`, `columns` (`*` or a comma-separated list), `where`.
- `new_database_folder` + `new_database_name` — used **only** when
  `database_path` is empty; creates an empty database and returns 0 rows.

`where` is raw SQL so AND/OR/LIKE/IN/BETWEEN all work, but it is screened: no
`;`, and no ATTACH/ALTER/CREATE/DELETE/DROP/INSERT/PRAGMA/REPLACE/UPDATE/VACUUM.
Table and column names are checked against the live schema and quoted, never
interpolated. A path that does not exist is an error rather than a silent
create — a typo should not scatter empty databases across the disk.

Outputs `table`, `record_count`, `column_count`, and `column_headers` (a real
ComfyUI list output, one string per column).

### Nova Batch Load Audio

Scans a folder into one batch.

- `folder_path` (empty = ComfyUI's `input/`), `file_filter` (comma-separated
  globs, empty = every known audio extension), `recursive`, `sort_by`, `limit`.
- `decode_audio` — **off by default**. The tag nodes need paths, not waveforms.

With decoding off, the `audio` output is a one-sample silent placeholder and
`metadata` says so. With it on, files are padded to the longest and mono fans
out across channels; a file whose sample rate differs from the first decoded
file stays in the file list but is left out of the tensor, and the exclusion is
listed under `warnings`.

### Nova Tag Writer

Writes each row onto its file. Rows are matched to files by the
`filename_column` value, treating case, spaces and underscores as equivalent —
so `No Cage But Mine.flac`, `No_Cage_But_Mine.flac` and `NO CAGE BUT MINE.FLAC`
are one and the same.

Every column becomes a tag by lowercasing and removing separators
(`Track Number` → `tracknumber`), except:

- `Length` — skipped by default; duration comes from the audio stream and is
  not a settable text field.
- the filename column — it is the match key, not a tag.
- anything listed in `skip_columns`.
- anything remapped in `column_map`, one `Column = tagname` per line. Use
  `Column = skip` to drop a column.

FLAC and Ogg get native Vorbis comments; MP4/M4A gets its atoms; MP3 and other
ID3 carriers get proper frames (COMM for comment, USLT for lyrics, TXXX for
anything unmapped). Formats mutagen cannot tag are reported and left alone.

`dry_run` reports the whole run without opening a file for writing.
`skip_empty_values` (on by default) leaves an existing tag alone rather than
blanking it when the cell is NULL or empty.

### Nova Tag Reader

Lists the tags each file actually carries. `fields` selects and orders them,
`*` lists everything. ID3 frames and MP4 atoms are reported under the same
names a FLAC would use, so output is comparable across formats. `tags_json`
is never truncated; `max_value_chars` only trims the console text.

### Nova Console

Accepts any link. Strings, numbers, `NOVA_TABLE`, `NOVA_FILES`, tensors and
list outputs all render. It declares `INPUT_IS_LIST`, so a list output such as
`column_headers` or `filenames` arrives whole and is shown as one listing
rather than running the node once per item.

## Files

    authoring/
      __init__.py                 aggregates the mappings for the root __init__.py
      nova_authoring_common.py    NOVA_TABLE / NOVA_FILES payloads, wildcard slot type
      nova_sqlite_reader.py
      nova_batch_audio_load.py
      nova_tag_writer.py
      nova_tag_reader.py
      nova_console.py
      nova_load_audio.py          moved from ../mastering/
    web/
      nova_console.js             renders Nova Console's text on the node face
