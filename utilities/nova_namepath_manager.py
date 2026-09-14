"""
nova_namepath_manager.py — one node that holds every path a Nova workflow needs.

The problem it solves: a delivery graph repeats the same database path, batch
folder, filter and output roots across four or five nodes, and changing album
means editing all of them. This node owns them once and feeds the rest, and a
named profile stores the whole set so switching project is one dropdown.

Profiles are plain JSON under `profiles/namepath/` — see nova_profile_store.

Two things deliberately NOT done here:

  * No filesystem is touched. This node composes strings; it does not create
    directories or verify that a path exists. The nodes downstream already
    report a missing path with their own context, and a path manager that
    silently made directories would scatter empty folders on every graph edit.
  * Saving happens on execute, through normal ComfyUI data flow, not over HTTP.
    The optional web widget (web/nova_namepath_manager.js) only ever *reads*,
    so the node behaves identically in API mode and headless runs where no
    frontend exists.
"""

import json
from typing import Any, Dict, List, Tuple

try:
    from ..nova_categories import UTILITY_IO
    from . import nova_profile_store as profiles
except ImportError:  # direct execution / test harness
    from nova_categories import UTILITY_IO
    import nova_profile_store as profiles

VERSION = "1.0.0"

ACTION_IGNORE = "use the widgets below"
ACTION_APPLY = "apply selected profile"
ACTION_SAVE = "save to selected profile"
ACTION_SAVE_AS = "save as new profile"
ACTIONS = [ACTION_IGNORE, ACTION_APPLY, ACTION_SAVE, ACTION_SAVE_AS]

# Every widget whose value a profile round-trips. Order is the display order.
PROFILE_KEYS = (
    "database_path",
    "table_name",
    "existing_database",
    "folder_string",
    "file_filter",
    "input_filename",
    "report_path",
    "audio_path",
    "concatenate_filename",
)


def _clean(value: Any) -> str:
    """Trim whitespace and the quotes a pasted path often brings with it."""
    return str(value if value is not None else "").strip().strip('"').strip("'")


def _join(directory: str, filename: str) -> str:
    """`directory` + "/" + `filename`, tolerating either side's separators.

    Backslashes are normalised to "/" so a pasted Windows path still composes,
    and repeated separators collapse — "/Reports/" + "/My Track" is one slash,
    not three. An empty side simply yields the other side.
    """
    left = _clean(directory).replace("\\", "/").rstrip("/")
    right = _clean(filename).replace("\\", "/").lstrip("/")
    if not left:
        return right
    if not right:
        return left
    return f"{left}/{right}"


def _split_for_new_database(database_path: str) -> Tuple[str, str]:
    """Split a full .db path into (folder, filename) for a database to create."""
    normalised = _clean(database_path).replace("\\", "/").rstrip("/")
    if not normalised:
        return "", ""
    if "/" not in normalised:
        return "", normalised
    folder, _, name = normalised.rpartition("/")
    return folder, name


