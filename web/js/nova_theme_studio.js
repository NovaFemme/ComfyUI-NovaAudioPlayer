/**
 * Nova Theme Studio 🎨 — edit a ComfyUI colour palette live, on the canvas.
 *
 * THE POINT IS THE FEEDBACK LOOP. Editing a theme JSON means save, refresh,
 * look, guess, repeat, and a refresh costs the graph you had open. Nothing in
 * that loop needs to exist: a palette is not compiled into anything. Loading
 * one is three assignments — link colours onto the canvas, LiteGraph constants
 * onto the LiteGraph object, and `comfy_base` onto CSS custom properties on
 * :root — and this file performs exactly those three, on every keystroke. What
 * you see after a change is what the file would have given you after a reload,
 * because it is the same assignment either way.
 *
 * So the file becomes the OUTPUT rather than the input. Pick colours until it
 * looks right, then export the JSON, or save it straight into ComfyUI's own
 * custom palettes where it joins the theme dropdown.
 *
 * ALPHA IS A FIRST-CLASS CONTROL, because Dark-Custom is built on it: layer
 * after layer of rgba(), which is how a wallpaper shows through the whole app.
 * A native colour swatch cannot express alpha at all, so every colour row here
 * is a swatch AND an alpha slider AND the literal text, all three bound to one
 * value. Anything that is not a colour — the grid tile's data: URI, the shape
 * enum, the font sizes — gets a plain field instead of being mangled into one.
 *
 * BACKDROP, which a theme file genuinely cannot express. Every palette value is
 * a colour string; the one slot that takes a URL, BACKGROUND_IMAGE, is the grid
 * TILE, drawn as a repeating pattern in graph space — it pans and zooms with
 * the nodes, so a photo put there tiles and slides around under them.
 * Dark-Custom uses that slot the only sensible way, a 1x1 transparent PNG,
 * which is how it has no grid. A wallpaper therefore has to be a DOM layer
 * behind the canvas, which is the Backdrop section. It exports under
 * `nova_backdrop`, a key ComfyUI ignores and this node reads back, so one file
 * still carries the whole look.
 *
 * A DUMMY NODE, in LiteGraph's precise sense: registered by the frontend only,
 * no Python class behind it, `isVirtualNode = true` so `graphToPrompt` walks
 * past it. It cannot break a run, and a workflow containing it still opens on
 * an install that has never seen this file.
 */

import { app } from "/scripts/app.js";

const NODE_TYPE = "NovaThemeStudio";
const STORE = "Nova.ThemeStudio";
const BACKDROP_KEY = "nova_backdrop";
const LAYER_ID = "nova-backdrop";
const DOM_MARGIN = 8;
const PANEL_MIN_H = 240;

/* ------------------------------------------------------------------ keys --
 * The palette schema, in the order a theme file writes it. Live values are
 * merged over these, so a custom link type that only exists on this install —
 * MADOW, NOVA_SQLITE_ROWS, NOVA_TABLE — shows up as a row too, and a key this
 * list has not heard of is still editable rather than silently dropped.
 */
const SLOT_KEYS = [
    "CLIP", "CLIP_VISION", "CLIP_VISION_OUTPUT", "CONDITIONING", "CONTROL_NET",
    "IMAGE", "LATENT", "MASK", "MODEL", "STYLE_MODEL", "VAE", "NOISE", "GUIDER",
    "SAMPLER", "SIGMAS", "TAESD", "AUDIO", "WEBCAM", "BOOLEAN", "INT", "FLOAT",
    "STRING",
];

