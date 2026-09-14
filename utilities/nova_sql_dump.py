"""Nova SQL Dump - ComfyUI node that logs a workflow's execution lifecycle to MySQL/MariaDB.

Unlike the old MySQLUniversalDump (which snapshotted widget values the instant
Queue Prompt was clicked - i.e. *before* the run, and even when the run never
finished), this logs against ComfyUI's real execution lifecycle. The frontend
(web/mysql_tracker.js) captures the snapshot when a run actually starts and
writes one row per lifecycle event:

    flow_start      - the run began (snapshot = the inputs actually used)
    flow_end        - the run finished successfully
    flow_cancelled  - the run was interrupted
    flow_exception  - the run errored

Each row also carries `flow_name` (a name you type on the node) so runs are easy
to group and query.
"""
import re

import pymysql
from aiohttp import web
from server import PromptServer

try:
    from ..nova_categories import UTILITY_IO
    from . import nova_profile_store as profiles
except ImportError:  # direct execution / test harness
    from nova_categories import UTILITY_IO
    import nova_profile_store as profiles

# Only allow safe identifier characters for the database name (basic SQL-injection
# guard, since MySQL can't bind identifiers like DB names as parameters).
_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")

VALID_FLOW_STATES = ("flow_start", "flow_end", "flow_cancelled", "flow_exception")


def _validate_identifier(name: str) -> str:
    if not _SAFE_IDENTIFIER.match(name or ""):
        raise ValueError(f"Invalid database name: {name!r}")
    return name


class NovaSQLDump:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enable_storage": ("BOOLEAN", {"default": True, "label_on": "Enabled", "label_off": "Disabled"}),
                "flow_name": ("STRING", {"default": "", "multiline": False,
                                          "placeholder": "Name for this flow (stored as flow_name)"}),
                "host": ("STRING", {"default": "127.0.0.1"}),
                "user": ("STRING", {"default": "root"}),
                "password": ("STRING", {"default": "", "password": True}),
                "database": ("STRING", {"default": "comfyui_db"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "status_display"
    # Change this line to file the node wherever you like under the menu.
    CATEGORY = UTILITY_IO

    def status_display(self, enable_storage, flow_name, host, user, password, database):
        if not enable_storage:
            return ("Storage: OFF",)
        return ("Storage: Active (logging flow lifecycle)",)

    # -- schema -------------------------------------------------------------
    @staticmethod
    def initialize_database(host, user, password, database, port=3306):
        """Ensure the database, table and the flow_state / flow_name columns exist."""
        database = _validate_identifier(database)
        connection = pymysql.connect(host=host, port=port, user=user, password=password, charset="utf8mb4")
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4")
                cursor.execute(f"USE `{database}`")
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS canvas_snapshots (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        node_data JSON NOT NULL,
                        flow_id    VARCHAR(64) NULL,
                        flow_state VARCHAR(32) NULL,
                        flow_name  VARCHAR(255) NULL,
                        INDEX idx_flow_id (flow_id)
                    ) CHARACTER SET utf8mb4
                    """
                )
                # Idempotent migration for pre-existing installs (portable across MySQL/MariaDB).
                NovaSQLDump._ensure_column(cursor, database, "canvas_snapshots", "flow_id", "VARCHAR(64) NULL")
                NovaSQLDump._ensure_column(cursor, database, "canvas_snapshots", "flow_state", "VARCHAR(32) NULL")
                NovaSQLDump._ensure_column(cursor, database, "canvas_snapshots", "flow_name", "VARCHAR(255) NULL")
                NovaSQLDump._ensure_index(cursor, database, "canvas_snapshots", "idx_flow_id", "flow_id")
            connection.commit()
        finally:
            connection.close()

    @staticmethod
    def _ensure_column(cursor, database, table, column, definition):
        cursor.execute(
            "SELECT COUNT(*) FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND COLUMN_NAME=%s",
            (database, table, column),
        )
        (exists,) = cursor.fetchone()
        if not exists:
            cursor.execute(f"ALTER TABLE `{table}` ADD COLUMN `{column}` {definition}")

    @staticmethod
    def _ensure_index(cursor, database, table, index_name, column):
        cursor.execute(
            "SELECT COUNT(*) FROM information_schema.STATISTICS "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND INDEX_NAME=%s",
            (database, table, index_name),
        )
        (exists,) = cursor.fetchone()
        if not exists:
            cursor.execute(f"ALTER TABLE `{table}` ADD INDEX `{index_name}` (`{column}`)")

    # -- write --------------------------------------------------------------
    @staticmethod
    def insert_snapshot(host, user, password, database, port, node_data_json, flow_id, flow_state, flow_name):
        NovaSQLDump.initialize_database(host, user, password, database, port)
        connection = pymysql.connect(host=host, port=port, user=user, password=password,
                                     database=database, charset="utf8mb4")
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO canvas_snapshots (node_data, flow_id, flow_state, flow_name) "
                    "VALUES (%s, %s, %s, %s)",
                    (node_data_json, flow_id, flow_state, flow_name),
                )
            connection.commit()
        finally:
            connection.close()


# --- HTTP route the frontend posts each lifecycle event to --------------------
@PromptServer.instance.routes.post("/nova_sql_dump/log")
async def nova_sql_dump_log(request):
    """Receive one lifecycle event from web/mysql_tracker.js and store a row."""
    try:
        data = await request.json()

        if not data.get("enable_storage", True):
            return web.json_response({"status": "skipped", "message": "Storage disabled via node switch."})

        raw_host = data.get("host", "127.0.0.1")
        user = data.get("user", "root")
        password = data.get("password", "")
        database = data.get("database", "comfyui_db")
        payload = data.get("all_screen_values", "{}")
        flow_id = data.get("flow_id") or None
        flow_name = data.get("flow_name") or None

        flow_state = data.get("flow_state") or None
        if flow_state is not None and flow_state not in VALID_FLOW_STATES:
            flow_state = str(flow_state)[:32]  # keep unexpected values bounded, don't hard-fail

        # Split "host:port" if a port was included in the host field.
        if ":" in raw_host:
            db_host, db_port_s = raw_host.rsplit(":", 1)
            db_port = int(db_port_s)
        else:
            db_host, db_port = raw_host, 3306

        NovaSQLDump.insert_snapshot(db_host, user, password, database, db_port, payload, flow_id, flow_state, flow_name)

        return web.json_response({"status": "success", "message": f"Saved ({flow_state or 'no state'})"})
    except Exception as e:
        print(f">>> Nova SQL Dump log failure: {e} <<<")
        return web.json_response({"status": "error", "message": str(e)}, status=500)

NODE_CLASS_MAPPINGS = {"NovaSQLDump": NovaSQLDump}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaSQLDump": "Nova SQL Dump 🛢️"}
