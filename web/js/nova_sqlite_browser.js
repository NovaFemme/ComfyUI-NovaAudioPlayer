import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const BROWSER = "NovaSQLiteBrowserNode";
const ITERATOR = "NovaSQLiteRowIteratorNode";
const SINGLE_ROW = "NovaSQLiteSingleRowNode";
const WHERE_FILTER = "NovaSQLiteWhereFilterNode";
const VIEWER_CLASSES = new Set([ITERATOR, SINGLE_ROW, WHERE_FILTER]);
const ROWS_TYPE = "NOVA_SQLITE_ROWS"; // must match ROWS_TYPE in the .py file

// Condition operators. Must match OPERATORS in the .py file. needsValue = false -> value box is hidden.
const OPERATORS = [
    { name: "equals", label: "=", needsValue: true },
    { name: "not equals", label: "≠", needsValue: true },
    { name: "greater than", label: ">", needsValue: true },
    { name: "greater or equal", label: "≥", needsValue: true },
    { name: "less than", label: "<", needsValue: true },
    { name: "less or equal", label: "≤", needsValue: true },
    { name: "contains", label: "contains", needsValue: true },
    { name: "does not contain", label: "does not contain", needsValue: true },
    { name: "starts with", label: "starts with", needsValue: true },
    { name: "ends with", label: "ends with", needsValue: true },
    { name: "in list", label: "in list (a, b, c)", needsValue: true },
    { name: "not in list", label: "not in list (a, b, c)", needsValue: true },
    { name: "is empty", label: "is empty", needsValue: false },
    { name: "is not empty", label: "is not empty", needsValue: false },
];
const MAX_CONDITIONS = 16; // must match MAX_CONDITIONS in the .py file
const OUTPUT_MODES = ["matching rows", "selected rows"]; // must match OUTPUT_MODES in the .py file
const TABLE_MIN_H = 200;
const TABLE_MAX_H = 640;
const FIXED_OUTPUTS = 3;          // next_row_index, total_rows, loop_finished
const MAX_COLUMN_OUTPUTS = 64;    // must match MAX_COLUMN_OUTPUTS in the .py file
const PINK = "#ff94c2";              // factory accent, used as the reset value

// ---------------------------------------------------------------------------
// Theme
//
// Colours live in CSS custom properties so a change repaints every node instantly
// without rebuilding any DOM. THEME mirrors the same values for the few places that
// cannot use CSS - the canvas notice box and the link colour. Status colours
// (error / warning / ok) are deliberately not themeable: they carry meaning.
// ---------------------------------------------------------------------------
const THEME_DEFAULTS = {
    accent: PINK, panel: "#1e1e24", console: "#131316",
    font: '-apple-system, "Segoe UI", sans-serif',
    size: 11,
};
// Must match FONT_CHOICES in nova_sqlite_browser.py
const FONT_CHOICES = [
    { name: "System", value: '-apple-system, "Segoe UI", sans-serif' },
    { name: "Monospace", value: 'ui-monospace, "Cascadia Code", "Fira Code", monospace' },
    { name: "Humanist", value: '"Noto Sans", "Segoe UI", Roboto, sans-serif' },
    { name: "Condensed", value: '"Roboto Condensed", "Segoe UI", sans-serif' },
];
// The data areas stay monospace so columns line up, but they scale with the size.
const MONO_STACK = 'ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace';
const THEME = { ...THEME_DEFAULTS };

const THEME_PRESETS = [
    { name: "Nova pink", accent: "#ff94c2", panel: "#1e1e24", console: "#131316" },
    { name: "Cyan", accent: "#5ad2e6", panel: "#17212450", console: "#101619" },
    { name: "Amber", accent: "#f0a93b", panel: "#221d14", console: "#17130d" },
    { name: "Mint", accent: "#5fd39b", panel: "#16211c", console: "#0f1714" },
    { name: "Violet", accent: "#a98bf0", panel: "#1d1926", console: "#14111c" },
    { name: "Slate", accent: "#8fa3bf", panel: "#1b1f26", console: "#12151a" },
];

const hexToRgb = (hex) => {
    const h = String(hex || "").replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6).padEnd(6, "0");
    const n = parseInt(full, 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [30, 30, 36];
};
const mix = (a, b, t) => {
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
    return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
};
const luma = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/**
 * Text and lines are derived FROM each background, towards black on a light
 * surface and towards white on a dark one. Without this, choosing a pale panel
 * leaves white text on white.
 */
const scaleFor = (bg) => {
    const ink = luma(bg) > 0.5 ? "#000000" : "#ffffff";
    return {
        text: mix(bg, ink, 0.90),
        dim: mix(bg, ink, 0.62),
        faint: mix(bg, ink, 0.44),
        line: mix(bg, ink, 0.20),
        field: mix(bg, ink, 0.09),
        hover: mix(bg, ink, 0.15),
        chip: mix(bg, ink, 0.14),
    };
};
/** An accent readable as text on the given background. */
const accentOn = (bg, accent) =>
    luma(bg) > 0.5 ? mix(accent, "#000000", 0.35) : mix(accent, "#ffffff", 0.28);

function applyTheme(next, { save = false } = {}) {
    Object.assign(THEME, THEME_DEFAULTS, next || {});
    THEME.size = Math.max(9, Math.min(16, Number(THEME.size) || THEME_DEFAULTS.size));
    if (!FONT_CHOICES.some((f) => f.value === THEME.font)) THEME.font = THEME_DEFAULTS.font;
    const c = scaleFor(THEME.console);
    const p = scaleFor(THEME.panel);
    THEME.accentOnConsole = accentOn(THEME.console, THEME.accent);
    THEME.accentOnPanel = accentOn(THEME.panel, THEME.accent);
    const [ar, ag, ab] = hexToRgb(THEME.accent);
    const tint = (a) => `rgba(${ar},${ag},${ab},${a})`;

    let style = document.getElementById("nova-sqlite-theme");
    if (!style) {
        style = document.createElement("style");
        style.id = "nova-sqlite-theme";
        document.head.appendChild(style);
    }
    style.textContent = `:root {
        --nsq-accent: ${THEME.accent};
        --nsq-panel: ${THEME.panel};
        --nsq-console: ${THEME.console};
        --nsq-accent-bright: ${THEME.accentOnConsole};
        --nsq-accent-p: ${THEME.accentOnPanel};
        --nsq-accent-dim: ${mix(THEME.accentOnConsole, THEME.console, 0.45)};
        --nsq-accent-a10: ${tint(0.10)};
        --nsq-accent-a13: ${tint(0.13)};
        --nsq-accent-a20: ${tint(0.20)};
        --nsq-accent-a30: ${tint(0.30)};
        --nsq-c-text: ${c.text};   --nsq-c-dim: ${c.dim};   --nsq-c-faint: ${c.faint};
        --nsq-c-line: ${c.line};   --nsq-c-hover: ${c.hover};
        --nsq-p-text: ${p.text};   --nsq-p-dim: ${p.dim};   --nsq-p-faint: ${p.faint};
        --nsq-p-line: ${p.line};   --nsq-p-field: ${p.field};
        --nsq-p-hover: ${p.hover}; --nsq-p-chip: ${p.chip};
        --nsq-font: ${THEME.font};
        --nsq-mono: ${MONO_STACK};
        --nsq-size: ${THEME.size}px;
        --nsq-danger: #ff557f;
        --nsq-warn: #ffd27f;
        --nsq-ok: #7fffb0;
    }`;

    const Canvas = window.LGraphCanvas;
    if (Canvas?.link_type_colors) Canvas.link_type_colors[ROWS_TYPE] = THEME.accent;
    if (app.canvas?.default_connection_color_byType) {
        app.canvas.default_connection_color_byType[ROWS_TYPE] = THEME.accent;
    }
    app.canvas?.setDirty?.(true, true);

    if (save) {
        api.fetchApi("/sqlite_browser/theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                accent: THEME.accent, panel: THEME.panel, console: THEME.console,
                font: THEME.font, size: THEME.size,
            }),
        }).catch((err) => console.warn("[Nova SQLite] could not save the theme:", err));
    }
}

async function loadTheme() {
    try {
        const res = await api.fetchApi("/sqlite_browser/theme", { method: "GET" });
        const data = await res.json();
        applyTheme(data?.theme);
    } catch {
        applyTheme(THEME_DEFAULTS);     // a missing store is not an error
    }
}