const LITEGRAPH_KEYS = [
    "BACKGROUND_IMAGE", "CLEAR_BACKGROUND_COLOR", "NODE_TITLE_COLOR",
    "NODE_SELECTED_TITLE_COLOR", "NODE_TEXT_SIZE", "NODE_TEXT_COLOR",
    "NODE_TEXT_HIGHLIGHT_COLOR", "NODE_SUBTEXT_SIZE", "NODE_DEFAULT_COLOR",
    "NODE_DEFAULT_BGCOLOR", "NODE_DEFAULT_BOXCOLOR", "NODE_DEFAULT_SHAPE",
    "NODE_BOX_OUTLINE_COLOR", "NODE_BYPASS_BGCOLOR", "NODE_ERROR_COLOUR",
    "DEFAULT_SHADOW_COLOR", "DEFAULT_GROUP_FONT", "WIDGET_BGCOLOR",
    "WIDGET_OUTLINE_COLOR", "WIDGET_TEXT_COLOR", "WIDGET_SECONDARY_TEXT_COLOR",
    "WIDGET_DISABLED_TEXT_COLOR", "LINK_COLOR", "EVENT_LINK_COLOR",
    "CONNECTING_LINK_COLOR", "BADGE_FG_COLOR", "BADGE_BG_COLOR",
];

const COMFY_KEYS = [
    "fg-color", "bg-color", "comfy-menu-bg", "comfy-menu-secondary-bg",
    "comfy-input-bg", "input-text", "descrip-text", "drag-text", "error-text",
    "border-color", "tr-even-bg-color", "tr-odd-bg-color", "content-bg",
    "content-fg", "content-hover-bg", "content-hover-fg", "bar-shadow",
];

/** Keys whose value is not a colour and must never meet a colour picker. */
const NOT_A_COLOUR = new Set([
    "BACKGROUND_IMAGE", "NODE_DEFAULT_SHAPE", "NODE_TEXT_SIZE",
    "NODE_SUBTEXT_SIZE", "DEFAULT_GROUP_FONT", "bar-shadow",
]);

const NUMERIC = new Set([
    "NODE_DEFAULT_SHAPE", "NODE_TEXT_SIZE", "NODE_SUBTEXT_SIZE",
]);

const FITS = ["cover", "contain", "tile", "center"];

const BACKDROP_DEFAULTS = { image: "", fit: "cover", blur: 0, dim: 0, hideGrid: true };

/* ---------------------------------------------------------------- colour --
 * Resolving a colour through the browser rather than by regex: `style.color`
 * accepts every CSS colour form there is — hex, rgb(), rgba(), hsl(), named,
 * "transparent" — and the computed value always comes back as rgb()/rgba().
 * One parser, no format left out, and no chance of disagreeing with what the
 * canvas will actually paint.
 */
const probe = document.createElement("span");

function parseColour(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    probe.style.color = "";
    probe.style.color = text;
    if (!probe.style.color) return null;          // the browser rejected it
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const m = computed.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map(s => parseFloat(s.trim()));
    return {
        r: parts[0] | 0, g: parts[1] | 0, b: parts[2] | 0,
        a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
    };
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const toHex = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** Opaque comes back as hex, translucent as rgba() — the two forms a theme
 *  file already uses, so an export reads like one written by hand. */
function compose(c) {
    if (c.a >= 0.999) return toHex(c);
    if (c.a <= 0.001) return "transparent";
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
}

/* ------------------------------------------------------------ live state -- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

function loadStore() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
        return {
            palette: raw.palette || null,
            backdrop: { ...BACKDROP_DEFAULTS, ...(raw.backdrop || {}) },
        };
    } catch {
        // Private window, blocked site data, or something else under this key.
        // A theme is worth less than the session: start clean.
        return { palette: null, backdrop: { ...BACKDROP_DEFAULTS } };
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORE, JSON.stringify({ palette, backdrop }));
    } catch { /* as above */ }
}

const stored = loadStore();
const backdrop = stored.backdrop;
let palette = null;      // { id, name, colors: {node_slot, litegraph_base, comfy_base} }
let baseline = null;     // what it was when this session started — what Reset restores

