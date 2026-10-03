# Nova SQLite Row Iterator & Splitter 📦

Steps through rows one run at a time and outputs each column of the current row.

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

## The other SQLite nodes

The four nodes work as a chain: **Nova Dynamic SQLite Browser** reads a table, **Nova SQLite Data Table & Filter** narrows the rows, and **Nova SQLite Row Iterator & Splitter** or **Nova SQLite Single Row Filter** hands out one row at a time. Each has its own Help page.
