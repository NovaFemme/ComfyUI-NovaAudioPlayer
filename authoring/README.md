# Nova SQLite Nodes for ComfyUI

Part of the **comfyui-novaaudioplayer** node pack.

Four nodes that let you browse a SQLite database in ComfyUI, pick the columns you need, filter the rows, and pass row values into your workflow. You can pass a single chosen row, or loop through a range of rows automatically.

| Node | Purpose |
|---|---|
| **Nova Dynamic SQLite Browser 📁** | Pick a database, table and columns. Outputs the rows. |
| **Nova SQLite Data Table & Filter 🔎** | Shows every row in a grid and narrows it down with conditions built in the UI. |
| **Nova SQLite Row Iterator & Splitter 📦** | Loops through the rows and outputs each column of the current row. |
| **Nova SQLite Single Row Filter 🔍** | Outputs each column of one selected row, with no loop. |

The rows flow along a single pink wire, and the Data Table is optional:

```
Browser ─► Data Table & Filter ─► Row Iterator   (or Single Row Filter)
        └──────────────────────► Row Iterator    (unfiltered)
```

---

## Installation

1. Copy `nova_sqlite_browser.py` into the node pack folder, for example `ComfyUI/custom_nodes/comfyui-novaaudioplayer/`.
2. Copy `nova_sqlite_browser.js` into the pack's web folder, for example `ComfyUI/custom_nodes/comfyui-novaaudioplayer/js/`.
3. Restart ComfyUI and hard-refresh the browser (Ctrl + F5).

### Adding your databases

Copy your SQLite files into the ComfyUI **input** folder:

```
ComfyUI/input/my_music_library.db
```

The supported extensions are `.db`, `.sqlite` and `.sqlite3`. **Sub-folders are scanned too**, so this works as well:

```
ComfyUI/input/audio/library/tracks.sqlite3
```

Databases in sub-folders appear in the dropdown by their relative path (`audio/library/tracks.sqlite3`), with top-level databases listed first. The scan goes up to six levels deep and skips hidden folders.

After copying a file in, press **⟳** on the node's toolbar to rescan — no ComfyUI restart or **R** refresh needed. For safety, only databases inside the input folder are opened: a path that climbs out of it, or an absolute path that points anywhere else, is refused.

---

## Nodes

### 📁 Nova Dynamic SQLite Browser

This node reads a table and outputs only the columns you select.

**Inputs**

| Input | Description |
|---|---|
| `database_path` | A SQLite file from the ComfyUI `input/` folder, including sub-folders. Press **⟳** after adding new files. |
| `table_name` | The tables in the chosen database. This list updates automatically when you change the database. |
| Column badges | Every column in the table, shown as a clickable badge. |

**Outputs**

| Output | Type | Description |
|---|---|---|
| `row_data_json` | `NOVA_SQLITE_ROWS` | All rows, with only the selected columns. Connect this to the Iterator or the Single Row node. |
| `column_names_list` | `LIST` | The selected column names. |
| `column_names_json` | `STRING` | The selected column names as a JSON array. |
| `column_count` | `INT` | The number of selected columns. |
| `row_count` | `INT` | The number of rows in the table. |
| `table` | `NOVA_TABLE` | The same rows as the pack's standard table payload, for **Nova Tag Writer** and the other Nova nodes. |

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
|---|---|
| `row_data_json` | Connect this from the Browser. |
| `row_index` | The row to process, counting from 0. It advances automatically while looping. |
| `stop_at_row` | The last row of the loop, which is included. `-1` means the last row when incrementing, or the first row when decrementing. |
| `loop_mode` | `increment`, `decrement` or `fixed`. `fixed` processes a single row once. |
| `auto_loop` | When this is on, the next row is queued automatically until the loop finishes. |

**Outputs**

| Output | Type | Description |
|---|---|---|
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
|---|---|
| `row_data_json` | Connect this from the Browser. |
| `row_index` | The row to output, counting from 0. It is only active when more than one row is received. |

**Outputs**

| Output | Type | Description |
|---|---|---|
| `single_row_json` | `STRING` | The selected row as a JSON object. |
| `row_index` | `INT` | The index of the row that was used. |
| `total_rows` | `INT` | The total number of rows received. |
| One output per selected column | `STRING` | The value of that column for the selected row. |

