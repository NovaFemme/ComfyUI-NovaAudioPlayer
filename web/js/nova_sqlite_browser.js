import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const BROWSER = "NovaSQLiteBrowserNode";
const ITERATOR = "NovaSQLiteRowIteratorNode";
const SINGLE_ROW = "NovaSQLiteSingleRowNode";
const VIEWER_CLASSES = new Set([ITERATOR, SINGLE_ROW]);
const ROWS_TYPE = "NOVA_SQLITE_ROWS"; // must match ROWS_TYPE in the .py file
const FIXED_OUTPUTS = 3;          // next_row_index, total_rows, loop_finished
const MAX_COLUMN_OUTPUTS = 64;    // must match MAX_COLUMN_OUTPUTS in the .py file
const PINK = "#ff94c2";
const DOM_MARGIN = 10;            // horizontal inset of DOM content inside the node
const VIEWER_MIN_H = 120;
const VIEWER_MAX_H = 460;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const first = (v) => (Array.isArray(v) ? v[0] : v);

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// selected_columns is stored as a JSON list; anything else counts as "nothing selected"
const parseSelected = (value) => {
    const s = String(value ?? "").trim();
    if (!s.startsWith("[")) return [];
    try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
        return [];
    }
};

const getLink = (graph, id) => {
    const links = graph?.links;
    if (!links || id == null) return null;
    return typeof links.get === "function" ? links.get(id) : links[id];
};

const isReroute = (n) => n?.type === "Reroute" || n?.comfyClass === "Reroute";

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    if (w.element) w.element.style.display = "none";
    if (w.inputEl) w.inputEl.style.display = "none";
}

function wrapCallback(widget, fn) {
    if (!widget) return;
    const orig = widget.callback;
    widget.callback = function (...args) {
        const r = orig?.apply(this, args);
        fn(...args);
        return r;
    };
}

/**
 * The frontend's own DOM-widget sizing can drift from the node's real size (e.g. while dragging),
 * which made content spill outside the node. The DOM widget is therefore a pass-through "host",
 * and the visible content ("inner") is sized from node.size on every canvas frame.
 */
function makeDomHost(inner, initialH) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative; overflow:visible; pointer-events:none; width:100%; height:100%;";
    inner.style.position = "absolute";
    inner.style.left = "0";
    inner.style.top = "0";
    inner.style.width = "300px";
    inner.style.height = `${initialH}px`;
    inner.style.boxSizing = "border-box";
    inner.style.pointerEvents = "auto";
    host.appendChild(inner);
    return host;
}

function pinDomSize(node, widget, inner, minH) {
    let lastW = -1;
    let lastH = -1;
    const orig = node.onDrawForeground;
    node.onDrawForeground = function () {
        const r = orig?.apply(this, arguments);
        if (this.flags?.collapsed) return r;

        const y = widget.y ?? widget.last_y;
        if (typeof y === "number" && y > 0) {
            // Auto-fit request (iterator): make the node exactly as tall as its content needs.
            if (this._wantFit) {
                this._wantFit = false;
                const needed = Math.round(y + (this._viewerH ?? minH) + DOM_MARGIN * 1.5);
                if (Math.abs(this.size[1] - needed) > 2) {
                    this.setSize([Math.max(this.size[0], 320), needed]);
                    this.setDirtyCanvas(true, true);
                }
            }
            const w = Math.max(40, Math.round(this.size[0] - DOM_MARGIN * 2));
            const h = Math.max(minH, Math.round(this.size[1] - y - DOM_MARGIN * 1.5));
            if (w !== lastW) { inner.style.width = `${w}px`; lastW = w; }
            if (h !== lastH) { inner.style.height = `${h}px`; lastH = h; }
        }
        return r;
    };
}

/**
 * Makes widget values survive page reloads / restored tabs.
 * ComfyUI restores widgets_values by position, which can shift values by one slot
 * (e.g. row_index = -1, stop_at_row = NaN, loop_mode = "true"). Values are therefore also
 * saved by name in node.properties, restored by name after load, and (optionally)
 * validated against the widget's own limits before every run.
 */
