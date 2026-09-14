"""
nova_sqlite_reader.py — read a table out of an existing SQLite database.

Feeds NOVA_TABLE into Nova Tag Writer. Identifiers (table, columns) are
validated against the live schema and quoted rather than interpolated, and the
connection is opened read-only, so a typo in the WHERE box cannot modify the
database. The WHERE text is raw SQL by design — you asked for AND/OR and the
rest of the operators — but it is screened for statement separators and for
anything that writes.
"""

import os
import re
import sqlite3
from typing import Any, Dict, List, Tuple

try:
    from .nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, TABLE_TYPE, empty_table, make_table,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, TABLE_TYPE, empty_table, make_table,
    )

# Statements that must never appear in a WHERE clause. Checked as whole words
# so a column called "Updated" or a value like 'dropped' stays legal.
_FORBIDDEN = (
    "attach", "detach", "alter", "create", "delete", "drop", "insert",
    "pragma", "reindex", "replace", "update", "vacuum", "commit", "rollback",
)
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_ .\-]*$")


def _quote(identifier: str) -> str:
    return '"' + str(identifier).replace('"', '""') + '"'


def _check_where(where: str) -> str:
    clause = (where or "").strip().rstrip(";").strip()
    if not clause:
        return ""
    if ";" in clause:
        raise ValueError(
            "Nova SQLite Reader: the where field may contain only one expression "
            "(no ';')."
        )
    lowered = clause.lower()
    for word in _FORBIDDEN:
        if re.search(rf"(?<![A-Za-z0-9_]){word}(?![A-Za-z0-9_])", lowered):
            raise ValueError(
                f"Nova SQLite Reader: '{word}' is not allowed in the where field — "
                "this node only reads."
            )
    if re.match(r"^\s*where\b", lowered):        # tolerate a pasted "WHERE ..."
        clause = clause[clause.lower().index("where") + 5:].strip()
    return clause


def _resolve_database(database_path: str, new_folder: str, new_name: str) -> Tuple[str, bool]:
    """Return (path, created_new)."""
    selected = (database_path or "").strip().strip('"').strip("'")
    if selected:
        path = os.path.abspath(os.path.expanduser(os.path.expandvars(selected)))
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"Nova SQLite Reader: no database at {path}. Clear the "
                "database_path field to create a new one from new_database_folder "
                "+ new_database_name instead."
            )
        return path, False

    folder = (new_folder or "").strip().strip('"').strip("'")
    name = (new_name or "").strip().strip('"').strip("'")
    if not folder or not name:
        raise ValueError(
            "Nova SQLite Reader: set database_path to an existing .db file, or fill "
            "in both new_database_folder and new_database_name to create one."
        )
    if not os.path.splitext(name)[1]:
        name += ".db"
    folder = os.path.abspath(os.path.expanduser(os.path.expandvars(folder)))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    created = not os.path.exists(path)
    connection = sqlite3.connect(path)     # creates the file if absent
    connection.close()
    return path, created


