import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const FLOWPULSE = "NovaFlowPulseNode";

// --- palette ---------------------------------------------------------------
// Series hues are validated for a dark chart surface. Each metric gets its own
// tile with its own axis and its own title, so no plot ever carries two series
// and identity is never colour-alone.
const SURFACE = "#15151a";
const PANEL = "#1b1b21";
const INK = "#e9e9ee";
const INK_2 = "#9a9aa8";
const INK_3 = "#6b6b78";
const GRID = "#2b2b34";
const PINK = "#ff94c2";              // Nova chrome accent: borders, selection, share bars
const SERIES = {
    cpu: "#3987e5",
    ram: "#199e70",
    disk: "#c98500",
    gpu: "#d55181",
};
const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };


// ---------------------------------------------------------------------------
// Theme
//
// Chrome only: accent, surfaces, label colours and the label font. The chart
// series colours and the status ramp are NOT themeable - those hues are validated
// for contrast and colour-blind separation, and they carry meaning.
//
// DOM styling goes through CSS custom properties so a change repaints instantly;
// THEME mirrors the resolved values for the canvas, which cannot read them.
// ---------------------------------------------------------------------------
const THEME_DEFAULTS = {
    accent: "#ff94c2",
    surface: "#15151a",
    panel: "#1b1b21",
    ink: "#e9e9ee",
    font: '-apple-system, "Segoe UI", sans-serif',
    size: 11,
};
const THEME = { ...THEME_DEFAULTS, grid: "#2b2b34", accentTint: "rgba(255,148,194,0.13)" };

const THEME_PRESETS = [
    { name: "Nova pink", accent: "#ff94c2", surface: "#15151a", panel: "#1b1b21", ink: "#e9e9ee" },
    { name: "Cyan", accent: "#5ad2e6", surface: "#101619", panel: "#172124", ink: "#e4f1f4" },
    { name: "Amber", accent: "#f0a93b", surface: "#17130d", panel: "#221d14", ink: "#f4ece0" },
    { name: "Mint", accent: "#5fd39b", surface: "#0f1714", panel: "#16211c", ink: "#e3f2ea" },
    { name: "Violet", accent: "#a98bf0", surface: "#14111c", panel: "#1d1926", ink: "#ece6f7" },
    { name: "Graphite", accent: "#9fb0c6", surface: "#131417", panel: "#1c1e23", ink: "#e6e8ec" },
];

const FONT_CHOICES = [
    { name: "System", value: '-apple-system, "Segoe UI", sans-serif' },
    { name: "Monospace", value: 'ui-monospace, "Cascadia Code", "Fira Code", monospace' },
    { name: "Humanist", value: '"Noto Sans", "Segoe UI", Roboto, sans-serif' },
    { name: "Condensed", value: '"Roboto Condensed", "Segoe UI", sans-serif' },
];

const hexToRgb = (hex) => {
    const h = String(hex).replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
    const n = parseInt(full, 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 148, 194];
};
const mix = (a, b, t) => {
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
    return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
};

function applyTheme(next, { save = false } = {}) {
    Object.assign(THEME, THEME_DEFAULTS, next || {});
    THEME.size = Math.max(9, Math.min(16, Number(THEME.size) || THEME_DEFAULTS.size));
    // derived, so one accent choice stays coherent
    THEME.grid = mix(THEME.ink, THEME.surface, 0.82);
    const [r, g, b] = hexToRgb(THEME.accent);
    THEME.accentTint = `rgba(${r},${g},${b},0.13)`;

    let style = document.getElementById("nova-flowpulse-theme");
    if (!style) {
        style = document.createElement("style");
        style.id = "nova-flowpulse-theme";
        document.head.appendChild(style);
    }
    style.textContent = `:root {
        --nfp-accent: ${THEME.accent};
        --nfp-surface: ${THEME.surface};
        --nfp-panel: ${THEME.panel};
        --nfp-ink: ${THEME.ink};
        --nfp-ink2: ${mix(THEME.ink, THEME.surface, 0.38)};
        --nfp-ink3: ${mix(THEME.ink, THEME.surface, 0.62)};
        --nfp-grid: ${THEME.grid};
        --nfp-font: ${THEME.font};
        --nfp-size: ${THEME.size}px;
    }`;
    app.canvas?.setDirty?.(true, true);

    if (save) {
        api.fetchApi("/nova_flowpulse/theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(THEME),
        }).catch((err) => console.warn("[Nova FlowPulse] could not save the theme:", err));
    }
}

async function loadTheme() {
    try {
        const res = await api.fetchApi("/nova_flowpulse/theme", { method: "GET" });
        applyTheme((await res.json())?.theme);
    } catch {
        applyTheme(THEME_DEFAULTS);
    }
}