/** Build a palette from what is actually in effect right now. */
function readLive() {
    const LG = window.LiteGraph || {};
    const c = app?.canvas;
    const root = getComputedStyle(document.documentElement);

    const node_slot = {};
    const liveSlots = {
        ...(window.LGraphCanvas?.link_type_colors || {}),
        ...(c?.default_connection_color_byType || {}),
    };
    for (const k of new Set([...SLOT_KEYS, ...Object.keys(liveSlots)])) {
        const v = liveSlots[k];
        if (typeof v === "string" && v) node_slot[k] = v;
    }

    const litegraph_base = {};
    for (const k of LITEGRAPH_KEYS) {
        const v = LG[k];
        if (v !== undefined && v !== null && v !== "") litegraph_base[k] = v;
    }

    const comfy_base = {};
    for (const k of COMFY_KEYS) {
        const v = root.getPropertyValue(`--${k}`).trim();
        if (v) comfy_base[k] = v;
    }

    return {
        id: "nova-live",
        name: "Nova Live",
        colors: { node_slot, litegraph_base, comfy_base },
    };
}

/* ------------------------------------------------------------- applying --
 * The same three assignments ComfyUI itself performs when it loads a palette.
 * Doing it this way rather than calling the frontend's own service keeps this
 * working across frontend versions: the service has moved and been renamed,
 * the things it assigns to have not.
 */
function applyPalette() {
    if (!palette) return false;
    const c = app?.canvas;
    const LG = window.LiteGraph;
    if (!c || !LG) return false;
    const { node_slot = {}, litegraph_base = {}, comfy_base = {} } = palette.colors || {};

    if (c.default_connection_color_byType) Object.assign(c.default_connection_color_byType, node_slot);
    if (window.LGraphCanvas?.link_type_colors) Object.assign(window.LGraphCanvas.link_type_colors, node_slot);

    for (const [k, v] of Object.entries(litegraph_base)) LG[k] = v;
    // Four that the canvas caches on itself rather than reading from LiteGraph
    // each frame; assigning only the constant leaves the old value on screen.
    if ("NODE_TITLE_COLOR" in litegraph_base) c.node_title_color = litegraph_base.NODE_TITLE_COLOR;
    if ("LINK_COLOR" in litegraph_base) c.default_link_color = litegraph_base.LINK_COLOR;
    if ("CLEAR_BACKGROUND_COLOR" in litegraph_base) c.clear_background_color = litegraph_base.CLEAR_BACKGROUND_COLOR;
    if ("BACKGROUND_IMAGE" in litegraph_base && !backdrop.hideGrid) {
        c.background_image = litegraph_base.BACKGROUND_IMAGE;
        c._pattern = null;   // the cached CanvasPattern, built from the old tile
        c._bg_img = null;
    }

    const root = document.documentElement;
    for (const [k, v] of Object.entries(comfy_base)) root.style.setProperty(`--${k}`, v);

    c.setDirty(true, true);
    return true;
}

/* ------------------------------------------------------------- backdrop -- */

function resolveSrc(raw) {
    const src = String(raw || "").trim();
    if (!src) return "";
    if (/^(https?:|data:|blob:|file:|\/)/i.test(src)) return src;
    // A bare filename means "the file I dropped in ComfyUI/input", which is
    // already served by the same /view endpoint the image widgets use — no
    // extra route, no Python, and it survives a frontend reinstall.
    const parts = src.replace(/\\/g, "/").split("/").filter(Boolean);
    const filename = parts.pop() || "";
    return `/view?filename=${encodeURIComponent(filename)}` +
           `&type=input&subfolder=${encodeURIComponent(parts.join("/"))}`;
}

const cssUrl = (src) => `url("${src.replace(/["\\]/g, "\\$&")}")`;

