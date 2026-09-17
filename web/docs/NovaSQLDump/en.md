# Nova SQL Dump

Logs a workflow's execution lifecycle to MySQL or MariaDB — one row per event,
against ComfyUI's real execution, not against the moment you clicked Queue.

## What gets written

| `flow_state` | When |
|---|---|
| `flow_start` | the run actually began — the snapshot records the inputs **as used** |
| `flow_end` | the run finished successfully |
| `flow_cancelled` | the run was interrupted |
| `flow_exception` | the run errored |

The distinction matters. A node that snapshots widget values when Queue Prompt
is clicked records the state *before* the run, and records it even for runs that
never happen. This captures at start, so what is in the database is what was
actually executed, and a cancelled run is visibly a cancelled run.

`flow_name` is a name you type on the node and is stored on every row, so runs
group and query cleanly. `flow_id` ties the events of one run together.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `enable_storage` | Enabled | Turn logging off without unwiring the node. |
| `flow_name` | empty | Stored as `flow_name` on every row for this run. |
| `host` | `127.0.0.1` | Database host. |
| `user` | `root` | Database user. |
| `password` | empty | Database password — **read the warning below**. |
| `database` | `comfyui_db` | Created if it does not exist. |

## Outputs

`status` — a short string, `Storage: OFF` or `Storage: Active (logging flow
lifecycle)`. The node reports its own state; the writing is done by the
lifecycle hooks, not by this output.

## The password is stored in the workflow

The field is masked on screen, but ComfyUI serialises every widget value into
the saved workflow JSON — and into the metadata embedded in images and audio
exported from that workflow. **Anyone you send a workflow or an exported file to
can read this password.** Use a dedicated account with rights only to its own
logging database, never a root password you care about, and think before sharing
a workflow that contains this node.

## Schema

The table is created on first use and is safe to point at an existing database:

```sql
CREATE TABLE IF NOT EXISTS canvas_snapshots (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    node_data  JSON NOT NULL,
    flow_id    VARCHAR(64)  NULL,
    flow_state VARCHAR(32)  NULL,
    flow_name  VARCHAR(255) NULL,
    INDEX idx_flow_id (flow_id)
) CHARACTER SET utf8mb4
```

Installs that predate the `flow_id` / `flow_state` / `flow_name` columns are
migrated in place, idempotently, by checking `information_schema` before each
`ALTER` — so upgrading adds the columns without touching existing rows, on both
MySQL and MariaDB.

## pymysql is optional on purpose

`pymysql` is declared as a dependency but is **not** imported at module scope. A
hard import would take the entire pack down on any install without it — one
ImportError in `__init__.py` and all 28 nodes vanish from the menu. Without
pymysql this node loads and tells you it cannot connect; every other Nova node
carries on working.

## The frontend half

`web/mysql_tracker.js` is what notices a run starting and captures the snapshot.
If the node is present but nothing is being written, check the browser console
for `[Nova SQL Dump] flow logger active` at page load.
