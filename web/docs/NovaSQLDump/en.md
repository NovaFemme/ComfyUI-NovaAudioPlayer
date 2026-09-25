# Nova SQL Dump

Logs a workflow's execution lifecycle to a **local** MariaDB or MySQL, one row per
event, against ComfyUI's real execution rather than the moment you clicked Queue.

## Read this first: what this node is

> **Local only. No authentication. Temporary logging storage.**
>
> - **Offline and local only.** The node writes to a database on this machine
>   (`127.0.0.1`) and nowhere else. There is no host setting, and nothing can
>   make it connect to another computer.
> - **No authentication.** It connects as the fixed account `nova_logger`, which
>   has **no password**. That account can only **add** rows to one table,
>   `nova_log.canvas_snapshots`. It cannot read, change or delete anything, and
>   cannot see any other database.
> - **Logging only, temporary storage.** The table is a staging area for run
>   logs. It is not a place to keep data.
> - **Your data is your responsibility.** Moving the rows into your own database,
>   and protecting that database with its own accounts, permissions and backups,
>   is up to you, outside this node. The node's job ends when the row is written.

### Why there is no password field

Every value on a node is saved in plain text in the workflow file. It is sent with
every run, and embedded in the metadata of every image and audio file the workflow
saves. Earlier versions had a password field, and it travelled inside every FLAC
saved from a workflow containing this node. With no credentials, there is nothing
to leak.

If you used an earlier version, check the files you share. Change that database
password if it turns up in them, and remove the embedded workflow:

```bash
python3 -c "import sys,mutagen; f=mutagen.File(sys.argv[1]); [print(k, v[0][:200]) for k,v in (f.tags or {}).items() if k.lower() in ('prompt','workflow') and 'NovaSQLDump' in v[0]]" "song.flac"
metaflac --remove-tag=prompt --remove-tag=workflow song.flac
```

The first command prints nothing when a file is clean.

## One-time setup

Run the setup script once, as a database administrator, on the machine running
ComfyUI:

```bash
sudo mariadb < ComfyUI/custom_nodes/comfyui-novaaudioplayer/utilities/nova_sql_dump_setup.sql
```

It creates the `nova_log` database, the `canvas_snapshots` table and the
insert-only `nova_logger` account. It is safe to run again: every statement is
`IF NOT EXISTS`, and nothing is dropped. The node itself never creates, alters or
drops anything.

Also make sure MariaDB listens locally only: `ss -tlnp | grep 3306` should show
`127.0.0.1:3306`, not `0.0.0.0:3306`.

If MariaDB runs on a port other than 3306, set the environment variable
`NOVA_SQL_DUMP_PORT` before starting ComfyUI. It is a server-side setting only,
never a node input.

## What gets written

| `flow_state` | When |
|---|---|
| `flow_start` | the run actually began: the snapshot records the inputs **as used** |
| `flow_end` | the run finished successfully |
| `flow_cancelled` | the run was interrupted |
| `flow_exception` | the run errored |

A node that snapshots widget values when Queue Prompt is clicked records the state
*before* the run, and records it even for runs that never happen. This one captures
at start, so what is in the database is what was actually executed, and a cancelled
run shows up as cancelled.

`flow_name` is stored on every row, so runs group and query cleanly. `flow_id` ties
the events of one run together. The SQL Dump node itself is never part of the
snapshot.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `enable_storage` | Enabled | Turn logging off without removing the node. |
| `flow_name` | empty | Stored as `flow_name` on every row for this run (up to 255 characters). |

## Outputs

`status`: `Storage: OFF`, or `Storage: Active` followed by where it writes.

## Moving your data out

`nova_logger` cannot read the table, so moving the data out is done with **your
own** administrator account. Move the rows into a database you control and
protect, then clear them from the staging table:

```sql
-- as your own admin account, e.g.  sudo mariadb
CREATE DATABASE IF NOT EXISTS my_library CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS my_library.canvas_snapshots LIKE nova_log.canvas_snapshots;

START TRANSACTION;
SET @last := (SELECT MAX(id) FROM nova_log.canvas_snapshots);
INSERT INTO my_library.canvas_snapshots (created_at, node_data, flow_id, flow_state, flow_name)
    SELECT created_at, node_data, flow_id, flow_state, flow_name
    FROM nova_log.canvas_snapshots WHERE id <= @last;
DELETE FROM nova_log.canvas_snapshots WHERE id <= @last;
COMMIT;
```

`@last` makes sure that rows logged while this runs stay in the staging table for
next time, instead of being deleted unmoved. Back up `my_library` the way you back
up anything you care about, for example:

```bash
mariadb-dump --single-transaction my_library | gzip > ~/Backups/my_library_$(date +%F).sql.gz
```

### Already have a log in another database?

Earlier versions wrote to `comfyui_db` (or whatever you typed) as whatever user you
typed. That data stays exactly where it is. This node no longer writes to it or
reads from it. Treat it as your own database from now on: give it its own
protected account, back it up, and if you like, move rows from `nova_log` into it
with the SQL above.

## When nothing is written

The status line on the node shows the last result. The most common messages:

| Message | Meaning |
|---|---|
| `The logging database is not set up yet` | the setup script has not been run: see "One-time setup" |
| `No MariaDB/MySQL is listening on 127.0.0.1:3306` | the database server is not running, or uses another port (`NOVA_SQL_DUMP_PORT`) |
| `Nova SQL Dump needs the pymysql package` | install it into ComfyUI's Python: `python -m pip install pymysql` |

If nothing appears at all, check the browser console for
`[Nova SQL Dump] flow logger active` at page load.

**An old anonymous account can get in the way.** Some older MariaDB installs have
an anonymous `''@'localhost'` account that takes priority over `nova_logger`.
`mariadb-secure-installation` removes it.

## pymysql is optional on purpose

`pymysql` is declared in `requirements.txt` but is **not** imported at module
scope. A hard import would take the whole pack down on any install without it.
Without pymysql this node loads and tells you what to install, and every other
Nova node carries on working.