function backdropLayer() {
    let el = document.getElementById(LAYER_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = LAYER_ID;
    // FIRST CHILD OF BODY, AND NO z-index. Painting order does the work: an
    // earlier sibling paints first, so everything ComfyUI mounts after it lands
    // on top. A negative z-index would put this behind body's own background,
    // where an opaque body colour would bury it.
    el.style.cssText = "position:fixed; inset:0; pointer-events:none;" +
                       "background-repeat:no-repeat; background-position:center center;";
    const scrim = document.createElement("div");
    scrim.id = `${LAYER_ID}-scrim`;
    scrim.style.cssText = "position:absolute; inset:0;";
    el.appendChild(scrim);
    document.body.insertBefore(el, document.body.firstChild);
    return el;
}

function applyBackdrop() {
    const el = backdropLayer();
    const scrim = document.getElementById(`${LAYER_ID}-scrim`);
    const src = resolveSrc(backdrop.image);

    el.style.backgroundImage = src ? cssUrl(src) : "none";
    const tile = backdrop.fit === "tile";
    el.style.backgroundSize = tile || backdrop.fit === "center" ? "auto" : backdrop.fit;
    el.style.backgroundRepeat = tile ? "repeat" : "no-repeat";
    // Blur samples from outside the element, leaving a soft transparent rim at
    // the edges of the viewport; scaling up pushes that rim off-screen.
    el.style.filter = backdrop.blur > 0 ? `blur(${backdrop.blur}px)` : "";
    el.style.transform = backdrop.blur > 0 ? "scale(1.06)" : "";
    if (scrim) scrim.style.background = backdrop.dim > 0 ? `rgba(0,0,0,${backdrop.dim})` : "transparent";

    const c = app?.canvas;
    if (c) {
        if (backdrop.hideGrid) {
            // LiteGraph's own hook: returning true sets `bg_already_painted`
            // and the pattern fill that draws the grid is skipped. The tile and
            // its cached pattern go too — clearing the URL alone would keep
            // drawing the grid from the cached CanvasPattern.
            c.onRenderBackground = () => true;
            c.background_image = null;
            c._pattern = null;
            c._bg_img = null;
        } else {
            c.onRenderBackground = null;
            const tileSrc = palette?.colors?.litegraph_base?.BACKGROUND_IMAGE;
            if (tileSrc) { c.background_image = tileSrc; c._pattern = null; c._bg_img = null; }
        }
        c.setDirty(true, true);
    }
}

function applyAll() {
    applyBackdrop();
    return applyPalette();
}

/* ------------------------------------------------------------- exporting -- */

function exportPalette() {
    return {
        id: palette?.id || "nova-custom",
        name: palette?.name || "Nova Custom",
        colors: JSON.parse(JSON.stringify(palette?.colors || {})),
        // A key ComfyUI ignores and this node reads back, so one file carries
        // the wallpaper as well as the colours.
        [BACKDROP_KEY]: { ...backdrop },
    };
}

function importPalette(obj) {
    if (!obj || typeof obj !== "object" || !obj.colors) {
        throw new Error("Not a ComfyUI palette: no `colors` object");
    }
    palette = {
        id: String(obj.id || "nova-custom"),
        name: String(obj.name || "Nova Custom"),
        colors: {
            node_slot: { ...(obj.colors.node_slot || {}) },
            litegraph_base: { ...(obj.colors.litegraph_base || {}) },
            comfy_base: { ...(obj.colors.comfy_base || {}) },
        },
    };
    if (obj[BACKDROP_KEY] && typeof obj[BACKDROP_KEY] === "object") {
        const b = obj[BACKDROP_KEY];
        backdrop.image = String(b.image || "");
        backdrop.fit = FITS.includes(b.fit) ? b.fit : "cover";
        backdrop.blur = clamp(b.blur, 0, 40);
        backdrop.dim = clamp(b.dim, 0, 0.9);
        backdrop.hideGrid = b.hideGrid !== false;
    }
    saveStore();
    applyAll();
}

/** Save into ComfyUI's own custom palettes, so it joins the theme dropdown and
 *  no file has to be edited at all. The settings API has moved between
 *  frontend versions, so both spellings are tried and a failure is reported
 *  rather than thrown — Download is always there as the fallback. */
async function saveToComfy() {
    const body = exportPalette();
    const id = body.id;
    const setting = "Comfy.CustomColorPalettes";
    const get = async () => {
        if (app.extensionManager?.setting?.get) return app.extensionManager.setting.get(setting);
        if (app.ui?.settings?.getSettingValue) return app.ui.settings.getSettingValue(setting, {});
        throw new Error("no settings API");
    };
    const set = async (v) => {
        if (app.extensionManager?.setting?.set) return app.extensionManager.setting.set(setting, v);
        if (app.ui?.settings?.setSettingValue) return app.ui.settings.setSettingValue(setting, v);
        throw new Error("no settings API");
    };
    const all = (await get()) || {};
    all[id] = body;
    await set(all);
    return id;
}

/* ------------------------------------------------------------------- DOM --
 * The same host/inner pattern the other Nova nodes use: the frontend's own DOM
 * widget sizing drifts from the node's real size while dragging, which spills
 * content outside the node, so the widget is a pass-through host and the
 * visible panel is sized from node.size on every frame.
 */
function makeDomHost(inner, initialH) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative; overflow:visible; pointer-events:none; width:100%; height:100%;";
    inner.style.cssText += ";position:absolute; left:0; top:0; width:300px;" +
                           `height:${initialH}px; box-sizing:border-box; pointer-events:auto;`;
    host.appendChild(inner);
    return host;
}

