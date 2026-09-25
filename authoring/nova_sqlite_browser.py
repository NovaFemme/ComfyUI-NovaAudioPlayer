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

# NOVA_TABLE is the payload the rest of the pack passes around (Nova Tag Writer,
# Nova Tag Reader, ...). Imported so this file always matches the pack's own value.
try:
    from .nova_authoring_common import TABLE_TYPE
except ImportError:
    try:
        from nova_authoring_common import TABLE_TYPE
    except ImportError:
        TABLE_TYPE = "NOVA_TABLE"


# Must match MAX_COLUMN_OUTPUTS in nova_sqlite_browser.js
MAX_COLUMN_OUTPUTS = 64
# Custom link type for the browser -> iterator / single row connection.
# Lets ComfyUI suggest the two row nodes when a wire is dragged from row_data_json.
# Must match ROWS_TYPE in nova_sqlite_browser.js
ROWS_TYPE = "NOVA_SQLITE_ROWS"
DB_EXTENSIONS = (".db", ".sqlite", ".sqlite3")
MAX_SCAN_DEPTH = 6            # how deep under input/ the database scan walks
NO_DB = "(no database in input folder)"
LOG = "[Nova SQLite]"
LOOP_MODES = ["increment", "decrement", "fixed"]

# Condition operators for the WHERE builder. Must match OPERATORS in nova_sqlite_browser.js
# name -> needs a value?
OPERATORS = {
    "equals": True,
    "not equals": True,
    "greater than": True,
    "greater or equal": True,
    "less than": True,
    "less or equal": True,
    "contains": True,
    "does not contain": True,
    "starts with": True,
    "ends with": True,
    "in list": True,
    "not in list": True,
    "is empty": False,
    "is not empty": False,
}
MAX_CONDITIONS = 16
# Must match OUTPUT_MODES in nova_sqlite_browser.js
OUTPUT_MODES = ["matching rows", "selected rows"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _list_db_files():
    """
    Every database under the input folder, including sub-folders, as paths relative
    to it ("audio/library.db"). Hidden folders and the usual heavy ComfyUI working
    directories are skipped so the walk stays quick on a large input folder.
    """
    input_dir = folder_paths.get_input_directory()
    if not os.path.isdir(input_dir):
        return []

    skip = {"__pycache__", "node_modules", ".git", "clipspace"}
    found = []
    for root, dirs, files in os.walk(input_dir, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in skip)
        depth = os.path.relpath(root, input_dir).count(os.sep)
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []
        for name in files:
            if name.lower().endswith(DB_EXTENSIONS) and not name.startswith("."):
                rel = os.path.relpath(os.path.join(root, name), input_dir)
                found.append(rel.replace(os.sep, "/"))
    # shallowest first, then alphabetically, so top-level databases stay at the top
    return sorted(found, key=lambda p: (p.count("/"), p.lower()))


def _first(value):
    if isinstance(value, (list, tuple)):
        return value[0] if value else ""
    return value


def _resolve_db_path(value):
    """
    A relative value names a database inside the input folder, possibly in a
    sub-folder. It is resolved and then checked to still be inside that folder, so a
    value like "../../etc/passwd" cannot reach out of it.
    """
    path = str(_first(value) or "").strip()
    if not path or path == NO_DB:
        return ""
    if os.path.isabs(path):
        return path                     # an explicit absolute path is the user's own call
    input_dir = os.path.realpath(folder_paths.get_input_directory())
    full = os.path.realpath(os.path.join(input_dir, path.replace("/", os.sep)))
    if full != input_dir and not full.startswith(input_dir + os.sep):
        print(f"{LOG} Refusing a database path outside the input folder: {path}")
        return ""
    return full


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


# --- WHERE builder helpers -------------------------------------------------
def _sql_text(value):
    """Quote a value as a SQL string literal. A single quote is doubled, so O'Brien -> 'O''Brien'."""
    return "'" + str(value).replace("'", "''") + "'"


def _sql_literal(value):
    """Numbers are emitted bare, everything else as a safely quoted string."""
    text = str(value)
    stripped = text.strip()
    if stripped and stripped.lstrip("+-").replace(".", "", 1).isdigit():
        try:
            float(stripped)
            return stripped
        except ValueError:
            pass
    return _sql_text(text)


def _sql_like(value, pattern):
    """Quote a LIKE pattern. Wildcards inside the user's value are escaped so they match literally."""
    escaped = str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return _sql_text(pattern.format(v=escaped)) + " ESCAPE '\\'"


def _num(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        text = str(value).strip()
        return float(text) if text else None
    except (TypeError, ValueError):
        return None


def _split_list(value):
    return [p.strip() for p in str(value or "").split(",") if p.strip()]


def _parse_conditions(value, columns):
    """
    where_json is stored by the UI as a list of
    {column, operator, value, join: "AND"|"OR", enabled: bool}.
    Unknown columns / operators are dropped rather than trusted.
    """
    text = str(value or "").strip()
    if not text or not text.startswith("["):
        return [], []

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return [], ["The filter conditions could not be read and were ignored"]
    if not isinstance(raw, list):
        return [], ["The filter conditions could not be read and were ignored"]

    known = set(columns)
    conditions, problems = [], []
    for i, item in enumerate(raw[:MAX_CONDITIONS]):
        if not isinstance(item, dict) or item.get("enabled") is False:
            continue
        column = str(item.get("column", "")).strip()
        operator = str(item.get("operator", "")).strip()
        if not column and not operator:
            continue
        if column not in known:
            problems.append(f"condition {i + 1}: column '{column}' is not available")
            continue
        if operator not in OPERATORS:
            problems.append(f"condition {i + 1}: unknown operator '{operator}'")
            continue
        value_text = "" if item.get("value") is None else str(item.get("value"))
        if OPERATORS[operator] and not value_text.strip():
            problems.append(f"condition {i + 1}: '{operator}' needs a value")
            continue
        if operator in ("in list", "not in list") and not _split_list(value_text):
            problems.append(f"condition {i + 1}: '{operator}' needs a comma separated list")
            continue
        join = "OR" if str(item.get("join", "AND")).upper() == "OR" else "AND"
        conditions.append({"column": column, "operator": operator, "value": value_text, "join": join})
    return conditions, problems


def _parse_selection(value):
    """selected_rows is stored by the grid as a JSON list of source row numbers."""
    text = str(value or "").strip()
    if not text.startswith("["):
        return set()
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return set()
    if not isinstance(raw, list):
        return set()
    out = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out


def _match(row, condition, case_sensitive):
    """Evaluates one condition against a row. Pure Python, so no SQL can be injected here."""
    raw = row.get(condition["column"])
    operator = condition["operator"]

    if operator == "is empty":
        return raw is None or str(raw) == ""
    if operator == "is not empty":
        return raw is not None and str(raw) != ""

    cell = "" if raw is None else str(raw)
    wanted = condition["value"]
    if not case_sensitive:
        cell_cmp, wanted_cmp = cell.lower(), wanted.lower()
    else:
        cell_cmp, wanted_cmp = cell, wanted

    if operator in ("equals", "not equals"):
        a, b = _num(raw), _num(wanted)
        hit = (a == b) if (a is not None and b is not None) else (cell_cmp == wanted_cmp)
        return hit if operator == "equals" else not hit

    if operator in ("greater than", "greater or equal", "less than", "less or equal"):
        a, b = _num(raw), _num(wanted)
        if a is None or b is None:
            a, b = cell_cmp, wanted_cmp
        if operator == "greater than":
            return a > b
        if operator == "greater or equal":
            return a >= b
        if operator == "less than":
            return a < b
        return a <= b

    if operator == "contains":
        return wanted_cmp in cell_cmp
    if operator == "does not contain":
        return wanted_cmp not in cell_cmp
    if operator == "starts with":
        return cell_cmp.startswith(wanted_cmp)
    if operator == "ends with":
        return cell_cmp.endswith(wanted_cmp)

    if operator in ("in list", "not in list"):
        items = _split_list(wanted)
        if not case_sensitive:
            items = [i.lower() for i in items]
        hit = cell_cmp in items
        return hit if operator == "in list" else not hit

    return True


def _row_matches(row, conditions, case_sensitive):
    """Left to right evaluation, the same order the builder shows the conditions in."""
    if not conditions:
        return True
    result = _match(row, conditions[0], case_sensitive)
    for condition in conditions[1:]:
        hit = _match(row, condition, case_sensitive)
        result = (result or hit) if condition["join"] == "OR" else (result and hit)
    return result


def _sql_fragment(condition, case_sensitive):
    column = _quote_ident(condition["column"])
    operator = condition["operator"]
    value = condition["value"]
    collate = "" if case_sensitive else " COLLATE NOCASE"

    if operator == "is empty":
        return f"({column} IS NULL OR {column} = '')"
    if operator == "is not empty":
        return f"({column} IS NOT NULL AND {column} <> '')"
    if operator == "equals":
        return f"{column}{collate} = {_sql_literal(value)}"
    if operator == "not equals":
        return f"{column}{collate} <> {_sql_literal(value)}"
    if operator == "greater than":
        return f"{column} > {_sql_literal(value)}"
    if operator == "greater or equal":
        return f"{column} >= {_sql_literal(value)}"
    if operator == "less than":
        return f"{column} < {_sql_literal(value)}"
    if operator == "less or equal":
        return f"{column} <= {_sql_literal(value)}"
    if operator == "contains":
        return f"{column} LIKE {_sql_like(value, '%{v}%')}"
    if operator == "does not contain":
        return f"{column} NOT LIKE {_sql_like(value, '%{v}%')}"
    if operator == "starts with":
        return f"{column} LIKE {_sql_like(value, '{v}%')}"
    if operator == "ends with":
        return f"{column} LIKE {_sql_like(value, '%{v}')}"
    if operator in ("in list", "not in list"):
        items = ", ".join(_sql_literal(v) for v in _split_list(value))
        keyword = "IN" if operator == "in list" else "NOT IN"
        return f"{column}{collate} {keyword} ({items})"
    return "1=1"


def _build_sql(conditions, case_sensitive):
    """Reference SQL for the built conditions. Values are escaped, so a single quote is safe."""
    if not conditions:
        return ""
    sql = _sql_fragment(conditions[0], case_sensitive)
    for condition in conditions[1:]:
        sql += f" {condition['join']} {_sql_fragment(condition, case_sensitive)}"
    return sql


# --- NOVA_TABLE payload ----------------------------------------------------
def _table_payload(database_path="", table="", columns=None, rows=None):
    """
    The dict shape the rest of the pack expects on a NOVA_TABLE wire:
    Nova Tag Writer reads rows, columns, database_path and table off it.
    """
    return {
        "database_path": str(database_path or ""),
        "table": str(table or ""),
        "columns": [str(c) for c in (columns or [])],
        "rows": list(rows or []),
    }


def _table_rows(table):
    """Reads rows / columns back off an incoming NOVA_TABLE, tolerating a missing column list."""
    if not isinstance(table, dict):
        return None, [], "", ""
    rows = table.get("rows")
    if not isinstance(rows, list):
        return None, [], "", ""
    rows = [r for r in rows if isinstance(r, dict)]
    columns = table.get("columns")
    if not isinstance(columns, list) or not columns:
        columns = list(rows[0].keys()) if rows else []
    return rows, [str(c) for c in columns], str(table.get("database_path", "")), str(table.get("table", ""))


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

    RETURN_TYPES = (ROWS_TYPE, "LIST", "STRING", "INT", "INT", TABLE_TYPE)
    RETURN_NAMES = ("row_data_json", "column_names_list", "column_names_json", "column_count", "row_count", "table")
    OUTPUT_TOOLTIPS = (
        "Rows for the Data Table, Row Iterator and Single Row nodes.",
        "The selected column names.",
        "The selected column names as JSON.",
        "How many columns are selected.",
        "How many rows the table holds.",
        "The same rows as a NOVA_TABLE, for Nova Tag Writer and the other pack nodes.",
    )
    FUNCTION = "execute_query"
    CATEGORY = DELIVERY

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # Table list is dynamic (depends on the chosen DB), so skip default combo validation.
        return True

    def execute_query(self, database_path, table_name, selected_columns=""):
        empty = ("[]", [], "[]", 0, 0, _table_payload())

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
                    return done((json.dumps(rows), [], "[]", 0, count, _table_payload(path, table, [], rows)),
                                f"{count} rows · 0 columns selected - select at least one column")

                cur = conn.execute(f"SELECT {', '.join(_quote_ident(c) for c in valid)} FROM {q_table}")
                rows = [{c: _jsonable(v) for c, v in zip(valid, r)} for r in cur.fetchall()]
        except sqlite3.Error as e:
            return done(empty, f"SQLite error: {e}")

        status = f"{len(rows)} rows · {len(valid)} columns"
        if missing:
            status += f" (ignored missing: {', '.join(missing)})"
        return done(
            (json.dumps(rows, ensure_ascii=False), valid, json.dumps(valid, ensure_ascii=False),
             len(valid), len(rows), _table_payload(path, table, valid, rows)),
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
                "row_data_json": (ROWS_TYPE, {}),
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
                "row_data_json": (ROWS_TYPE, {}),
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
# Node 4: Data table with a visual condition builder
# ---------------------------------------------------------------------------
class NovaSQLiteWhereFilterNode:
    """
    Shows every row in a grid and narrows it down with conditions built in the UI.
    Filtering happens in Python over the incoming rows, so no user text ever reaches SQL.
    The matching SQL is still produced (safely escaped) on the where_clause output.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Hidden in the UI, driven by the condition builder (JSON list of conditions)
                "where_json": ("STRING", {"default": "[]", "multiline": False}),
                # Hidden in the UI, driven by clicking rows in the grid (JSON list of source row numbers)
                "selected_rows": ("STRING", {"default": "[]", "multiline": False}),
                "output_rows": (OUTPUT_MODES, {"default": OUTPUT_MODES[0],
                                               "tooltip": "Which rows leave this node: everything the conditions match, "
                                                          "or only the rows highlighted in the grid."}),
                "case_sensitive": ("BOOLEAN", {"default": False,
                                               "tooltip": "Off: text is matched regardless of upper / lower case"}),
                "max_display_rows": ("INT", {"default": 200, "min": 1, "max": 10000, "step": 10,
                                             "tooltip": "How many rows the table shows. All matching rows are still passed on."}),
            },
            # Connect either one. Both connected: row_data_json wins and the table only
            # supplies the database / table names for the NOVA_TABLE output.
            "optional": {
                "row_data_json": (ROWS_TYPE, {"tooltip": "Rows from the Nova Dynamic SQLite Browser."}),
                "table": (TABLE_TYPE, {"tooltip": "A NOVA_TABLE from any pack node, so its rows can be filtered too."}),
            },
        }

    RETURN_TYPES = (ROWS_TYPE, "STRING", "INT", "INT", "STRING", TABLE_TYPE, "INT")
    RETURN_NAMES = ("row_data_json", "rows_json", "matched_rows", "total_rows", "where_clause", "table", "selected_rows")
    OUTPUT_TOOLTIPS = (
        "The rows leaving this node, for the Row Iterator and Single Row nodes.",
        "The same rows as plain text.",
        "How many rows the conditions matched.",
        "How many rows came in.",
        "The same conditions as SQL, safely escaped.",
        "The same rows as a NOVA_TABLE, for Nova Tag Writer and the other pack nodes.",
        "How many rows are highlighted in the grid.",
    )
    FUNCTION = "filter_rows"
    CATEGORY = DELIVERY
    OUTPUT_NODE = True

    @staticmethod
    def _ui(**kw):
        # Every value must be a list, the same as the other nodes.
        base = {"error": "", "warning": "", "columns": [], "rows": [], "row_ids": [], "matched_rows": 0,
                "total_rows": 0, "shown_rows": 0, "condition_count": 0, "where_clause": "",
                "selected_count": 0, "output_mode": OUTPUT_MODES[0]}
        base.update(kw)
        return {k: [v] for k, v in base.items()}

    def _fail(self, msg, total=0):
        print(f"{LOG} Where filter error: {msg}")
        return {
            "ui": self._ui(error=msg, total_rows=total),
            "result": ("[]", "[]", 0, total, "", _table_payload(), 0),
        }

    def filter_rows(self, where_json="[]", selected_rows="[]", output_rows=OUTPUT_MODES[0],
                    case_sensitive=False, max_display_rows=200, row_data_json=None, table=None):
        # The NOVA_TABLE input carries the database / table names for the table output,
        # and is also used as the row source when nothing is wired to row_data_json.
        table_rows, table_columns, db_path, table_name = _table_rows(table)

        if row_data_json is None or row_data_json == "":
            if table_rows is None:
                return self._fail("Nothing connected: wire the SQLite Browser to row_data_json, or a NOVA_TABLE to table")
            data = table_rows
        else:
            try:
                data = json.loads(row_data_json) if isinstance(row_data_json, str) else row_data_json
            except (json.JSONDecodeError, TypeError):
                return self._fail("row_data_json is not valid JSON")
        if not isinstance(data, list):
            return self._fail("Invalid data: expected a JSON list of rows")

        total = len(data)
        if total == 0:
            return self._fail("No rows: the table is empty or the query failed (check the browser node)")

        # Rows are tagged with their position in the incoming data. The grid stores the
        # selection by that number, so highlighting survives a change of conditions.
        rows = [(i, r) for i, r in enumerate(data) if isinstance(r, dict)]
        if not rows:
            return self._fail("Invalid data: the rows are not objects", total)

        columns = list(rows[0][1].keys()) or table_columns
        if not columns:
            return self._fail("0 columns selected: select at least one column badge on the SQLite Browser", total)

        try:
            max_display_rows = max(1, min(10000, int(max_display_rows)))
        except (TypeError, ValueError):
            max_display_rows = 200
        case_sensitive = bool(case_sensitive)

        if output_rows not in OUTPUT_MODES:
            output_rows = OUTPUT_MODES[0]

        conditions, problems = _parse_conditions(where_json, columns)

        try:
            matched = [(i, r) for i, r in rows if _row_matches(r, conditions, case_sensitive)]
        except (TypeError, ValueError) as e:
            return self._fail(f"A condition could not be applied: {e}", total)

        where_clause = _build_sql(conditions, case_sensitive)
        warning = "; ".join(problems)
        if not matched and conditions:
            warning = (warning + "; " if warning else "") + "No rows match the current conditions"

        # Highlighted rows, kept in the order they appear in the grid
        wanted = _parse_selection(selected_rows)
        selected = [(i, r) for i, r in matched if i in wanted]

        if output_rows == OUTPUT_MODES[1]:
            out_pairs = selected
            if not selected:
                warning = (warning + "; " if warning else "") + \
                    "Output is set to 'selected rows' but nothing is highlighted - click rows in the grid"
        else:
            out_pairs = matched
        out_rows = [r for _, r in out_pairs]

        shown = matched[:max_display_rows]
        if len(matched) > len(shown):
            warning = (warning + "; " if warning else "") + f"Showing the first {len(shown)} of {len(matched)} matching rows"

        print(f"{LOG} Where filter: {len(matched)}/{total} rows match {len(conditions)} condition(s), "
              f"{len(selected)} selected, {len(out_rows)} out ({output_rows})"
              + (f" -> {where_clause}" if where_clause else ""))

        return {
            "ui": self._ui(
                warning=warning,
                columns=columns,
                rows=[r for _, r in shown],
                row_ids=[i for i, _ in shown],
                matched_rows=len(matched),
                total_rows=total,
                shown_rows=len(shown),
                condition_count=len(conditions),
                where_clause=where_clause,
                selected_count=len(selected),
                output_mode=output_rows,
            ),
            "result": (
                json.dumps(out_rows, ensure_ascii=False),
                json.dumps(out_rows, ensure_ascii=False),
                len(matched),
                total,
                where_clause,
                _table_payload(db_path, table_name, columns, out_rows),
                len(selected),
            ),
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


# ---------------------------------------------------------------------------
# Preview routes - "Execute" on a node's toolbar
#
# These call the node functions directly rather than re-implementing the queries,
# so what the toolbar shows is what a real run would produce. Nothing is queued:
# no prompt is submitted and no workflow executes.
# ---------------------------------------------------------------------------
def _ui_raw(out):
    """
    The UI payload exactly as an execution would send it, list wrappers and all.
    Unwrapping here would break the browser: several values (rows, columns) are
    themselves lists, and the JS unwraps once more - turning a list of rows into
    its first row.
    """
    return (out or {}).get("ui") or {}


def _ui_value(ui, key, default=""):
    """One unwrapped value, for decisions made on this side."""
    value = ui.get(key)
    if isinstance(value, list):
        return value[0] if value else default
    return default if value is None else value


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return {}


def _rows_arg(body, key="rows_json"):
    """Accepts either a JSON string or an already-decoded list of rows."""
    value = body.get(key)
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    return str(value or "[]")


@PromptServer.instance.routes.post("/sqlite_browser/list_databases")
async def list_databases(request):
    try:
        files = _list_db_files()
        return web.json_response({"databases": files, "input_dir": folder_paths.get_input_directory()})
    except Exception as e:
        print(f"{LOG} list_databases error: {e}")
        return web.json_response({"error": str(e), "databases": []})


@PromptServer.instance.routes.post("/sqlite_browser/preview/browser")
async def preview_browser(request):
    body = await _body(request)
    try:
        out = NovaSQLiteBrowserNode().execute_query(
            body.get("database_path", ""),
            body.get("table_name", ""),
            body.get("selected_columns", ""),
        )
    except Exception as e:
        print(f"{LOG} Browser preview failed: {e}")
        return web.json_response({"ok": False, "error": str(e)})

    result = out["result"]
    status = _ui_value(_ui_raw(out), "status")
    failed = result[4] == 0 and ("error" in status.lower() or "not found" in status.lower()
                                or status.startswith("No "))
    return web.json_response({
        "ok": not failed,
        "status": status,
        "rows_json": result[0],
        "columns": result[1],
        "column_count": result[3],
        "row_count": result[4],
    })


@PromptServer.instance.routes.post("/sqlite_browser/preview/filter")
async def preview_filter(request):
    body = await _body(request)
    try:
        out = NovaSQLiteWhereFilterNode().filter_rows(
            where_json=str(body.get("where_json", "[]")),
            selected_rows=str(body.get("selected_rows", "[]")),
            output_rows=body.get("output_rows", OUTPUT_MODES[0]),
            case_sensitive=bool(body.get("case_sensitive", False)),
            max_display_rows=body.get("max_display_rows", 200),
            row_data_json=_rows_arg(body),
            table=body.get("table"),
        )
    except Exception as e:
        print(f"{LOG} Filter preview failed: {e}")
        return web.json_response({"ok": False, "error": str(e)})

    ui = _ui_raw(out)
    return web.json_response({
        "ok": not _ui_value(ui, "error"),
        "ui": ui,
        "rows_json": out["result"][0],      # what this node passes downstream
    })


@PromptServer.instance.routes.post("/sqlite_browser/preview/row")
async def preview_row(request):
    body = await _body(request)
    rows = _rows_arg(body)
    mode = str(body.get("mode", "single"))
    try:
        if mode == "iterator":
            out = NovaSQLiteRowIteratorNode().process_row(
                rows,
                body.get("row_index", 0),
                body.get("stop_at_row", -1),
                body.get("loop_mode", LOOP_MODES[0]),
                auto_loop=False,            # a preview never queues the next row
            )
        else:
            out = NovaSQLiteSingleRowNode().isolate_single_row(rows, body.get("row_index", 0))
    except Exception as e:
        print(f"{LOG} Row preview failed: {e}")
        return web.json_response({"ok": False, "error": str(e)})

    ui = _ui_raw(out)
    return web.json_response({"ok": not _ui_value(ui, "error"), "ui": ui})


# ---------------------------------------------------------------------------
# Theme storage - the colour picker on the node toolbars
#
# Kept in ComfyUI's user directory rather than beside this file, so updating the
# node pack does not wipe the chosen colours.
# ---------------------------------------------------------------------------
THEME_DEFAULTS = {
    "accent": "#ff94c2",
    "panel": "#1e1e24",
    "console": "#131316",
    "font": '-apple-system, "Segoe UI", sans-serif',
    "size": 11,
}
# Must match FONT_CHOICES in nova_sqlite_browser.js. Only these stacks are stored,
# because the value ends up inside a stylesheet.
FONT_CHOICES = [
    '-apple-system, "Segoe UI", sans-serif',
    'ui-monospace, "Cascadia Code", "Fira Code", monospace',
    '"Noto Sans", "Segoe UI", Roboto, sans-serif',
    '"Roboto Condensed", "Segoe UI", sans-serif',
]
_HEX = ("#", 4, 9)      # "#rgb" through "#rrggbbaa"


def _theme_path():
    for getter in ("get_user_directory", "get_output_directory", "get_input_directory"):
        try:
            base = getattr(folder_paths, getter)()
            if base and os.path.isdir(base):
                return os.path.join(base, "nova_sqlite_theme.json")
        except Exception:
            continue
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova_sqlite_theme.json")


def _clean_colour(value, fallback):
    """Only plain hex colours are stored - this value is written straight into CSS."""
    text = str(value or "").strip()
    if (text.startswith(_HEX[0]) and _HEX[1] <= len(text) <= _HEX[2]
            and all(c in "0123456789abcdefABCDEF" for c in text[1:])):
        return text
    return fallback


def _clean_theme(raw):
    raw = raw if isinstance(raw, dict) else {}
    theme = dict(THEME_DEFAULTS)
    for key in ("accent", "panel", "console"):
        theme[key] = _clean_colour(raw.get(key), THEME_DEFAULTS[key])
    font = str(raw.get("font", "") or "")
    theme["font"] = font if font in FONT_CHOICES else THEME_DEFAULTS["font"]
    try:
        theme["size"] = max(9, min(16, int(raw.get("size", THEME_DEFAULTS["size"]))))
    except (TypeError, ValueError):
        theme["size"] = THEME_DEFAULTS["size"]
    return theme


def _read_theme():
    path = _theme_path()
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                return _clean_theme(json.load(fh))
    except (OSError, json.JSONDecodeError) as e:
        print(f"{LOG} Could not read the saved theme ({e}); using the defaults")
    return dict(THEME_DEFAULTS)


@PromptServer.instance.routes.get("/sqlite_browser/theme")
async def get_theme(request):
    return web.json_response({"theme": _read_theme()})


@PromptServer.instance.routes.post("/sqlite_browser/theme")
async def set_theme(request):
    theme = _clean_theme(await _body(request))
    path = _theme_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(theme, fh, indent=2)
    except OSError as e:
        print(f"{LOG} Could not save the theme: {e}")
        return web.json_response({"ok": False, "error": str(e), "theme": theme})
    print(f"{LOG} Theme saved to {path}")
    return web.json_response({"ok": True, "theme": theme})


NODE_CLASS_MAPPINGS = {
    "NovaSQLiteBrowserNode": NovaSQLiteBrowserNode,
    "NovaSQLiteSingleRowNode": NovaSQLiteSingleRowNode,
    "NovaSQLiteRowIteratorNode": NovaSQLiteRowIteratorNode,
    "NovaSQLiteWhereFilterNode": NovaSQLiteWhereFilterNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaSQLiteBrowserNode": "Nova Dynamic SQLite Browser 📁",
    "NovaSQLiteSingleRowNode": "Nova SQLite Single Row Filter 🔍",
    "NovaSQLiteRowIteratorNode": "Nova SQLite Row Iterator & Splitter 📦",
    "NovaSQLiteWhereFilterNode": "Nova SQLite Data Table & Filter 🔎",
}
