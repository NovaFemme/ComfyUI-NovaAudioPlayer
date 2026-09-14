# Nova NamePath Manager

Holds every path a delivery workflow needs in one node, and stores the whole set
as a named profile. Change album by picking a profile instead of editing the
same folder into four nodes.

This node composes strings. It never creates a directory and never checks that a
path exists — the nodes downstream report a missing path with their own context,
and a path manager that silently made folders would scatter empty directories
on every graph edit.

## Profiles

| Widget | Purpose |
|---|---|
| `profile` | Saved profiles, read from `profiles/namepath/`. |
| `profile_action` | What to do with the selection on this run. |
| `new_profile_name` | Target name for **save as new profile**. |

`profile_action` values:

- **use the widgets below** — profiles ignored; the widgets are the truth.
- **apply selected profile** — outputs come from the profile file. The widget
  boxes keep whatever you typed; use the Load button if you want to see the
  stored values on the node face.
- **save to selected profile** — overwrite the selected profile with the widgets.
- **save as new profile** — write the widgets to `new_profile_name`.

Profile names allow letters, digits, spaces, dots, dashes and underscores, up to
64 characters. A profile is a plain JSON file, so it can be edited by hand,
committed to git and shared.

**Saving happens when the graph runs.** Press Run (Queue) after choosing a save
action — that is what commits the file. The node is an output node, so it
executes even with nothing connected to its outputs; without that flag ComfyUI
prunes any node that does not feed an output, and the save would silently never
happen. The node face reports what each run did.

A profile written by a run is added to the dropdown straight away. Use
**Refresh profile list** if you edited the `profiles/namepath/` folder by hand.

### The Load button

**Load profile into widgets** fills the widgets from the selected profile so you
can see and adjust the values before running. It is a convenience only: it calls
two read-only endpoints, and every profile operation the node actually performs
happens server-side during execution. With no frontend — API mode, a headless
run, or the extension failing to load — the node behaves identically.

## SQL inputs

| Widget | Purpose |
|---|---|
| `database_path` | Full path to the SQLite database. |
| `table_name` | Table to read. |
| `existing_database` | On: the database already exists. Off: it describes one to create. |

`existing_database` decides how three outputs are filled, so the node wires
straight into Nova SQLite Reader:

- **On** — `database_path` carries the path; `new_database_folder` and
  `new_database_name` are empty.
- **Off** — `database_path` is empty and the path is split into
  `new_database_folder` and `new_database_name`.

## File batch inputs

`folder_string` and `file_filter` feed Nova Batch Load Audio unchanged.

## Mastering inputs

| Widget | Purpose |
|---|---|
| `input_filename` | The mastering filename. No extension is added. |
| `report_path` | Output folder for reports. |
| `audio_path` | Output folder for audio. |
| `concatenate_filename` | Join the filename onto both output paths. |

With `concatenate_filename` **on**:

    report_path -> report_path + "/" + input_filename
    audio_path  -> audio_path  + "/" + input_filename

With it **off**, both are passed through unchanged.

Joining tolerates either side's separators: backslashes are normalised to `/`
and repeated separators collapse, so `/Reports/` + `/My Track` yields
`/Reports/My Track`. No extension is added — the node that writes the file adds
its own.

## Outputs

| Output | Type | Notes |
|---|---|---|
| `database_path` | STRING | Empty when `existing_database` is off. |
| `new_database_folder` | STRING | Empty when `existing_database` is on. |
| `new_database_name` | STRING | Empty when `existing_database` is on. |
| `table_name` | STRING | Passed through. |
| `existing_database` | BOOLEAN | The switch, so a node downstream can branch. |
| `folder_string` | STRING | Passed through. |
| `file_filter` | STRING | Passed through. |
| `input_filename` | STRING | Passed through. |
| `report_path` | STRING | Joined when `concatenate_filename` is on. |
| `audio_path` | STRING | Joined when `concatenate_filename` is on. |
| `settings_json` | STRING | Every resolved value, for Nova Console or a report. |

## Limitations

- No filesystem validation, by design (see above).
- Saving happens during execution, so a profile is only written when the graph
  runs — queuing a prompt is what commits it.
- Values are trimmed of surrounding whitespace and of the quotes a pasted path
  often brings with it.