function pinDomSize(node, widget, inner, minH) {
    let lastW = -1, lastH = -1;
    const orig = node.onDrawForeground;
    node.onDrawForeground = function () {
        const r = orig?.apply(this, arguments);
        if (this.flags?.collapsed) return r;
        const y = widget.y ?? widget.last_y;
        if (typeof y === "number" && y > 0) {
            const w = Math.max(40, Math.round(this.size[0] - DOM_MARGIN * 2));
            const h = Math.max(minH, Math.round(this.size[1] - y - DOM_MARGIN * 1.5));
            if (w !== lastW) { inner.style.width = `${w}px`; lastW = w; }
            if (h !== lastH) { inner.style.height = `${h}px`; lastH = h; }
        }
        return r;
    };
}

const CSS = `
.nts { display:flex; flex-direction:column; gap:6px; padding:8px;
       box-sizing:border-box; overflow:hidden; border-radius:6px;
       background:var(--comfy-input-bg, rgba(0,0,0,.45));
       border:1px solid var(--border-color, #ffffff24);
       font:11px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
       color:var(--input-text, #dfe3f2); }
.nts__bar { display:flex; gap:5px; align-items:center; flex-wrap:wrap; flex:0 0 auto; }
.nts input, .nts select, .nts button {
       background:var(--comfy-input-bg, rgba(0,0,0,.5)); color:inherit; font:inherit;
       border:1px solid var(--border-color, #ffffff24); border-radius:4px; padding:3px 6px;
       min-width:0; box-sizing:border-box; }
.nts button { cursor:pointer; flex:0 0 auto; }
.nts button:hover { background:var(--content-hover-bg, rgba(255,255,255,.12)); }
.nts__search { flex:1 1 90px; }
.nts__rows { flex:1 1 auto; overflow-y:auto; overflow-x:hidden; display:flex;
             flex-direction:column; gap:3px; padding-right:2px; }
.nts__sec { position:sticky; top:0; z-index:1; padding:3px 4px; margin-top:4px;
            border-radius:3px; letter-spacing:.06em; text-transform:uppercase;
            font-size:10px; opacity:.75;
            background:var(--comfy-menu-bg, rgba(0,0,0,.65)); }
.nts__row { display:flex; gap:5px; align-items:center; }
.nts__row label { flex:0 0 40%; overflow:hidden; text-overflow:ellipsis;
                  white-space:nowrap; opacity:.85; }
.nts__row input[type=color] { flex:0 0 26px; height:20px; padding:1px; cursor:pointer; }
.nts__row input[type=range] { flex:0 0 52px; padding:0; accent-color:currentColor; }
.nts__row input[type=text], .nts__row input[type=number] { flex:1 1 60px; }
.nts__row.wide input[type=text] { flex:1 1 100%; }
.nts__msg { flex:0 0 auto; min-height:13px; opacity:.7; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; }
.nts__msg.err { color:var(--error-text, #ff8a5c); opacity:1; }
`;