// --- the colour pop-out, drawn on the node ---------------------------------
function themePopover(host) {
    host.querySelectorAll(".nfp-pop").forEach((el) => el.remove());
    const before = { ...THEME };

    const backdrop = document.createElement("div");
    backdrop.className = "nfp-pop";
    backdrop.style.cssText = `position:absolute; inset:0; z-index:40; display:flex;
        align-items:flex-start; justify-content:center; padding-top:10px;
        background:rgba(0,0,0,0.55); border-radius:8px;`;
    const panel = document.createElement("div");
    panel.style.cssText = `width:270px; max-width:96%; max-height:94%; overflow:auto; box-sizing:border-box;
        background:var(--nfp-panel); border:1px solid var(--nfp-accent); border-radius:8px; padding:10px;
        box-shadow:0 8px 22px rgba(0,0,0,.6); font-size:var(--nfp-size); color:var(--nfp-ink);`;
    backdrop.appendChild(panel);

    const close = () => backdrop.remove();
    backdrop.addEventListener("pointerdown", (e) => {
        if (e.target === backdrop) { applyTheme(before); close(); }
    });
    backdrop.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    const draft = { ...THEME };
    const mkBtn2 = (label, primary) => {
        const b = document.createElement("span");
        b.textContent = label;
        b.style.cssText = `cursor:pointer; user-select:none; padding:4px 10px; border-radius:5px;
            font-size:var(--nfp-size); white-space:nowrap;
            border:1px solid ${primary ? "var(--nfp-accent)" : "var(--nfp-grid)"};
            background:${primary ? THEME.accentTint : "var(--nfp-panel)"};
            color:${primary ? "var(--nfp-accent)" : "var(--nfp-ink2)"};`;
        return b;
    };

    panel.innerHTML = `<div style="color:var(--nfp-accent); font-weight:700; margin-bottom:8px;">🎨 Node colours</div>`;

    const presets = document.createElement("div");
    presets.style.cssText = "display:flex; flex-wrap:wrap; gap:5px; margin-bottom:9px;";
    for (const preset of THEME_PRESETS) {
        const chip = document.createElement("span");
        chip.title = preset.name;
        chip.style.cssText = `width:20px; height:20px; border-radius:5px; cursor:pointer;
            background:${preset.accent}; border:1px solid #00000060;`;
        chip.onclick = () => { Object.assign(draft, preset); delete draft.name; applyTheme(draft); sync(); };
        presets.appendChild(chip);
    }
    panel.appendChild(presets);

    const swatches = {};
    for (const [key, label, hint] of [
        ["accent", "Accent", "Buttons, borders, the running marker"],
        ["surface", "Surface", "The node background"],
        ["panel", "Panel", "Tiles and stat cards"],
        ["ink", "Labels", "Text; dimmer shades are derived"],
    ]) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex; align-items:center; gap:7px; margin-bottom:6px; cursor:pointer;";
        const sw = document.createElement("input");
        sw.type = "color";
        sw.value = draft[key];
        sw.style.cssText = "width:26px; height:22px; border:none; background:none; padding:0; cursor:pointer;";
        sw.oninput = () => { draft[key] = sw.value; applyTheme(draft); };
        const text = document.createElement("span");
        text.innerHTML = `<span>${label}</span><span style="color:var(--nfp-ink3);"> — ${hint}</span>`;
        row.append(sw, text);
        panel.appendChild(row);
        swatches[key] = sw;
    }

    const fontRow = document.createElement("div");
    fontRow.style.cssText = "display:flex; align-items:center; gap:6px; margin:8px 0 6px;";
    const fontSel = document.createElement("select");
    fontSel.style.cssText = `flex:1; background:var(--nfp-surface); color:var(--nfp-ink);
        border:1px solid var(--nfp-grid); border-radius:4px; font-size:var(--nfp-size); padding:2px 4px; cursor:pointer;`;
    for (const f of FONT_CHOICES) {
        const o = document.createElement("option");
        o.value = f.value; o.textContent = f.name;
        fontSel.appendChild(o);
    }
    fontSel.value = draft.font;
    fontSel.onchange = () => { draft.font = fontSel.value; applyTheme(draft); };
    fontSel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const sizeSel = document.createElement("select");
    sizeSel.style.cssText = fontSel.style.cssText.replace("flex:1;", "flex:0 0 58px;");
    for (const n of [9, 10, 11, 12, 13, 14]) {
        const o = document.createElement("option");
        o.value = String(n); o.textContent = `${n}px`;
        sizeSel.appendChild(o);
    }
    sizeSel.value = String(draft.size);
    sizeSel.onchange = () => { draft.size = Number(sizeSel.value); applyTheme(draft); };
    sizeSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    fontRow.append(Object.assign(document.createElement("span"),
        { textContent: "Font", style: "color:var(--nfp-ink3);" }), fontSel, sizeSel);
    panel.appendChild(fontRow);

    const sync = () => {
        for (const [k, el] of Object.entries(swatches)) el.value = draft[k];
        fontSel.value = draft.font;
        sizeSel.value = String(draft.size);
    };

    const note = document.createElement("div");
    note.style.cssText = "color:var(--nfp-ink3); margin:6px 0 8px; line-height:1.45;";
    note.textContent = "Chart colours stay as they are — those hues are validated for contrast and colour-blind readers.";
    panel.appendChild(note);

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:6px; justify-content:flex-end;";
    const reset = mkBtn2("Reset", false);
    const cancel = mkBtn2("Cancel", false);
    const save = mkBtn2("Save", true);
    reset.onclick = () => { Object.assign(draft, THEME_DEFAULTS); applyTheme(draft); sync(); };
    cancel.onclick = () => { applyTheme(before); close(); };
    save.onclick = () => { applyTheme(draft, { save: true }); close(); };
    row.append(reset, cancel, save);
    panel.appendChild(row);

    host.appendChild(backdrop);
}

const HISTORY = 900;
const MIN_POLL = 200;

