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
| Nova Dynamic SQLite Browser 📁| `SQLiteBrowserNode`| ▶️ Nova Audio/Authoring |
| Nova SQLite Row Iterator & Splitter 📦|`SQLiteRowIteratorNode`|  ▶️ Nova Audio/Authoring |
| Nova SQLite Single Row Filter 🔍|`SQLiteSingleRowNode`|  ▶️ Nova Audio/Authoring |
| Nova SQLite Reader 🗃️ [DEPRECATED]| `NovaSQLiteReader` | ▶️ Nova Audio/Authoring |
| Nova Batch Load Audio 🎼 | `NovaBatchLoadAudio` | ▶️ Nova Audio/Authoring |
| Nova Tag Writer 🏷️ | `NovaTagWriter` | ▶️ Nova Audio/Authoring |
| Nova Tag Reader 🔖 | `NovaTagReader` | ▶️ Nova Audio/Authoring |
| Nova Console 🖥️ | `NovaConsole` | ▶️ Nova Audio/Authoring |
| Nova Load Audio 🔄 | `NovaLoadAudio` | ▶️ Nova Audio (unchanged) |

`nova_load_audio.py` moved here from `../mastering/` but deliberately keeps its
original top-level category, so saved workflows and the node menu are unaffected.

### Nova SQLite Reader [DEPRECATED]

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

## Replacement nodes for Nova SQLite Reader

# Nova SQLite Nodes for ComfyUI

Three nodes that let you browse a SQLite database in ComfyUI, pick the columns you need, and pass row values into your workflow. You can pass one row at a time, a single chosen row, or loop through a range of rows automatically.

| Node | Purpose |
| :---- | :---- |
| **Nova Dynamic SQLite Browser 📁** | Pick a database, table and columns. Outputs the rows. |
| **Nova SQLite Row Iterator & Splitter 📦** | Loops through the rows and outputs each column of the current row. |
| **Nova SQLite Single Row Filter 🔍** | Outputs each column of one selected row, with no loop. |

### Adding your databases

Copy your SQLite files into the ComfyUI **input** folder:

ComfyUI/input/my\_music\_library.db

The supported extensions are `.db`, `.sqlite` and `.sqlite3`. After copying a file, press **R** in ComfyUI to refresh the node definitions. The file will then appear in the `database_path` dropdown. The Browser node also shows this reminder at the top.

---

## Nodes

### 📁 Nova Dynamic SQLite Browser

This node reads a table and outputs only the columns you select.

**Inputs**

| Input | Description |
| :---- | :---- |
| `database_path` | A SQLite file from the ComfyUI `input/` folder. |
| `table_name` | The tables in the chosen database. This list updates automatically when you change the database. |
| Column badges | Every column in the table, shown as a clickable badge. |

**Outputs**

| Output | Type | Description |
| :---- | :---- | :---- |
| `row_data_json` | `NOVA_SQLITE_ROWS` | All rows, with only the selected columns. Connect this to the Iterator or the Single Row node. |
| `column_names_list` | `LIST` | The selected column names. |
| `column_names_json` | `STRING` | The selected column names as a JSON array. |
| `column_count` | `INT` | The number of selected columns. |
| `row_count` | `INT` | The number of rows in the table. |

**Features**

- Badges start **unselected**. Click a badge to select it (it turns pink) and click it again to deselect it.  
- The **All** and **None** shortcuts select or clear every column at once.  
- A live counter shows how many columns are selected, for example `3 / 44 selected`. The status line shows the row and column count after a run.  
- Selecting or deselecting a badge immediately adds or removes the matching output on every connected Iterator or Single Row node.  
- If a selected column no longer exists, for example after switching tables, it is dropped from the selection.  
- The node only runs `SELECT` queries, so it never changes your data. Column and table names are quoted safely.  
- BLOB columns are shown as `<BLOB n bytes>` instead of breaking the JSON.

---

### 📦 Nova SQLite Row Iterator & Splitter

This node processes one row per run and can queue the next run by itself until the loop is finished.

**Inputs**

| Input | Description |
| :---- | :---- |
| `row_data_json` | Connect this from the Browser. |
| `row_index` | The row to process, counting from 0\. It advances automatically while looping. |
| `stop_at_row` | The last row of the loop, which is included. `-1` means the last row when incrementing, or the first row when decrementing. |
| `loop_mode` | `increment`, `decrement` or `fixed`. `fixed` processes a single row once. |
| `auto_loop` | When this is on, the next row is queued automatically until the loop finishes. |

**Outputs**

| Output | Type | Description |
| :---- | :---- | :---- |
| `next_row_index` | `INT` | The index that will be processed next. |
| `total_rows` | `INT` | The total number of rows received. |
| `loop_finished` | `BOOLEAN` | `True` on the last row of the loop. |
| One output per selected column | `STRING` | The value of that column for the current row. |

**Features**

- Column outputs are **dynamic**. They match the badges selected on the Browser, and existing wires stay connected when other columns are added or removed.  
- A live viewer shows the current row as `Row [ 3 / 19 ]`, with the index, stop row, mode, a progress bar and a ✅ when the loop has finished.  
- When a loop finishes, `row_index` is reset to its starting value, so pressing **Run** again repeats the same loop.  
- Pressing Cancel or Interrupt, or any execution error, stops the loop.  
- The viewer and the node resize to fit the content. Content stays inside the node when you move or resize it.