function protectWidgetValues(node, names, { validate = true } = {}) {
    const getWidgets = () => names.map((n) => node.widgets?.find((w) => w.name === n)).filter(Boolean);

    // Defaults from the node definition (captured before a saved workflow is applied)
    const defaults = {};
    for (const w of getWidgets()) defaults[w.name] = w.value;

    const fix = (w) => {
        const d = defaults[w.name];
        let v = w.value;
        const list = w.options?.values;
        if (Array.isArray(list) && list.length) {
            if (!list.includes(v)) v = list.includes(d) ? d : list[0];
        } else if (typeof d === "number") {
            let n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
            if (!Number.isFinite(n)) n = d;
            const min = w.options?.min;
            const max = w.options?.max;
            if (min != null && n < min) n = d >= min ? d : min;
            if (max != null && n > max) n = max;
            v = Math.round(n);
        } else if (typeof d === "boolean") {
            v = v === true || v === "true" ? true : v === false || v === "false" ? false : d;
        }
        if (v !== w.value) {
            console.warn(`[Nova SQLite] ${node.title}: invalid ${w.name} value ${JSON.stringify(w.value)} reset to ${JSON.stringify(v)}`);
            w.value = v;
        }
        return v;
    };

    const restore = () => {
        const saved = node.properties?.nova_widget_values;
        for (const w of getWidgets()) {
            if (saved && Object.prototype.hasOwnProperty.call(saved, w.name)) w.value = saved[w.name];
            if (validate) fix(w);
        }
        node.setDirtyCanvas(true, true);
    };

    // Save by name whenever the workflow is serialized (autosave, save, tab storage)
    const onSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        const r = onSerialize?.apply(this, arguments);
        o.properties = o.properties || {};
        o.properties.nova_widget_values = Object.fromEntries(getWidgets().map((w) => [w.name, w.value]));
        return r;
    };

    // Restore by name after the positional restore has happened
    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        restore();
        setTimeout(restore, 0);
        return r;
    };

    // Last line of defence: never send an invalid value to the backend
    if (validate) {
        for (const w of getWidgets()) {
            w.serializeValue = async () => fix(w);
        }
    }
}

// Browser node feeding an iterator's row_data_json input (follows reroutes)
function upstreamBrowser(iterNode) {
    let node = iterNode;
    let slot = node.inputs?.findIndex((i) => i.name === "row_data_json") ?? -1;
    for (let guard = 0; guard < 20 && node && slot >= 0; guard++) {
        const link = getLink(node.graph, node.inputs[slot]?.link);
        if (!link) return null;
        const origin = node.graph.getNodeById(link.origin_id);
        if (!origin) return null;
        if (origin.comfyClass === BROWSER) return link.origin_slot === 0 ? origin : null;
        if (!isReroute(origin)) return null;
        node = origin;
        slot = 0;
    }
    return null;
}

// Iterator nodes fed by a browser's row_data_json output (follows reroutes)
function downstreamIterators(browserNode) {
    const found = [];
    const visit = (node, slot, depth) => {
        if (depth > 20) return;
        for (const id of node.outputs?.[slot]?.links ?? []) {
            const link = getLink(node.graph, id);
            if (!link) continue;
            const target = node.graph.getNodeById(link.target_id);
            if (!target) continue;
            if (VIEWER_CLASSES.has(target.comfyClass)) found.push(target);
            else if (isReroute(target)) visit(target, 0, depth + 1);
        }
    };
    visit(browserNode, 0, 0);
    return found;
}

