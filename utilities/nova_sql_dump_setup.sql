-- Nova SQL Dump: one-time setup for the local, temporary logging database.
--
-- Run ONCE, as a database administrator, on the machine that runs ComfyUI:
--
--     sudo mariadb < utilities/nova_sql_dump_setup.sql
--
-- Safe to run again: every statement is IF NOT EXISTS, and nothing is dropped.
--
-- What it creates
--   * database  nova_log             - a staging area for logs, separate from
--                                      any database that holds data you keep
--   * table     nova_log.canvas_snapshots
--   * account   nova_logger          - NO PASSWORD, local connections only,
--                                      and INSERT on that one table only
--
-- What that means
--   nova_logger can add rows and do nothing else: it cannot read, change or
--   delete a single row, and cannot see any other database. Anything on this
--   machine can use it to append rows, which is the accepted cost of having no
--   credentials to leak.
--
--   This is temporary storage. Moving rows into your own database, and
--   protecting that database (its own accounts, backups), is your
--   responsibility and happens outside the node. The help page for Nova SQL
--   Dump shows how.
--
-- Keep MariaDB listening locally only: `ss -tlnp | grep 3306` should show
-- 127.0.0.1:3306, not 0.0.0.0:3306 (bind-address in the server config).

CREATE DATABASE IF NOT EXISTS nova_log CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS nova_log.canvas_snapshots (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    node_data  JSON NOT NULL,
    flow_id    VARCHAR(64)  NULL,
    flow_state VARCHAR(32)  NULL,
    flow_name  VARCHAR(255) NULL,
    INDEX idx_flow_id (flow_id)
) CHARACTER SET utf8mb4;

-- TCP to 127.0.0.1 and the local socket can match different host entries
-- depending on server settings, so the account exists for both. Neither host
-- entry accepts a connection from another machine.
CREATE USER IF NOT EXISTS 'nova_logger'@'localhost';
CREATE USER IF NOT EXISTS 'nova_logger'@'127.0.0.1';

GRANT INSERT ON nova_log.canvas_snapshots TO 'nova_logger'@'localhost';
GRANT INSERT ON nova_log.canvas_snapshots TO 'nova_logger'@'127.0.0.1';
