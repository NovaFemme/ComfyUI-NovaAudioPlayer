import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// New node type + legacy alias so old graphs keep working.
const NODE_TYPES = ["NovaSQLDump", "MySQLUniversalDump"];
const LOG_ROUTE = "/nova_sql_dump/log";

function findLoggerNode() {
    const nodes = app.graph?._nodes || [];
    return nodes.find(n => NODE_TYPES.includes(n.type) || NODE_TYPES.includes(n.comfyClass));
}

function widgetVal(node, name, fallback = "") {
    const w = node?.widgets?.find(w => w.name === name);
    return w ? w.value : fallback;
}

// A fresh unique id for each flow run. Prefer the platform UUID; fall back to a
// simple RFC4122-style generator for older/non-secure contexts.
function makeFlowId() {
    try {
        if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* ignore */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// Build the snapshot in the SAME shape the SQL view depends on:
//   { "<node title>": { "<widget name>": value, ... }, ... }
// The logger node itself is excluded (it only holds connection config).
function buildSnapshot() {
    const nodes = app.graph?._nodes || [];
    const screen = {};
    for (const node of nodes) {
        if (!node.type || NODE_TYPES.includes(node.type) || !node.widgets) continue;
        screen[node.title || node.type] = node.widgets.reduce((acc, w) => {
            if (w.name) acc[w.name] = w.value;
            return acc;
        }, {});
    }
    return screen;
}

async function sendFlow(flowState, flowId, snapshot) {
    const node = findLoggerNode();
    if (!node) return;                                   // no logger on the canvas
    const enabled = widgetVal(node, "enable_storage", true);
    if (enabled === false) return;                       // logging switched off

    const payload = {
        enable_storage: enabled !== false,
        host: widgetVal(node, "host", "127.0.0.1:3306") || "127.0.0.1:3306",
        user: widgetVal(node, "user", "root") || "root",
        password: widgetVal(node, "password", ""),
        database: widgetVal(node, "database", "comfyui_db") || "comfyui_db",
        flow_name: widgetVal(node, "flow_name", ""),
        flow_id: flowId,
        flow_state: flowState,
        all_screen_values: JSON.stringify(snapshot || buildSnapshot()),
    };

    node.setDbStatus?.(`${flowState}: saving...`);
    try {
        const resp = await api.fetchApi(LOG_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const res = await resp.json();
        const t = new Date().toLocaleTimeString();
        const shortId = (flowId || "").slice(0, 8);
        node.setDbStatus?.(res.status === "success" ? `${flowState} · ${shortId} @ ${t}` : `Error: ${res.message || "unknown"}`);
    } catch (e) {
        node.setDbStatus?.(`Error: ${e.message}`);
    }
}

app.registerExtension({
    name: "Nova.SQLDump.FlowLogger",
    async setup() {
        console.log("[Nova SQL Dump] flow logger active — flow_id build");
        // Per-run state: the flow_id + the snapshot taken at flow_start. The
        // snapshot is reused for the terminal row so every row for a run reflects
        // the inputs that actually ran (ComfyUI randomises seeds AFTER a run, so
        // re-reading at the end would record the next seed). The flow_id ties the
        // start/end/cancelled/exception rows together.
        const runs = new Map();        // prompt_id -> { flowId, snapshot }
        const terminated = new Set();  // prompt_ids that already got a terminal row
        let lastPromptId = null;

        const idOf = (detail) =>
            (detail && typeof detail === "object" ? detail.prompt_id : undefined) ?? lastPromptId;

        api.addEventListener("execution_start", (e) => {
            const id = e.detail?.prompt_id ?? `run_${Date.now()}`;
            lastPromptId = id;
            terminated.delete(id);
            const flowId = makeFlowId();
            const snapshot = buildSnapshot();
            runs.set(id, { flowId, snapshot });
            sendFlow("flow_start", flowId, snapshot);
        });

        const terminal = (detail, state) => {
            const id = idOf(detail);
            if (id != null) {
                if (terminated.has(id)) return;         // one terminal row per run
                terminated.add(id);
            }
            const run = id != null ? runs.get(id) : undefined;
            // If the start was missed, still emit with a fresh id so the row isn't orphaned.
            const flowId = run?.flowId ?? makeFlowId();
            sendFlow(state, flowId, run?.snapshot);
            if (id != null) runs.delete(id);
        };

        api.addEventListener("execution_success", (e) => terminal(e.detail, "flow_end"));
        api.addEventListener("execution_error", (e) => terminal(e.detail, "flow_exception"));
        api.addEventListener("execution_interrupted", (e) => terminal(e.detail, "flow_cancelled"));

        // Fallback for ComfyUI builds without "execution_success": a run ends
        // when an "executing" event arrives with a null node id.
        api.addEventListener("executing", (e) => {
            let nodeId = e.detail;
            const detail = e.detail;
            if (nodeId && typeof nodeId === "object") nodeId = nodeId.node;   // {node, prompt_id} shape
            if (nodeId === null || nodeId === undefined) terminal(detail, "flow_end");
        });
    },
});
