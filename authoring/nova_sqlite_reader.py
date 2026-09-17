"""
nova_sqlite_reader.py — read a table out of an existing SQLite database.

Feeds NOVA_TABLE into Nova Tag Writer. Identifiers (table, columns) are
validated against the live schema and quoted rather than interpolated, and the
connection is opened read-only, so a typo in the WHERE box cannot modify the
database. The WHERE text is raw SQL by design — you asked for AND/OR and the
rest of the operators — but it is screened for statement separators and for
anything that writes.
"""

import json
import os
import re
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

try:
    from .nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, TABLE_TYPE, empty_table, make_table,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, TABLE_TYPE, empty_table, make_table,
    )

def _norm(name: str) -> str:
    """Column names differ only in punctuation and case between databases."""
    return re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


# Columns each preset asks for. Intersected with the table's real columns, so
# a preset never fails on a database that happens not to carry one of them.
COLUMN_SETS: Dict[str, Tuple[str, ...]] = {
    "tags": (
        "FileName", "Title", "Artist", "Album Artist", "Album", "Track Number",
        "Disc Number", "Date", "Year", "Genre", "Comment", "Copyright",
        "EncodedBy", "Encoded By", "Composer", "Publisher", "Lyrics", "BPM", "ISRC",
    ),
    "identity": (
        "Title", "Artist", "Album", "Track Number", "Version", "Date", "Year",
        "ISRC", "Catalog Number", "CatalogNumber", "UPC", "EAN", "UPC_EAN",
        "Publisher", "Label", "Composer", "Producer", "Mix Engineer",
        "Mastering Engineer", "Copyright", "Comment", "Work ID", "ISWC",
        "Project", "Territory", "Language", "Explicit", "Client Reference",
        # a table built for this node can simply use the node's own field names
        "artist_name", "track_title", "artist_initials", "track_number", "version",
        "album_title", "catalog_number", "isrc", "publisher", "label",
        "mastering_engineer", "mastering_company", "copyright_owner",
        "release_year", "composer", "producer", "mix_engineer", "project_name",
        "territory", "language", "explicit_flag", "upc_ean", "work_id",
        "client_reference", "notes", "target_bit_depth", "target_sample_rate",
    ),
}

# Which Nova Master Identity widget each database column feeds. Keys are
# normalised column names; several spellings map to one field on purpose.
_IDENTITY_MAP: Dict[str, str] = {}
for _field, _columns in {
    "track_title": ("Title", "Track Title", "Song", "Song Title", "track_title"),
    "artist_name": ("Artist", "Artist Name", "Album Artist", "Performer", "artist_name"),
    "artist_initials": ("Artist Initials", "Initials", "artist_initials"),
    "album_title": ("Album", "Album Title", "album_title"),
    "track_number": ("Track Number", "Track", "TrackNo", "track_number"),
    "version": ("Version", "Mix", "Mix Version", "version"),
    "isrc": ("ISRC", "isrc"),
    "catalog_number": ("Catalog Number", "CatalogNumber", "Catalogue Number",
                       "Cat No", "catalog_number"),
    "upc_ean": ("UPC", "EAN", "UPC_EAN", "Barcode", "upc_ean"),
    "work_id": ("Work ID", "ISWC", "work_id"),
    "publisher": ("Publisher", "publisher"),
    "label": ("Label", "Record Label", "label"),
    "composer": ("Composer", "Writer", "composer"),
    "producer": ("Producer", "producer"),
    "mix_engineer": ("Mix Engineer", "mix_engineer"),
    "mastering_engineer": ("Mastering Engineer", "mastering_engineer"),
    "mastering_company": ("Mastering Company", "mastering_company"),
    "copyright_owner": ("Copyright", "Copyright Owner", "copyright_owner"),
    "release_year": ("Year", "Date", "Release Year", "release_year"),
    "project_name": ("Project", "Project Name", "project_name"),
    "territory": ("Territory", "territory"),
    "language": ("Language", "language"),
    "explicit_flag": ("Explicit", "explicit_flag"),
    "client_reference": ("Client Reference", "client_reference"),
    "notes": ("Comment", "Notes", "Description", "notes"),
    "target_bit_depth": ("Bit Depth", "target_bit_depth"),
    "target_sample_rate": ("Sample Rate", "target_sample_rate"),
}.items():
    for _column in _columns:
        _IDENTITY_MAP.setdefault(_norm(_column), _field)

_INT_FIELDS = ("track_number", "release_year")
_TRUE_WORDS = {"1", "true", "yes", "y", "on", "explicit"}

# A column named exactly like an Identity field is a deliberate statement and
# outranks a tag column that merely maps onto the same field. A table can
# legitimately carry both: Copyright holds the full notice a player displays
# while copyright_owner holds just the owner, and Comment holds the public
# blurb while notes holds the mastering note.
_CANONICAL_FIELDS = {_norm(f): f for f in set(_IDENTITY_MAP.values())}

