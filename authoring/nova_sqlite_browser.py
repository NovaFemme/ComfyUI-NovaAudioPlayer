import os
import json
import sqlite3
from contextlib import closing

from aiohttp import web
import folder_paths
from server import PromptServer

try:
    from .nova_authoring_common import (DELIVERY)
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (DELIVERY)


# Must match MAX_COLUMN_OUTPUTS in nova_sqlite_browser.js
MAX_COLUMN_OUTPUTS = 64
DB_EXTENSIONS = (".db", ".sqlite", ".sqlite3")
NO_DB = "(no database in input folder)"
LOG = "[Nova SQLite]"
LOOP_MODES = ["increment", "decrement", "fixed"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _list_db_files():
    input_dir = folder_paths.get_input_directory()
    if not os.path.isdir(input_dir):
        return []
    return sorted(f for f in os.listdir(input_dir) if f.lower().endswith(DB_EXTENSIONS))


def _first(value):
    if isinstance(value, (list, tuple)):
        return value[0] if value else ""
    return value


def _resolve_db_path(value):
    path = str(_first(value) or "").strip()
    if not path or path == NO_DB:
        return ""
    if not os.path.isabs(path):
        path = os.path.join(folder_paths.get_input_directory(), path)
    return path


def _clean_name(value):
    name = str(_first(value) or "").strip()
    return "" if name in ("[]", "None") else name


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _parse_selected(value):
    """selected_columns is stored by the UI as a JSON list. A comma list is accepted for manual input."""
    text = str(value or "").strip()
    if not text or text == "*":
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(c) for c in parsed if str(c).strip()]
        except json.JSONDecodeError:
            pass
    return [c.strip() for c in text.split(",") if c.strip()]


