"""Nova SQL Dump - logs a workflow's execution lifecycle to a LOCAL MariaDB/MySQL.

WHAT THIS NODE IS, AND IS NOT
-----------------------------
A local, temporary logging buffer. Nothing more.

* LOCAL ONLY. It connects to 127.0.0.1 and nowhere else. There is no host
  field, and no code path that can reach another machine.
* NO AUTHENTICATION. It connects as the fixed account ``nova_logger``, which
  has no password and exactly one right: INSERT into
  ``nova_log.canvas_snapshots``. That account cannot read, change or delete a
  single row, so nothing written here can be taken back out through this node.
* TEMPORARY STORAGE, LOGGING ONLY. The table is a staging area. Moving rows into
  your own database, and protecting that data (access control, backups), is the
  user's responsibility and happens outside this node. See
  web/docs/NovaSQLDump/en.md, "Moving your data out".

Why no credentials: a node input is saved in plain text in the workflow JSON,
sent in every prompt, and embedded in the metadata of every image or audio file
the workflow saves. A password on this node would have travelled with every
exported FLAC. With no credentials there is nothing to leak.

The one-time database setup is utilities/nova_sql_dump_setup.sql, run by the
user as a database administrator. This node never creates, alters or drops
anything.

The frontend (web/mysql_tracker.js) captures the snapshot when a run actually
starts and posts one row per lifecycle event:

    flow_start      - the run began (snapshot = the inputs actually used)
    flow_end        - the run finished successfully
    flow_cancelled  - the run was interrupted
    flow_exception  - the run errored
"""
import asyncio
import json
import os
import re

from aiohttp import web
from server import PromptServer

# OPTIONAL, AND IT HAS TO BE.
#
# __init__.py imports this module to register the node, so a hard `import
# pymysql` at module scope takes the WHOLE PACK down on any install that does
# not have it. It is declared in requirements.txt, but a git-clone install may
# never have run pip, so it degrades: absent until used, then a message that
# says what to do.
try:
    import pymysql
except ImportError:                                     # pragma: no cover
    pymysql = None

try:
    from ..nova_categories import UTILITY_IO
except ImportError:  # direct execution / test harness
    from nova_categories import UTILITY_IO


# --- The whole connection, fixed. Nothing here comes from a node or a request. --
DB_HOST = "127.0.0.1"
# Server-side only: an environment variable on the machine running ComfyUI, for
# a MariaDB on a non-standard port. Never read from the graph or from HTTP.
DB_PORT = int(os.environ.get("NOVA_SQL_DUMP_PORT", "3306"))
DB_USER = "nova_logger"          # no password; INSERT on one table only
DB_NAME = "nova_log"
DB_TABLE = "canvas_snapshots"

VALID_FLOW_STATES = ("flow_start", "flow_end", "flow_cancelled", "flow_exception")

# A flow_id is a UUID from the frontend (or its RFC4122-style fallback).
_FLOW_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_FLOW_NAME_MAX = 255             # the column is VARCHAR(255)

# Largest snapshot accepted, in bytes of UTF-8. Every widget value of every node
# in the graph goes into one row, so a big workflow is a big row. MariaDB's
# default max_allowed_packet is 16 MiB; stay under it. If a genuine run is ever
# refused, check `SELECT MAX(LENGTH(node_data)) FROM <your table>` and raise
# both this and max_allowed_packet together.
MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024

SETUP_HINT = (
    "Run the one-time setup as a database administrator:\n"
    "    sudo mariadb < custom_nodes/comfyui-novaaudioplayer/utilities/nova_sql_dump_setup.sql\n"
    "It creates the nova_log database, its table and the password-less, "
    "insert-only nova_logger account."
)

NODE_DESCRIPTION = (
    "Local, temporary logging only. Connects to a MariaDB/MySQL on this machine "
    "(127.0.0.1) as the password-less account nova_logger, which can only add "
    "rows to nova_log.canvas_snapshots. There is no authentication and no remote "
    "access. The table is a staging area: moving the data to your own database "
    "and protecting it is your responsibility, outside this node."
)


def _require_pymysql():
    """Fail at the point of use, in words, rather than at import."""
    if pymysql is None:
        raise RuntimeError(
            "Nova SQL Dump needs the pymysql package, which is not installed. "
            "Install it yourself and restart ComfyUI (this node installs "
            "nothing):\n"
            "    python -m pip install pymysql\n"
            "Every other Nova node works without it."
        )
    return pymysql


def _explain(exc) -> str:
    """Turn the MariaDB errors a missing setup produces into instructions."""
    code = exc.args[0] if getattr(exc, "args", None) else None
    if code == 2003:
        return (f"No MariaDB/MySQL is listening on {DB_HOST}:{DB_PORT}. Start the "
                "database server, or set NOVA_SQL_DUMP_PORT if it uses another port.")
    # 1044/1045/1698 access denied (1698: an account that does not exist yet,
    # as MariaDB reports a password-less login), 1049 unknown database,
    # 1142 command denied, 1146 unknown table.
    if code in (1044, 1045, 1049, 1142, 1146, 1698):
        return f"The logging database is not set up yet ({exc}).\n{SETUP_HINT}"
    return str(exc)