**Features**

- It uses the same dynamic column outputs, live viewer and auto-resizing as the Iterator.
- If only one row is received, `row_index` is greyed out and relabelled `row_index (only 1 row)`, and that row is always used.

---

### 🔎 Nova SQLite Data Table & Filter

This node shows every row in a scrollable grid and narrows the rows down with conditions you build in the UI. You never write SQL, and the word `WHERE` never appears.

Put it between the Browser and the other two nodes to filter what they receive:

```
Browser ─► Data Table & Filter ─► Row Iterator / Single Row Filter
```

**Inputs**

| Input | Description |
|---|---|
| `row_data_json` | Rows from the Browser. |
| `table` | A `NOVA_TABLE` from any pack node. Connect this instead to filter an existing table, or alongside `row_data_json` to carry the database and table names through to the `table` output. |
| Condition builder | One row per condition: `AND / OR`, column, operator and value. Use **+ Condition** and **Clear** in the bar above it. |
| `output_rows` | `matching rows` (the default) sends everything the conditions match. `selected rows` sends only the rows you highlighted in the grid. |

Connect either input. If both are connected, `row_data_json` supplies the rows and `table` supplies the names.
| `case_sensitive` | Off by default, so text matches regardless of upper or lower case. |
| `max_display_rows` | How many rows the grid shows. All matching rows are still passed on. |

**Outputs**

| Output | Type | Description |
|---|---|---|
| `row_data_json` | `NOVA_SQLITE_ROWS` | The rows leaving the node, matching or selected depending on `output_rows`. Connect this to the Iterator or the Single Row Filter. |
| `rows_json` | `STRING` | The same rows as plain text, for nodes that take a normal string. |
| `matched_rows` | `INT` | How many rows the conditions matched. |
| `total_rows` | `INT` | How many rows came in. |
| `where_clause` | `STRING` | The equivalent SQL, safely escaped, if you want to reuse it elsewhere. |
| `table` | `NOVA_TABLE` | The same rows as the pack's standard table payload, for **Nova Tag Writer** and the other Nova nodes. |
| `selected_rows` | `INT` | How many rows are highlighted in the grid. |

**Operators**

`=` · `≠` · `>` · `≥` · `<` · `≤` · contains · does not contain · starts with · ends with · in list · not in list · is empty · is not empty

`in list` takes a comma separated list, such as `rock, jazz, folk`. The value box is disabled for `is empty` and `is not empty`. Numbers are compared as numbers when both sides look numeric, and as text otherwise.

Conditions are combined left to right, so `A AND B OR C` is read as `(A AND B) OR C`. Up to 16 conditions can be used.

**How the quote problem is handled**

Nothing you type is ever pasted into a SQL statement. The conditions are stored as structured JSON and applied in Python over the rows that are already in memory, so a value such as `O'Brien`, `50% off` or `x'; DROP TABLE albums;--` is only ever compared as text.

The `where_clause` output is generated separately for when you want the SQL:

- Single quotes in values are doubled, so `O'Brien` becomes `'O''Brien'`.
- Column names are quoted, and an embedded `"` is doubled.
- `%` and `_` inside a value are escaped for `LIKE`, with `ESCAPE '\'`, so they match literally instead of acting as wildcards.
- Numbers are emitted bare and everything else as a quoted string.
- Column names are checked against the columns that actually arrived, and anything unknown is dropped with a warning rather than passed through.

For example, three conditions produce:

```sql
"Artist" COLLATE NOCASE = 'O''Brien' OR "Year" >= 2019 AND "Title" LIKE '%50\% off%' ESCAPE '\'
```

**Selecting rows with the mouse**

The grid is interactive. Click a row to highlight it, and use the highlighted rows as the node's output by setting `output_rows` to `selected rows`.

| Action | Result |
|---|---|
| Click | Select that row on its own. Clicking the only selected row again clears it. |
| Ctrl + click (⌘ on a Mac) | Add or remove one row, keeping the rest. |
| Shift + click | Select everything between the last clicked row and this one. |
| Click and drag | Sweep a range of rows as you move. |
| **all** / **invert** / **none** | Shortcuts on the right of the grid header. |

