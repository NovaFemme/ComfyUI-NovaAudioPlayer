# Nova Dynamic SQLite Browser 📁

Pick a SQLite database in ComfyUI's input folder, a table and its columns, and output the rows. This is the head of the SQLite chain: the other three SQLite nodes take their rows from it.

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

## Adding your databases

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

## Changing the database or table with nodes connected

The Iterator and Single Row nodes grow one output per selected column. Switching to a different database or table rebuilds that selection, so those outputs — and the wires attached to them — disappear.

When that would actually cost you wires, the Browser asks first, in a panel **on the node**:

> ⚠ **This will break connections**
> Switching table to "tracks" rebuilds the column selection, which removes 3 connected outputs.
> Wired from: Nova SQLite Row Iterator, Nova Audio Master

**Keep current** puts the dropdown back where it was and nothing changes. **Change anyway** proceeds. Clicking outside the panel counts as keeping the current value.

If no column outputs are wired there is nothing to lose, so the change goes through silently — the prompt only appears when it is earning its place.

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

## The other SQLite nodes

The four nodes work as a chain: **Nova Dynamic SQLite Browser** reads a table, **Nova SQLite Data Table & Filter** narrows the rows, and **Nova SQLite Row Iterator & Splitter** or **Nova SQLite Single Row Filter** hands out one row at a time. Each has its own Help page.