// --- helpers ---------------------------------------------------------------
const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtBytes = (n) => {
    if (n == null || Number.isNaN(n)) return "-";
    const sign = n < 0 ? "-" : "";
    let v = Math.abs(n);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${sign}${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};
const fmtRate = (n) => (n == null ? "-" : `${fmtBytes(n)}/s`);
const fmtSecs = (s) => {
    if (s == null || Number.isNaN(s)) return "-";
    if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
    if (s < 60) return `${s.toFixed(2)} s`;
    return `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Status colour for a load percentage. Always paired with the number itself.
const loadColour = (pct) =>
    pct >= 90 ? STATUS.critical : pct >= 70 ? STATUS.serious : pct >= 40 ? STATUS.warning : STATUS.good;

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    if (w.element) w.element.style.display = "none";
    if (w.inputEl) w.inputEl.style.display = "none";
}

// The DOM widget is a pass-through host; the content is sized from node.size each
// frame so nothing spills outside the node while it is dragged or resized.
function makeDomHost(inner, initialH) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative; overflow:visible; pointer-events:none; width:100%; height:100%;";
    Object.assign(inner.style, {
        position: "absolute", left: "0", top: "0", width: "420px",
        height: `${initialH}px`, boxSizing: "border-box", pointerEvents: "auto",
    });
    host.appendChild(inner);
    return host;
}

/**
 * Keeps widget values correct across reloads and version skew.
 *
 * ComfyUI restores widgets_values BY POSITION, so a browser holding an older copy of
 * this node shifts every value after a newly added widget by one slot - which is how
 * `gpu_telemetry` ends up holding a boolean and the whole node gets dropped from the
 * run. Values are therefore also saved by name, restored by name, and checked against
 * each widget's own options before every run.
 */
function protectWidgetValues(node, names) {
    const widgets = () => names.map((n) => node.widgets?.find((w) => w.name === n)).filter(Boolean);
    const defaults = {};
    for (const w of widgets()) defaults[w.name] = w.value;

    const fix = (w) => {
        const d = defaults[w.name];
        let v = w.value;
        const list = w.options?.values;
        if (Array.isArray(list) && list.length) {
            if (!list.includes(v)) v = list.includes(d) ? d : list[0];
        } else if (typeof d === "number") {
            let n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
            if (!Number.isFinite(n)) n = d;
            const min = w.options?.min, max = w.options?.max;
            if (min != null && n < min) n = d >= min ? d : min;
            if (max != null && n > max) n = max;
            v = Math.round(n);
        } else if (typeof d === "boolean") {
            v = v === true || v === "true" ? true : v === false || v === "false" ? false : d;
        }
        if (v !== w.value) {
            console.warn(`[Nova FlowPulse] ${w.name} was ${JSON.stringify(w.value)}; reset to ${JSON.stringify(v)}`);
            w.value = v;
        }
        return v;
    };

    const restore = () => {
        const saved = node.properties?.nova_widget_values;
        for (const w of widgets()) {
            if (saved && Object.prototype.hasOwnProperty.call(saved, w.name)) w.value = saved[w.name];
            fix(w);
        }
        node.setDirtyCanvas(true, true);
    };

    const onSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        const r = onSerialize?.apply(this, arguments);
        o.properties = o.properties || {};
        o.properties.nova_widget_values = Object.fromEntries(widgets().map((w) => [w.name, w.value]));
        return r;
    };

    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        restore();
        setTimeout(restore, 0);
        return r;
    };

    // Last line of defence: never send a value the backend would reject
    for (const w of widgets()) w.serializeValue = async () => fix(w);
}

function pinDomSize(node, widget, inner, minH) {
    let lw = -1, lh = -1;
    const orig = node.onDrawForeground;
    node.onDrawForeground = function (...args) {
        const r = orig?.apply(this, args);
        if (this.flags?.collapsed) return r;
        const y = widget.y ?? widget.last_y;
        if (typeof y === "number" && y > 0) {
            const w = Math.max(60, Math.round(this.size[0] - 20));
            const h = Math.max(minH, Math.round(this.size[1] - y - 15));
            if (w !== lw) { inner.style.width = `${w}px`; lw = w; }
            if (h !== lh) { inner.style.height = `${h}px`; lh = h; }
        }
        return r;
    };
}

// --- canvas charts ---------------------------------------------------------
/**
 * One series, one axis, one label. `windows` tints the stretches of time where a
 * focused node held the execution slot.
 */
function drawChart(cv, values, opts = {}) {
    const { color = SERIES.cpu, max: fixedMax, windows = [], hover = null, unit = "" } = opts;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 200;
    const h = cv.clientHeight || 48;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = 2;
    const n = values.length;
    let max = fixedMax;
    if (max == null) {
        max = 0;
        for (const v of values) if (v != null && v > max) max = v;
        max = max <= 0 ? 1 : max * 1.15;
    }
    const x = (i) => (n <= 1 ? w : (i / (n - 1)) * w);
    const y = (v) => h - pad - (clamp(v / max, 0, 1) * (h - pad * 2));

    // recessive grid: a single midline
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.stroke();

    // execution windows for the focused node
    if (windows.length) {
        ctx.fillStyle = THEME.accentTint;
        for (const [a, b] of windows) {
            const xa = x(a), xb = x(b);
            ctx.fillRect(xa, 0, Math.max(1.5, xb - xa), h);
        }
    }

    if (!n) return { x, y, max };

    // area then line
    ctx.beginPath();
    ctx.moveTo(x(0), h);
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(values[i] ?? 0));
    ctx.lineTo(x(n - 1), h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "55");
    grad.addColorStop(1, color + "07");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const px = x(i), py = y(values[i] ?? 0);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // last point marker
    const lx = x(n - 1), ly = y(values[n - 1] ?? 0);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // hover crosshair
    if (hover != null && hover >= 0 && hover < n) {
        const hx = x(hover), hy = y(values[hover] ?? 0);
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx + 0.5, 0);
        ctx.lineTo(hx + 0.5, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = THEME.surface;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    return { x, y, max };
}

// ---------------------------------------------------------------------------
app.registerExtension({
    name: "comfy.nova_flowpulse",

    async setup() {
        await loadTheme();
    },

    async nodeCreated(node) {
        if (node.comfyClass !== FLOWPULSE) return;

        const stateWidget = node.widgets.find((w) => w.name === "view_state");
        const intervalWidget = node.widgets.find((w) => w.name === "sample_interval_ms");
        const gpuWidget = node.widgets.find((w) => w.name === "gpu_telemetry");
        protectWidgetValues(node, ["log_to_file", "log_format", "log_name",
                                   "sample_interval_ms", "gpu_telemetry", "reset_each_run"]);
        const fmtWidget = node.widgets.find((w) => w.name === "log_format");
        const nameWidget = node.widgets.find((w) => w.name === "log_name");
        hideWidget(stateWidget);

        let view = { view: "dash", focus: null, sort: "total" };
        try {
            const saved = JSON.parse(stateWidget?.value || "{}");
            if (saved && typeof saved === "object") view = { ...view, ...saved };
        } catch { /* keep defaults */ }
        const saveView = () => { if (stateWidget) stateWidget.value = JSON.stringify(view); };

        let samples = [];
        let meta = null;
        let nodes = [];
        let seq = 0;
        let alive = true;
        let paused = false;
        let hoverIndex = null;
        let toast = "";
        let toastUntil = 0;
        let lastNamesHash = "";

        // --- DOM ------------------------------------------------------------
        const wrap = document.createElement("div");
        wrap.style.cssText = `
            display:flex; flex-direction:column; gap:8px; min-height:0; overflow:hidden; position:relative;
            font-family: var(--nfp-font); color:var(--nfp-ink); font-size:var(--nfp-size);
            background:var(--nfp-surface); border:1px solid var(--nfp-accent); border-radius:8px; padding:8px;
        `;

        const bar = document.createElement("div");
        bar.style.cssText = "display:flex; align-items:center; gap:8px; flex:0 0 auto; min-width:0;";
        const statusEl = document.createElement("span");
        statusEl.style.cssText = `font-weight:700; white-space:nowrap; letter-spacing:.3px;`;
        const subEl = document.createElement("span");
        subEl.style.cssText = `flex:1; min-width:0; color:var(--nfp-ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
        const mkBtn = (label, title) => {
            const b = document.createElement("span");
            b.textContent = label;
            b.title = title;
            b.style.cssText = `cursor:pointer; color:var(--nfp-accent); border:1px solid var(--nfp-grid); border-radius:5px;
                padding:2px 7px; user-select:none; white-space:nowrap; background:var(--nfp-panel);`;
            b.onmouseenter = () => (b.style.borderColor = "var(--nfp-accent)");
            b.onmouseleave = () => (b.style.borderColor = "var(--nfp-grid)");
            return b;
        };
        const pauseBtn = mkBtn("⏸ Pause", "Stop sampling (the graph keeps running)");
        const resetBtn = mkBtn("⟲ Reset", "Clear all collected statistics");
        const saveBtn = mkBtn("⭳ Save log", "Write a profile file now");
        const themeBtn = mkBtn("🎨", "Colours — accent, surfaces and label font (chart colours are fixed)");
        bar.append(statusEl, subEl, themeBtn, pauseBtn, resetBtn, saveBtn);

        const tiles = document.createElement("div");
        tiles.style.cssText = "display:grid; grid-template-columns:repeat(4,1fr); gap:6px; flex:0 0 auto;";

        // Built once and never re-rendered. A <select> inside body.innerHTML was being
        // destroyed on every poll, which slammed the native dropdown shut the moment it
        // opened, so the sort control lives outside the re-rendered area.
        const controls = document.createElement("div");
        controls.style.cssText = "display:flex; align-items:center; gap:6px; padding:0 2px 2px; flex:0 0 auto; min-width:0;";
        const sortLabel = document.createElement("span");
        sortLabel.textContent = "Sort by";
        sortLabel.style.cssText = `color:var(--nfp-ink3);`;
        const sortSelect = document.createElement("select");
        sortSelect.style.cssText = `background:var(--nfp-panel); color:var(--nfp-ink); border:1px solid var(--nfp-grid);
            border-radius:4px; font-size:var(--nfp-size); padding:1px 4px; cursor:pointer;`;
        const summaryEl = document.createElement("span");
        summaryEl.style.cssText = `color:var(--nfp-ink3); margin-left:auto; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; min-width:0;`;
        controls.append(sortLabel, sortSelect, summaryEl);

        const body = document.createElement("div");
        body.style.cssText = "flex:1 1 auto; min-height:0; overflow:auto; border-radius:6px;";

        const foot = document.createElement("div");
        foot.style.cssText = `flex:0 0 auto; color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 1px); display:flex; gap:6px; min-width:0;`;

        wrap.append(bar, tiles, controls, body, foot);

        node._viewerH = 430;
        const widget = node.addDOMWidget("flowpulse", "HTML", makeDomHost(wrap, 430), {
            getMinHeight: () => node._viewerH,
            hideOnZoom: false,
            serialize: false,
        });
        widget.computeSize = (w) => [w ?? node.size[0], node._viewerH + 10];
        pinDomSize(node, widget, wrap, 240);

        wrap.addEventListener("pointerdown", (e) => e.stopPropagation());
        body.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

        // --- tiles ----------------------------------------------------------
        const tileDefs = [
            { key: "cpu", label: "CPU", colour: SERIES.cpu },
            { key: "ram", label: "MEMORY", colour: SERIES.ram },
            { key: "disk", label: "DISK", colour: SERIES.disk },
            { key: "gpu", label: "GPU", colour: SERIES.gpu },
        ];
        const tileEls = {};
        for (const def of tileDefs) {
            const el = document.createElement("div");
            el.style.cssText = `background:var(--nfp-panel); border:1px solid var(--nfp-grid); border-radius:6px;
                padding:5px 7px; display:flex; flex-direction:column; gap:2px; min-width:0; overflow:hidden;`;
            const head = document.createElement("div");
            head.style.cssText = `display:flex; align-items:baseline; gap:5px; min-width:0;`;
            const dot = document.createElement("span");
            dot.style.cssText = `width:7px; height:7px; border-radius:2px; background:${def.colour}; flex:0 0 auto;`;
            const name = document.createElement("span");
            name.textContent = def.label;
            name.style.cssText = `color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 2px); font-weight:700; letter-spacing:.7px;`;
            head.append(dot, name);
            const value = document.createElement("div");
            value.style.cssText = `font-size:calc(var(--nfp-size) + 4px); font-weight:700; line-height:1.1; white-space:nowrap;
                overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums;`;
            const sub = document.createElement("div");
            sub.style.cssText = `color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 2px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
            const cv = document.createElement("canvas");
            cv.style.cssText = "width:100%; height:28px; display:block; margin-top:2px;";
            el.append(head, value, sub, cv);
            tiles.appendChild(el);
            tileEls[def.key] = { el, value, sub, cv, colour: def.colour };
        }

        // Hovering a sparkline reads that moment out in the tile itself
        for (const [key, t] of Object.entries(tileEls)) {
            t.cv.addEventListener("pointermove", (e) => {
                const r = t.cv.getBoundingClientRect();
                const n = samples.length;
                hoverIndex = n > 1 ? Math.round(((e.clientX - r.left) / r.width) * (n - 1)) : null;
                render();
            });
            t.cv.addEventListener("pointerleave", () => { hoverIndex = null; render(); });
        }

        // --- data helpers ----------------------------------------------------
        const at = (i) => samples[clamp(i, 0, samples.length - 1)];
        const latest = () => (hoverIndex != null ? at(hoverIndex) : samples[samples.length - 1]) || null;
        const series = (fn) => samples.map((s) => { const v = fn(s); return v == null ? 0 : v; });
        // Node ids are numbers in a classic graph and strings inside subgraphs, so try both
        const findNode = (id) => {
            const g = node.graph;
            if (!g || id == null) return null;
            return g.getNodeById?.(id) || g.getNodeById?.(Number(id)) ||
                (g._nodes ?? []).find((n) => String(n.id) === String(id)) || null;
        };
        const nodeLabel = (id) => {
            const g = findNode(id);
            return g ? (g.title || g.type || `node ${id}`) : `node ${id} (removed)`;
        };
        const nodeType = (id) => findNode(id)?.type || "";

        const gpuOn = () => !!meta?.gpu?.available;

        // A node that ran for less than one sample interval has no trustworthy CPU
        // figure. Saying so is better than printing a number made of noise.
        const measured = (r) => (r?.samples ?? 0) > 0;
        const cpuCell = (r, key = "cpu_avg") =>
            measured(r) ? `${(r[key] || 0).toFixed(0)}%`
                        : `<span style="color:var(--nfp-ink3);" title="Ran for less than one sample interval - too brief to measure CPU">–</span>`;

        // --- rendering -------------------------------------------------------
        const renderTiles = () => {
            const s = latest();
            const cpuMax = Math.max(100, ...samples.map((x) => x.cpu || 0));
            const ramTotal = meta?.ram_total || 0;

            tileEls.cpu.value.textContent = s ? `${(s.cpu ?? 0).toFixed(0)}%` : "-";
            tileEls.cpu.value.style.color = s ? loadColour(((s.cpu ?? 0) / cpuMax) * 100) : "var(--nfp-ink)";
            tileEls.cpu.sub.textContent = s ? `system ${(s.scpu ?? 0).toFixed(0)}% · ${meta?.cpu_count ?? "?"} cores` : "";
            drawChart(tileEls.cpu.cv, series((x) => x.cpu), { color: SERIES.cpu, max: cpuMax, hover: hoverIndex });

            tileEls.ram.value.textContent = s ? fmtBytes(s.rss) : "-";
            tileEls.ram.value.style.color = s ? loadColour(s.ram ?? 0) : "var(--nfp-ink)";
            tileEls.ram.sub.textContent = s && ramTotal ? `system ${(s.ram ?? 0).toFixed(0)}% of ${fmtBytes(ramTotal)}` : "process RSS";
            drawChart(tileEls.ram.cv, series((x) => x.rss), { color: SERIES.ram, hover: hoverIndex });

            const rd = s?.rd ?? 0, wr = s?.wr ?? 0;
            tileEls.disk.value.textContent = s ? fmtRate(rd + wr) : "-";
            tileEls.disk.value.style.color = "var(--nfp-ink)";
            tileEls.disk.sub.textContent = s ? `r ${fmtRate(rd)} · w ${fmtRate(wr)}` : "";
            drawChart(tileEls.disk.cv, series((x) => (x.rd || 0) + (x.wr || 0)), { color: SERIES.disk, hover: hoverIndex });

            const t = tileEls.gpu;
            if (!gpuOn()) {
                t.el.style.display = "none";
                tiles.style.gridTemplateColumns = "repeat(3,1fr)";
            } else {
                t.el.style.display = "flex";
                tiles.style.gridTemplateColumns = "repeat(4,1fr)";
                const hasUtil = meta.gpu.utilisation;
                if (hasUtil && s?.gpu != null) {
                    t.value.textContent = `${s.gpu.toFixed(0)}%`;
                    t.value.style.color = loadColour(s.gpu);
                } else {
                    t.value.textContent = s ? fmtBytes(s.vram) : "-";
                    t.value.style.color = "var(--nfp-ink)";
                }
                const total = meta.gpu.total || 0;
                t.sub.textContent = total ? `vram ${fmtBytes(s?.vram)} / ${fmtBytes(total)}` : meta.gpu.name;
                drawChart(t.cv, series((x) => (hasUtil ? x.gpu : x.vram)), {
                    color: SERIES.gpu, max: hasUtil ? 100 : undefined, hover: hoverIndex,
                });
            }
        };

        const SORTS = [
            { key: "total", label: "Total time" },
            { key: "avg", label: "Avg time" },
            { key: "cpu_avg", label: "CPU" },
            { key: "rss_peak", label: "Peak RAM" },
            { key: "rss_delta", label: "Δ RAM" },
            { key: "io", label: "Disk I/O" },
            { key: "calls", label: "Calls" },
        ];
        const sortValue = (r, key) => {
            if (key === "io") return (r.read || 0) + (r.write || 0);
            if (key === "cpu_avg" && !measured(r)) return -1;   // unmeasured sorts last
            return r[key] ?? 0;
        };

        const renderDashboard = () => {
            if (!nodes.length) {
                body.innerHTML = `<div style="padding:18px; text-align:center; color:var(--nfp-ink3); line-height:1.7;">
                    <div style="font-size:22px;">📊</div>
                    <div style="color:var(--nfp-ink2); font-weight:600;">No node timings yet</div>
                    <div>Run the workflow once with this node on the canvas.<br>
                    Every node that executes is timed and sampled automatically.</div>
                </div>`;
                return;
            }
            const sorted = [...nodes].sort((a, b) => sortValue(b, view.sort) - sortValue(a, view.sort));
            const totalTime = sorted.reduce((a, r) => a + (r.total || 0), 0) || 1;
            const topSort = Math.max(...sorted.map((r) => sortValue(r, view.sort)), 1e-9);

            summaryEl.textContent = `${sorted.length} node(s) · ${fmtSecs(totalTime)} inside nodes · click a row for detail`;

            // TABLE-LAYOUT: FIXED, and the widths below are the whole reason.
            //
            // With the browser's default `auto` layout every column is measured
            // from its content on every render, and this table re-renders on
            // every poll. A node name a few characters longer, a figure going
            // from "5 ms" to "1.23 s", the running marker appearing — any of
            // them re-measured the whole table and the NODE column visibly grew
            // and shrank several times a second while a graph ran.
            //
            // Fixed layout reads the widths once from the first row: the
            // measured columns get a size that fits their widest realistic
            // value, NODE takes whatever is left, and content can no longer
            // move anything. Long names ellipsis instead, which they already
            // did. The body scrolls horizontally if the node is made narrower
            // than the fixed columns need.
            let h = `<table style="width:100%; border-collapse:collapse; table-layout:fixed;
                            font-variant-numeric:tabular-nums;">
                <thead><tr style="color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 2px); letter-spacing:.6px;
                            white-space:nowrap;">
                    <th style="text-align:left; padding:0 6px 4px 4px;">NODE</th>
                    <th style="text-align:right; padding:0 6px 4px; width:48px;">CALLS</th>
                    <th style="text-align:right; padding:0 6px 4px; width:66px;">TOTAL</th>
                    <th style="text-align:right; padding:0 6px 4px; width:62px;">AVG</th>
                    <th style="text-align:right; padding:0 6px 4px; width:46px; color:${SERIES.cpu};">CPU</th>
                    <th style="text-align:right; padding:0 6px 4px; width:76px; overflow:hidden;
                               text-overflow:ellipsis; color:${SERIES.ram};">PEAK RAM</th>
                    <th style="text-align:right; padding:0 6px 4px; width:72px; color:${SERIES.ram};">Δ RAM</th>
                    <th style="text-align:right; padding:0 4px 4px; width:66px;" title="Bytes read + written">I/O</th>
                </tr></thead><tbody>`;

            for (const r of sorted) {
                const share = (r.total || 0) / totalTime;
                const barPct = (sortValue(r, view.sort) / topSort) * 100;
                const live = meta?.current === r.id;
                const delta = r.rss_delta || 0;
                h += `<tr data-id="${esc(r.id)}" class="nfp-row" style="cursor:pointer; border-top:1px solid var(--nfp-grid);">
                    <td style="padding:4px 6px 4px 4px; overflow:hidden;">
                        <div style="display:flex; align-items:center; gap:5px; min-width:0;">
                            <!-- ALWAYS PRESENT, sometimes invisible. Adding and
                                 removing the running marker shifted the name
                                 sideways every time the executing node changed;
                                 hiding it instead keeps its box. -->
                            <span style="flex:0 0 auto; color:var(--nfp-accent);
                                  visibility:${live ? "visible" : "hidden"};">●</span>
                            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(nodeLabel(r.id))} — ${esc(nodeType(r.id))}">${esc(nodeLabel(r.id))}</span>
                        </div>
                        <div style="height:3px; margin-top:3px; background:var(--nfp-grid); border-radius:2px; overflow:hidden;">
                            <div style="height:3px; width:${barPct.toFixed(1)}%; background:var(--nfp-accent);
                                 opacity:${(0.35 + share * 0.65).toFixed(2)}; border-radius:2px;"></div>
                        </div>
                    </td>
                    <td style="text-align:right; padding:4px 6px; color:var(--nfp-ink2);">${r.calls}</td>
                    <td style="text-align:right; padding:4px 6px; font-weight:600;">${fmtSecs(r.total)}</td>
                    <td style="text-align:right; padding:4px 6px; color:var(--nfp-ink2);">${fmtSecs(r.avg)}</td>
                    <td style="text-align:right; padding:4px 6px;">${cpuCell(r)}</td>
                    <td style="text-align:right; padding:4px 6px;">${fmtBytes(r.rss_peak)}</td>
                    <td style="text-align:right; padding:4px 6px; color:${delta > 0 ? STATUS.serious : "var(--nfp-ink3)"};">${delta > 0 ? "+" : ""}${fmtBytes(delta)}</td>
                    <td style="text-align:right; padding:4px 4px; color:var(--nfp-ink2);">${fmtBytes((r.read || 0) + (r.write || 0))}</td>
                </tr>`;
            }
            h += `</tbody></table>`;
            body.innerHTML = h;
        };

        const statTile = (label, value, colour) => `
            <div style="background:var(--nfp-panel); border:1px solid var(--nfp-grid); border-radius:6px; padding:5px 7px; min-width:0;">
                <div style="color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 2px); font-weight:700; letter-spacing:.6px;">${label}</div>
                <div style="font-size:calc(var(--nfp-size) + 2px); font-weight:700; color:${colour || "var(--nfp-ink)"}; white-space:nowrap;
                     overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums;">${value}</div>
            </div>`;

        const renderFocus = () => {
            const id = view.focus;
            const r = nodes.find((x) => String(x.id) === String(id));
            const live = meta?.current === id;

            let h = `<div style="display:flex; align-items:center; gap:8px; padding:0 2px 6px;">
                <span data-back style="cursor:pointer; color:var(--nfp-accent); border:1px solid var(--nfp-grid); background:var(--nfp-panel);
                      border-radius:5px; padding:2px 7px; user-select:none;">← All nodes</span>
                <span style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(nodeLabel(id))}</span>
                <span style="color:var(--nfp-ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(nodeType(id))}</span>
                ${live ? `<span style="color:var(--nfp-accent); font-weight:700; white-space:nowrap;">● RUNNING</span>` : ""}
                <span data-locate style="margin-left:auto; cursor:pointer; color:var(--nfp-accent); border:1px solid var(--nfp-grid);
                      background:var(--nfp-panel); border-radius:5px; padding:2px 7px; user-select:none; white-space:nowrap;"
                      title="Select and centre this node on the canvas">◎ Find on canvas</span>
            </div>`;

            if (!r) {
                h += `<div style="padding:16px; text-align:center; color:var(--nfp-ink3);">
                    This node has not executed yet. Run the workflow to collect figures for it.</div>`;
                body.innerHTML = h;
                return;
            }

            h += `<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-bottom:8px;">
                ${statTile("CALLS", r.calls)}
                ${statTile("TOTAL", fmtSecs(r.total))}
                ${statTile("AVERAGE", fmtSecs(r.avg))}
                ${statTile("SLOWEST", fmtSecs(r.max))}
                ${statTile("CPU AVG", cpuCell(r, "cpu_avg"), SERIES.cpu)}
                ${statTile("CPU PEAK", cpuCell(r, "cpu_max"), SERIES.cpu)}
                ${statTile("PEAK RAM", fmtBytes(r.rss_peak), SERIES.ram)}
                ${statTile("Δ RAM", `${(r.rss_delta || 0) > 0 ? "+" : ""}${fmtBytes(r.rss_delta)}`, SERIES.ram)}
                ${statTile("DISK READ", fmtBytes(r.read), SERIES.disk)}
                ${statTile("DISK WRITE", fmtBytes(r.write), SERIES.disk)}
                ${gpuOn() && meta.gpu.utilisation ? statTile("GPU AVG", `${(r.gpu_avg || 0).toFixed(0)}%`, SERIES.gpu) : ""}
                ${gpuOn() ? statTile("PEAK VRAM", fmtBytes(r.vram_peak), SERIES.gpu) : ""}
            </div>
            <div style="color:var(--nfp-ink3); padding:0 2px 4px;">Live process activity — the tinted stretches are when this node was running.</div>
            <div data-charts style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;"></div>`;
            body.innerHTML = h;

            const host = body.querySelector("[data-charts]");
            const defs = [
                { label: "CPU", colour: SERIES.cpu, get: (s) => s.cpu, fmt: (v) => `${(v ?? 0).toFixed(0)}%`, max: Math.max(100, ...samples.map((x) => x.cpu || 0)) },
                { label: "Memory (RSS)", colour: SERIES.ram, get: (s) => s.rss, fmt: fmtBytes },
                { label: "Disk read", colour: SERIES.disk, get: (s) => s.rd, fmt: fmtRate },
                { label: "Disk write", colour: SERIES.disk, get: (s) => s.wr, fmt: fmtRate },
            ];
            if (gpuOn() && meta.gpu.utilisation) defs.push({ label: "GPU", colour: SERIES.gpu, get: (s) => s.gpu, fmt: (v) => `${(v ?? 0).toFixed(0)}%`, max: 100 });
            if (gpuOn()) defs.push({ label: "VRAM", colour: SERIES.gpu, get: (s) => s.vram, fmt: fmtBytes });

            // stretches of the timeline where this node held the slot
            const windows = [];
            let start = null;
            samples.forEach((s, i) => {
                if (String(s.n) === String(id)) { if (start == null) start = i; }
                else if (start != null) { windows.push([start, i]); start = null; }
            });
            if (start != null) windows.push([start, samples.length - 1]);

            for (const def of defs) {
                const cell = document.createElement("div");
                cell.style.cssText = `background:var(--nfp-panel); border:1px solid var(--nfp-grid); border-radius:6px; padding:5px 7px;`;
                const head = document.createElement("div");
                head.style.cssText = "display:flex; align-items:baseline; gap:6px; min-width:0;";
                head.innerHTML = `<span style="width:7px;height:7px;border-radius:2px;background:${def.colour};display:inline-block;"></span>
                    <span style="color:var(--nfp-ink3); font-size:calc(var(--nfp-size) - 2px); font-weight:700; letter-spacing:.6px;">${def.label}</span>`;
                const val = document.createElement("span");
                val.style.cssText = `margin-left:auto; font-weight:700; font-variant-numeric:tabular-nums;`;
                const s = latest();
                val.textContent = s ? def.fmt(def.get(s)) : "-";
                head.appendChild(val);
                const cv = document.createElement("canvas");
                cv.style.cssText = "width:100%; height:54px; display:block; margin-top:3px;";
                cell.append(head, cv);
                host.appendChild(cell);
                drawChart(cv, series(def.get), { color: def.colour, max: def.max, windows, hover: hoverIndex });

                cv.addEventListener("pointermove", (e) => {
                    const rect = cv.getBoundingClientRect();
                    const n = samples.length;
                    hoverIndex = n > 1 ? Math.round(((e.clientX - rect.left) / rect.width) * (n - 1)) : null;
                    render();
                });
                cv.addEventListener("pointerleave", () => { hoverIndex = null; render(); });
            }
        };

        const render = () => {
            const running = meta?.running;
            const cur = meta?.current;
            statusEl.textContent = paused ? "⏸ PAUSED" : running ? "● PROFILING" : "○ IDLE";
            statusEl.style.color = paused ? STATUS.warning : running ? "var(--nfp-accent)" : "var(--nfp-ink3)";

            if (meta && !meta.ok) {
                subEl.textContent = meta.error || "Sampling unavailable";
                subEl.style.color = STATUS.critical;
            } else {
                subEl.style.color = "var(--nfp-ink2)";
                subEl.textContent = running && cur
                    ? `running ${nodeLabel(cur)}`
                    : meta?.last_run
                        ? `last run ${meta.last_run.status} · ${fmtSecs(meta.last_run.duration)} · ${meta.last_run.nodes} node(s)`
                        : "waiting for a run";
            }

            renderTiles();
            const onTable = !(view.view === "focus" && view.focus != null);
            controls.style.display = onTable && nodes.length ? "flex" : "none";
            if (onTable) renderDashboard(); else renderFocus();

            const bits = [];
            if (meta) {
                bits.push(`sample ${Math.round((meta.interval || 0.25) * 1000)} ms`);
                bits.push(`disk counters: ${meta.io_source}`);
                bits.push(gpuOn()
                    ? `gpu: ${meta.gpu.name} via ${meta.gpu.source}${meta.gpu.utilisation ? "" : " (memory only)"}`
                    : `gpu: off${meta.gpu?.note ? ` — ${meta.gpu.note}` : ""}`);
                if (meta.last_log) bits.push(`log: ${meta.last_log.split(/[\\/]/).pop()}`);
            }
            foot.innerHTML = `<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(bits.join("  ·  "))}</span>`;
            if (meta?.gpu?.risky) {
                foot.innerHTML += `<span style="color:${STATUS.warning}; white-space:nowrap;"
                    title="Polling the compute runtime during a run can abort ComfyUI on ROCm. Switch gpu_telemetry to 'auto (safe)' if the process aborts.">⚠ torch GPU mode</span>`;
            }
            if (toast && Date.now() < toastUntil) {
                foot.innerHTML += `<span style="color:var(--nfp-accent); white-space:nowrap;">${esc(toast)}</span>`;
            }
            node.setDirtyCanvas(true, true);
        };

        // --- interaction -----------------------------------------------------
        for (const opt of SORTS) {
            const o = document.createElement("option");
            o.value = opt.key;
            o.textContent = opt.label;
            sortSelect.appendChild(o);
        }
        sortSelect.value = view.sort;
        sortSelect.onchange = () => { view.sort = sortSelect.value; saveView(); render(); };
        // keep the native dropdown from being treated as a canvas drag
        sortSelect.addEventListener("pointerdown", (e) => e.stopPropagation());

        body.addEventListener("pointerdown", (e) => {
            const back = e.target.closest("[data-back]");
            if (back) { view.view = "dash"; view.focus = null; saveView(); render(); return; }
            const locate = e.target.closest("[data-locate]");
            if (locate) {
                const g = findNode(view.focus);
                const cv = app.canvas;
                if (g && cv) {
                    // Frontend versions differ; use whichever of these exists
                    if (typeof cv.selectNode === "function") cv.selectNode(g);
                    else if (typeof cv.selectNodes === "function") cv.selectNodes([g]);
                    if (typeof cv.centerOnNode === "function") cv.centerOnNode(g);
                    else if (cv.ds) {                     // fall back to moving the viewport by hand
                        cv.ds.offset[0] = -g.pos[0] - g.size[0] / 2 + cv.canvas.width / (2 * cv.ds.scale);
                        cv.ds.offset[1] = -g.pos[1] - g.size[1] / 2 + cv.canvas.height / (2 * cv.ds.scale);
                    }
                    cv.setDirty?.(true, true);
                    toast = `Centred on ${g.title || g.type}`;
                } else {
                    toast = "That node is no longer in the graph";
                }
                toastUntil = Date.now() + 2500;
                render();
                return;
            }
            const row = e.target.closest("tr.nfp-row");
            if (row) {
                view.view = "focus";
                view.focus = row.dataset.id;
                hoverIndex = null;
                saveView();
                render();
            }
        });
        body.addEventListener("mouseover", (e) => {
            const row = e.target.closest("tr.nfp-row");
            if (row) row.style.background = "rgba(255,148,194,0.10)";
        });
        body.addEventListener("mouseout", (e) => {
            const row = e.target.closest("tr.nfp-row");
            if (row) row.style.background = "";
        });

        const control = async (action, extra = {}) => {
            try {
                const res = await api.fetchApi("/nova_flowpulse/control", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action, ...extra }),
                });
                const data = await res.json();
                toast = data.message || "";
                toastUntil = Date.now() + 3000;
                render();
                return data;
            } catch (err) {
                toast = `Request failed: ${err.message}`;
                toastUntil = Date.now() + 4000;
                render();
            }
        };

        pauseBtn.onclick = async () => {
            paused = !paused;
            pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
            await control(paused ? "pause" : "resume");
        };
        resetBtn.onclick = async () => {
            await control("reset");
            samples = []; nodes = []; seq = 0;
            view.view = "dash"; view.focus = null; saveView();
            render();
        };
        saveBtn.onclick = () => control("save", { format: fmtWidget?.value, name: nameWidget?.value });
        themeBtn.onclick = () => themePopover(wrap);

        // --- polling ---------------------------------------------------------
        const namesPayload = () => {
            const out = {};
            for (const n of node.graph?._nodes ?? []) out[String(n.id)] = { title: n.title || "", type: n.type || "" };
            const hash = JSON.stringify(out);
            if (hash === lastNamesHash) return null;
            lastNamesHash = hash;
            return out;
        };

        const poll = async () => {
            if (!alive) return;
            if (document.hidden) return schedule(1000);
            try {
                const res = await api.fetchApi("/nova_flowpulse/poll", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ since: seq, focus: view.focus, names: namesPayload() }),
                });
                const data = await res.json();
                meta = data;
                nodes = data.nodes || [];
                if (data.seq < seq) { samples = []; }          // the backend was reset
                seq = data.seq ?? seq;
                if (data.samples?.length) {
                    samples.push(...data.samples);
                    if (samples.length > HISTORY) samples = samples.slice(-HISTORY);
                }
                render();
            } catch (err) {
                statusEl.textContent = "⚠ OFFLINE";
                statusEl.style.color = STATUS.critical;
                subEl.textContent = "Cannot reach the FlowPulse endpoint - is the Python file loaded?";
                subEl.style.color = STATUS.critical;
            }
            schedule();
        };

        let timer = null;
        const schedule = (ms) => {
            if (!alive) return;
            clearTimeout(timer);
            const base = Math.max(MIN_POLL, (meta?.interval ?? 0.25) * 1000);
            timer = setTimeout(poll, ms ?? base);
        };

        const onRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            alive = false;
            clearTimeout(timer);
            return onRemoved?.apply(this, args);
        };

        // Interval changes take effect on the backend too
        if (gpuWidget) {
            const prev = gpuWidget.callback;
            gpuWidget.callback = function (...args) {
                const r = prev?.apply(this, args);
                control("gpu_mode", { value: gpuWidget.value });
                return r;
            };
        }

        const origCb = intervalWidget?.callback;
        if (intervalWidget) {
            intervalWidget.callback = function (...args) {
                const r = origCb?.apply(this, args);
                control("interval", { value: intervalWidget.value });
                return r;
            };
        }

        render();
        poll();
        requestAnimationFrame(() => {
            const min = node.computeSize();
            node.setSize([Math.max(node.size[0], min[0], 620), Math.max(node.size[1], min[1], 470)]);
            node.setDirtyCanvas(true, true);
        });
    },
});