// ---------------------------------------------------------------------------
// Extension 1: Main Data Browser Node
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_browser",
    async nodeCreated(node) {
        if (node.comfyClass !== BROWSER) return;

        const dbWidget = node.widgets.find((w) => w.name === "database_path");
        const tableWidget = node.widgets.find((w) => w.name === "table_name");
        const selWidget = node.widgets.find((w) => w.name === "selected_columns");
        hideWidget(selWidget);
        protectWidgetValues(node, ["database_path", "table_name", "selected_columns"], { validate: false });

        let columns = [];

        // --- DOM ---
        const wrap = document.createElement("div");
        wrap.style.cssText = `display:flex; flex-direction:column; gap:6px; overflow:hidden; min-height:0;`;

        const bar = document.createElement("div");
        bar.style.cssText = `display:flex; align-items:center; gap:8px; font-size:11px; color:#bbb; flex:0 0 auto; min-width:0;`;
        const countEl = document.createElement("span");
        countEl.style.cssText = `color:${PINK}; font-weight:bold; white-space:nowrap;`;
        const statusEl = document.createElement("span");
        statusEl.style.cssText = `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#888;`;
        const mkBtn = (label) => {
            const b = document.createElement("span");
            b.textContent = label;
            b.style.cssText = `cursor:pointer; color:${PINK}; text-decoration:underline; user-select:none; white-space:nowrap;`;
            return b;
        };
        const allBtn = mkBtn("All");
        const noneBtn = mkBtn("None");
        bar.append(countEl, statusEl, allBtn, noneBtn);

        const badges = document.createElement("div");
        badges.style.cssText = `
            flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
            display:flex; flex-wrap:wrap; align-content:flex-start; gap:6px; padding:8px;
            background:#1e1e24; border-radius:8px; border:1px dashed ${PINK}; box-sizing:border-box;
        `;
        wrap.append(bar, badges);

        const badgeWidget = node.addDOMWidget("column_badges", "HTML", makeDomHost(wrap, 110), {
            getMinHeight: () => 110,
            hideOnZoom: false,
            serialize: false,
        });
        pinDomSize(node, badgeWidget, wrap, 80);

        const setStatus = (text, isError = false) => {
            statusEl.textContent = text || "";
            statusEl.title = text || "";
            statusEl.style.color = isError ? "#ff557f" : "#888";
        };

        const getSelected = () => parseSelected(selWidget?.value);
        node.getSelectedColumns = () => getSelected().slice(0, MAX_COLUMN_OUTPUTS);

        const propagate = () => {
            const cols = node.getSelectedColumns();
            downstreamIterators(node).forEach((it) => it.syncColumnOutputs?.(cols));
        };

        const commit = (selectedList) => {
            if (selWidget) selWidget.value = JSON.stringify(selectedList);
            render();
            propagate();
            node.setDirtyCanvas(true, true);
        };

        const toggle = (col) => {
            const sel = new Set(getSelected());
            if (sel.has(col)) {
                sel.delete(col);
            } else {
                if (sel.size >= MAX_COLUMN_OUTPUTS) {
                    setStatus(`Maximum of ${MAX_COLUMN_OUTPUTS} columns can be selected`, true);
                    return;
                }
                sel.add(col);
            }
            commit(columns.filter((c) => sel.has(c)));
        };

        allBtn.onclick = () => commit(columns.slice(0, MAX_COLUMN_OUTPUTS));
        noneBtn.onclick = () => commit([]);

        const render = () => {
            badges.innerHTML = "";
            const sel = new Set(getSelected());
            countEl.textContent = columns.length ? `${sel.size} / ${columns.length} selected` : "";
            if (!columns.length) {
                badges.innerHTML = `<span style="color:#777; font-size:11px; font-style:italic;">${
                    tableWidget?.value ? "No columns found" : "Select a table..."
                }</span>`;
                return;
            }
            for (const col of columns) {
                const on = sel.has(col);
                const b = document.createElement("span");
                b.textContent = col;
                b.title = on ? "Selected - click to remove output" : "Click to add as output";
                b.style.cssText = `
                    padding:4px 10px; border-radius:20px; font-size:11px; font-weight:bold;
                    cursor:pointer; user-select:none; transition:all 0.15s ease; display:inline-block;
                    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box;
                    background:${on ? PINK : "#333"}; color:${on ? "#1e1e24" : "#aaa"};
                    border:1px solid ${on ? "#ffb7d5" : "#444"};
                `;
                b.onclick = (e) => {
                    e.stopPropagation();
                    toggle(col);
                };
                badges.appendChild(b);
            }
        };

        const post = async (url, body) => {
            const res = await api.fetchApi(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return res.json();
        };

        const updateColumns = async () => {
            columns = [];
            let ok = false;
            if (tableWidget?.value) {
                try {
                    const data = await post("/sqlite_browser/get_columns", {
                        database_path: dbWidget?.value,
                        table_name: tableWidget.value,
                    });
                    columns = data.columns || [];
                    ok = !data.error;
                    if (data.error) setStatus(data.error, true);
                } catch (err) {
                    setStatus(`Could not load columns: ${err.message}`, true);
                }
            }
            if (ok) {
                const sel = new Set(getSelected());
                commit(columns.filter((c) => sel.has(c)).slice(0, MAX_COLUMN_OUTPUTS));
            } else {
                render();
            }
        };

        const updateTables = async () => {
            try {
                const data = await post("/sqlite_browser/get_tables", { database_path: dbWidget?.value });
                const tables = data.tables || [];
                tableWidget.options.values = tables.length ? tables : [""];
                if (!tables.includes(tableWidget.value)) tableWidget.value = tables[0] ?? "";
                setStatus(data.error || (tables.length ? "" : "No tables in database"), !!data.error || !tables.length);
            } catch (err) {
                setStatus(`Could not load tables: ${err.message}`, true);
            }
            await updateColumns();
        };

        wrapCallback(dbWidget, async () => {
            await updateTables();
            app.canvas.draw(true, true);
        });
        wrapCallback(tableWidget, async () => {
            await updateColumns();
            app.canvas.draw(true, true);
        });

        const onExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const status = first(message?.status);
            if (status) setStatus(status, /error|not found|0 columns|No /i.test(status));
        };

        // --- Notice at the top of the node (drawn in the empty space left of the outputs) ---
        const NOTICE =
            "ℹ️ Copy your .db / .sqlite / .sqlite3 files into the ComfyUI input/ folder, " +
            "then press R to refresh. They will appear in database_path below.";
        const drawNotice = function (ctx) {
            if (this.flags?.collapsed || !ctx) return;
            const slotH = window.LiteGraph?.NODE_SLOT_HEIGHT ?? 20;
            ctx.save();
            ctx.font = "12px Arial";
            const labelW = Math.max(0, ...(this.outputs ?? []).map((o) => ctx.measureText(o.label ?? o.name ?? "").width));
            const x = 8;
            const y = 5;
            const w = this.size[0] - labelW - 36;
            const h = (this.outputs?.length ?? 0) * slotH - 6;
            if (w < 90 || h < 24) { ctx.restore(); return; }

            // box
            ctx.fillStyle = "#1e1e24";
            ctx.strokeStyle = PINK;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
            else ctx.rect(x, y, w, h);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);

            // word-wrapped text, clipped to the box
            ctx.font = "11px Arial";
            ctx.fillStyle = "#ffb7d5";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            const pad = 7;
            const lineH = 14;
            const maxW = w - pad * 2;
            const maxLines = Math.max(1, Math.floor((h - pad * 2 + 2) / lineH));
            const lines = [];
            let line = "";
            for (const word of NOTICE.split(" ")) {
                const test = line ? `${line} ${word}` : word;
                if (ctx.measureText(test).width > maxW && line) {
                    lines.push(line);
                    line = word;
                } else {
                    line = test;
                }
            }
            if (line) lines.push(line);
            if (lines.length > maxLines) {
                lines.length = maxLines;
                let last = lines[maxLines - 1];
                while (last.length > 1 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
                lines[maxLines - 1] = last + "…";
            }
            lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * lineH));
            ctx.restore();
        };
        const origNoticeFg = node.onDrawForeground;
        node.onDrawForeground = function (ctx) {
            const r = origNoticeFg?.apply(this, arguments);
            drawNotice.call(this, ctx);
            return r;
        };

        render();
        setTimeout(() => updateTables(), 100);
        requestAnimationFrame(() => {
            const min = node.computeSize();
            node.setSize([Math.max(node.size[0], min[0], 420), Math.max(node.size[1], min[1], 340)]);
            node.setDirtyCanvas(true, true);
        });
    },
});