def _read_only(path: str) -> sqlite3.Connection:
    uri = "file:" + path.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _coerce(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return bytes(value).decode("utf-8")
        except Exception:
            return f"<{len(bytes(value))} bytes>"
    return str(value)


class NovaSQLiteReader:
    CATEGORY = AUTHORING_CATEGORY
    FUNCTION = "read"
    RETURN_TYPES = (TABLE_TYPE, "INT", "INT", "STRING")
    RETURN_NAMES = ("table", "record_count", "column_count", "column_headers")
    OUTPUT_IS_LIST = (False, False, False, True)
    OUTPUT_TOOLTIPS = (
        "The selected rows, for Nova Tag Writer.",
        "Number of rows returned.",
        "Number of columns returned.",
        "Column names, as a list output (one string per column).",
    )
    DESCRIPTION = (
        f"Nova SQLite Reader v{AUTHORING_VERSION} — opens an existing SQLite file "
        "read-only and returns every column of the chosen table, optionally "
        "filtered by a WHERE expression."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "database_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "/home/novaf/Databases/NovaAudioMastering_test.db",
                    "tooltip": "Full path to an existing .db file. Leave empty to create a new one below.",
                }),
                "table_name": ("STRING", {
                    "default": "albums",
                    "multiline": False,
                    "tooltip": "Table to read from.",
                }),
                "columns": ("STRING", {
                    "default": "*",
                    "multiline": False,
                    "tooltip": "* for every column, or a comma-separated list of column names.",
                }),
                "where": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "Artist = 'crazy gecko' AND Genre LIKE '%Metal%'",
                    "tooltip": "Empty selects all rows. Read-only SQL expression; AND/OR/LIKE/IN/BETWEEN etc. are all fine.",
                }),
                "new_database_folder": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Only used when database_path is empty",
                    "tooltip": "Folder for a new database, used only when database_path is empty.",
                }),
                "new_database_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "NovaAudioMastering.db",
                    "tooltip": "File name for the new database. '.db' is appended when no extension is given.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, database_path, table_name, columns, where,
                   new_database_folder, new_database_name, **kwargs):
        # Re-run whenever the file changes on disk, not just when a widget moves.
        try:
            path = (database_path or "").strip()
            stat = os.stat(path)
            stamp = f"{path}|{stat.st_size}|{stat.st_mtime_ns}"
        except Exception:
            stamp = f"unresolved|{database_path}|{new_database_folder}|{new_database_name}"
        return f"{stamp}|{table_name}|{columns}|{where}"

    def read(self, database_path, table_name, columns, where,
             new_database_folder, new_database_name, **kwargs):
        path, created = _resolve_database(database_path, new_database_folder, new_database_name)
        table = (table_name or "").strip()
        clause = _check_where(where)

        if created or not table:
            note = (
                f"Created a new, empty database at {path}."
                if created else
                "No table_name given."
            )
            print(f"[Nova SQLite Reader] {note}")
            return (empty_table(path, table, note), 0, 0, [])

        if not _IDENTIFIER.match(table):
            raise ValueError(f"Nova SQLite Reader: '{table}' is not a valid table name.")

        connection = _read_only(path)
        try:
            known = [r[0] for r in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')")]
            if table not in known:
                raise ValueError(
                    f"Nova SQLite Reader: table '{table}' is not in {os.path.basename(path)}. "
                    f"Available: {', '.join(known) if known else '(none)'}"
                )

            available = [r[1] for r in connection.execute(f"PRAGMA table_info({_quote(table)})")]
            requested = (columns or "*").strip()
            if requested in ("", "*"):
                selected = list(available)
            else:
                selected = [c.strip() for c in requested.split(",") if c.strip()]
                lookup = {c.lower(): c for c in available}
                missing = [c for c in selected if c.lower() not in lookup]
                if missing:
                    raise ValueError(
                        f"Nova SQLite Reader: column(s) {', '.join(missing)} not in "
                        f"'{table}'. Available: {', '.join(available)}"
                    )
                selected = [lookup[c.lower()] for c in selected]   # honour real casing

            projection = ", ".join(_quote(c) for c in selected)
            sql = f"SELECT {projection} FROM {_quote(table)}"
            if clause:
                sql += f" WHERE {clause}"

            try:
                cursor = connection.execute(sql)
            except sqlite3.Error as exc:
                raise ValueError(
                    f"Nova SQLite Reader: SQLite rejected the query — {exc}\n  {sql}"
                ) from exc

            rows: List[Dict[str, Any]] = [
                {key: _coerce(row[key]) for key in selected} for row in cursor
            ]
        finally:
            connection.close()

        payload = make_table(path, table, selected, rows, sql=sql, where=clause)
        print(
            f"[Nova SQLite Reader] {os.path.basename(path)} :: {table} -> "
            f"{len(rows)} row(s) x {len(selected)} column(s)"
            + (f" WHERE {clause}" if clause else "")
        )
        return (payload, len(rows), len(selected), list(selected))


NODE_CLASS_MAPPINGS = {"NovaSQLiteReader": NovaSQLiteReader}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaSQLiteReader": "Nova SQLite Reader 🗃️"}