def _jsonable(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<BLOB {len(bytes(value))} bytes>"
    return value


def _to_str(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _get_tables(conn):
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
    return [r[0] for r in cur.fetchall()]


def _get_columns(conn, table):
    cur = conn.execute(f"PRAGMA table_info({_quote_ident(table)})")
    return [r[1] for r in cur.fetchall()]


def _all_known_tables():
    tables = []
    for f in _list_db_files():
        try:
            with closing(sqlite3.connect(os.path.join(folder_paths.get_input_directory(), f))) as conn:
                for t in _get_tables(conn):
                    if t not in tables:
                        tables.append(t)
        except sqlite3.Error:
            pass
    return tables


# ---------------------------------------------------------------------------
# Node 1: Browser
# ---------------------------------------------------------------------------
class NovaSQLiteBrowserNode:
    @classmethod
    def INPUT_TYPES(cls):
        db_files = _list_db_files() or [NO_DB]
        tables = _all_known_tables() or [""]
        return {
            "required": {
                "database_path": (db_files, {"default": db_files[0]}),
                "table_name": (tables, {"default": tables[0]}),
                # Hidden in the UI, driven by the column badges (JSON list of selected columns)
                "selected_columns": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING", "LIST", "STRING", "INT", "INT")
    RETURN_NAMES = ("row_data_json", "column_names_list", "column_names_json", "column_count", "row_count")
    FUNCTION = "execute_query"
    CATEGORY = DELIVERY

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Table list is dynamic (depends on the chosen DB), so skip default combo validation.
        return True

    def execute_query(self, database_path, table_name, selected_columns=""):
        empty = ("[]", [], "[]", 0, 0)

        def done(result, status):
            print(f"{LOG} Browser: {status}")
            return {"ui": {"status": [status]}, "result": result}

        path = _resolve_db_path(database_path)
        if not path:
            return done(empty, "No database selected")
        if not os.path.isfile(path):
            return done(empty, f"Database not found: {path}")

        table = _clean_name(table_name)
        if not table:
            return done(empty, "No table selected")

        requested = _parse_selected(selected_columns)

        try:
            with closing(sqlite3.connect(path)) as conn:
                if table not in _get_tables(conn):
                    return done(empty, f"Table '{table}' not found in database")

                table_cols = _get_columns(conn, table)
                valid = [c for c in requested if c in table_cols]
                missing = [c for c in requested if c not in table_cols]
                q_table = _quote_ident(table)

                if not valid:
                    # Keep the row count so the iterator can report "0 columns selected" precisely.
                    count = conn.execute(f"SELECT COUNT(*) FROM {q_table}").fetchone()[0]
                    rows = [{} for _ in range(count)]
                    return done((json.dumps(rows), [], "[]", 0, count),
                                f"{count} rows · 0 columns selected - select at least one column")

                cur = conn.execute(f"SELECT {', '.join(_quote_ident(c) for c in valid)} FROM {q_table}")
                rows = [{c: _jsonable(v) for c, v in zip(valid, r)} for r in cur.fetchall()]
        except sqlite3.Error as e:
            return done(empty, f"SQLite error: {e}")

        status = f"{len(rows)} rows · {len(valid)} columns"
        if missing:
            status += f" (ignored missing: {', '.join(missing)})"
        return done(
            (json.dumps(rows, ensure_ascii=False), valid, json.dumps(valid, ensure_ascii=False), len(valid), len(rows)),
            status,
        )


# ---------------------------------------------------------------------------
# Node 2: Single row viewer / splitter
# ---------------------------------------------------------------------------
class NovaSQLiteSingleRowNode:
    """Shows / outputs exactly one row. Same dynamic column outputs and viewer as the iterator, no loop."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "row_data_json": ("STRING", {"forceInput": True, "default": "[]"}),
                "row_index": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1,
                                      "tooltip": "Row to show (0-based). Ignored when only one row is received."}),
            }
        }

    # Fixed outputs + a pool of STRING slots. The UI only shows one slot per selected column.
    RETURN_TYPES = ("STRING", "INT", "INT") + ("STRING",) * MAX_COLUMN_OUTPUTS
    RETURN_NAMES = ("single_row_json", "row_index", "total_rows") + tuple(f"col_{i}" for i in range(MAX_COLUMN_OUTPUTS))
    FUNCTION = "isolate_single_row"
    CATEGORY = DELIVERY
    OUTPUT_NODE = True

    @staticmethod
    def _ui(**kw):
        # Same UI payload shape as the iterator so the viewer renders identically (every value must be a list).
        base = {"error": "", "warning": "", "current_row_data": {}, "column_names": [], "current_index": 0,
                "total_rows": 0, "next_row_index": 0, "loop_finished": True, "stop_at_row": 0,
                "loop_mode": "single", "row_locked": False}
        base.update(kw)
        return {k: [v] for k, v in base.items()}

    def _fail(self, msg, total=0, index=0):
        print(f"{LOG} Single row error: {msg}")
        return {
            "ui": self._ui(error=msg, total_rows=total, current_index=index, next_row_index=index,
                           row_locked=total == 1),
            "result": ("{}", index, total) + ("",) * MAX_COLUMN_OUTPUTS,
        }

    def isolate_single_row(self, row_data_json, row_index=0):
        try:
            data = json.loads(row_data_json) if isinstance(row_data_json, str) else row_data_json
        except (json.JSONDecodeError, TypeError):
            return self._fail("row_data_json is not valid JSON")
        if not isinstance(data, list):
            return self._fail("Invalid data: expected a JSON list of rows")

        total = len(data)
        if total == 0:
            return self._fail("No rows: the table is empty or the query failed (check the browser node)")

        try:
            row_index = int(row_index)
        except (TypeError, ValueError):
            return self._fail("row_index must be an integer", total)

        locked = total == 1
        if locked:
            row_index = 0  # only one row -> selector is inactive
        elif row_index < 0 or row_index >= total:
            return self._fail(f"row_index {row_index} is out of range (valid: 0 - {total - 1})", total)

        row = data[row_index]
        if not isinstance(row, dict):
            return self._fail(f"Row {row_index} is not an object", total, row_index)
        if not row:
            return self._fail("0 columns selected: select at least one column badge on the SQLite Browser", total, row_index)

        col_names = list(row.keys())
        warning = ""
        if len(col_names) > MAX_COLUMN_OUTPUTS:
            warning = f"Only the first {MAX_COLUMN_OUTPUTS} of {len(col_names)} columns are output"
        values = [_to_str(row[c]) for c in col_names[:MAX_COLUMN_OUTPUTS]]
        values += [""] * (MAX_COLUMN_OUTPUTS - len(values))

        print(f"{LOG} Single row: row {row_index}/{total - 1}{' (only row)' if locked else ''}")

        return {
            "ui": self._ui(
                warning=warning,
                current_row_data=row,
                column_names=col_names,
                current_index=row_index,
                total_rows=total,
                next_row_index=row_index,
                stop_at_row=row_index,
                row_locked=locked,
            ),
            "result": (json.dumps(row, ensure_ascii=False), row_index, total) + tuple(values),
        }


# ---------------------------------------------------------------------------
# Node 3: Row iterator (dynamic column outputs are managed by the JS side)
# ---------------------------------------------------------------------------
class NovaSQLiteRowIteratorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "row_data_json": ("STRING", {"forceInput": True, "default": "[]"}),
                "row_index": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "stop_at_row": ("INT", {"default": -1, "min": -1, "max": 999999, "step": 1,
                                        "tooltip": "-1 = last row (increment) / first row (decrement)"}),
                "loop_mode": (LOOP_MODES, {"default": "increment"}),
                "auto_loop": ("BOOLEAN", {"default": True,
                                          "tooltip": "Automatically queue the next row until the loop finishes"}),
            }
        }

    # Fixed outputs + a pool of STRING slots. The UI only shows one slot per selected column.
    RETURN_TYPES = ("INT", "INT", "BOOLEAN") + ("STRING",) * MAX_COLUMN_OUTPUTS
    RETURN_NAMES = ("next_row_index", "total_rows", "loop_finished") + tuple(f"col_{i}" for i in range(MAX_COLUMN_OUTPUTS))
    FUNCTION = "process_row"
    CATEGORY = DELIVERY
    OUTPUT_NODE = True

    @staticmethod
    def _ui(**kw):
        # ComfyUI merges UI outputs by iterating each value, so every value must be a list.
        base = {"error": "", "warning": "", "current_row_data": {}, "column_names": [], "current_index": 0,
                "total_rows": 0, "next_row_index": 0, "loop_finished": True, "stop_at_row": 0, "loop_mode": ""}
        base.update(kw)
        return {k: [v] for k, v in base.items()}

    def _fail(self, msg, total=0, index=0):
        print(f"{LOG} Iterator error: {msg}")
        return {
            "ui": self._ui(error=msg, total_rows=total, current_index=index, next_row_index=index),
            "result": (index, total, True) + ("",) * MAX_COLUMN_OUTPUTS,
        }

    def process_row(self, row_data_json, row_index, stop_at_row, loop_mode, auto_loop=True):
        # --- parse input ---
        try:
            data = json.loads(row_data_json) if isinstance(row_data_json, str) else row_data_json
        except (json.JSONDecodeError, TypeError):
            return self._fail("row_data_json is not valid JSON")
        if not isinstance(data, list):
            return self._fail("Invalid data: expected a JSON list of rows")

        total = len(data)
        if total == 0:
            return self._fail("No rows: the table is empty or the query failed (check the browser node)")

        try:
            row_index = int(row_index)
            stop_at_row = int(stop_at_row)
        except (TypeError, ValueError):
            return self._fail("row_index / stop_at_row must be integers", total)

        if loop_mode not in LOOP_MODES:
            return self._fail(f"Invalid loop_mode '{loop_mode}'", total)
        if row_index < 0 or row_index >= total:
            return self._fail(f"row_index {row_index} is out of range (valid: 0 - {total - 1})", total)

        row = data[row_index]
        if not isinstance(row, dict):
            return self._fail(f"Row {row_index} is not an object", total, row_index)
        if not row:
            return self._fail("0 columns selected: select at least one column badge on the SQLite Browser", total, row_index)

        # --- loop bounds ---
        if loop_mode == "increment":
            end = total - 1 if stop_at_row < 0 else min(stop_at_row, total - 1)
            if end < row_index:
                return self._fail(f"stop_at_row ({stop_at_row}) is before row_index ({row_index}) in increment mode", total, row_index)
            finished = row_index >= end
            next_index = row_index if finished else row_index + 1
        elif loop_mode == "decrement":
            end = 0 if stop_at_row < 0 else min(stop_at_row, total - 1)
            if end > row_index:
                return self._fail(f"stop_at_row ({stop_at_row}) is after row_index ({row_index}) in decrement mode", total, row_index)
            finished = row_index <= end
            next_index = row_index if finished else row_index - 1
        else:  # fixed
            end = row_index
            finished = True
            next_index = row_index

        # --- column outputs (order = order of selected columns) ---
        col_names = list(row.keys())
        warning = ""
        if len(col_names) > MAX_COLUMN_OUTPUTS:
            warning = f"Only the first {MAX_COLUMN_OUTPUTS} of {len(col_names)} columns are output"
        values = [_to_str(row[c]) for c in col_names[:MAX_COLUMN_OUTPUTS]]
        values += [""] * (MAX_COLUMN_OUTPUTS - len(values))

        print(f"{LOG} Iterator: row {row_index}/{total - 1} ({loop_mode}, stop {end}) -> next {next_index}, finished={finished}")

        return {
            "ui": self._ui(
                warning=warning,
                current_row_data=row,
                column_names=col_names,
                current_index=row_index,
                total_rows=total,
                next_row_index=next_index,
                loop_finished=finished,
                stop_at_row=end,
                loop_mode=loop_mode,
            ),
            "result": (next_index, total, finished) + tuple(values),
        }


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@PromptServer.instance.routes.post("/sqlite_browser/get_tables")
async def get_tables(request):
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid request", "tables": []})

    db_path = _resolve_db_path(json_data.get("database_path", ""))
    if not db_path or not os.path.isfile(db_path):
        return web.json_response({"error": "Database file not found", "tables": []})
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            return web.json_response({"tables": _get_tables(conn)})
    except sqlite3.Error as e:
        print(f"{LOG} get_tables error: {e}")
        return web.json_response({"error": str(e), "tables": []})


@PromptServer.instance.routes.post("/sqlite_browser/get_columns")
async def get_columns(request):
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid request", "columns": []})

    db_path = _resolve_db_path(json_data.get("database_path", ""))
    table = _clean_name(json_data.get("table_name", ""))
    if not db_path or not os.path.isfile(db_path):
        return web.json_response({"error": "Database file not found", "columns": []})
    if not table:
        return web.json_response({"columns": []})
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            return web.json_response({"columns": _get_columns(conn, table)})
    except sqlite3.Error as e:
        print(f"{LOG} get_columns error: {e}")
        return web.json_response({"error": str(e), "columns": []})


NODE_CLASS_MAPPINGS = {
    "NovaSQLiteBrowserNode": NovaSQLiteBrowserNode,
    "NovaSQLiteSingleRowNode": NovaSQLiteSingleRowNode,
    "NovaSQLiteRowIteratorNode": NovaSQLiteRowIteratorNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaSQLiteBrowserNode": "Nova Dynamic SQLite Browser 📁",
    "NovaSQLiteSingleRowNode": "Nova SQLite Single Row Filter 🔍",
    "NovaSQLiteRowIteratorNode": "Nova SQLite Row Iterator & Splitter 📦",
}