- A selected row is tinted pink with a bright bar down its left edge, and rows highlight softly as you hover.
- The selection count appears in the top bar and in the grid header.
- With `output_rows` set to `selected rows`, the `#` column renumbers so it shows the index each selected row will have downstream, and unselected rows show `·`.
- Rows are remembered by their position in the incoming data, so a highlight survives changing the conditions, running the graph again, and saving and reloading the workflow. A selection is dropped only when the row itself is gone.
- A row that is highlighted but filtered out by the conditions is not sent on. The conditions always apply first.

**Features**

- The column dropdowns follow the badges selected on the Browser, and they update as soon as you change the selection.
- The grid has a sticky header and a `#` column. That number is the index the Single Row Filter and the Iterator use, so you can read the row you want straight off the grid.
- The header line shows `7 / 19 rows` with the condition count, and long cell values are shortened with the full text in the tooltip.
- A condition that refers to a column that is no longer selected is outlined in red and reported as a warning instead of silently changing the result.
- It uses the same auto-resizing and in-node layout as the other nodes. Drag the node bigger to see more rows.

---

## The toolbar

All four nodes carry the same two buttons at the top.

| Button | What it does |
|---|---|
| **⟳ Refresh** | Rescans the input folder for databases, then reloads the table and column lists. On the other three nodes it re-reads the column selection from the Browser. |
| **▶ Execute** | Reads the data **now** and shows it, without running the workflow. |
| **🎨 Colours** | Opens a colour picker for all four nodes. |

**Execute is the useful one.** It walks the whole chain from the Browser outward — Browser, then Data Table, then whatever the Data Table feeds — and fills each node's display with real data. Nothing is queued: no prompt is submitted and no other node in your workflow runs. It exists so you can see the rows, tune the conditions and pick the row you want *before* pressing Run.

Press it on any of the four nodes; it always starts from the Browser at the head of the chain, so the result is the same wherever you press it. If a node isn't connected to a Browser, its toolbar says so rather than doing nothing.

Behind the scenes the preview calls the same Python functions that a real execution calls, so what you see is what a run produces — not a separate code path that might drift out of step. The small grey text to the right of the buttons reports the outcome (`28 rows · 12 columns`, `2 / 19 rows`, `preview failed`).

### Colours

The **🎨** button opens a small panel on the node with six presets and three colour pickers:

| Slot | Where it shows |
|---|---|
| **Accent** | Borders, selected badges, highlights, the row wire, the toolbar buttons |
| **Panel** | The badge area and the condition builder |
| **Console** | The data grid and the row viewer |

Pick a preset or a custom colour and the change is live as you drag — every SQLite node on the canvas repaints at once, because the colours are CSS variables rather than baked into each node. **Save** stores your choice on the server, so it applies to nodes you add later and survives a restart. **Cancel** puts back what you had, and **Reset** returns to Nova pink.

The dimmer and brighter accents are derived from your accent colour, so one choice keeps everything coherent. The error, warning and success colours are deliberately not themeable — they carry meaning, and a red that isn't red is a bug waiting to happen.

The theme is saved to `nova_sqlite_theme.json` in ComfyUI's user directory rather than beside the node pack, so updating the pack doesn't wipe it. Only plain hex colours are accepted; anything else falls back to the default, since these values are written into a stylesheet.

---

## Changing the database or table with nodes connected

The Iterator and Single Row nodes grow one output per selected column. Switching to a different database or table rebuilds that selection, so those outputs — and the wires attached to them — disappear.

When that would actually cost you wires, the Browser asks first, in a panel **on the node**:

> ⚠ **This will break connections**
> Switching table to "tracks" rebuilds the column selection, which removes 3 connected outputs.
> Wired from: Nova SQLite Row Iterator, Nova Audio Master

**Keep current** puts the dropdown back where it was and nothing changes. **Change anyway** proceeds. Clicking outside the panel counts as keeping the current value.

If no column outputs are wired there is nothing to lose, so the change goes through silently — the prompt only appears when it is earning its place.

---

## Connection suggestions

`row_data_json` uses its own wire type, `NOVA_SQLITE_ROWS`, which is drawn in pink.