function buildPanel(node) {
    const root = document.createElement("div");
    root.className = "nts";
    root.innerHTML = `<style>${CSS}</style>
        <div class="nts__bar">
            <input class="nts__search" type="text" placeholder="filter keys…">
            <select class="nts__group">
                <option value="">all sections</option>
                <option value="node_slot">node_slot</option>
                <option value="litegraph_base">litegraph_base</option>
                <option value="comfy_base">comfy_base</option>
                <option value="backdrop">backdrop</option>
            </select>
            <button data-act="reset" title="Back to the palette as it was when this tab opened">Reset</button>
            <button data-act="copy" title="Copy the theme JSON to the clipboard">Copy</button>
            <button data-act="save" title="Save into ComfyUI's custom themes, no file editing">Save</button>
            <button data-act="download" title="Download the theme JSON">Download</button>
            <button data-act="load" title="Load a theme JSON from a file">Load</button>
            <input class="nts__file" type="file" accept=".json,application/json" hidden>
        </div>
        <div class="nts__rows"></div>
        <div class="nts__msg"></div>`;

    const rows = root.querySelector(".nts__rows");
    const search = root.querySelector(".nts__search");
    const groupSel = root.querySelector(".nts__group");
    const file = root.querySelector(".nts__file");
    const msg = root.querySelector(".nts__msg");
    const say = (t, err = false) => { msg.textContent = t || ""; msg.classList.toggle("err", !!err); };

    // The canvas listens for bare keys — "n" adds a node, Delete removes the
    // selected one. Without this, typing a colour name deletes the node it is
    // being typed into.
    root.addEventListener("keydown", (e) => e.stopPropagation());
    root.addEventListener("pointerdown", (e) => e.stopPropagation());

    /** One editable value. Colour rows get swatch + alpha + text, all three
     *  bound to the same value; anything that is not a colour gets a plain
     *  field rather than being forced through a picker. */
    function makeRow(group, key, value, onChange) {
        const row = document.createElement("div");
        row.className = "nts__row";
        row.dataset.key = key;
        row.dataset.group = group;

        const label = document.createElement("label");
        label.textContent = key;
        label.title = key;
        row.appendChild(label);

        const colour = !NOT_A_COLOUR.has(key) && parseColour(value);

        if (!colour) {
            row.classList.add("wide");
            const field = document.createElement("input");
            field.type = NUMERIC.has(key) ? "number" : "text";
            field.value = value ?? "";
            field.title = String(value ?? "");
            field.addEventListener("input", () => {
                const v = field.type === "number" ? Number(field.value) : field.value;
                onChange(v);
            });
            row.appendChild(field);
            return row;
        }

        const swatch = document.createElement("input");
        swatch.type = "color";
        swatch.value = toHex(colour);

        const alpha = document.createElement("input");
        alpha.type = "range";
        alpha.min = "0"; alpha.max = "1"; alpha.step = "0.01";
        alpha.value = String(colour.a);
        alpha.title = "alpha";

        const text = document.createElement("input");
        text.type = "text";
        text.value = String(value);

        const push = (next) => { text.value = next; onChange(next); };
        swatch.addEventListener("input", () => {
            const c = parseColour(swatch.value);
            push(compose({ ...c, a: parseFloat(alpha.value) }));
        });
        alpha.addEventListener("input", () => {
            const c = parseColour(swatch.value);
            push(compose({ ...c, a: parseFloat(alpha.value) }));
        });
        text.addEventListener("input", () => {
            // Typed text wins as written — it is passed through verbatim so a
            // hand-tuned hsl() or named colour survives into the export. The
            // swatch and slider just follow along if it parses.
            const c = parseColour(text.value);
            if (c) { swatch.value = toHex(c); alpha.value = String(c.a); }
            onChange(text.value);
        });

        row.append(swatch, alpha, text);
        return row;
    }

    function render() {
        rows.innerHTML = "";
        const q = search.value.trim().toLowerCase();
        const only = groupSel.value;

        const section = (title) => {
            const h = document.createElement("div");
            h.className = "nts__sec";
            h.textContent = title;
            return h;
        };

        for (const group of ["node_slot", "litegraph_base", "comfy_base"]) {
            if (only && only !== group) continue;
            const table = palette?.colors?.[group] || {};
            const keys = Object.keys(table).filter(k => !q || k.toLowerCase().includes(q));
            if (!keys.length) continue;
            rows.appendChild(section(group));
            for (const key of keys) {
                rows.appendChild(makeRow(group, key, table[key], (v) => {
                    palette.colors[group][key] = v;
                    saveStore();
                    applyPalette();
                    node.setDirtyCanvas(true, true);
                }));
            }
        }

        if (!only || only === "backdrop") {
            const fields = [
                ["image", "text", "file in ComfyUI/input, or a URL"],
                ["fit", "combo", FITS],
                ["blur", "range", [0, 40, 1]],
                ["dim", "range", [0, 0.9, 0.01]],
                ["hideGrid", "check", null],
            ].filter(([k]) => !q || k.toLowerCase().includes(q));
            if (fields.length) {
                rows.appendChild(section("backdrop — not part of a theme file"));
                for (const [key, kind, extra] of fields) {
                    const row = document.createElement("div");
                    row.className = "nts__row wide";
                    const label = document.createElement("label");
                    label.textContent = key;
                    row.appendChild(label);

                    let input;
                    if (kind === "combo") {
                        input = document.createElement("select");
                        input.innerHTML = extra.map(v =>
                            `<option${v === backdrop[key] ? " selected" : ""}>${v}</option>`).join("");
                        input.style.flex = "1 1 60px";
                    } else if (kind === "check") {
                        input = document.createElement("input");
                        input.type = "checkbox";
                        input.checked = !!backdrop[key];
                        input.style.flex = "0 0 auto";
                    } else if (kind === "range") {
                        input = document.createElement("input");
                        input.type = "range";
                        [input.min, input.max, input.step] = extra.map(String);
                        input.value = String(backdrop[key]);
                        input.style.flex = "1 1 60px";
                    } else {
                        input = document.createElement("input");
                        input.type = "text";
                        input.value = backdrop[key];
                        input.placeholder = extra;
                    }

                    const read = () => kind === "check" ? input.checked
                        : kind === "range" ? parseFloat(input.value)
                        : input.value;
                    input.addEventListener("input", () => {
                        backdrop[key] = read();
                        saveStore();
                        applyBackdrop();
                    });
                    input.addEventListener("change", () => {
                        backdrop[key] = read();
                        saveStore();
                        applyBackdrop();
                    });
                    row.appendChild(input);
                    rows.appendChild(row);
                }
            }
        }

        if (!rows.children.length) say(`Nothing matches "${q}"`);
        else say("");
    }

    search.addEventListener("input", render);
    groupSel.addEventListener("change", render);

    root.querySelector('[data-act="reset"]').addEventListener("click", () => {
        palette = JSON.parse(JSON.stringify(baseline));
        saveStore();
        applyAll();
        render();
        say("Back to the palette this tab opened with");
    });

    root.querySelector('[data-act="copy"]').addEventListener("click", async () => {
        const text = JSON.stringify(exportPalette(), null, 2);
        try {
            await navigator.clipboard.writeText(text);
            say("Theme JSON copied");
        } catch {
            // Clipboard access is refused without a user gesture in some
            // contexts, and over plain http in others. The text still has to
            // reach the user, so fall back to the file.
            download(text);
            say("Clipboard refused — downloaded instead");
        }
    });

    function download(text) {
        const blob = new Blob([text], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${(palette?.id || "nova-custom")}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    root.querySelector('[data-act="download"]').addEventListener("click", () => {
        download(JSON.stringify(exportPalette(), null, 2));
        say("Downloaded");
    });

    root.querySelector('[data-act="save"]').addEventListener("click", async () => {
        try {
            const id = await saveToComfy();
            say(`Saved as "${id}" — pick it in Settings ▸ Appearance`);
        } catch (e) {
            say(`Could not save to ComfyUI (${e.message}) — use Download`, true);
        }
    });

    root.querySelector('[data-act="load"]').addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
            importPalette(JSON.parse(await f.text()));
            render();
            say(`Loaded "${palette.name}"`);
        } catch (e) {
            say(`Could not load: ${e.message}`, true);
        }
        file.value = "";
    });

    return { element: root, render, say };
}

