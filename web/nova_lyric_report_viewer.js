// nova_lyric_report_viewer.js
// Front-end for the "Nova Lyric Report 📈" node (NovaLyricReportViewer).
//
// The Python node emits, on every execution:
//   { "ui": { "nova_lyric_report": [ {
//       views:  {name: theme-neutral html},   // CSS uses var(--x) + var(--fs)
//       themes: {name: {var: colour}},         // palettes for every theme
//       view_mode, theme, font_scale, html
//   } ] } }
//
// Because the views are theme-NEUTRAL, the front-end builds the :root block
// (palette + font multiplier) from the node's theme + font_scale dropdowns and
// injects it when a view is shown. So switching view_mode — or changing the
// theme / font_scale and pressing "Apply View" — re-themes and re-scales a
// loaded report instantly, with no graph re-run.
//
// view_mode, theme and font_scale all reload the panel live on change, and the
// "Apply View" button re-applies the current selection explicitly.
//
// NOTE: inside a pack, this file must live in the pack's own web/ folder.

import { app } from "../../scripts/app.js";

console.log("[Nova Lyric Report] viewer JS loaded — theme-var build");

const NODE = "NovaLyricReportViewer";
const UI_KEY = "nova_lyric_report";
const MIN_H = 320;

const FALLBACK_THEME = {
    bg: "#0d1117", panel: "#161b26", panel2: "#1b2333", border: "#232c3c",
    text: "#c9d3df", muted: "#8592a3", blue: "#4aa3ff", green: "#3fb950",
    amber: "#d29922", red: "#f85149", track: "#0b0f16", grid: "#1f2836",
};

const PLACEHOLDER =
    "<div class='nlr' style=\"font-family:'Segoe UI',system-ui,Arial,sans-serif;" +
    "color:var(--muted);padding:24px;font-size:13px\">Run the graph to render the report.</div>";

const THEME_NAMES = ["Nova Dark", "High Contrast", "Studio Slate"];
const VIEW_NAMES = ["Dashboard", "Transcription", "Lyric Report"];

function widgetVal(node, name, dflt) {
    const w = node.widgets && node.widgets.find((x) => x.name === name);
    return w ? w.value : dflt;
}

// Repair widget values, including any left corrupted by an older build that
// reordered the widget list (theme showing a view name, font_scale = NaN, …).
function sanitizeWidgets(node) {
    if (!node.widgets) return;
    const t = node.widgets.find((x) => x.name === "theme");
    if (t && !THEME_NAMES.includes(t.value)) t.value = "Nova Dark";
    const v = node.widgets.find((x) => x.name === "view_mode");
    if (v && !VIEW_NAMES.includes(v.value)) v.value = "Dashboard";
    const f = node.widgets.find((x) => x.name === "font_scale");
    if (f) {
        let n = parseFloat(f.value);
        if (!isFinite(n)) n = 1.0;
        f.value = Math.max(0.75, Math.min(1.5, n));
    }
}

// Build the :root block (concrete palette + font multiplier) from the node's
// current theme + font_scale dropdowns.
function rootCss(node) {
    const themes = node.__novaThemes || {};
    const tName = widgetVal(node, "theme", "Nova Dark");
    const pal = themes[tName] || themes["Nova Dark"] || FALLBACK_THEME;
    let fs = parseFloat(widgetVal(node, "font_scale", 1.0));
    if (!(fs > 0)) fs = 1.0;
    fs = Math.max(0.75, Math.min(1.6, fs));
    const decls = Object.keys(pal).map((k) => `--${k}:${pal[k]}`).join(";");
    return `:root{${decls};--fs:${fs}}`;
}

function frameDoc(inner, root) {
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>" +
        (root || "") +
        " html,body{margin:0;padding:0;background:var(--bg,#0d1117);}" +
        "::-webkit-scrollbar{width:10px;height:10px}" +
        "::-webkit-scrollbar-thumb{background:#2a3444;border-radius:5px}" +
        "::-webkit-scrollbar-track{background:var(--bg,#0d1117)}</style></head>" +
        "<body>" + (inner || PLACEHOLDER) + "</body></html>"
    );
}

function ensureWidget(node) {
    let w = node.__novaLyricWidget;
    if (w && w.iframe && w.iframe.isConnected !== false) return w;

    const wrap = document.createElement("div");
    wrap.style.cssText =
        "width:100%;height:100%;min-height:" + MIN_H + "px;border-radius:8px;" +
        "overflow:hidden;background:#0d1117;border:1px solid #232c3c;box-sizing:border-box;";

    const iframe = document.createElement("iframe");
    iframe.setAttribute("scrolling", "auto");
    iframe.style.cssText =
        "width:100%;height:100%;border:0;display:block;background:#0d1117;";
    wrap.appendChild(iframe);

    // Plain DOM widget → ComfyUI sizes it to the node's remaining area, so the
    // node is freely resizable and the report reflows / scrolls inside.
    w = node.addDOMWidget(UI_KEY, "nova_lyric_report_view", wrap, {
        serialize: false,
        hideOnZoom: false,
        getValue() { return ""; },
        setValue() {},
    });
    w.iframe = iframe;
    node.__novaLyricWidget = w;
    iframe.srcdoc = frameDoc(PLACEHOLDER, rootCss(node));
    return w;
}

// Show whichever view the view_mode dropdown points at, themed + scaled by the
// current theme / font_scale dropdowns. Uses already-loaded HTML — no re-run.
function showView(node) {
    const w = ensureWidget(node);
    const views = node.__novaViews;
    const vm = widgetVal(node, "view_mode", "Dashboard");
    let html = PLACEHOLDER;
    if (views) html = views[vm] || views[Object.keys(views)[0]] || PLACEHOLDER;
    w.iframe.srcdoc = frameDoc(html, rootCss(node));
    node.__novaCurrent = vm;
}

app.registerExtension({
    name: "Nova.LyricReportViewer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            // "Apply View" button. IMPORTANT: append it (do NOT reorder the
            // widget list). ComfyUI stores widget values as a flat positional
            // array, so moving a widget to the front shifts every saved value
            // by one on reload (theme/​font_scale come back wrong / NaN). The
            // button therefore sits just above the report panel, and both it
            // and the DOM panel are serialize:false so they don't take a slot.
            const btn = node.addWidget("button", "🔄  Apply View", null, () => showView(node));
            btn.serialize = false;

            // Live-reload the panel whenever view_mode, theme or font_scale
            // changes (the "Apply View" button stays as an explicit trigger).
            for (const name of ["view_mode", "theme", "font_scale"]) {
                const wdg = node.widgets.find((x) => x.name === name);
                if (!wdg) continue;
                const prev = wdg.callback;
                wdg.callback = function () {
                    const r = prev ? prev.apply(this, arguments) : undefined;
                    showView(node);
                    return r;
                };
            }

            ensureWidget(node);
            sanitizeWidgets(node);
            if (!node.size || node.size[0] < 460) node.size = [560, 640];
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const blocks = message && message[UI_KEY];
            if (!blocks || !blocks.length) return;
            const block = blocks[0];
            this.__novaThemes = block.themes || this.__novaThemes || null;
            this.__novaViews = block.views ||
                (block.html ? { [block.view_mode || "Dashboard"]: block.html } : null);
            showView(this);
        };

        // Re-inject stored views when a saved workflow is reloaded, and repair
        // any widget values corrupted by an older (reordered) build.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            sanitizeWidgets(this);
            if (this.__novaViews) showView(this);
        };
    },
});