- Drag a wire from the Browser's `row_data_json` output and release it on empty canvas. ComfyUI suggests the **Data Table & Filter**, the **Iterator** and the **Single Row Filter**.
- The Data Table's `row_data_json` output suggests the same row nodes, so you can chain it in.
- Drag a wire backwards from the `row_data_json` input of any of those nodes, and ComfyUI suggests the **Browser** and the **Data Table & Filter**.

---

## Error handling

All three row nodes show errors in a red box in their viewer instead of crashing the workflow. On an error, the column outputs are empty strings and the loop stops.

| Situation | Message |
|---|---|
| The table is empty or the query failed | `No rows: the table is empty or the query failed` |
| No column badges are selected | `0 columns selected: select at least one column badge on the SQLite Browser` |
| `row_index` is higher than the last row | `row_index X is out of range (valid: 0 - N)` |
| `stop_at_row` is before `row_index` in increment mode | `stop_at_row (X) is before row_index (Y) in increment mode` |
| `stop_at_row` is after `row_index` in decrement mode | `stop_at_row (X) is after row_index (Y) in decrement mode` |
| The incoming data is not valid | `row_data_json is not valid JSON` or `Invalid data: expected a JSON list of rows` |

The Browser reports a missing database, a missing table and SQLite errors on its status line.

The Data Table reports these as warnings in amber, above the grid, and still returns the rows it could match:

| Situation | Message |
|---|---|
| A condition uses a column that is no longer selected | `condition 3: column 'Genre' is not available` |
| A condition has no value | `condition 1: 'equals' needs a value` |
| `in list` has no usable entries | `condition 2: 'in list' needs a comma separated list` |
| Nothing matched | `No rows match the current conditions` |
| More matches than the grid shows | `Showing the first 200 of 1,430 matching rows` |

---

## Working scenarios

### 1. Batch-process every track in a music library

Go through every row of an `albums` table and send each title and artist into your audio or text nodes.

1. In the **Browser**, choose `album_data.db` and the `albums` table, then select **Title**, **Artist** and **FileName**.
2. Connect `row_data_json` to the **Row Iterator**.
3. Set `row_index = 0`, `stop_at_row = -1`, `loop_mode = increment` and `auto_loop = true`.
4. Connect the `Title`, `Artist` and `FileName` outputs to your downstream nodes.
5. Press **Run** once. The iterator queues a run for each row until the last one and then shows ✅ loop finished.

### 2. Process a specific range of rows

To process only rows 5 to 10, set `row_index = 5`, `stop_at_row = 10` and `loop_mode = increment`. This gives six runs, after which `row_index` resets to 5.

### 3. Walk backwards through the newest entries

If the newest records are at the end of the table, set `row_index` to the last index, for example 18. Then set `stop_at_row = -1` and `loop_mode = decrement`. The iterator counts down to row 0.

### 4. Step through rows by hand

Turn `auto_loop` **off**. Each press of **Run** processes one row and moves `row_index` on to the next, so you can check each result before continuing.

### 5. Pull one record for a single job

Use the **Single Row Filter** when you only need one record, for example to build a prompt from one track's metadata.

1. Select the columns you need in the **Browser**, for example **Title** and **Album**.
2. Connect `row_data_json` to the **Single Row Filter** and set `row_index` to the row you want.
3. Connect the `Title` and `Album` outputs to your nodes. Use `single_row_json` if a node needs the whole record.

### 6. Show values in Nova Console

Connect any column output, such as `Title`, from the Iterator or the Single Row Filter to **Nova Console 🖥️**. It displays and logs the value for each processed row.

### 7. One browser, several consumers

A single Browser can feed several Iterators and Single Row Filters at once. All of them follow the same badge selection. You could, for example, have the Iterator process the whole table while a Single Row Filter keeps a reference record on screen.

### 8. Look up a known record from a one-row table

If the table, or your data, contains only one row, the Single Row Filter locks `row_index` and always outputs that row. Workflows that expect exactly one record therefore don't need any index handling.

### 9. Loop over one artist's tracks only

Process the tracks of a single artist rather than the whole library.