/* ----------------------------------------------------------- extension -- */

function bootstrap() {
    if (!app?.canvas || !window.LiteGraph) return false;
    // The live palette is the starting point, so opening the node shows what is
    // on screen rather than a set of defaults that would repaint everything the
    // moment it appears.
    baseline = readLive();
    palette = stored.palette
        ? JSON.parse(JSON.stringify(stored.palette))
        : JSON.parse(JSON.stringify(baseline));
    applyAll();
    return true;
}

function bootstrapWhenReady(tries = 100) {
    if (bootstrap() || tries <= 0) return;
    setTimeout(() => bootstrapWhenReady(tries - 1), 100);
}

app.registerExtension({
    name: "Nova.ThemeStudio",

    async setup() {
        bootstrapWhenReady();

        // The escape hatch, for the day this node is not in the open graph.
        window.novaTheme = {
            help() {
                console.log(
                    "novaTheme.get()            the palette as JSON text\n" +
                    "novaTheme.set(obj|text)    load a palette and apply it\n" +
                    "novaTheme.reset()          back to this tab's starting palette\n" +
                    "novaTheme.backdrop({image,fit,blur,dim,hideGrid})\n" +
                    "novaTheme.live()           re-read what is on screen now"
                );
            },
            get: () => JSON.stringify(exportPalette(), null, 2),
            set(v) { importPalette(typeof v === "string" ? JSON.parse(v) : v); },
            reset() { palette = JSON.parse(JSON.stringify(baseline)); saveStore(); applyAll(); },
            backdrop(patch) {
                Object.assign(backdrop, patch || {});
                backdrop.blur = clamp(backdrop.blur, 0, 40);
                backdrop.dim = clamp(backdrop.dim, 0, 0.9);
                saveStore();
                applyBackdrop();
            },
            live() { baseline = readLive(); return baseline; },
        };
    },

    registerCustomNodes() {
        const LG = window.LiteGraph;
        if (!LG?.registerNodeType) return;

        class NovaThemeStudio {
            constructor() {
                // The line that keeps this node harmless: graphToPrompt skips
                // virtual nodes, so it is never sent to the backend.
                this.isVirtualNode = true;
                this.serialize_widgets = false;
                this.size = [430, 460];

                if (!palette) bootstrap();

                // The panel is built in _ensurePanel rather than here. A DOM
                // widget registers itself with the frontend's widget store
                // under the node's id, and a node under construction does not
                // have one yet — it gets it when it joins the graph. Building
                // on `onAdded` is the path every node takes; the animation
                // frame is for a node created some other way, and the flag
                // makes whichever arrives first the only one that builds.
                requestAnimationFrame(() => this._ensurePanel());
            }

            _ensurePanel() {
                if (this._panel) { this._panel.render(); return; }
                if (!palette) bootstrap();

                const panel = buildPanel(this);
                this._panel = panel;

                const widget = this.addDOMWidget("nova_theme_studio", "HTML",
                    makeDomHost(panel.element, PANEL_MIN_H), {
                        serialize: false,
                        hideOnZoom: false,
                        getMinHeight: () => PANEL_MIN_H,
                    });
                widget.computeSize = (width) => [width ?? this.size[0], PANEL_MIN_H + DOM_MARGIN];
                pinDomSize(this, widget, panel.element, PANEL_MIN_H);
                panel.render();
            }

            onAdded() { this._ensurePanel(); }

            /** The palette is carried IN THE WORKFLOW as well as in
             *  localStorage, so a graph shared with someone else arrives
             *  looking the way it was built. */
            onSerialize(o) {
                o.properties = o.properties || {};
                o.properties.palette = exportPalette();
            }

            onConfigure(o) {
                const saved = o?.properties?.palette;
                if (!saved) return;
                try {
                    importPalette(saved);
                    this._panel?.render();
                } catch {
                    // A workflow from a newer build of this node, or a hand-
                    // edited one. The graph matters more than its colours.
                }
            }
        }

        NovaThemeStudio.title = "Nova Theme Studio 🎨";
        NovaThemeStudio.category = "Nova/utils";
        NovaThemeStudio.collapsable = true;
        NovaThemeStudio.desc =
            "Edit the ComfyUI colour palette live, plus a wallpaper behind the " +
            "canvas. Frontend only — never sent to the backend.";

        LG.registerNodeType(NODE_TYPE, NovaThemeStudio);
    },
});
