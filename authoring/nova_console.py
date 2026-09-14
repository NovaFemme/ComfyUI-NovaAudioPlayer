"""
nova_console.py — display whatever is wired into it.

A terminal node for the authoring chain: Nova Tag Writer and Nova Tag Reader
both emit a `console` string, and this renders it on the node face (see
web/nova_console.js) as well as printing it to the ComfyUI server log.

Two details make it accept anything:

  * the input slot uses a wildcard type, so any output can connect to it;
  * INPUT_IS_LIST is on, so a list output — Nova SQLite Reader's
    column_headers, Nova Batch Load Audio's filenames — arrives whole and is
    shown as one numbered listing, instead of running this node once per item.

Because INPUT_IS_LIST applies to every input, the widget values arrive wrapped
in a list too; `_first` unwraps them.
"""

import json
from typing import Any, List

try:
    from .nova_authoring_common import (
        ANY_TYPE, UTILITY_CATEGORY, AUTHORING_VERSION,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        ANY_TYPE, UTILITY_CATEGORY, AUTHORING_VERSION,
    )


def _first(value: Any, fallback: Any = None) -> Any:
    if isinstance(value, list):
        return value[0] if value else fallback
    return fallback if value is None else value


def _render(value: Any) -> str:
    if value is None:
        return "<none>"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, dict):
        # NOVA_TABLE / NOVA_FILES and other structured payloads.
        schema = value.get("schema")
        if schema == "nova.authoring.table":
            head = (
                f"NOVA_TABLE  {value.get('database_path', '')}\n"
                f"  table   : {value.get('table')}\n"
                f"  rows    : {value.get('record_count')}\n"
                f"  columns : {', '.join(value.get('columns') or [])}\n"
            )
            if value.get("where"):
                head += f"  where   : {value['where']}\n"
            rows = value.get("rows") or []
            body = json.dumps(rows[:50], indent=2, ensure_ascii=False, default=str)
            if len(rows) > 50:
                body += f"\n… and {len(rows) - 50} more row(s)"
            return head + body
        if schema == "nova.authoring.files":
            names = [f.get("name", "?") for f in value.get("files") or []]
            listing = "\n".join(f"  {i + 1:>3}. {n}" for i, n in enumerate(names))
            return (
                f"NOVA_FILES  {value.get('root', '')}\n"
                f"  count   : {value.get('count')}\n"
                f"  decoded : {value.get('decoded')}\n" + listing
            )
        try:
            return json.dumps(value, indent=2, ensure_ascii=False, default=str)
        except Exception:
            return str(value)
    if isinstance(value, (list, tuple)):
        return "\n".join(f"{i + 1:>3}. {_render(v)}" for i, v in enumerate(value))
    # Tensors and anything else exotic.
    shape = getattr(value, "shape", None)
    if shape is not None:
        return f"<{type(value).__name__} shape={tuple(shape)} dtype={getattr(value, 'dtype', '?')}>"
    return str(value)


class NovaConsole:
    CATEGORY = UTILITY_CATEGORY
    FUNCTION = "show"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    OUTPUT_TOOLTIPS = ("The rendered text, so you can chain another console or a save node.",)
    DESCRIPTION = (
        f"Nova Console v{AUTHORING_VERSION} — displays any input on the node face and "
        "in the server log."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (ANY_TYPE, {"tooltip": "Anything. Strings, numbers, NOVA_TABLE, NOVA_FILES, list outputs."}),
            },
            "optional": {
                "label": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Optional heading",
                    "tooltip": "Printed above the value, to tell two consoles apart.",
                }),
                "print_to_server_log": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Also write the text to the terminal ComfyUI is running in.",
                }),
                "max_lines": ("INT", {
                    "default": 0, "min": 0, "max": 100000, "step": 50,
                    "tooltip": "Trim the display to this many lines. 0 = show everything.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # always refresh what is on screen

    def show(self, value, label=None, print_to_server_log=None, max_lines=None, **kwargs):
        heading = str(_first(label, "") or "").strip()
        to_log = bool(_first(print_to_server_log, True))
        limit = int(_first(max_lines, 0) or 0)

        # INPUT_IS_LIST hands us every linked value; one link is the common case.
        values: List[Any] = value if isinstance(value, list) else [value]
        if len(values) == 1:
            body = _render(values[0])
        else:
            body = "\n".join(_render(v) for v in values)

        text = f"{heading}\n{'-' * len(heading)}\n{body}" if heading else body

        if limit > 0:
            lines = text.splitlines()
            if len(lines) > limit:
                text = "\n".join(lines[:limit]) + f"\n… {len(lines) - limit} more line(s) hidden"

        if to_log:
            print(f"[Nova Console] {heading or ''}".rstrip())
            print(text)

        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"NovaConsole": NovaConsole}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaConsole": "Nova Console 🖥️"}