1. In the **Browser**, select **Title**, **Artist** and **FileName**.
2. Connect `row_data_json` to the **Data Table & Filter**.
3. Press **+ Condition** and set `Artist` · `equals` · `Example Artist`. The grid shows the matching rows and the header reads, for example, `6 / 19 rows`.
4. Connect the Data Table's `row_data_json` to the **Row Iterator**, and set `stop_at_row = -1` with `auto_loop` on.
5. Press **Run**. The iterator loops over the 6 matching rows only.

### 10. Narrow down with several conditions

Find the recent tracks of two artists that still need lyrics.

1. `Artist` · `in list` · `Example Artist, Second Artist`
2. `AND` · `release_year` · `greater or equal` · `2019`
3. `AND` · `Lyrics` · `is empty`

The value box disappears for `is empty`. Read the row you want off the `#` column of the grid and put that number into a **Single Row Filter**.

### 11. Search for text that contains an apostrophe or a percent sign

Set `Title` · `contains` · `O'Brien's 50% cut`. It matches as plain text, and both the apostrophe and the `%` are treated literally rather than as SQL syntax or a wildcard. Read `where_clause` if you want the escaped SQL for use elsewhere.

### 12. Reuse the filter in your own SQL

Connect `where_clause` to **Nova Console 🖥️** or any string input. It gives you a ready-to-paste clause such as `"Artist" COLLATE NOCASE = 'O''Brien'`, which you can drop in after `WHERE` in your own query.

### 13. Tag only the files that match a filter

The `table` output is a standard `NOVA_TABLE`, so it plugs straight into **Nova Tag Writer 🏷️** and the rest of the pack.

```
Browser ─► Data Table & Filter ──table──► Nova Tag Writer 🏷️
Nova Batch Load Audio ──────────files───►
```

1. In the **Browser**, select the columns you want written as tags, including `FileName`.
2. Filter down to the tracks you want, for example `Artist` · `equals` · `Example Artist`.
3. Connect the Data Table's `table` output to the Tag Writer's `table` input.
4. Only the matching rows are tagged. The database and table names travel with the payload, so they still appear in the Tag Writer log.

To tag everything, connect the Browser's own `table` output to the Tag Writer and leave the Data Table out.

### 14. Hand-pick a few rows to process

When a filter cannot express what you want, pick the rows by eye.

1. Filter roughly, or not at all, so the rows you care about are on screen.
2. Click the first row, then Ctrl + click the others. Or click and drag down a run of rows.
3. Set `output_rows` to `selected rows`. The banner confirms how many rows will leave the node, and the `#` column renumbers to match.
4. Connect `row_data_json` to the **Row Iterator** with `stop_at_row = -1`. Only your chosen rows are looped over.

The selection is saved with the workflow, so the same rows are still highlighted when you reopen it.

### 15. Filter a table from another Nova node

The Data Table also accepts a `NOVA_TABLE` on its `table` input, so any node in the pack that produces one can be filtered before being passed on. Connect it to `table`, leave `row_data_json` empty, and the grid, conditions and all five other outputs work exactly the same.

---

## Tips and limits

- Up to **64** columns can be output at once, and up to **16** filter conditions.
- Column outputs follow the table's column order, not the order in which you clicked the badges.
- All column outputs are `STRING`. `NULL` values become an empty string. Use a converter node if you need numbers.
- The Data Table filters the rows it receives, so you can only filter on columns selected in the Browser. Select a column to filter on it, even if you don't need it as an output.
- Filtering happens in memory after the table has been read. For very large tables, select fewer columns in the Browser to keep the data small.
- If a `row_data_json` wire in an older saved workflow shows red, delete it and reconnect it once.
- The node IDs are `NovaSQLiteBrowserNode`, `NovaSQLiteSingleRowNode`, `NovaSQLiteRowIteratorNode` and `NovaSQLiteWhereFilterNode`. Workflows saved before the rename will report the nodes as missing, so re-add them once.
- `TABLE_TYPE` is imported from `nova_authoring_common`, so the `table` outputs always match whatever value the pack uses. It falls back to `"NOVA_TABLE"` if that import is not available.
- The node reads the database each time the Browser runs. If you change the database outside ComfyUI, change any Browser setting or re-select the table to force a fresh read.