// ---------------------------------------------------------------------------
// Shared row viewer (used by the Iterator and the Single Row node)
//   mode "loop"   -> iterator: advances row_index and auto-queues until finished
//   mode "single" -> one row only; row_index is disabled when only 1 row is received
// ---------------------------------------------------------------------------
function setupRowViewer(node, mode) {
    const isLoop = mode === "loop";
    protectWidgetValues(node, isLoop ? ["row_index", "stop_at_row", "loop_mode", "auto_loop"] : ["row_index"]);
    const rowWidget = node.widgets.find((w) => w.name === "row_index");
    const autoWidget = node.widgets.find((w) => w.name === "auto_loop");

    // Python declares a pool of column slots; show only the selected ones.
    while (node.outputs.length > FIXED_OUTPUTS) node.removeOutput(node.outputs.length - 1);

    node._viewerH = VIEWER_MIN_H;
    node._lastRun = null;
    node._lastError = null;

    const consoleEl = document.createElement("div");
    consoleEl.style.cssText = `
        background:#131316; border-radius:6px; padding:8px; border:1px solid ${PINK};
        font-family:monospace; font-size:11px; color:#ffb7d5; overflow:auto;
    `;
    const content = document.createElement("div");
    consoleEl.appendChild(content);

    const viewerWidget = node.addDOMWidget("live_viewer", "HTML", makeDomHost(consoleEl, VIEWER_MIN_H), {
        getMinHeight: () => node._viewerH,
        hideOnZoom: false,
        serialize: false,
    });
    viewerWidget.computeSize = (width) => [width ?? node.size[0], node._viewerH + DOM_MARGIN];
    pinDomSize(node, viewerWidget, consoleEl, 60);

    const currentColumns = () => node.outputs.slice(FIXED_OUTPUTS).map((o) => o.name);

    // Single-row mode: row selector is only active when more than one row is received.
    const setRowLocked = (locked) => {
        if (isLoop || !rowWidget) return;
        rowWidget.disabled = !!locked;
        if (rowWidget.options) rowWidget.options.disabled = !!locked;
        rowWidget.label = locked ? "row_index (only 1 row)" : undefined;
        node.setDirtyCanvas(true, true);
    };

    // Measure content and ask the node to resize (grow or shrink) to fit it.
    const autoFit = () => {
        requestAnimationFrame(() => {
            const measured = content.offsetHeight;
            const estimate = 40 + Math.max(1, currentColumns().length) * 17;
            const contentH = (measured > 0 ? measured : estimate) + 18; // padding + border
            node._viewerH = Math.min(VIEWER_MAX_H, Math.max(VIEWER_MIN_H, contentH));
            node._wantFit = true;
            node.setDirtyCanvas(true, true);
            app.canvas?.draw(true, true);
        });
    };

    const msg = (html) => { content.innerHTML = html; };

    const renderIdle = () => {
        const cols = currentColumns();
        msg(cols.length
            ? `<div style="color:#aa7788; font-style:italic;">${cols.length} column(s) ready - press Run to load data.</div>`
            : `<div style="color:#aa7788; font-style:italic;">${isLoop ? "Awaiting valid loop wire connection / column selection..." : "Awaiting valid wire connection / column selection..."}</div>`);
    };

    const renderError = (text) => {
        msg(`<div style="color:#ff557f; font-weight:bold; border:1px dotted #ff557f; padding:4px; word-break:break-word;">❌ ${esc(text)}</div>`);
    };

    const renderRow = (run) => {
        const { row, idx, total, stop, mode: loopMode, finished, warning, locked } = run;
        const cols = currentColumns();
        const progress = total ? Math.round(((idx + 1) / total) * 100) : 0;
        const detail = isLoop
            ? `index ${idx} · stop ${stop} · ${esc(loopMode)}`
            : `index ${idx}${locked ? " · only row" : ""}`;
        let h = `<div style="color:${PINK}; font-weight:bold; margin-bottom:6px; border-bottom:1px solid ${PINK}; padding-bottom:2px; overflow-wrap:anywhere;">
            ✨ Row [ ${idx + 1} / ${total} ]
            <span style="color:#aa7788; font-weight:normal;">${detail}</span>
            ${isLoop && finished ? `<span style="color:#7fffb0;"> ✅ loop finished</span>` : ""}
        </div>
        <div style="height:3px; background:#333; border-radius:2px; margin-bottom:6px;">
            <div style="height:3px; width:${progress}%; background:${PINK}; border-radius:2px;"></div>
        </div>`;
        if (warning) h += `<div style="color:#ffd27f; margin-bottom:4px;">⚠ ${esc(warning)}</div>`;
        if (!cols.length) {
            h += `<div style="color:#aa7788; font-style:italic;">No columns selected.</div>`;
            msg(h);
            return;
        }
        h += `<table style="width:100%; border-collapse:collapse; table-layout:fixed;">`;
        for (const key of cols) {
            const has = Object.prototype.hasOwnProperty.call(row, key);
            const val = row[key];
            let text = !has ? "" : val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
            if (text.length > 400) text = text.slice(0, 400) + "…";
            const cell = has ? esc(text) : `<span style="color:#aa7788; font-style:italic;">run to load</span>`;
            h += `<tr style="border-bottom:1px solid #222;">
                <td style="color:#777; padding:3px 0; font-weight:bold; width:35%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:top;" title="${esc(key)}">${esc(key)}</td>
                <td style="color:#eee; padding:3px 0 3px 6px; overflow-wrap:anywhere; word-break:break-word;">${cell}</td>
            </tr>`;
        }
        h += `</table>`;
        msg(h);
    };

    node.refreshViewer = () => {
        if (node._lastError) renderError(node._lastError);
        else if (node._lastRun) renderRow(node._lastRun);
        else renderIdle();
        autoFit();
    };

    // Rebuild column outputs, preserving existing links by column name.
    node.syncColumnOutputs = function (cols) {
        cols = (cols || []).slice(0, MAX_COLUMN_OUTPUTS).map(String);
        const current = currentColumns();
        if (current.length === cols.length && current.every((n, i) => n === cols[i])) return;

        const saved = {};
        for (let i = node.outputs.length - 1; i >= FIXED_OUTPUTS; i--) {
            const out = node.outputs[i];
            saved[out.name] = (out.links ?? [])
                .map((id) => getLink(node.graph, id))
                .filter(Boolean)
                .map((l) => ({ target: l.target_id, slot: l.target_slot }));
            node.removeOutput(i);
        }

        cols.forEach((col) => node.addOutput(col, "STRING"));
        cols.forEach((col, i) => {
            for (const l of saved[col] ?? []) {
                const t = node.graph?.getNodeById(l.target);
                if (t) node.connect(FIXED_OUTPUTS + i, t, l.slot);
            }
        });

        node.refreshViewer(); // drops/adds rows in the display and re-fits the node
    };

    const syncFromUpstream = () => {
        const b = upstreamBrowser(node);
        if (b?.getSelectedColumns) node.syncColumnOutputs(b.getSelectedColumns());
        return !!b;
    };

    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected) {
        onConnectionsChange?.apply(this, arguments);
        if (app.configuringGraph) return;
        const INPUT = window.LiteGraph?.INPUT ?? 1;
        if (type !== INPUT || node.inputs?.[index]?.name !== "row_data_json") return;
        setTimeout(() => {
            if (!syncFromUpstream()) {
                node._lastRun = null;
                node._lastError = null;
                setRowLocked(false);
                node.syncColumnOutputs([]);
                node.refreshViewer();
            }
        }, 0);
    };

    const onExecuted = node.onExecuted;
    node.onExecuted = function (message) {
        onExecuted?.apply(this, arguments);
        if (!message) return;

        const error = first(message.error);
        if (error) {
            node._loop = null;
            node._lastError = error;
            setRowLocked(!!first(message.row_locked));
            node.refreshViewer();
            return;
        }

        const row = first(message.current_row_data) || {};
        const cols = first(message.column_names) || Object.keys(row);
        const run = {
            row,
            idx: first(message.current_index) ?? 0,
            total: first(message.total_rows) ?? 0,
            stop: first(message.stop_at_row) ?? 0,
            mode: first(message.loop_mode) ?? "",
            finished: !!first(message.loop_finished),
            warning: first(message.warning),
            locked: !!first(message.row_locked),
        };
        const next = first(message.next_row_index) ?? run.idx;

        node._lastError = null;
        node._lastRun = run;
        setRowLocked(run.locked);

        // No browser directly upstream: fall back to the columns that actually ran
        if (!upstreamBrowser(node)) node.syncColumnOutputs(cols);
        node.refreshViewer();

        if (!isLoop) return; // single row: no looping

        if (!node._loop) node._loop = { start: run.idx };
        if (run.finished) {
            if (rowWidget) rowWidget.value = node._loop.start; // Run again repeats the loop
            node._loop = null;
        } else {
            if (rowWidget) rowWidget.value = next;
            if (autoWidget?.value) setTimeout(() => app.queuePrompt(0, 1), 50);
            else node._loop = null;
        }
    };

    renderIdle();
    setTimeout(() => { syncFromUpstream(); node.refreshViewer(); }, 150);
    requestAnimationFrame(() => {
        if (node.size[0] < 320) node.setSize([320, node.size[1]]);
        node.setDirtyCanvas(true, true);
    });
}