class NovaSQLDump:
    DESCRIPTION = NODE_DESCRIPTION

    @classmethod
    def INPUT_TYPES(cls):
        # Deliberately no host, user, password or database: see the module
        # docstring. Workflows saved with the old six widgets still load --
        # enable_storage and flow_name are the first two saved values, and the
        # rest are dropped the next time the workflow is saved.
        return {
            "required": {
                "enable_storage": ("BOOLEAN", {
                    "default": True, "label_on": "Enabled", "label_off": "Disabled",
                    "tooltip": "Turn logging off without removing the node."}),
                "flow_name": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "Name for this flow (stored as flow_name)",
                    "tooltip": "Stored on every row for this run, so runs group "
                               "and query cleanly. Local, temporary logging only."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "status_display"
    CATEGORY = UTILITY_IO

    def status_display(self, enable_storage, flow_name, **_ignored):
        # **_ignored: an old prompt may still carry host/user/password/database.
        # They are never read.
        if not enable_storage:
            return ("Storage: OFF",)
        return (f"Storage: Active - local temporary log "
                f"({DB_USER}@{DB_HOST}/{DB_NAME}, insert-only)",)

    # -- write --------------------------------------------------------------
    @staticmethod
    def insert_snapshot(node_data_json, flow_id, flow_state, flow_name):
        """Append one row. The only statement this node ever runs."""
        db = _require_pymysql()
        try:
            connection = db.connect(
                host=DB_HOST, port=DB_PORT, user=DB_USER, password="",
                database=DB_NAME, charset="utf8mb4", connect_timeout=5)
        except db.err.OperationalError as exc:
            raise RuntimeError(_explain(exc)) from exc
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"INSERT INTO `{DB_TABLE}` (node_data, flow_id, flow_state, flow_name) "
                    "VALUES (%s, %s, %s, %s)",
                    (node_data_json, flow_id, flow_state, flow_name),
                )
            connection.commit()
        except (db.err.OperationalError, db.err.ProgrammingError) as exc:
            raise RuntimeError(_explain(exc)) from exc
        finally:
            connection.close()


class _Refused(ValueError):
    """A request that does not describe one valid log row."""


def validate_event(data):
    """Reduce a request body to exactly one row, or refuse it.

    Only four fields are read. Anything else -- including the host, user,
    password and database an older frontend may still send -- is ignored, and
    never reaches the database driver.
    """
    if not isinstance(data, dict):
        raise _Refused("body must be a JSON object")

    flow_state = data.get("flow_state")
    if flow_state not in VALID_FLOW_STATES:
        raise _Refused(f"flow_state must be one of {', '.join(VALID_FLOW_STATES)}")

    flow_id = data.get("flow_id") or None
    if flow_id is not None and not (isinstance(flow_id, str) and _FLOW_ID.match(flow_id)):
        raise _Refused("flow_id must be 1-64 letters, digits, '-' or '_'")

    flow_name = data.get("flow_name") or None
    if flow_name is not None:
        if not isinstance(flow_name, str):
            raise _Refused("flow_name must be text")
        if len(flow_name) > _FLOW_NAME_MAX:
            raise _Refused(f"flow_name is longer than {_FLOW_NAME_MAX} characters")

    payload = data.get("all_screen_values", "{}")
    if not isinstance(payload, str):
        raise _Refused("all_screen_values must be a JSON string")
    if len(payload.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise _Refused(f"snapshot is larger than {MAX_SNAPSHOT_BYTES // (1024 * 1024)} MiB")
    try:
        if not isinstance(json.loads(payload), dict):
            raise _Refused("all_screen_values must encode a JSON object")
    except json.JSONDecodeError as exc:
        raise _Refused(f"all_screen_values is not valid JSON ({exc.msg})") from exc

    return payload, flow_id, flow_state, flow_name


# --- HTTP route the frontend posts each lifecycle event to --------------------
@PromptServer.instance.routes.post("/nova_sql_dump/log")
async def nova_sql_dump_log(request):
    """Append one validated lifecycle row to the local temporary log.

    Accepts data, not instructions: nothing in the request can choose where the
    server connects, as whom, or which statement runs.
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "body is not JSON"}, status=400)

    if isinstance(data, dict) and data.get("enable_storage") is False:
        return web.json_response({"status": "skipped", "message": "Storage disabled via node switch."})

    try:
        row = validate_event(data)
    except _Refused as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)

    try:
        # pymysql blocks; keep it off ComfyUI's event loop.
        await asyncio.get_running_loop().run_in_executor(None, NovaSQLDump.insert_snapshot, *row)
    except Exception as exc:
        print(f">>> Nova SQL Dump: {exc} <<<")
        return web.json_response({"status": "error", "message": str(exc)}, status=500)

    return web.json_response({"status": "success", "message": f"Saved ({row[2]})"})


NODE_CLASS_MAPPINGS = {"NovaSQLDump": NovaSQLDump}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaSQLDump": "Nova SQL Dump 🛢️"}
