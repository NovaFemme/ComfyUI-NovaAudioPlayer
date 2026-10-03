# Nova SQLite Data Table & Filter 🔎

Shows rows in a grid, filters them with conditions, and outputs the matching or selected rows.

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

## The other SQLite nodes

The four nodes work as a chain: **Nova Dynamic SQLite Browser** reads a table, **Nova SQLite Data Table & Filter** narrows the rows, and **Nova SQLite Row Iterator & Splitter** or **Nova SQLite Single Row Filter** hands out one row at a time. Each has its own Help page.