// ---------------------------------------------------------------------------
// Extension 2: Iterator Node
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_row_iterator",

    setup() {
        const stopLoops = () => {
            for (const n of app.graph?._nodes ?? []) if (n.comfyClass === ITERATOR) n._loop = null;
        };
        api.addEventListener("execution_interrupted", stopLoops);
        api.addEventListener("execution_error", stopLoops);
    },

    async nodeCreated(node) {
        if (node.comfyClass !== ITERATOR) return;
        setupRowViewer(node, "loop");
    },
});

// ---------------------------------------------------------------------------
// Extension 3: Single Row Node
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_single_row",
    async nodeCreated(node) {
        if (node.comfyClass !== SINGLE_ROW) return;
        setupRowViewer(node, "single");
    },
});

// ---------------------------------------------------------------------------
// Extension 4: Connection suggestions + link colour
//   Dragging from row_data_json and releasing on empty canvas suggests the
//   Iterator and Single Row nodes; dragging back from their row_data_json
//   input suggests the Browser.
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_connection_suggestions",
    setup() {
        const LG = window.LiteGraph;
        if (LG) {
            LG.slot_types_default_out = LG.slot_types_default_out || {};
            LG.slot_types_default_in = LG.slot_types_default_in || {};
            LG.slot_types_default_out[ROWS_TYPE] = [ITERATOR, SINGLE_ROW];
            LG.slot_types_default_in[ROWS_TYPE] = [BROWSER];
        }
        const Canvas = window.LGraphCanvas;
        if (Canvas) {
            Canvas.link_type_colors = Canvas.link_type_colors || {};
            Canvas.link_type_colors[ROWS_TYPE] = PINK;
        }
        if (app.canvas) {
            app.canvas.default_connection_color_byType = app.canvas.default_connection_color_byType || {};
            app.canvas.default_connection_color_byType[ROWS_TYPE] = PINK;
        }
    },
});