const DOM_MARGIN = 10;            // horizontal inset of DOM content inside the node
const VIEWER_MIN_H = 120;
const VIEWER_MAX_H = 460;
const TOOLBAR_H = 28;        // height the Refresh / Execute row adds

// Row highlighting for the Data Table grid. Injected once, class names are prefixed.
function installGridStyles() {
    if (document.getElementById("nova-sqlite-grid-styles")) return;
    const style = document.createElement("style");
    style.id = "nova-sqlite-grid-styles";
    style.textContent = `
        .nsq-grid table { user-select: none; }
        .nsq-row { cursor: pointer; }
        .nsq-row > td { transition: background 0.08s linear; }
        .nsq-row:hover > td { background: var(--nsq-c-hover); }
        .nsq-row.nsq-sel > td { background: var(--nsq-accent-a20); color: var(--nsq-c-text); }
        .nsq-row.nsq-sel:hover > td { background: var(--nsq-accent-a30); }
        .nsq-row.nsq-sel > td.nsq-num { color: var(--nsq-accent); box-shadow: inset 3px 0 0 var(--nsq-accent); font-weight: bold; }
        .nsq-row.nsq-lead > td.nsq-num { text-decoration: underline; }
        .nsq-link { cursor: pointer; text-decoration: underline; user-select: none; }
    `;
    document.head.appendChild(style);
}

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

const slotByName = (list, name) => list?.findIndex((s) => s.name === name) ?? -1;

// Which input a node takes its rows on. The Data Table can be fed by either wire.
const rowsInputSlot = (node) => {
    const rows = slotByName(node?.inputs, "row_data_json");
    if (rows >= 0 && node.inputs[rows].link != null) return rows;
    const table = slotByName(node?.inputs, "table");
    if (table >= 0 && node.inputs[table].link != null) return table;
    return rows >= 0 ? rows : table;
};

// The Browser carries the same columns on its rows output and its NOVA_TABLE output
const browserRowsSlots = (node) =>
    [0, slotByName(node?.outputs, "table")].filter((i) => i >= 0);

// Browser node feeding a node's row_data_json input (follows reroutes and the Data Table node)
function upstreamBrowser(startNode) {
    let node = startNode;
    let slot = rowsInputSlot(node);
    for (let guard = 0; guard < 20 && node && slot >= 0; guard++) {
        const link = getLink(node.graph, node.inputs[slot]?.link);
        if (!link) return null;
        const origin = node.graph.getNodeById(link.origin_id);
        if (!origin) return null;
        if (origin.comfyClass === BROWSER) {
            return browserRowsSlots(origin).includes(link.origin_slot) ? origin : null;
        }
        if (origin.comfyClass === WHERE_FILTER) {
            // Only the filtered rows / table outputs carry the column set
            if (!browserRowsSlots(origin).includes(link.origin_slot)) return null;
            node = origin;
            slot = rowsInputSlot(origin);
            continue;
        }
        if (!isReroute(origin)) return null;
        node = origin;
        slot = 0;
    }
    return null;
}

// Row nodes fed by a browser's row_data_json output (follows reroutes and the Data Table node)
function downstreamIterators(browserNode) {
    const found = [];
    const visit = (node, slot, depth) => {
        if (depth > 20) return;
        for (const id of node.outputs?.[slot]?.links ?? []) {
            const link = getLink(node.graph, id);
            if (!link) continue;
            const target = node.graph.getNodeById(link.target_id);
            if (!target || found.includes(target)) continue;
            if (VIEWER_CLASSES.has(target.comfyClass)) {
                found.push(target);
                // The Data Table passes the same columns on to whatever it feeds
                if (target.comfyClass === WHERE_FILTER) {
                    for (const s of browserRowsSlots(target)) visit(target, s, depth + 1);
                }
            } else if (isReroute(target)) {
                visit(target, 0, depth + 1);
            }
        }
    };
    for (const s of browserRowsSlots(browserNode)) visit(browserNode, s, 0);
    return found;
}



// ---------------------------------------------------------------------------
// In-node pop-outs
//
// Both the colour picker and the "this will break connections" prompt render
// inside the node itself rather than as a browser alert, so the canvas stays
// usable and the question is attached to the node it is about.
// ---------------------------------------------------------------------------
function openPopover(host, build, { width = 250, onDismiss } = {}) {
    host.querySelectorAll(".nsq-pop").forEach((el) => el.remove());

    const backdrop = document.createElement("div");
    backdrop.className = "nsq-pop";
    backdrop.style.cssText = `
        position:absolute; inset:0; z-index:40; display:flex; align-items:flex-start;
        justify-content:center; padding-top:10px; background:rgba(0,0,0,0.55);
        border-radius:8px; pointer-events:auto;
    `;

    const panel = document.createElement("div");
    panel.style.cssText = `
        width:${width}px; max-width:96%; max-height:96%; overflow:auto; box-sizing:border-box;
        background:var(--nsq-panel); border:1px solid var(--nsq-accent); border-radius:8px;
        padding:10px; box-shadow:0 8px 22px rgba(0,0,0,0.6); font-size:var(--nsq-size); color:var(--nsq-p-text);
    `;
    backdrop.appendChild(panel);

    let settled = false;
    const close = () => { settled = true; backdrop.remove(); };
    backdrop.addEventListener("pointerdown", (e) => {
        if (e.target !== backdrop) return;
        const wasOpen = !settled;
        close();
        if (wasOpen) onDismiss?.();          // clicking away is a cancel
    });
    backdrop.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    build(panel, close);
    host.appendChild(backdrop);
    return close;
}

function popButton(label, { primary = false } = {}) {
    const b = document.createElement("span");
    b.textContent = label;
    b.style.cssText = `
        cursor:pointer; user-select:none; padding:4px 10px; border-radius:5px; font-size:var(--nsq-size);
        border:1px solid ${primary ? "var(--nsq-accent)" : "var(--nsq-p-line)"};
        background:${primary ? "var(--nsq-accent-a20)" : "var(--nsq-p-field)"};
        color:${primary ? "var(--nsq-accent-p)" : "var(--nsq-p-dim)"}; white-space:nowrap;
    `;
    return b;
}

/** Confirmation prompt. Resolves true only if the user picks the confirm button. */
function confirmPopover(host, { title, message, detail = "", confirmLabel = "Continue", cancelLabel = "Cancel" }) {
    return new Promise((resolve) => {
        let answered = false;
        const settle = (value) => { if (!answered) { answered = true; resolve(value); } };
        openPopover(host, (panel, close) => {
            panel.innerHTML = `
                <div style="color:var(--nsq-warn); font-weight:700; margin-bottom:5px;">⚠ ${esc(title)}</div>
                <div style="color:var(--nsq-p-text); line-height:1.5; margin-bottom:6px;">${esc(message)}</div>
                ${detail ? `<div style="color:var(--nsq-accent-dim); line-height:1.45; margin-bottom:8px;">${esc(detail)}</div>` : ""}`;
            const row = document.createElement("div");
            row.style.cssText = "display:flex; gap:6px; justify-content:flex-end;";
            const cancel = popButton(cancelLabel);
            const ok = popButton(confirmLabel, { primary: true });
            cancel.onclick = () => { close(); settle(false); };
            ok.onclick = () => { close(); settle(true); };
            row.append(cancel, ok);
            panel.appendChild(row);
        }, { width: 270, onDismiss: () => settle(false) });
    });
}