---

### 🔍 Nova SQLite Single Row Filter

This node looks and behaves like the Iterator, but it always outputs exactly one row and never loops.

**Inputs**

| Input | Description |
| :---- | :---- |
| `row_data_json` | Connect this from the Browser. |
| `row_index` | The row to output, counting from 0\. It is only active when more than one row is received. |

**Outputs**

| Output | Type | Description |
| :---- | :---- | :---- |
| `single_row_json` | `STRING` | The selected row as a JSON object. |
| `row_index` | `INT` | The index of the row that was used. |
| `total_rows` | `INT` | The total number of rows received. |
| One output per selected column | `STRING` | The value of that column for the selected row. |

**Features**

- It uses the same dynamic column outputs, live viewer and auto-resizing as the Iterator.  
- If only one row is received, `row_index` is greyed out and relabelled `row_index (only 1 row)`, and that row is always used.

---

## Connection suggestions

`row_data_json` uses its own wire type, `NOVA_SQLITE_ROWS`, which is drawn in pink.

- Drag a wire from the Browser's `row_data_json` output and release it on empty canvas. ComfyUI suggests the **Iterator** and the **Single Row Filter**.  
- Drag a wire backwards from the `row_data_json` input of either row node, and ComfyUI suggests the **Browser**.

---

## Error handling

Both row nodes show errors in a red box in their viewer instead of crashing the workflow. On an error, the column outputs are empty strings and the loop stops.

| Situation | Message |
| :---- | :---- |
| The table is empty or the query failed | `No rows: the table is empty or the query failed` |
| No column badges are selected | `0 columns selected: select at least one column badge on the SQLite Browser` |
| `row_index` is higher than the last row | `row_index X is out of range (valid: 0 - N)` |
| `stop_at_row` is before `row_index` in increment mode | `stop_at_row (X) is before row_index (Y) in increment mode` |
| `stop_at_row` is after `row_index` in decrement mode | `stop_at_row (X) is after row_index (Y) in decrement mode` |
| The incoming data is not valid | `row_data_json is not valid JSON` or `Invalid data: expected a JSON list of rows` |

The Browser reports a missing database, a missing table and SQLite errors on its status line.

---

## Working scenarios

### 1\. Batch-process every track in a music library

Go through every row of an `albums` table and send each title and artist into your audio or text nodes.

1. In the **Browser**, choose `album_data.db` and the `albums` table, then select **Title**, **Artist** and **FileName**.  
2. Connect `row_data_json` to the **Row Iterator**.  
3. Set `row_index = 0`, `stop_at_row = -1`, `loop_mode = increment` and `auto_loop = true`.  
4. Connect the `Title`, `Artist` and `FileName` outputs to your downstream nodes.  
5. Press **Run** once. The iterator queues a run for each row until the last one and then shows ✅ loop finished.

### 2\. Process a specific range of rows

To process only rows 5 to 10, set `row_index = 5`, `stop_at_row = 10` and `loop_mode = increment`. This gives six runs, after which `row_index` resets to 5\.

### 3\. Walk backwards through the newest entries

If the newest records are at the end of the table, set `row_index` to the last index, for example 18\. Then set `stop_at_row = -1` and `loop_mode = decrement`. The iterator counts down to row 0\.

### 4\. Step through rows by hand

Turn `auto_loop` **off**. Each press of **Run** processes one row and moves `row_index` on to the next, so you can check each result before continuing.

### 5\. Pull one record for a single job

Use the **Single Row Filter** when you only need one record, for example to build a prompt from one track's metadata.

1. Select the columns you need in the **Browser**, for example **Title** and **Album**.  
2. Connect `row_data_json` to the **Single Row Filter** and set `row_index` to the row you want.  
3. Connect the `Title` and `Album` outputs to your nodes. Use `single_row_json` if a node needs the whole record.

### 6\. Show values in Nova Console

Connect any column output, such as `Title`, from the Iterator or the Single Row Filter to **Nova Console 🖥️**. It displays and logs the value for each processed row.

### 7\. One browser, several consumers

A single Browser can feed several Iterators and Single Row Filters at once. All of them follow the same badge selection. You could, for example, have the Iterator process the whole table while a Single Row Filter keeps a reference record on screen.

### 8\. Look up a known record from a one-row table

If the table, or your data, contains only one row, the Single Row Filter locks `row_index` and always outputs that row. Workflows that expect exactly one record therefore don't need any index handling.

---

## Tips and limits

- Up to **64** columns can be output at once.  
- Column outputs follow the table's column order, not the order in which you clicked the badges.  
- All column outputs are `STRING`. `NULL` values become an empty string. Use a converter node if you need numbers.  
- If a `row_data_json` wire in an older saved workflow shows red, delete it and reconnect it once.  
- The node reads the database each time the Browser runs. If you change the database outside ComfyUI, change any Browser setting or re-select the table to force a fresh read.


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
