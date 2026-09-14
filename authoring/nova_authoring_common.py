"""
nova_authoring_common.py — shared vocabulary for the ▶️ Nova Audio/Authoring nodes.

Two custom link types travel between these nodes:

  NOVA_TABLE   a table read out of SQLite
               {"source", "database_path", "table", "columns", "rows",
                "record_count", "column_count", "sql", "where"}
               `rows` is a list of {column: value} dicts, values already
               coerced to str/int/float/None (never sqlite3.Row objects, so
               the payload stays JSON-serialisable and picklable).

  NOVA_FILES   an ordered batch of audio files on disk
               {"root", "count", "decoded", "files"}
               each entry: {"path", "name", "stem", "extension",
                            "size_bytes", "modified_utc", ...optional probe}

Both are plain dicts on purpose: ComfyUI caches node outputs between runs and
anything exotic (open handles, tensors it does not understand) makes that
caching unreliable.
"""

import os
from datetime import datetime, timezone
from typing import Any, Dict, List

try:
    from ..nova_categories import DELIVERY, UTILITY_IO
except ImportError:  # direct execution / test harness
    from nova_categories import DELIVERY, UTILITY_IO

# The authoring group was one menu; it is now split between two of the pack's
# five groups. Both names are exported so each node picks the one it belongs in.
UTILITY_CATEGORY = UTILITY_IO
DELIVERY_CATEGORY = DELIVERY

# Kept so anything still importing the old name keeps working.
AUTHORING_CATEGORY = DELIVERY
AUTHORING_VERSION = "1.0.0"

TABLE_TYPE = "NOVA_TABLE"
FILES_TYPE = "NOVA_FILES"


class AnyType(str):
    """A slot type that ComfyUI's validator accepts from any link.

    ComfyUI compares slot types with `!=`; a str subclass that always reports
    "equal" therefore matches every producer. This is the long-standing
    community idiom for a wildcard input.
    """

    def __ne__(self, other) -> bool:  # noqa: D105
        return False

    def __eq__(self, other) -> bool:  # noqa: D105
        return True

    def __hash__(self):  # noqa: D105
        return hash(str(self))


ANY_TYPE = AnyType("*")


# ---------------------------------------------------------------------------
# Payload builders
# ---------------------------------------------------------------------------

def make_table(
    database_path: str,
    table: str,
    columns: List[str],
    rows: List[Dict[str, Any]],
    sql: str = "",
    where: str = "",
    source: str = "sqlite",
) -> Dict[str, Any]:
    return {
        "schema": "nova.authoring.table",
        "schema_version": 1,
        "source": source,
        "database_path": str(database_path),
        "table": str(table),
        "columns": list(columns),
        "rows": list(rows),
        "record_count": len(rows),
        "column_count": len(columns),
        "sql": str(sql),
        "where": str(where),
    }


def empty_table(database_path: str = "", table: str = "", note: str = "") -> Dict[str, Any]:
    payload = make_table(database_path, table, [], [])
    payload["note"] = note
    return payload


def describe_file(path: str, extra: Dict[str, Any] | None = None) -> Dict[str, Any]:
    name = os.path.basename(path)
    stem, ext = os.path.splitext(name)
    entry: Dict[str, Any] = {
        "path": os.path.abspath(path),
        "name": name,
        "stem": stem,
        "extension": ext[1:].lower(),
    }
    try:
        stat = os.stat(path)
        entry["size_bytes"] = int(stat.st_size)
        entry["modified_utc"] = (
            datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except OSError:
        entry["size_bytes"] = 0
        entry["modified_utc"] = ""
    if extra:
        entry.update(extra)
    return entry


def make_files(root: str, files: List[Dict[str, Any]], decoded: bool = False) -> Dict[str, Any]:
    return {
        "schema": "nova.authoring.files",
        "schema_version": 1,
        "root": str(root),
        "count": len(files),
        "decoded": bool(decoded),
        "files": list(files),
    }


def file_paths(payload: Any) -> List[str]:
    """Accept a NOVA_FILES payload, a bare list, or a single path string."""
    if payload is None:
        return []
    if isinstance(payload, str):
        return [payload] if payload.strip() else []
    if isinstance(payload, dict):
        entries = payload.get("files") or []
        return [str(e.get("path")) for e in entries if isinstance(e, dict) and e.get("path")]
    if isinstance(payload, (list, tuple)):
        out: List[str] = []
        for item in payload:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict) and item.get("path"):
                out.append(str(item["path"]))
        return out
    return []


# ---------------------------------------------------------------------------
# Console text
# ---------------------------------------------------------------------------

def banner(title: str, width: int = 72) -> str:
    title = f" {title} "
    pad = max(0, width - len(title))
    left = pad // 2
    return "=" * left + title + "=" * (pad - left)


def render_value(value: Any, limit: int = 0) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        text = ", ".join(render_value(v) for v in value)
    else:
        text = str(value)
    text = text.replace("\r\n", "\n")
    if limit and len(text) > limit:
        text = text[:limit] + f"… <+{len(text) - limit} chars>"
    return text