/** The colour picker. Saves to the server, so new nodes come up in the chosen colours. */
function themePopover(host) {
    openPopover(host, (panel, close) => {
        const before = { ...THEME };        // restored if the user cancels
        const draft = { ...THEME };

        const head = document.createElement("div");
        head.style.cssText = "color:var(--nsq-accent); font-weight:700; margin-bottom:8px;";
        head.textContent = "🎨 Node colours";
        panel.appendChild(head);

        const presets = document.createElement("div");
        presets.style.cssText = "display:flex; flex-wrap:wrap; gap:5px; margin-bottom:9px;";
        for (const preset of THEME_PRESETS) {
            const chip = document.createElement("span");
            chip.title = preset.name;
            chip.style.cssText = `
                width:20px; height:20px; border-radius:5px; cursor:pointer;
                background:${preset.accent}; border:1px solid #00000060;
            `;
            chip.onclick = () => {
                Object.assign(draft, preset);
                delete draft.name;
                applyTheme(draft);
                sync();
            };
            presets.appendChild(chip);
        }
        panel.appendChild(presets);

        const fields = [
            ["accent", "Accent", "Borders, highlights and selected items"],
            ["panel", "Panel", "Badge area and condition builder"],
            ["console", "Console", "Data grid and row viewer"],
        ];
        const inputs = {};
        for (const [key, label, hint] of fields) {
            const row = document.createElement("label");
            row.style.cssText = "display:flex; align-items:center; gap:7px; margin-bottom:6px; cursor:pointer;";
            const swatch = document.createElement("input");
            swatch.type = "color";
            swatch.value = draft[key];
            swatch.style.cssText = "width:26px; height:22px; border:none; background:none; padding:0; cursor:pointer;";
            swatch.oninput = () => { draft[key] = swatch.value; applyTheme(draft); };
            const text = document.createElement("span");
            text.innerHTML = `<span style="color:var(--nsq-p-text);">${label}</span>
                <span style="color:var(--nsq-p-faint);"> — ${hint}</span>`;
            row.append(swatch, text);
            panel.appendChild(row);
            inputs[key] = swatch;
        }
        // Defined here, but only ever called from the preset chips and Reset - by then
        // the font controls below exist.
        const sync = () => {
            for (const [k, el] of Object.entries(inputs)) el.value = draft[k];
            fontSel.value = draft.font;
            sizeSel.value = String(draft.size);
        };

        const fontRow = document.createElement("div");
        fontRow.style.cssText = "display:flex; align-items:center; gap:6px; margin:8px 0 6px;";
        const fontSel = document.createElement("select");
        fontSel.style.cssText = `flex:1; min-width:0; background:var(--nsq-p-field); color:var(--nsq-p-text);
            border:1px solid var(--nsq-p-line); border-radius:4px; font-size:var(--nsq-size); padding:2px 4px; cursor:pointer;`;
        for (const f of FONT_CHOICES) {
            const o = document.createElement("option");
            o.value = f.value; o.textContent = f.name;
            fontSel.appendChild(o);
        }
        fontSel.value = draft.font;
        fontSel.onchange = () => { draft.font = fontSel.value; applyTheme(draft); };
        fontSel.addEventListener("pointerdown", (e) => e.stopPropagation());

        const sizeSel = document.createElement("select");
        sizeSel.style.cssText = fontSel.style.cssText.replace("flex:1; min-width:0;", "flex:0 0 58px;");
        for (const n of [9, 10, 11, 12, 13, 14, 15, 16]) {
            const o = document.createElement("option");
            o.value = String(n); o.textContent = `${n}px`;
            sizeSel.appendChild(o);
        }
        sizeSel.value = String(draft.size);
        sizeSel.onchange = () => { draft.size = Number(sizeSel.value); applyTheme(draft); };
        sizeSel.addEventListener("pointerdown", (e) => e.stopPropagation());

        const fontLabel = document.createElement("span");
        fontLabel.textContent = "Font";
        fontLabel.style.cssText = "color:var(--nsq-p-faint);";
        fontRow.append(fontLabel, fontSel, sizeSel);
        panel.appendChild(fontRow);

        const note = document.createElement("div");
        note.style.cssText = "color:var(--nsq-p-faint); margin:8px 0; line-height:1.45;";
        note.textContent = "Data grids stay monospace so columns line up, but they follow the size. "
            + "Saved for all four SQLite nodes, including ones you add later.";
        panel.appendChild(note);

        const row = document.createElement("div");
        row.style.cssText = "display:flex; gap:6px; justify-content:flex-end;";
        const reset = popButton("Reset");
        const cancel = popButton("Cancel");
        const save = popButton("Save", { primary: true });
        reset.onclick = () => { Object.assign(draft, THEME_DEFAULTS); applyTheme(draft); sync(); };
        cancel.onclick = () => { applyTheme(before); close(); };
        save.onclick = () => { applyTheme(draft, { save: true }); close(); };
        row.append(reset, cancel, save);
        panel.appendChild(row);
    }, { width: 268, onDismiss: () => applyTheme(before) });
}

/**
 * How many wires a change to the database or table would destroy: the dynamic
 * column outputs on the row nodes downstream disappear when the column selection
 * is rebuilt for a different table.
 */
function dynamicLinkImpact(browserNode) {
    let links = 0;
    const nodes = new Set();
    const walk = (node, depth) => {
        if (depth > 12) return;
        for (const target of directConsumers(node)) {
            if (target.comfyClass === WHERE_FILTER) { walk(target, depth + 1); continue; }
            for (let i = FIXED_OUTPUTS; i < (target.outputs?.length ?? 0); i++) {
                const n = target.outputs[i].links?.length ?? 0;
                if (n) { links += n; nodes.add(target); }
            }
        }
    };
    walk(browserNode, 0);
    return { links, nodes: [...nodes] };
}