# Combo widgets accept only these values, so a database string is reduced to
# its digits and checked rather than passed through ("24-bit" -> "24").
_CHOICE_FIELDS = {
    "target_bit_depth": ("24", "16"),
    "target_sample_rate": ("48000", "44100", "96000"),
}


def _as_int(value: Any, field: str) -> Optional[int]:
    """Pull an integer out of a tag value: '5/12' -> 5, '2026-09-11' -> 2026."""
    text = str(value).strip()
    if field == "release_year":
        match = re.search(r"(1[89]\d{2}|2[01]\d{2})", text)
        return int(match.group(1)) if match else None
    match = re.match(r"\s*(\d+)", text)
    return int(match.group(1)) if match else None


def identity_fields_from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map one database row onto Nova Master Identity's field names.

    Only non-empty values are emitted, so a blank cell never clears a value
    that is already set on the Identity node. A column the map does not
    recognise is ignored rather than guessed at.
    """
    fields: Dict[str, Any] = {}

    def take(column: str, value: Any, authoritative: bool) -> None:
        field = _CANONICAL_FIELDS.get(_norm(column)) if authoritative \
            else _IDENTITY_MAP.get(_norm(column))
        if not field or value is None:
            return
        if not authoritative and field in fields:
            return                      # an exact column already spoke for this
        text = str(value).strip()
        if not text:
            return
        if field in _INT_FIELDS:
            number = _as_int(text, field)
            if number is not None:
                fields[field] = number
        elif field == "explicit_flag":
            fields[field] = text.lower() in _TRUE_WORDS
        elif field in _CHOICE_FIELDS:
            digits = re.sub(r"[^0-9]", "", text)
            if digits in _CHOICE_FIELDS[field]:
                fields[field] = digits
        else:
            fields[field] = text

    # Pass one: columns named exactly like an Identity field.
    for column, value in row.items():
        take(column, value, authoritative=True)
    # Pass two: tag columns fill only what pass one left empty.
    for column, value in row.items():
        take(column, value, authoritative=False)
    return fields


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
    RETURN_TYPES = (TABLE_TYPE, "INT", "INT", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("table", "record_count", "column_count", "column_headers", "identity_json", "value")
    OUTPUT_IS_LIST = (False, False, False, True, False, False)
    OUTPUT_TOOLTIPS = (
        "The selected rows, for Nova Tag Writer.",
        "Number of rows returned.",
        "Number of columns returned.",
        "Column names, as a list output (one string per column).",
        "The single selected row mapped onto Nova Master Identity's field names. "
        "Wire it into that node's identity_fields_json input.",
        "One cell as plain text, for a STRING input such as Nova Lyric Score's "
        "reference_lyrics. Set value_column to switch it on.",
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
                    "placeholder": "~/Databases/NovaAudioMastering_test.db",
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
            "optional": {
                "value_column": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Lyrics",
                    "tooltip": (
                        "Name one column to also return as plain text on the 'value' "
                        "output - lyrics, a comment, a path. Empty leaves that output "
                        "empty and changes nothing. When set, the query must select "
                        "exactly one row, and the column must be among the columns "
                        "selected (it always is when columns is '*')."
                    ),
                }),
                "column_set": (["custom", "tags", "identity"], {
                    "default": "custom",
                    "tooltip": (
                        "Preset column selection.\n"
                        "custom: use the columns field as typed.\n"
                        "tags: the columns Nova Tag Writer writes.\n"
                        "identity: the columns that map onto Nova Master Identity.\n"
                        "A preset only applies while columns is '*' or empty - type a "
                        "column list and that always wins. Columns a preset asks for "
                        "that the table does not have are skipped, not an error."
                    ),
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, database_path, table_name, columns, where,
                   new_database_folder, new_database_name, column_set="custom",
                   value_column="", **kwargs):
        # Re-run whenever the file changes on disk, not just when a widget moves.
        try:
            path = (database_path or "").strip()
            stat = os.stat(path)
            stamp = f"{path}|{stat.st_size}|{stat.st_mtime_ns}"
        except Exception:
            stamp = f"unresolved|{database_path}|{new_database_folder}|{new_database_name}"
        return f"{stamp}|{table_name}|{columns}|{where}|{column_set}|{value_column}"

    def read(self, database_path, table_name, columns, where,
             new_database_folder, new_database_name, column_set="custom",
             value_column="", **kwargs):
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
            return (empty_table(path, table, note), 0, 0, [], "{}", "")

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
            preset = str(column_set or "custom").strip().lower()
            if requested in ("", "*") and preset in COLUMN_SETS:
                # A preset names what it would like; the table decides what exists.
                #
                # Exact spelling is tried before the normalised match, because a
                # table can carry both families at once: "Track Number" for the
                # tag and "track_number" for the Identity field normalise to the
                # same key, and picking the wrong one writes a tag called
                # "track_number" or feeds Identity a tag column.
                by_exact = {c: c for c in available}
                by_norm = {}
                for c in available:
                    by_norm.setdefault(_norm(c), c)
                selected, seen = [], set()
                for wanted in COLUMN_SETS[preset]:
                    real = by_exact.get(wanted) or by_norm.get(_norm(wanted))
                    if real and real not in seen:
                        selected.append(real)
                        seen.add(real)
                if not selected:
                    raise ValueError(
                        f"Nova SQLite Reader: the '{preset}' column set matches no column "
                        f"in '{table}'. Available: {', '.join(available)}"
                    )
            elif requested in ("", "*"):
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

        identity_json = self._identity_json(rows, preset, table, clause)
        value = self._single_value(rows, selected, value_column, table, clause)

        payload = make_table(path, table, selected, rows, sql=sql, where=clause)
        print(
            f"[Nova SQLite Reader] {os.path.basename(path)} :: {table} -> "
            f"{len(rows)} row(s) x {len(selected)} column(s)"
            + (f" WHERE {clause}" if clause else "")
        )
        return (payload, len(rows), len(selected), list(selected), identity_json, value)

    @staticmethod
    def _single_value(rows: List[Dict[str, Any]], selected: List[str],
                      value_column: str, table: str, clause: str) -> str:
        """Return one cell as plain text, for wiring into a STRING input.

        Opt-in: an empty value_column returns an empty string and changes
        nothing, so every existing graph behaves exactly as before. Once a
        column is named the query must resolve to a single row, because a
        silent "first of several" is how the wrong lyrics end up scored
        against the wrong song.
        """
        wanted = str(value_column or "").strip()
        if not wanted:
            return ""

        lookup = {_norm(c): c for c in selected}
        real = next((c for c in selected if c == wanted), None) or lookup.get(_norm(wanted))
        if not real:
            raise ValueError(
                f"Nova SQLite Reader: value_column '{wanted}' is not among the columns "
                f"selected from '{table}'.\nSelected: {', '.join(selected)}\n"
                "Add it to the columns field, or set columns to '*'."
            )
        if len(rows) != 1:
            raise ValueError(
                f"Nova SQLite Reader: value_column '{real}' needs the query to select "
                f"exactly one row, but {len(rows)} matched in '{table}'"
                + (f" WHERE {clause}" if clause else " (no WHERE clause)")
                + ".\nNarrow the where field, for example:\n"
                "Album = 'High Water Sessions' AND Title = 'Nine Hours North'"
            )

        cell = rows[0].get(real)
        text = "" if cell is None else str(cell)
        print(f"[Nova SQLite Reader] value <- {real} ({len(text)} chars)")
        return text

    @staticmethod
    def _identity_json(rows: List[Dict[str, Any]], preset: str, table: str, clause: str) -> str:
        """Map the selected row onto Nova Master Identity's field names.

        Identity describes one recording, so the identity preset insists on a
        query that returns exactly one row. Silently taking the first of several
        is how the wrong song ends up carrying a catalogue number, and that is
        the mistake this whole chain exists to prevent.
        """
        if preset != "identity":
            return "{}"
        if len(rows) != 1:
            titles = []
            for row in rows[:12]:
                label = next((str(v) for k, v in row.items()
                              if _norm(k) in ("title", "tracktitle") and v), None)
                titles.append(f"  {label or list(row.values())[:1]}")
            raise ValueError(
                f"Nova SQLite Reader: the 'identity' column set needs the query to "
                f"select exactly one track, but {len(rows)} row(s) matched in "
                f"'{table}'"
                + (f" WHERE {clause}" if clause else " (no WHERE clause)")
                + ".\nNarrow the where field, for example: Title = 'Nine Hours North'"
                + ("\nMatched:\n" + "\n".join(titles) if titles else "")
            )
        fields = identity_fields_from_row(rows[0])
        if not fields:
            raise ValueError(
                "Nova SQLite Reader: none of the selected columns map onto a Nova "
                "Master Identity field. Recognised names include Title, Artist, "
                "Album, Track Number, Date, ISRC, Catalog Number, Publisher, Label, "
                "Composer, Producer, Copyright and Comment."
            )
        print("[Nova SQLite Reader] identity -> "
              + ", ".join(f"{k}={v!r}" for k, v in sorted(fields.items())))
        return json.dumps(fields, indent=2, ensure_ascii=False, allow_nan=False)


NODE_CLASS_MAPPINGS = {"NovaSQLiteReader": NovaSQLiteReader}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaSQLiteReader": "Nova SQLite Reader 🗃️"}
