# Nova Console

Shows whatever you wire into it. Strings, numbers, booleans, `NOVA_TABLE`,
`NOVA_FILES`, tensors and list outputs all render on the node face.

Most Nova nodes have a `console` output carrying their run log. Wiring it here
is how you read it without watching the terminal.

![Nova Console showing a Nova Memory Probe report](images/nova-console.png)
*Any node's `console` output renders here — this one is a Nova Memory Probe
report. `max_lines` is 0, so nothing is trimmed.*

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `value` | — | Anything. The only input you normally connect. |
| `label` | empty | A heading above the output, for telling two consoles apart. |
| `print_to_server_log` | on | Also print to the terminal, so it survives a browser reload. |
| `max_lines` | `0` | Trim the display to the last N lines. `0` means no limit. |

## Outputs

`text` — the same content as a string, so consoles can be chained or the text
reused. The node is an `OUTPUT_NODE`, so it runs even with nothing downstream.

## It takes lists whole

`INPUT_IS_LIST` is declared, so a genuine list output — Nova SQLite Reader's
`column_headers`, Nova Batch Load Audio's `filenames` — arrives as one value and
is shown as a single listing. Without that, ComfyUI would run the node once per
item and you would get one console per filename.

## Auto-connect always lands on `value`

Drag a link from any output, release on empty canvas, pick Nova Console: the
link attaches to `value`, never to `label`.

That is not free behaviour. In the current frontend every widget is also a
connectable input, so this node offers four, and auto-connect picks by type — a
STRING source is an exact match for `label` while the wildcard `value` is not.
Left alone it lands on `label` and the graph then fails to execute. An INT
source went to `max_lines`, a BOOLEAN to `print_to_server_log`.

`web/nova_console.js` overrides the four internals that resolve that slot
(`findInputByType`, `findConnectByTypeSlot`, `findSlotByType`,
`findInputSlotByType`) **for this node type only** — never the shared prototype,
so nothing else in ComfyUI changes behaviour. Dropping a link directly onto a
named slot uses a different code path and is untouched, so you can still wire
something into `label` deliberately.

## Notes

- The text survives a page reload: it is stashed on the node and restored from
  the serialised value.
- The display widget never serialises into your workflow JSON, so a long log
  does not bloat the saved file.
- Turning `print_to_server_log` off only stops the terminal copy; the node face
  still shows everything.