// ---------------------------------------------------------------------------
// Toolbar: Refresh + Execute, shared by all four nodes
//
// Execute runs the query through the preview endpoints and paints the result into
// every node in the chain. It never queues a prompt, so the workflow does not run -
// the point is to have the data in front of you before you press Run.
// ---------------------------------------------------------------------------
const api_post = async (url, body) => {
    const res = await api.fetchApi(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    return res.json();
};

function makeToolbar({ onRefresh, onExecute, host, extra = [] }) {
    const bar = document.createElement("div");
    bar.style.cssText = `display:flex; align-items:center; gap:4px; flex:0 0 auto; min-width:0;`;

    const mk = (glyph, title, handler) => {
        const b = document.createElement("span");
        b.textContent = glyph;
        b.title = title;
        b.style.cssText = `
            cursor:pointer; user-select:none; flex:0 0 auto; font-size:calc(var(--nsq-size) + 1px); line-height:1;
            padding:3px 8px; border-radius:5px; border:1px solid var(--nsq-p-line); background:var(--nsq-p-field);
            color:var(--nsq-accent); transition:border-color .12s, background .12s;
        `;
        b.onmouseenter = () => { if (!b.dataset.busy) { b.style.borderColor = THEME.accent; b.style.background = "var(--nsq-p-hover)"; } };
        b.onmouseleave = () => { b.style.borderColor = "var(--nsq-p-line)"; b.style.background = "var(--nsq-p-field)"; };
        b.onclick = async (e) => {
            e.stopPropagation();
            if (b.dataset.busy) return;
            b.dataset.busy = "1";
            const before = b.textContent;
            b.textContent = "…";
            b.style.opacity = "0.6";
            try { await handler(); } finally {
                delete b.dataset.busy;
                b.textContent = before;
                b.style.opacity = "1";
            }
        };
        return b;
    };

    const refreshBtn = mk("⟳", "Refresh — rescan databases, tables and columns", onRefresh);
    const runBtn = mk("▶", "Execute — read the data now and show it below (does not run the workflow)", onExecute);
    const themeBtn = mk("🎨", "Colours — change the node colours for every SQLite node", () => {
        themePopover(typeof host === "function" ? host() : host);
    });

    const note = document.createElement("span");
    note.style.cssText = `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
        white-space:nowrap; color:var(--nsq-p-faint); font-size:calc(var(--nsq-size) - 1px); padding-left:2px;`;

    bar.append(refreshBtn, runBtn, themeBtn, ...extra, note);
    return { bar, note, refreshBtn, runBtn, themeBtn };
}

// Consumers fed directly by this node, following reroutes but NOT through the
// Data Table (which transforms the rows and so must be applied in order).
function directConsumers(node) {
    const found = [];
    const visit = (n, slot, depth) => {
        if (depth > 20) return;
        for (const id of n.outputs?.[slot]?.links ?? []) {
            const link = getLink(n.graph, id);
            if (!link) continue;
            const target = n.graph.getNodeById(link.target_id);
            if (!target || found.includes(target)) continue;
            if (VIEWER_CLASSES.has(target.comfyClass)) found.push(target);
            else if (isReroute(target)) visit(target, 0, depth + 1);
        }
    };
    for (const s of browserRowsSlots(node)) visit(node, s, 0);
    return found;
}

// Walks the chain from the browser outwards, previewing each node with the rows
// its upstream actually produced.
async function previewChain(startNode) {
    const browser = startNode.comfyClass === BROWSER ? startNode : upstreamBrowser(startNode);
    if (!browser) {
        startNode._novaPreviewNote?.("Connect a SQLite Browser first");
        return;
    }

    const head = await browser._novaPreviewSelf?.();
    if (!head?.ok) return;

    const walk = async (node, rowsJson, depth) => {
        if (depth > 12) return;
        for (const target of directConsumers(node)) {
            const out = await target._novaPreviewWith?.(rowsJson);
            if (target.comfyClass === WHERE_FILTER && out?.rows_json != null) {
                await walk(target, out.rows_json, depth + 1);
            }
        }
    };
    await walk(browser, head.rows_json, 0);
}

// ---------------------------------------------------------------------------
// Extension 1: Main Data Browser Node
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_browser",
    async setup() {
        await loadTheme();
    },
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
        wrap.style.cssText = `display:flex; flex-direction:column; gap:6px; overflow:hidden; min-height:0;
            position:relative; font-family:var(--nsq-font); font-size:var(--nsq-size);`;

        const bar = document.createElement("div");
        bar.style.cssText = `display:flex; align-items:center; gap:8px; font-size:var(--nsq-size); color:var(--nsq-p-dim); flex:0 0 auto; min-width:0;`;
        const countEl = document.createElement("span");
        countEl.style.cssText = `color:var(--nsq-accent); font-weight:bold; white-space:nowrap;`;
        const statusEl = document.createElement("span");
        statusEl.style.cssText = `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--nsq-p-faint);`;
        const mkBtn = (label) => {
            const b = document.createElement("span");
            b.textContent = label;
            b.style.cssText = `cursor:pointer; color:var(--nsq-accent); text-decoration:underline; user-select:none; white-space:nowrap;`;
            return b;
        };
        const allBtn = mkBtn("All");
        const noneBtn = mkBtn("None");
        bar.append(countEl, statusEl, allBtn, noneBtn);

        const toolbar = makeToolbar({
            host: () => wrap,
            onRefresh: async () => { await refreshDatabases(); await updateTables(); },
            onExecute: async () => { await previewChain(node); },
        });

        const badges = document.createElement("div");
        badges.style.cssText = `
            flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
            display:flex; flex-wrap:wrap; align-content:flex-start; gap:6px; padding:8px;
            background:var(--nsq-panel); border-radius:8px; border:1px dashed var(--nsq-accent); box-sizing:border-box;
        `;
        wrap.append(toolbar.bar, bar, badges);

        const badgeWidget = node.addDOMWidget("column_badges", "HTML", makeDomHost(wrap, 110), {
            getMinHeight: () => 110,
            hideOnZoom: false,
            serialize: false,
        });
        pinDomSize(node, badgeWidget, wrap, 80);

        const setStatus = (text, isError = false) => {
            statusEl.textContent = text || "";
            statusEl.title = text || "";
            statusEl.style.color = isError ? "var(--nsq-danger)" : "var(--nsq-p-faint)";
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
                badges.innerHTML = `<span style="color:var(--nsq-p-faint); font-size:var(--nsq-size); font-style:italic;">${
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
                    padding:4px 10px; border-radius:20px; font-size:var(--nsq-size); font-weight:bold;
                    cursor:pointer; user-select:none; transition:all 0.15s ease; display:inline-block;
                    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box;
                    background:${on ? "var(--nsq-accent)" : "var(--nsq-p-chip)"}; color:${on ? "var(--nsq-panel)" : "var(--nsq-p-dim)"};
                    border:1px solid ${on ? "var(--nsq-accent)" : "var(--nsq-p-line)"};
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

        // Rescan the input folder, sub-folders included
        const refreshDatabases = async () => {
            try {
                const data = await post("/sqlite_browser/list_databases", {});
                const files = data.databases || [];
                if (dbWidget) {
                    dbWidget.options.values = files.length ? files : ["(no database in input folder)"];
                    if (!files.includes(dbWidget.value) && files.length) dbWidget.value = files[0];
                }
                toolbar.note.textContent = files.length
                    ? `${files.length} database${files.length === 1 ? "" : "s"} found`
                    : "no databases under input/";
                toolbar.note.title = files.join("\n");
            } catch (err) {
                toolbar.note.textContent = `rescan failed: ${err.message}`;
            }
        };

        // Run this node's query now and hand the rows to the rest of the chain
        node._novaPreviewSelf = async () => {
            toolbar.note.textContent = "reading…";
            try {
                const data = await post("/sqlite_browser/preview/browser", {
                    database_path: dbWidget?.value,
                    table_name: tableWidget?.value,
                    selected_columns: selWidget?.value,
                });
                setStatus(data.status || (data.ok ? "" : "Query failed"), !data.ok);
                toolbar.note.textContent = data.ok
                    ? `${data.row_count} rows · ${data.column_count} columns`
                    : "query failed";
                node.setDirtyCanvas(true, true);
                return data;
            } catch (err) {
                setStatus(`Preview failed: ${err.message}`, true);
                toolbar.note.textContent = "preview failed";
                return { ok: false };
            }
        };
        node._novaPreviewNote = (text) => { toolbar.note.textContent = text; };

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

        /**
         * Changing the database or the table rebuilds the column selection, which
         * removes the dynamic outputs on the row nodes downstream and takes their
         * wires with them. When wires are actually at stake, ask first - in the node,
         * not in a browser dialog - and put the old value back if the answer is no.
         */
        const guardSourceChange = (widget, what, apply) => {
            if (!widget) return;
            let previous = widget.value;
            const original = widget.callback;

            widget.callback = function (...args) {
                const next = widget.value;
                if (next === previous) return original?.apply(this, args);

                const impact = dynamicLinkImpact(node);
                if (impact.links === 0) {                 // nothing to lose
                    previous = next;
                    const r = original?.apply(this, args);
                    apply();
                    return r;
                }

                widget.value = previous;                  // hold the change until answered
                node.setDirtyCanvas(true, true);

                const names = impact.nodes.map((n) => n.title || n.type).join(", ");
                confirmPopover(wrap, {
                    title: "This will break connections",
                    message: `Switching ${what} to "${next}" rebuilds the column selection, `
                        + `which removes ${impact.links} connected output${impact.links === 1 ? "" : "s"}.`,
                    detail: `Wired from: ${names}`,
                    confirmLabel: "Change anyway",
                    cancelLabel: "Keep current",
                }).then(async (ok) => {
                    if (!ok) {
                        setStatus(`Kept ${what} "${previous}"`);
                        return;
                    }
                    widget.value = next;
                    previous = next;
                    original?.apply(widget, args);
                    await apply();
                    app.canvas.draw(true, true);
                });
            };
        };

        guardSourceChange(dbWidget, "database", async () => {
            await updateTables();
            app.canvas.draw(true, true);
        });
        guardSourceChange(tableWidget, "table", async () => {
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
        // How far in from the right edge an output label ends: the slot dot and
        // its padding, which LiteGraph draws the label to the left of.
        const SLOT_RESERVE = 34;
        // Clear air between the notice and the nearest label.
        const NOTICE_GAP = 14;

        const drawNotice = function (ctx) {
            if (this.flags?.collapsed || !ctx) return;
            const LG = window.LiteGraph;
            const slotH = LG?.NODE_SLOT_HEIGHT ?? 20;
            ctx.save();

            // MEASURED IN THE FONT THE LABELS ARE ACTUALLY DRAWN IN.
            //
            // This used to measure them in THEME.font at THEME.size — the
            // panel's own font, which is this node's setting and has nothing to
            // do with the canvas. Raise NODE_SUBTEXT_SIZE in a theme and the
            // labels grow while the reservation does not, so the notice keeps
            // its old width and the two run into each other.
            //
            // `inner_text_font` is the string LiteGraph itself assigns to
            // ctx.font before drawing slot labels, so measuring with it cannot
            // disagree with what ends up on screen — including when a theme has
            // changed the size since the canvas was built, because the drawn
            // labels use that same stale value too.
            ctx.font = app?.canvas?.inner_text_font
                || `normal ${LG?.NODE_SUBTEXT_SIZE ?? 12}px ${LG?.NODE_FONT ?? "Arial"}`;
            const outputs = this.outputs ?? [];
            const labelW = Math.max(0, ...outputs.map(
                (o) => ctx.measureText(o.label ?? o.name ?? "").width));

            const x = 8;
            const y = 5;
            const w = this.size[0] - x - labelW - SLOT_RESERVE - NOTICE_GAP;

            // Prefer the slots' own geometry where the frontend exposes it:
            // with a larger label font the rows are taller than NODE_SLOT_HEIGHT
            // and a fixed multiple would leave the box short of the last one.
            const last = outputs[outputs.length - 1];
            const rect = last?.boundingRect;
            const slotsBottom = Array.isArray(rect) && rect.length >= 4
                ? rect[1] + rect[3]
                : outputs.length * slotH;
            const h = slotsBottom - y - 6;

            if (w < 90 || h < 24) { ctx.restore(); return; }

            // box
            ctx.fillStyle = THEME.panel;
            ctx.strokeStyle = THEME.accent;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
            else ctx.rect(x, y, w, h);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);

            // word-wrapped text, clipped to the box
            ctx.font = `${THEME.size}px ${THEME.font}`;
            ctx.fillStyle = THEME.accentOnPanel;
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
        setTimeout(async () => { await refreshDatabases(); await updateTables(); }, 100);
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

    const shell = document.createElement("div");
    shell.style.cssText = "display:flex; flex-direction:column; gap:6px; min-height:0; overflow:hidden;"
        + " position:relative; font-family:var(--nsq-font); font-size:var(--nsq-size);";

    const toolbar = makeToolbar({
        host: () => shell,
        onRefresh: async () => { syncFromUpstream(); node.refreshViewer(); },
        onExecute: async () => { await previewChain(node); },
    });

    const consoleEl = document.createElement("div");
    consoleEl.style.cssText = `
        flex:1 1 auto; min-height:0;
        background:var(--nsq-console); border-radius:6px; padding:8px; border:1px solid var(--nsq-accent);
        font-family:var(--nsq-mono); font-size:var(--nsq-size); color:var(--nsq-accent-bright); overflow:auto;
    `;
    const content = document.createElement("div");
    consoleEl.appendChild(content);
    shell.append(toolbar.bar, consoleEl);

    const viewerWidget = node.addDOMWidget("live_viewer", "HTML", makeDomHost(shell, VIEWER_MIN_H), {
        getMinHeight: () => node._viewerH,
        hideOnZoom: false,
        serialize: false,
    });
    viewerWidget.computeSize = (width) => [width ?? node.size[0], node._viewerH + DOM_MARGIN];
    pinDomSize(node, viewerWidget, shell, 60);

    // Preview: show the row this node would produce for the given upstream rows
    node._novaPreviewWith = async (rowsJson) => {
        toolbar.note.textContent = "reading…";
        try {
            const data = await api_post("/sqlite_browser/preview/row", {
                rows_json: rowsJson,
                mode: isLoop ? "iterator" : "single",
                row_index: rowWidget?.value ?? 0,
                stop_at_row: node.widgets.find((w) => w.name === "stop_at_row")?.value ?? -1,
                loop_mode: node.widgets.find((w) => w.name === "loop_mode")?.value ?? "increment",
            });
            applyPreview(data.ui || {});
            toolbar.note.textContent = data.ok ? "preview" : "preview failed";
            return data;
        } catch (err) {
            node._lastError = `Preview failed: ${err.message}`;
            node.refreshViewer();
            toolbar.note.textContent = "preview failed";
            return { ok: false };
        }
    };
    node._novaPreviewNote = (text) => { toolbar.note.textContent = text; };

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
            const contentH = (measured > 0 ? measured : estimate) + 18 + TOOLBAR_H; // padding + border + toolbar
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
            ? `<div style="color:var(--nsq-accent-dim); font-style:italic;">${cols.length} column(s) ready - press Run to load data.</div>`
            : `<div style="color:var(--nsq-accent-dim); font-style:italic;">${isLoop ? "Awaiting valid loop wire connection / column selection..." : "Awaiting valid wire connection / column selection..."}</div>`);
    };

    const renderError = (text) => {
        msg(`<div style="color:var(--nsq-danger); font-weight:bold; border:1px dotted var(--nsq-danger); padding:4px; word-break:break-word;">❌ ${esc(text)}</div>`);
    };

    const renderRow = (run) => {
        const { row, idx, total, stop, mode: loopMode, finished, warning, locked } = run;
        const cols = currentColumns();
        const progress = total ? Math.round(((idx + 1) / total) * 100) : 0;
        const detail = isLoop
            ? `index ${idx} · stop ${stop} · ${esc(loopMode)}`
            : `index ${idx}${locked ? " · only row" : ""}`;
        let h = `<div style="color:var(--nsq-accent); font-weight:bold; margin-bottom:6px; border-bottom:1px solid var(--nsq-accent); padding-bottom:2px; overflow-wrap:anywhere;">
            ✨ Row [ ${idx + 1} / ${total} ]
            <span style="color:var(--nsq-accent-dim); font-weight:normal;">${detail}</span>
            ${isLoop && finished ? `<span style="color:var(--nsq-ok);"> ✅ loop finished</span>` : ""}
        </div>
        <div style="height:3px; background:var(--nsq-p-chip); border-radius:2px; margin-bottom:6px;">
            <div style="height:3px; width:${progress}%; background:var(--nsq-accent); border-radius:2px;"></div>
        </div>`;
        if (warning) h += `<div style="color:var(--nsq-warn); margin-bottom:4px;">⚠ ${esc(warning)}</div>`;
        if (!cols.length) {
            h += `<div style="color:var(--nsq-accent-dim); font-style:italic;">No columns selected.</div>`;
            msg(h);
            return;
        }
        h += `<table style="width:100%; border-collapse:collapse; table-layout:fixed;">`;
        for (const key of cols) {
            const has = Object.prototype.hasOwnProperty.call(row, key);
            const val = row[key];
            let text = !has ? "" : val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
            if (text.length > 400) text = text.slice(0, 400) + "…";
            const cell = has ? esc(text) : `<span style="color:var(--nsq-accent-dim); font-style:italic;">run to load</span>`;
            h += `<tr style="border-bottom:1px solid var(--nsq-c-line);">
                <td style="color:var(--nsq-c-faint); padding:3px 0; font-weight:bold; width:35%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:top;" title="${esc(key)}">${esc(key)}</td>
                <td style="color:var(--nsq-c-text); padding:3px 0 3px 6px; overflow-wrap:anywhere; word-break:break-word;">${cell}</td>
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

    /**
     * Paints one result into the viewer. Shared by a real execution and by the
     * toolbar's Execute, so a preview looks exactly like the real thing. Values may
     * arrive wrapped in lists (execution) or bare (preview); first() handles both.
     */
    function applyPreview(message) {
        const error = first(message.error);
        if (error) {
            node._loop = null;
            node._lastError = error;
            setRowLocked(!!first(message.row_locked));
            node.refreshViewer();
            return null;
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

        node._lastError = null;
        node._lastRun = run;
        setRowLocked(run.locked);

        // No browser directly upstream: fall back to the columns that actually ran
        if (!upstreamBrowser(node)) node.syncColumnOutputs(cols);
        node.refreshViewer();
        return run;
    }

    const onExecuted = node.onExecuted;
    node.onExecuted = function (message) {
        onExecuted?.apply(this, arguments);
        if (!message) return;

        const run = applyPreview(message);
        if (!run) return;
        const next = first(message.next_row_index) ?? run.idx;

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
// Extension 4: Data Table & Filter Node
//   Shows every row in a grid and narrows it down with conditions built here.
//   The conditions are stored as JSON and applied in Python, so nothing typed
//   here is ever pasted into SQL.
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_where_filter",
    async nodeCreated(node) {
        if (node.comfyClass !== WHERE_FILTER) return;

        installGridStyles();

        const whereWidget = node.widgets.find((w) => w.name === "where_json");
        const selWidget = node.widgets.find((w) => w.name === "selected_rows");
        const modeWidget = node.widgets.find((w) => w.name === "output_rows");
        hideWidget(whereWidget);
        hideWidget(selWidget);
        protectWidgetValues(node, ["where_json", "selected_rows", "output_rows", "case_sensitive", "max_display_rows"]);

        let columns = [];      // columns available to filter on
        let lastRun = null;    // { columns, rows, rowIds, matched, total, shown, conditions, warning, selected }
        let lastError = null;

        // --- row selection ------------------------------------------------------
        // Rows are keyed by their position in the incoming data, so a highlight
        // survives a change of conditions and a re-run.
        const readSelection = () => {
            const text = String(selWidget?.value ?? "").trim();
            if (!text.startsWith("[")) return new Set();
            try {
                const arr = JSON.parse(text);
                return new Set(Array.isArray(arr) ? arr.map(Number).filter(Number.isInteger) : []);
            } catch {
                return new Set();
            }
        };
        let selection = readSelection();
        let leadRow = null; // anchor for shift-click ranges

        const saveSelection = () => {
            if (selWidget) selWidget.value = JSON.stringify([...selection].sort((a, b) => a - b));
        };

        const readState = () => {
            const text = String(whereWidget?.value ?? "").trim();
            if (!text.startsWith("[")) return [];
            try {
                const parsed = JSON.parse(text);
                if (!Array.isArray(parsed)) return [];
                return parsed.slice(0, MAX_CONDITIONS).map((c) => ({
                    column: String(c?.column ?? ""),
                    operator: OPERATORS.some((o) => o.name === c?.operator) ? c.operator : OPERATORS[0].name,
                    value: c?.value == null ? "" : String(c.value),
                    join: String(c?.join ?? "AND").toUpperCase() === "OR" ? "OR" : "AND",
                    enabled: c?.enabled !== false,
                }));
            } catch {
                return [];
            }
        };
        let state = readState();

        const saveState = () => {
            if (whereWidget) whereWidget.value = JSON.stringify(state);
        };

        // --- DOM ---------------------------------------------------------------
        const wrap = document.createElement("div");
        wrap.style.cssText = `display:flex; flex-direction:column; gap:6px; overflow:hidden; min-height:0;
            position:relative; font-family:var(--nsq-font); font-size:var(--nsq-size);`;

        const bar = document.createElement("div");
        bar.style.cssText = `display:flex; align-items:center; gap:8px; font-size:var(--nsq-size); color:var(--nsq-p-dim); flex:0 0 auto; min-width:0;`;
        const countEl = document.createElement("span");
        countEl.style.cssText = `color:var(--nsq-accent); font-weight:bold; white-space:nowrap;`;
        const noteEl = document.createElement("span");
        noteEl.style.cssText = `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--nsq-p-faint);`;
        const mkBtn = (label, title) => {
            const b = document.createElement("span");
            b.textContent = label;
            b.title = title;
            b.style.cssText = `cursor:pointer; color:var(--nsq-accent); text-decoration:underline; user-select:none; white-space:nowrap;`;
            return b;
        };
        const addBtn = mkBtn("+ Condition", "Add a filter condition");
        const clearBtn = mkBtn("Clear", "Remove all conditions");
        bar.append(countEl, noteEl, addBtn, clearBtn);

        const toolbar = makeToolbar({
            host: () => wrap,
            onRefresh: async () => { syncFromUpstream(); refresh(); },
            onExecute: async () => { await previewChain(node); },
        });

        const builder = document.createElement("div");
        builder.style.cssText = `
            flex:0 0 auto; display:flex; flex-direction:column; gap:4px; max-height:190px; overflow-y:auto; overflow-x:hidden;
            padding:6px; background:var(--nsq-panel); border-radius:8px; border:1px dashed var(--nsq-accent); box-sizing:border-box;
        `;

        const grid = document.createElement("div");
        grid.className = "nsq-grid";
        grid.style.cssText = `
            flex:1 1 auto; min-height:0; overflow:auto; box-sizing:border-box;
            background:var(--nsq-console); border-radius:6px; padding:8px; border:1px solid var(--nsq-accent);
            font-family:var(--nsq-mono); font-size:var(--nsq-size); color:var(--nsq-accent-bright);
        `;
        const gridContent = document.createElement("div");
        grid.appendChild(gridContent);

        wrap.append(toolbar.bar, bar, builder, grid);

        node._viewerH = TABLE_MIN_H;
        const viewerWidget = node.addDOMWidget("where_builder", "HTML", makeDomHost(wrap, TABLE_MIN_H), {
            getMinHeight: () => node._viewerH,
            hideOnZoom: false,
            serialize: false,
        });
        viewerWidget.computeSize = (width) => [width ?? node.size[0], node._viewerH + DOM_MARGIN];
        pinDomSize(node, viewerWidget, wrap, 120);

        // Keep clicks, typing and grid scrolling inside the widgets instead of panning the canvas
        wrap.addEventListener("pointerdown", (e) => e.stopPropagation());
        grid.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
        builder.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

        // --- condition rows ----------------------------------------------------
        const FIELD = `
            background:var(--nsq-p-field); color:var(--nsq-p-text); border:1px solid var(--nsq-p-line); border-radius:4px;
            font-size:var(--nsq-size); padding:2px 4px; box-sizing:border-box; min-width:0; height:22px;
        `;

        const mkSelect = (options, value, onChange, width) => {
            const s = document.createElement("select");
            s.style.cssText = FIELD + `flex:0 0 ${width}; width:${width}; cursor:pointer;`;
            for (const o of options) {
                const opt = document.createElement("option");
                opt.value = o.value;
                opt.textContent = o.label;
                s.appendChild(opt);
            }
            s.value = value;
            if (s.value !== value && options.length) s.selectedIndex = 0;
            s.onchange = () => onChange(s.value);
            return s;
        };

        const renderBuilder = () => {
            builder.innerHTML = "";
            if (!state.length) {
                const hint = document.createElement("span");
                hint.textContent = columns.length
                    ? "No conditions - all rows are passed through. Use + Condition to narrow them down."
                    : "Connect the SQLite Browser (or a NOVA_TABLE) and press Run to load the columns.";
                hint.style.cssText = "color:var(--nsq-p-faint); font-size:var(--nsq-size); font-style:italic;";
                builder.appendChild(hint);
                return;
            }

            const colOptions = columns.map((c) => ({ value: c, label: c }));
            state.forEach((cond, i) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex; align-items:center; gap:4px; min-width:0;";

                if (i === 0) {
                    const spacer = document.createElement("span");
                    spacer.textContent = "·";
                    spacer.style.cssText = "flex:0 0 54px; width:54px; color:var(--nsq-p-faint); text-align:center; font-size:var(--nsq-size);";
                    row.appendChild(spacer);
                } else {
                    row.appendChild(mkSelect(
                        [{ value: "AND", label: "AND" }, { value: "OR", label: "OR" }],
                        cond.join,
                        (v) => { cond.join = v; commit(false); },
                        "54px",
                    ));
                }

                const colSelect = mkSelect(
                    colOptions.length ? colOptions : [{ value: cond.column, label: cond.column || "(no columns)" }],
                    cond.column,
                    (v) => { cond.column = v; commit(false); },
                    "31%",
                );
                if (columns.length && !columns.includes(cond.column)) {
                    colSelect.style.borderColor = "var(--nsq-danger)";
                    colSelect.title = `'${cond.column}' is not one of the selected columns`;
                }
                row.appendChild(colSelect);

                row.appendChild(mkSelect(
                    OPERATORS.map((o) => ({ value: o.name, label: o.label })),
                    cond.operator,
                    (v) => { cond.operator = v; commit(true); },
                    "31%",
                ));

                const spec = OPERATORS.find((o) => o.name === cond.operator);
                const valueEl = document.createElement("input");
                valueEl.type = "text";
                valueEl.value = cond.value;
                valueEl.placeholder = spec?.name.includes("list") ? "a, b, c" : "value";
                valueEl.style.cssText = FIELD + "flex:1 1 60px;";
                if (!spec || spec.needsValue === false) {
                    valueEl.disabled = true;
                    valueEl.value = "";
                    valueEl.placeholder = "-";
                    valueEl.style.opacity = "0.4";
                }
                // Typing only updates the stored value, so the field never loses focus
                valueEl.oninput = () => { cond.value = valueEl.value; saveState(); };
                valueEl.onchange = () => { cond.value = valueEl.value; commit(false); };
                row.appendChild(valueEl);

                const del = document.createElement("span");
                del.textContent = "✕";
                del.title = "Remove this condition";
                del.style.cssText = "flex:0 0 16px; text-align:center; cursor:pointer; color:var(--nsq-danger); user-select:none; font-size:var(--nsq-size);";
                del.onclick = () => { state.splice(i, 1); commit(true); };
                row.appendChild(del);

                builder.appendChild(row);
            });
        };

        const renderGrid = () => {
            if (lastError) {
                gridContent.innerHTML = `<div style="color:var(--nsq-danger); font-weight:bold; border:1px dotted var(--nsq-danger); padding:4px; word-break:break-word;">❌ ${esc(lastError)}</div>`;
                return;
            }
            if (!lastRun) {
                gridContent.innerHTML = `<div style="color:var(--nsq-accent-dim); font-style:italic;">${
                    columns.length ? `${columns.length} column(s) ready - press Run to load the data.` : "Awaiting a connection on row_data_json or table..."
                }</div>`;
                return;
            }

            const { rows, rowIds, columns: cols, matched, total, shown, conditions, warning } = lastRun;
            const selectedOnly = modeWidget?.value === OUTPUT_MODES[1];
            const selCount = [...selection].length;

            let h = `<div style="color:var(--nsq-accent); font-weight:bold; margin-bottom:6px; border-bottom:1px solid var(--nsq-accent); padding-bottom:2px; overflow-wrap:anywhere;">
                ✨ ${matched} / ${total} rows
                <span style="color:var(--nsq-accent-dim); font-weight:normal;">${conditions} condition${conditions === 1 ? "" : "s"}${shown < matched ? ` · showing ${shown}` : ""}</span>
                ${selCount ? `<span style="color:var(--nsq-accent);"> · ${selCount} selected</span>` : ""}
                <span style="float:right; font-weight:normal;">
                    <span class="nsq-link" data-act="all" style="color:var(--nsq-accent);" title="Select every row shown">all</span>
                    <span style="color:var(--nsq-c-line);"> | </span>
                    <span class="nsq-link" data-act="invert" style="color:var(--nsq-accent);" title="Invert the selection">invert</span>
                    <span style="color:var(--nsq-c-line);"> | </span>
                    <span class="nsq-link" data-act="none" style="color:var(--nsq-accent);" title="Clear the selection">none</span>
                </span>
            </div>`;
            if (warning) h += `<div style="color:var(--nsq-warn); margin-bottom:4px; overflow-wrap:anywhere;">⚠ ${esc(warning)}</div>`;
            if (selectedOnly) {
                h += `<div style="color:var(--nsq-accent); margin-bottom:4px;">▶ Only the highlighted rows leave this node (${selCount}).</div>`;
            }

            if (!rows.length) {
                h += `<div style="color:var(--nsq-accent-dim); font-style:italic;">No rows match the current conditions.</div>`;
                gridContent.innerHTML = h;
                return;
            }

            // In "selected rows" mode the # column numbers the rows that actually leave the node
            let outPos = 0;

            h += `<table style="border-collapse:collapse; white-space:nowrap;">
                <thead><tr>
                    <th style="position:sticky; top:0; background:var(--nsq-console); color:var(--nsq-c-faint); text-align:right; padding:2px 8px 4px 0; border-bottom:1px solid var(--nsq-accent);" title="The row number the Iterator and Single Row nodes use">#</th>`;
            for (const c of cols) {
                h += `<th style="position:sticky; top:0; background:var(--nsq-console); color:var(--nsq-c-faint); text-align:left; padding:2px 10px 4px 0; border-bottom:1px solid var(--nsq-accent); max-width:240px; overflow:hidden; text-overflow:ellipsis;" title="${esc(c)}">${esc(c)}</th>`;
            }
            h += `</tr></thead><tbody>`;
            rows.forEach((row, i) => {
                const id = rowIds?.[i] ?? i;
                const on = selection.has(id);
                const num = selectedOnly ? (on ? outPos++ : "·") : i;
                const cls = `nsq-row${on ? " nsq-sel" : ""}${leadRow === id ? " nsq-lead" : ""}`;
                h += `<tr class="${cls}" data-id="${id}" data-i="${i}" style="border-bottom:1px solid var(--nsq-c-line);">
                    <td class="nsq-num" style="color:var(--nsq-c-faint); text-align:right; padding:3px 8px 3px 0; vertical-align:top;">${num}</td>`;
                for (const c of cols) {
                    const val = row?.[c];
                    let text = val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
                    const full = text;
                    if (text.length > 160) text = text.slice(0, 160) + "…";
                    h += `<td style="color:var(--nsq-c-text); padding:3px 10px 3px 0; max-width:240px; overflow:hidden; text-overflow:ellipsis; vertical-align:top;" title="${esc(full)}">${esc(text)}</td>`;
                }
                h += `</tr>`;
            });
            h += `</tbody></table>`;
            // Keep the reader where they were when a selection change redraws the grid
            const top = grid.scrollTop;
            const left = grid.scrollLeft;
            gridContent.innerHTML = h;
            grid.scrollTop = top;
            grid.scrollLeft = left;
        };

        // --- mouse selection ----------------------------------------------------
        const shownIds = () => (lastRun?.rowIds ?? []).map(Number);

        // Repaints without rebuilding the table, so the scroll position is kept
        const paintSelection = () => {
            const selectedOnly = modeWidget?.value === OUTPUT_MODES[1];
            let outPos = 0;
            for (const tr of gridContent.querySelectorAll("tr.nsq-row")) {
                const id = Number(tr.dataset.id);
                const on = selection.has(id);
                tr.classList.toggle("nsq-sel", on);
                tr.classList.toggle("nsq-lead", leadRow === id);
                const num = tr.querySelector("td.nsq-num");
                if (num) num.textContent = selectedOnly ? (on ? outPos++ : "·") : tr.dataset.i;
            }
            saveSelection();
            updateBar();
            node.setDirtyCanvas(true, true);
        };

        const setSelected = (ids, on) => {
            for (const id of ids) {
                if (on) selection.add(id);
                else selection.delete(id);
            }
        };

        const rangeBetween = (a, b) => {
            const ids = shownIds();
            const ia = ids.indexOf(a);
            const ib = ids.indexOf(b);
            if (ia < 0 || ib < 0) return [b];
            return ids.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
        };

        // --- keeping the rest of the chain in step with the selection --------
        /**
         * SELECTING ROWS IS AN EDIT TO THIS NODE'S OUTPUT, so the nodes fed by
         * it are stale the moment the selection changes. Until now only ▶ told
         * them otherwise, which meant a Single Row node downstream went on
         * showing a row nobody had selected any more. Changing the selection
         * now runs exactly what ▶ runs.
         *
         * Debounced, because dragging across rows changes the selection on
         * every pointermove, and each run is a round trip for every node
         * downstream. It also refuses to run for a selection it has already
         * run for, so a click that puts the selection back where it was — or a
         * drag that ends where it started — costs nothing.
         */
        const selectionKey = () => [...selection].sort((a, b) => a - b).join(",");
        let firedFor = selectionKey();   // the state on load is not a change
        let fireTimer = null;
        let firing = false;

        const runChain = async () => {
            // A run already in flight is left to finish: starting a second
            // would have two walks of the same chain writing over each other.
            if (firing) { fireTimer = setTimeout(runChain, 120); return; }
            const key = selectionKey();
            if (key === firedFor) return;
            firing = true;
            try { await previewChain(node); firedFor = key; }
            catch { /* leave firedFor alone so the next change tries again */ }
            finally { firing = false; }
        };

        const fireSelection = () => {
            clearTimeout(fireTimer);
            fireTimer = setTimeout(runChain, 120);
        };

        let dragging = null;   // { mode: "add" | "remove" }

        const onRowPointerDown = (e, tr) => {
            const id = Number(tr.dataset.id);
            if (e.shiftKey && leadRow != null) {
                setSelected(rangeBetween(leadRow, id), true);
                dragging = { mode: "add" };
            } else if (e.ctrlKey || e.metaKey) {
                const on = !selection.has(id);
                setSelected([id], on);
                leadRow = id;
                dragging = { mode: on ? "add" : "remove" };
            } else {
                // Plain click: start a fresh selection, unless it is a drag off an existing one
                const only = selection.size === 1 && selection.has(id);
                selection = new Set(only ? [] : [id]);
                leadRow = only ? null : id;
                dragging = { mode: "add" };
            }
            paintSelection();
        };

        gridContent.addEventListener("pointerdown", (e) => {
            const link = e.target.closest?.(".nsq-link");
            if (link) {
                const act = link.dataset.act;
                const ids = shownIds();
                if (act === "all") selection = new Set(ids);
                else if (act === "none") { selection = new Set(); leadRow = null; }
                else if (act === "invert") selection = new Set(ids.filter((i) => !selection.has(i)));
                paintSelection();
                renderGrid();     // the # column and the header banner both change
                fireSelection();
                return;
            }
            const tr = e.target.closest?.("tr.nsq-row");
            if (!tr) return;
            e.preventDefault();
            onRowPointerDown(e, tr);
            gridContent.setPointerCapture?.(e.pointerId);
        });

        // Drag across rows to extend the selection
        gridContent.addEventListener("pointermove", (e) => {
            if (!dragging || e.buttons === 0) return;
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const tr = el?.closest?.("tr.nsq-row");
            if (!tr || !gridContent.contains(tr)) return;
            const id = Number(tr.dataset.id);
            if (leadRow == null) leadRow = id;
            setSelected(rangeBetween(leadRow, id), dragging.mode === "add");
            paintSelection();
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = null;
            if (e?.pointerId != null) gridContent.releasePointerCapture?.(e.pointerId);
            renderGrid();   // refresh the header tally and the # numbering
            // The end of the gesture, not each step of it: one run per click or
            // drag, however many rows it passed over.
            fireSelection();
        };
        gridContent.addEventListener("pointerup", endDrag);
        gridContent.addEventListener("pointercancel", endDrag);

        const autoFit = () => {
            requestAnimationFrame(() => {
                const builderH = Math.min(190, builder.scrollHeight || 24);
                const gridH = Math.min(TABLE_MAX_H, (gridContent.offsetHeight || 40) + 18);
                const needed = builderH + gridH + 30 + TOOLBAR_H; // bars + gaps + toolbar
                node._viewerH = Math.min(TABLE_MAX_H, Math.max(TABLE_MIN_H, needed));
                node._wantFit = true;
                node.setDirtyCanvas(true, true);
                app.canvas?.draw(true, true);
            });
        };

        const updateBar = () => {
            const active = state.filter((c) => c.enabled !== false).length;
            countEl.textContent = lastRun ? `${lastRun.matched} / ${lastRun.total} rows` : "";
            const bits = [];
            bits.push(active
                ? `${active} condition${active === 1 ? "" : "s"}${state.length > active ? ` (${state.length - active} off)` : ""}`
                : "no filter - all rows");
            if (selection.size) bits.push(`${selection.size} selected`);
            // SAYING WHY A SELECTION APPEARS TO DO NOTHING.
            //
            // In "matching rows" mode the highlight is only a highlight: every
            // matching row leaves the node whatever is selected, so a node
            // downstream shows the same thing after a click as before it. That
            // is correct, and it is indistinguishable from broken unless the
            // node says so — which, until now, it did not.
            const selectedOnly = modeWidget?.value === OUTPUT_MODES[1];
            if (selectedOnly) bits.push("output: selected only");
            else if (selection.size) bits.push('highlight only — set output_rows to "selected rows" to send it on');
            noteEl.textContent = bits.join(" · ");
            noteEl.title = noteEl.textContent;
        };

        // structural = the condition list changed shape, so the rows are rebuilt
        function commit(structural) {
            saveState();
            updateBar();
            if (structural) {
                renderBuilder();
                autoFit();
            }
            node.setDirtyCanvas(true, true);
        }

        const refresh = () => {
            renderBuilder();
            renderGrid();
            updateBar();
            autoFit();
        };

        // Switching the output mode changes the # numbering and the banner
        wrapCallback(modeWidget, () => {
            renderGrid();
            updateBar();
            autoFit();
        });

        addBtn.onclick = () => {
            if (state.length >= MAX_CONDITIONS) {
                noteEl.textContent = `Maximum of ${MAX_CONDITIONS} conditions`;
                return;
            }
            state.push({ column: columns[0] ?? "", operator: OPERATORS[0].name, value: "", join: "AND", enabled: true });
            commit(true);
        };
        clearBtn.onclick = () => { state = []; commit(true); };

        // Called by the Browser whenever the column badges change
        node.syncColumnOutputs = function (cols) {
            const next = (cols || []).map(String);
            if (next.length === columns.length && next.every((c, i) => c === columns[i])) return;
            columns = next;
            renderBuilder();
            updateBar();
            autoFit();
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
            const name = node.inputs?.[index]?.name;
            if (type !== INPUT || (name !== "row_data_json" && name !== "table")) return;
            setTimeout(() => {
                if (!syncFromUpstream()) {
                    lastRun = null;
                    lastError = null;
                    node.syncColumnOutputs([]);
                    refresh();
                }
            }, 0);
        };

        // Shared by a real execution and by the toolbar's Execute
        function applyResult(message) {
            const error = first(message.error);
            if (error) {
                lastError = error;
                lastRun = null;
                refresh();
                return;
            }

            const cols = first(message.columns) || [];
            const rows = first(message.rows) || [];
            lastError = null;
            lastRun = {
                columns: cols,
                rows,
                rowIds: (first(message.row_ids) || rows.map((_, i) => i)).map(Number),
                matched: first(message.matched_rows) ?? 0,
                total: first(message.total_rows) ?? 0,
                shown: first(message.shown_rows) ?? 0,
                conditions: first(message.condition_count) ?? 0,
                warning: first(message.warning) || "",
            };
            // Drop highlights for rows that no longer exist in the source data
            const totalIn = lastRun.total;
            const before = selection.size;
            selection = new Set([...selection].filter((i) => i >= 0 && i < totalIn));
            if (selection.size !== before) saveSelection();
            if (leadRow != null && !selection.has(leadRow) && leadRow >= totalIn) leadRow = null;
            node._whereClause = first(message.where_clause) || "";
            if (cols.length && !upstreamBrowser(node)) node.syncColumnOutputs(cols);
            refresh();
        }

        const onExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message) applyResult(message);
        };

        // Filter the rows handed down from upstream, and pass the result further on
        node._novaPreviewWith = async (rowsJson) => {
            toolbar.note.textContent = "filtering…";
            try {
                const data = await api_post("/sqlite_browser/preview/filter", {
                    rows_json: rowsJson,
                    where_json: whereWidget?.value ?? "[]",
                    selected_rows: selWidget?.value ?? "[]",
                    output_rows: modeWidget?.value ?? OUTPUT_MODES[0],
                    case_sensitive: !!node.widgets.find((w) => w.name === "case_sensitive")?.value,
                    max_display_rows: node.widgets.find((w) => w.name === "max_display_rows")?.value ?? 200,
                });
                applyResult(data.ui || {});
                toolbar.note.textContent = data.ok
                    ? `${first(data.ui?.matched_rows) ?? 0} / ${first(data.ui?.total_rows) ?? 0} rows`
                    : "filter failed";
                return data;
            } catch (err) {
                lastError = `Preview failed: ${err.message}`;
                refresh();
                toolbar.note.textContent = "preview failed";
                return { ok: false };
            }
        };
        node._novaPreviewNote = (text) => { toolbar.note.textContent = text; };

        refresh();
        setTimeout(() => { syncFromUpstream(); refresh(); }, 150);
        requestAnimationFrame(() => {
            const min = node.computeSize();
            node.setSize([Math.max(node.size[0], min[0], 520), Math.max(node.size[1], min[1], 380)]);
            node.setDirtyCanvas(true, true);
        });
    },
});

// ---------------------------------------------------------------------------
// Extension 5: Connection suggestions + link colour
//   Dragging from row_data_json and releasing on empty canvas suggests the
//   Data Table, Iterator and Single Row nodes; dragging back from their
//   row_data_json input suggests the Browser.
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.sqlite_connection_suggestions",
    setup() {
        const LG = window.LiteGraph;
        if (LG) {
            LG.slot_types_default_out = LG.slot_types_default_out || {};
            LG.slot_types_default_in = LG.slot_types_default_in || {};
            LG.slot_types_default_out[ROWS_TYPE] = [WHERE_FILTER, ITERATOR, SINGLE_ROW];
            LG.slot_types_default_in[ROWS_TYPE] = [BROWSER, WHERE_FILTER];
        }
        const Canvas = window.LGraphCanvas;
        if (Canvas) {
            Canvas.link_type_colors = Canvas.link_type_colors || {};
            Canvas.link_type_colors[ROWS_TYPE] = THEME.accent;
        }
        if (app.canvas) {
            app.canvas.default_connection_color_byType = app.canvas.default_connection_color_byType || {};
            app.canvas.default_connection_color_byType[ROWS_TYPE] = THEME.accent;
        }
    },
});