class NovaNamePathManager:
    CATEGORY = UTILITY_IO
    FUNCTION = "resolve"

    # WHY THIS IS AN OUTPUT NODE. ComfyUI's execution is demand-driven: it walks
    # back from output nodes and prunes everything that does not feed one. This
    # node writes a profile file as a side effect, and that side effect is the
    # whole point of "save as new profile" — but with nothing connected
    # downstream (or a downstream chain that ends in no output node) the node was
    # pruned from the prompt and never ran, so the save silently never happened.
    # OUTPUT_NODE is exactly the flag for "this node does something worth
    # executing for its own sake". It does not stop the outputs feeding other
    # nodes, and it costs nothing on a run that only composes strings.
    OUTPUT_NODE = True
    RETURN_TYPES = (
        "STRING", "STRING", "STRING", "STRING", "BOOLEAN",
        "STRING", "STRING",
        "STRING", "STRING", "STRING",
        "STRING",
    )
    RETURN_NAMES = (
        "database_path", "new_database_folder", "new_database_name", "table_name",
        "existing_database",
        "folder_string", "file_filter",
        "input_filename", "report_path", "audio_path",
        "settings_json",
    )
    OUTPUT_TOOLTIPS = (
        "Path to an existing database — empty when existing_database is off.",
        "Folder for a database to create — empty when existing_database is on.",
        "File name for a database to create — empty when existing_database is on.",
        "Table name, passed straight through.",
        "The switch itself, so a downstream node can branch on it.",
        "Batch folder for Nova Batch Load Audio.",
        "Batch file filter for Nova Batch Load Audio.",
        "The mastering filename, passed straight through.",
        "Report path — with the filename joined on when concatenate_filename is on.",
        "Audio path — with the filename joined on when concatenate_filename is on.",
        "Every resolved value as JSON, for Nova Console or a report.",
    )
    DESCRIPTION = (
        f"Nova NamePath Manager v{VERSION} — holds the database, batch and output "
        "paths for a delivery workflow, and stores the whole set as a named profile."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "profile": (profiles.combo_choices(), {
                    "default": profiles.NONE_LABEL,
                    "tooltip": "Saved profiles. The list refreshes when the browser reloads.",
                }),
                "profile_action": (ACTIONS, {
                    "default": ACTION_IGNORE,
                    "tooltip": (
                        "use the widgets below: ignore profiles entirely.\n"
                        "apply selected profile: outputs come from the profile.\n"
                        "save to selected profile: overwrite it with the widgets below.\n"
                        "save as new profile: write the widgets below to new_profile_name."
                    ),
                }),
                "new_profile_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Tag Audio Files",
                    "tooltip": "Name for 'save as new profile'. Letters, digits, space, dot, dash, underscore.",
                }),

                "database_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "~/Databases/NovaAudioMastering.db",
                    "tooltip": "Full path to the SQLite database.",
                }),
                "table_name": ("STRING", {
                    "default": "albums",
                    "multiline": False,
                    "tooltip": "Table to read.",
                }),
                "existing_database": ("BOOLEAN", {
                    "default": True,
                    "tooltip": (
                        "On: database_path points at a database that already exists.\n"
                        "Off: it describes one to create — the path is split into "
                        "new_database_folder and new_database_name for Nova SQLite Reader."
                    ),
                }),

                "folder_string": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "~/Music/Nova Audio Masters/Albums/…",
                    "tooltip": "Folder for Nova Batch Load Audio.",
                }),
                "file_filter": ("STRING", {
                    "default": "*.flac",
                    "multiline": False,
                    "tooltip": "Comma-separated glob patterns for Nova Batch Load Audio.",
                }),

                "input_filename": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "My Track",
                    "tooltip": "The mastering filename. No extension is added — downstream nodes add their own.",
                }),
                "report_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Output folder for reports.",
                }),
                "audio_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Output folder for audio.",
                }),
                "concatenate_filename": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "On: report_path and audio_path each get input_filename joined "
                        "on with '/'.\nOff: both are passed through unchanged."
                    ),
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, profile, profile_action, new_profile_name, **kwargs):
        # A save writes to disk, and an apply reads a file that another run may
        # have rewritten — neither is safely cacheable. Composing strings is
        # cheap, so re-running costs nothing.
        if profile_action != ACTION_IGNORE:
            return float("nan")
        return json.dumps([profile, profile_action, new_profile_name, kwargs], sort_keys=True, default=str)

    @classmethod
    def VALIDATE_INPUTS(cls, profile, profile_action, new_profile_name, **kwargs):
        if profile_action == ACTION_SAVE_AS and not profiles.valid_name(_clean(new_profile_name)):
            return (
                "Nova NamePath Manager: 'save as new profile' needs a new_profile_name "
                "of letters, digits, spaces, dots, dashes or underscores (max 64)."
            )
        if profile_action in (ACTION_APPLY, ACTION_SAVE) and profile == profiles.NONE_LABEL:
            return f"Nova NamePath Manager: '{profile_action}' needs a profile selected."
        return True

    def resolve(self, profile, profile_action, new_profile_name, **kwargs):
        widget_values: Dict[str, Any] = {key: kwargs.get(key) for key in PROFILE_KEYS}
        notes: List[str] = []

        if profile_action == ACTION_APPLY:
            stored = profiles.load(profile)
            if stored is None:
                raise ValueError(
                    f"Nova NamePath Manager: could not read profile '{profile}'. "
                    "It may have been deleted or hand-edited into invalid JSON."
                )
            # Only keys this version knows about; an older profile keeps the
            # widget value for anything it predates.
            values = dict(widget_values)
            values.update({k: v for k, v in stored.items() if k in PROFILE_KEYS})
            notes.append(f"Applied profile '{profile}'.")
        else:
            values = widget_values

        if profile_action in (ACTION_SAVE, ACTION_SAVE_AS):
            target = profile if profile_action == ACTION_SAVE else _clean(new_profile_name)
            if not profiles.save(target, values):
                raise ValueError(
                    f"Nova NamePath Manager: could not write profile '{target}'. "
                    "Check the name and that profiles/namepath/ is writable."
                )
            notes.append(f"Saved profile '{target}'.")

        existing = bool(values.get("existing_database", True))
        database_path = _clean(values.get("database_path"))
        if existing:
            out_database, out_folder, out_name = database_path, "", ""
        else:
            out_database = ""
            out_folder, out_name = _split_for_new_database(database_path)

        concatenate = bool(values.get("concatenate_filename", False))
        input_filename = _clean(values.get("input_filename"))
        report_path = _clean(values.get("report_path"))
        audio_path = _clean(values.get("audio_path"))
        if concatenate:
            report_out = _join(report_path, input_filename)
            audio_out = _join(audio_path, input_filename)
        else:
            report_out, audio_out = report_path, audio_path

        resolved = {
            "schema": "nova.namepath.resolved",
            "schema_version": 1,
            "node_version": VERSION,
            "profile": None if profile == profiles.NONE_LABEL else profile,
            "profile_action": profile_action,
            "sql": {
                "existing_database": existing,
                "database_path": out_database,
                "new_database_folder": out_folder,
                "new_database_name": out_name,
                "table_name": _clean(values.get("table_name")),
            },
            "batch": {
                "folder_string": _clean(values.get("folder_string")),
                "file_filter": _clean(values.get("file_filter")),
            },
            "mastering": {
                "input_filename": input_filename,
                "concatenate_filename": concatenate,
                "report_path_in": report_path,
                "audio_path_in": audio_path,
                "report_path": report_out,
                "audio_path": audio_out,
            },
            "notes": notes,
        }

        if not notes:
            notes.append(
                "Resolved from the widgets — no profile was read or written."
                if profile_action == ACTION_IGNORE else
                f"'{profile_action}' completed."
            )
        for note in notes:
            print(f"[Nova NamePath Manager] {note}")

        result = (
            out_database,
            out_folder,
            out_name,
            _clean(values.get("table_name")),
            existing,
            _clean(values.get("folder_string")),
            _clean(values.get("file_filter")),
            input_filename,
            report_out,
            audio_out,
            json.dumps(resolved, indent=2, ensure_ascii=False),
        )
        # `saved` tells the frontend to refresh its profile dropdown without a
        # page reload; `status` is shown on the node face.
        return {
            "ui": {
                "status": ["  ".join(notes)],
                "saved": [profile_action in (ACTION_SAVE, ACTION_SAVE_AS)],
            },
            "result": result,
        }


NODE_CLASS_MAPPINGS = {"NovaNamePathManager": NovaNamePathManager}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaNamePathManager": "Nova NamePath Manager 🧭"}
