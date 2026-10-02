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
import { vueSize, keepMinimumWidth } from "../core/vue-size.js";

/**
 * TWO COPIES OF THIS FILE CANNOT BOTH WIN, AND THE LOSER IS SILENT.
 *
 * ComfyUI loads every `.js` under the extension folder, so a stale duplicate
 * left anywhere in the tree runs too. Both call `registerExtension` with the
 * same name; whichever gets there first wins, and the other is rejected with
 * "Extension named 'Nova.ThemeStudio' already registered" — a message that
 * names neither file and does not say which one lost.
 *
 * Being a load-order race, it changes from reload to reload: when the current
 * file wins everything works, and when a stale one wins the page gets a studio
 * that knows nothing about the Nodes 2.0 adapter and comes up unthemed.
 * Diagnosed from a log containing two page loads — the first carried this
 * file's "started" line, the second carried no line from it at all.
 *
 * Hence this. One property, and an unexplainable intermittent failure becomes
 * a console line naming both files.
 */
(() => {
    const KEY = "__novaThemeStudioModule";
    const here = import.meta.url;
    const first = globalThis[KEY];
    if (!first) { globalThis[KEY] = here; return; }
    if (first === here) return;
    console.error(
        "[Nova Theme Studio] TWO COPIES of this extension are installed and only " +
        "one of them can register. Which one wins changes between reloads, and a " +
        "stale copy winning is why a page sometimes loads with no theme. Delete " +
        "whichever of these is not the current file:",
        { loadedFirst: first, alsoLoaded: here });
})();

const NODE_TYPE = "NovaThemeStudio";
const NODE_TITLE = "Nova Theme Studio 🎨";
const NODE_DESC = "Edit the ComfyUI colour palette live, plus a wallpaper " +
                  "behind the canvas. Frontend only — never sent to the backend.";
/* --------------------------------------------------------- the menu it --
 *                                                              belongs in
 *
 * FOUND BY VALUE, NOT WRITTEN DOWN — which is what the companion .py already
 * does, and this file should have done from the start.
 *
 * The pack's section is `▶️ Nova Audio/🛠️ Utility & IO`, emoji and all, and a
 * literal here meant the emoji had to be typed back in by hand on every update
 * of this file. Worse, a literal drifts silently: rename the section and this
 * node quietly moves to a submenu of its own with the old name, which looks
 * like the menu duplicating itself rather than like a stale string.
 *
 * So the section is read off the nodes that are already registered — the same
 * "match on the value, whatever it is called" rule the Python uses. The
 * literal below is only what happens when nothing at all is registered to
 * learn from, which in a working install is never.
 */
const CATEGORY_TAIL = "Utility & IO";
const NODE_CATEGORY_FALLBACK = "▶️ Nova Audio/🛠️ Utility & IO";

function novaCategory() {
    const types = window.LiteGraph?.registered_node_types || {};
    for (const cls of Object.values(types)) {
        const cat = typeof cls?.category === "string" ? cls.category.trim() : "";
        // `__frontend_only__` is the synthetic category the frontend invents
        // for a node with no backend definition, so it names nothing real.
        if (!cat || cat === "__frontend_only__") continue;
        if (cat.endsWith(CATEGORY_TAIL)) return cat;
    }
    return NODE_CATEGORY_FALLBACK;
}
const STORE = "Nova.ThemeStudio";
const BACKDROP_KEY = "nova_backdrop";
const PRESET_KEY = "nova_preset";
const LAYER_ID = "nova-backdrop";
const DOM_MARGIN = 8;
// Raised when the top-panel row was added to the preset bar: the bar wraps, so
// a minimum sized for four rows of chips leaves a five-row bar with the key
// list clipped off the bottom of a node that has just been created.
const PANEL_MIN_H = 264;
// Room for the toolbar, both chip rows, the name row and a usable stretch of
// the key list without reaching for the resize handle first.
const DEFAULT_SIZE = [660, 820];
// A floor, not a default: below this the chips wrap into a column and the key
// rows lose their text fields.
const MIN_SIZE = [430, 330];

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

/* --------------------------------------------------------------- presets --
 * SIX THEMES AND FOUR FINISHES, NOT TWENTY-FOUR PALETTES.
 *
 * The two axes are independent: a theme decides the hues, a finish decides how
 * much of the wallpaper comes through them. Writing out every combination by
 * hand would be twenty-four palettes to keep in step, and the first edit to a
 * shared value would put them out of step. Composing instead means a finish
 * works with every theme by construction, including themes added later.
 *
 * A preset deliberately leaves two things alone. `node_slot` is not touched,
 * because link colours are SEMANTIC — LATENT is pink, MODEL is purple, and the
 * custom Nova types have their own — and recolouring them per theme would make
 * a familiar graph unreadable for the sake of a mood. The font size keys are
 * left alone for the same reason: they are a legibility setting, not a colour,
 * and yours are already tuned for a 2560x1440 display.
 */

// A 1x1 fully transparent PNG: the grid tile that draws no grid, same trick
// Dark-Custom uses.
const TRANSPARENT_TILE =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function hexToRgb(hex) {
    let h = String(hex).replace("#", "").trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return Number.isFinite(n)
        ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
        : { r: 0, g: 0, b: 0 };
}

/** A theme colour at a finish's alpha. Opaque stays hex, so an exported
 *  "Solid" palette reads like one written by hand. */
function rgba(hex, a) {
    if (a >= 0.999) return hex;
    if (a <= 0.001) return "transparent";
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

const THEMES = [
    {
        id: "midnight", name: "Midnight", swatch: "#4c7dff",
        deep: "#060913", ink: "#0d1428", field: "#131b31",
        accent: "#4c7dff", title: "#e9edff", text: "#c3cbe6", dim: "#8791b0",
        border: "#2b3557", error: "#ff6b6b",
    },
    {
        id: "ember", name: "Ember", swatch: "#ff8f45",
        deep: "#120a06", ink: "#1d1109", field: "#2a190d",
        accent: "#ff8f45", title: "#ffeede", text: "#e4cdb8", dim: "#b09079",
        border: "#4a2f1a", error: "#ff5c5c",
    },
    {
        id: "nova", name: "Nova", swatch: "#e07cd6",
        deep: "#0f0715", ink: "#1a0f24", field: "#251534",
        accent: "#e07cd6", title: "#fbe9fb", text: "#d8c4e4", dim: "#a688b8",
        border: "#432a56", error: "#ff6f91",
    },
    {
        id: "forest", name: "Forest", swatch: "#4fd1a1",
        deep: "#05100c", ink: "#0b1c16", field: "#112a21",
        accent: "#4fd1a1", title: "#e4fff4", text: "#bcd9cd", dim: "#7fa294",
        border: "#204a3a", error: "#ff7b6b",
    },
    {
        id: "slate", name: "Slate", swatch: "#9aa7bd",
        deep: "#0c0e11", ink: "#16191f", field: "#1f242c",
        accent: "#9aa7bd", title: "#f0f2f6", text: "#c6ccd7", dim: "#8b929e",
        border: "#333a45", error: "#ff7a7a",
    },
    {
        id: "ultraviolet", name: "Ultraviolet", swatch: "#a06bff",
        deep: "#08060f", ink: "#140e26", field: "#1e1636",
        accent: "#a06bff", title: "#eee6ff", text: "#cabde8", dim: "#9182b8",
        border: "#3a2a63", error: "#ff5fa8",
    },
];

/**
 * How much of the wallpaper comes through each layer.
 *
 * A NODE BODY IS EITHER DRAWN OR IT IS NOT — THERE IS NO PARTLY.
 *
 * This is measured, not assumed. On a Glass preset with the body at
 * rgba(13, 20, 40, 0.10) over a 0.55 wash, roughly a third of the wallpaper's
 * variation should have come through. Sampling five points across a node body
 * against five points on the canvas beside it: the canvas varied by 24 levels
 * of red, the body by ZERO. The renderer takes the colour's channels and fills
 * opaquely; the alpha is discarded. The one value it does honour is the literal
 * `transparent`, which makes it skip the fill altogether.
 *
 * So glass cannot be dialled on the body. It is `transparent` — the node stops
 * being painted and becomes a window — and the DARKNESS MOVES TO THE WASH,
 * which is a different fill and does honour its alpha. That is exactly the
 * shape Dark-Custom had, and why it looked right: bodies at `transparent`, wash
 * at 0.6. `null` below means that literal.
 *
 * The same goes for the title bar and the widget pills: canvas-drawn, so an
 * alpha between 0 and 1 buys nothing. They are opaque or absent, and an opaque
 * title bar over an absent body is what keeps a node looking like a node.
 *
 * `menu`, `input` and the rest of comfy_base are CSS rather than canvas, so
 * their alpha works normally and can be graded.
 *
 * `node` is `editor_alpha`. It is the only thing that genuinely fades a node
 * body — and it fades the title and every label with it, which is unreadable
 * well before it is glassy. It stays at 1 in every finish, so choosing a finish
 * always puts it back; the slider in the panel is there for deliberate use.
 */
/*
 * The wash values are not chosen by eye. Once the body stops being painted,
 * that wash is the ONLY thing behind node text, so each one was solved for
 * contrast against the brightest wallpaper a photo is likely to put there
 * (235, 210, 220), taking the worst of the six themes:
 *
 *     wash   worst contrast        wash   worst contrast
 *     1.00      11.5                0.65      4.56  <- AA body, the floor
 *     0.88       9.25               0.55      3.30  <- AA large only
 *     0.70       5.38               0.45      2.44  <- fails outright
 *
 * Glass sits at 0.65 rather than lower because 0.45 measured 2.44:1, which is
 * below even the large-text threshold — see-through, and unreadable with it.
 * The wallpaper's own `dim` slider is there for anyone who wants to push
 * further and can live with the trade.
 */
const FINISHES = [
    { id: "solid",   name: "Solid",   body: 1.00, widget: 1.00, menu: 1.00, input: 1.00, canvas: 1.00, node: 1.00 },
    { id: "tinted",  name: "Tinted",  body: null, widget: 1.00, menu: 0.92, input: 0.90, canvas: 0.92, node: 1.00 },
    { id: "frosted", name: "Frosted", body: null, widget: null, menu: 0.72, input: 0.62, canvas: 0.80, node: 1.00 },
    { id: "glass",   name: "Glass",   body: null, widget: null, menu: 0.45, input: 0.40, canvas: 0.65, node: 1.00 },
];

/** A canvas-drawn layer: painted at full strength, or not painted at all. */
const layer = (hex, a) => (a === null ? "transparent" : rgba(hex, a));

const themeById = (id) => THEMES.find(t => t.id === id) || THEMES[0];
const finishById = (id) => FINISHES.find(f => f.id === id) || FINISHES[0];

/** A full palette for one theme at one finish, merged over what is loaded now
 *  so node_slot and the font sizes carry through untouched. */
function buildPreset(themeId, finishId, base) {
    const t = themeById(themeId);
    const f = finishById(finishId);
    const current = base?.colors || {};

    return {
        id: `nova-${t.id}-${f.id}`,
        name: `${t.name} ${f.name}`,
        colors: {
            // Untouched on purpose — see the note above.
            node_slot: { ...(current.node_slot || {}) },

            litegraph_base: {
                ...(current.litegraph_base || {}),
                BACKGROUND_IMAGE: TRANSPARENT_TILE,
                CLEAR_BACKGROUND_COLOR: rgba(t.deep, f.canvas),
                NODE_TITLE_COLOR: t.title,
                NODE_SELECTED_TITLE_COLOR: t.accent,
                NODE_TEXT_COLOR: t.text,
                NODE_TEXT_HIGHLIGHT_COLOR: t.title,
                // Opaque in every finish. Canvas-drawn, so a middling alpha
                // would render solid anyway, and a title bar is what still
                // reads as a node once the body has gone.
                NODE_DEFAULT_COLOR: t.field,
                NODE_DEFAULT_BGCOLOR: layer(t.ink, f.body),
                NODE_DEFAULT_BOXCOLOR: t.border,
                NODE_BOX_OUTLINE_COLOR: t.accent,
                NODE_BYPASS_BGCOLOR: rgba(t.accent, 0.18),
                NODE_ERROR_COLOUR: t.error,
                DEFAULT_SHADOW_COLOR: "rgba(0, 0, 0, 0.45)",
                WIDGET_BGCOLOR: layer(t.field, f.widget),
                // Opaque, and it matters more the glassier things get: with no
                // pill behind them, the outline is the only thing separating
                // one widget row from the next.
                WIDGET_OUTLINE_COLOR: t.border,
                WIDGET_TEXT_COLOR: t.text,
                WIDGET_SECONDARY_TEXT_COLOR: t.dim,
                WIDGET_DISABLED_TEXT_COLOR: rgba(t.dim, 0.45),
                LINK_COLOR: t.accent,
                EVENT_LINK_COLOR: rgba(t.accent, 0.75),
                CONNECTING_LINK_COLOR: t.title,
                BADGE_FG_COLOR: rgba(t.title, 0.7),
                BADGE_BG_COLOR: rgba(t.deep, Math.min(1, f.menu + 0.2)),
            },

            comfy_base: {
                ...(current.comfy_base || {}),
                "fg-color": t.text,
                "bg-color": rgba(t.deep, f.canvas),
                "comfy-menu-bg": rgba(t.ink, f.menu),
                "comfy-menu-secondary-bg": rgba(t.deep, f.menu),
                "comfy-input-bg": rgba(t.field, f.input),
                "input-text": t.text,
                "descrip-text": t.dim,
                "drag-text": t.title,
                "error-text": t.error,
                "border-color": rgba(t.border, Math.min(1, f.widget + 0.3)),
                "tr-even-bg-color": rgba(t.ink, f.widget),
                "tr-odd-bg-color": rgba(t.field, f.widget),
                "content-bg": rgba(t.field, f.menu),
                "content-fg": t.title,
                "content-hover-bg": rgba(t.accent, 0.22),
                "content-hover-fg": t.title,
                "bar-shadow": `${rgba(t.deep, 0.55)} 0 0 0.5rem`,
            },
        },
    };
}

/** A name that is safe as a filename and as a palette id. */
function slug(name) {
    const s = String(name || "").trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return s || "nova-custom";
}

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

/** Same, except zero alpha keeps its channels: rgba(r, g, b, 0) rather than
 *  the literal `transparent`, which is black with the alpha off and cannot be
 *  faded back up into the colour it replaced. */
function composeKeep(c) {
    if (c.a >= 0.999) return toHex(c);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
}

/**
 * A colour for the swatch when the value itself has none.
 *
 * Seeded from a neighbouring key rather than an invented default, so raising
 * the alpha on a transparent node background gives the node's own colouring at
 * low opacity — which is what "make it slightly see-through" was asking for —
 * instead of black.
 */
const SEED_KEYS = {
    NODE_DEFAULT_BGCOLOR: ["NODE_DEFAULT_COLOR", "CLEAR_BACKGROUND_COLOR", "bg-color"],
    NODE_DEFAULT_COLOR: ["NODE_DEFAULT_BGCOLOR", "CLEAR_BACKGROUND_COLOR"],
    WIDGET_BGCOLOR: ["NODE_DEFAULT_BGCOLOR", "NODE_DEFAULT_COLOR", "comfy-input-bg"],
    NODE_BYPASS_BGCOLOR: ["NODE_DEFAULT_BGCOLOR"],
};

function seedFor(group, key) {
    const colors = palette?.colors || {};
    for (const candidate of SEED_KEYS[key] || []) {
        for (const table of [colors.litegraph_base, colors.comfy_base, colors[group]]) {
            const raw = table?.[candidate];
            if (!raw) continue;
            const c = parseColour(raw);
            // A neighbour that is itself transparent is no help.
            if (c && (c.r || c.g || c.b)) return { ...c, a: 0, from: candidate };
        }
    }
    return { r: 32, g: 32, b: 38, a: 0, from: "a neutral dark" };
}

/* ------------------------------------------------------------ live state -- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

// `enabled` is the master switch: off, the studio applies nothing at all and
// the page looks the way ComfyUI draws it. `restyleAll` is kept only so a
// store written by an older build still loads; nothing sets it any more.
const PRESET_DEFAULTS = { theme: "", finish: "", nodeAlpha: 1, restyleAll: false,
                          renderer: "auto", collapsible: false, enabled: true };

/* ------------------------------------------------------------- renderer --
 * NODES 2.0 IS A DIFFERENT RENDERER, NOT A DIFFERENT SKIN.
 *
 * A palette has two halves and they reach a node by completely different
 * routes. `comfy_base` becomes CSS custom properties on :root, so it styles
 * anything built from DOM — menus, dialogs, panels — whichever renderer is
 * running. `litegraph_base` becomes constants that the CANVAS reads while it
 * paints node bodies, titles, widgets and slots. Turn on Nodes 2.0 and nodes
 * stop being painted on the canvas at all, so that half has nothing left to
 * talk to. The CSS half keeps working; the canvas half goes quiet.
 *
 * DETECTED BY BEHAVIOUR, NOT BY NAME. A setting id is a guess that goes stale
 * the moment it is renamed, and the beta's id is not something to hard-code
 * blind. What cannot lie is whether the canvas is still drawing nodes: the
 * probe below notes every call to drawNode, and a graph that holds nodes while
 * drawNode has gone quiet is a graph being rendered by something else. The
 * settings lookup runs too, but only to put a name to what was already
 * measured.
 */
const RENDERER_MODES = ["auto", "v1", "v2"];

// Where a Nodes 2.0 adapter registers itself. It is a SEPARATE FILE on purpose:
// this one drives a renderer whose behaviour is known and measured, and mixing
// in guesses about another would put both at risk. Ship
// nova_theme_studio_v2.js beside this file and it is picked up here.
window.novaThemeRenderers = window.novaThemeRenderers || {};

let lastDrawNode = 0;
/** Whether DOM node cards have ever been seen on this page. Once they have,
 *  auto-detection is not allowed to downgrade to the classic renderer. */
let everV2 = false;
let lastRenderer = null;   // what the most recent apply found
let v2Applied = null;      // true / false under v2, null under v1

function installDrawProbe() {
    const proto = window.LGraphCanvas?.prototype;
    if (!proto || proto.__novaDrawProbe) return;
    proto.__novaDrawProbe = true;
    const orig = proto.drawNode;
    if (typeof orig !== "function") return;
    proto.drawNode = function () {
        // ONLY THE GRAPH'S OWN CANVAS COUNTS.
        //
        // `drawNode` is on the prototype, so every LGraphCanvas on the page
        // goes through it — including the MINIMAP, which paints the whole
        // graph continuously no matter which renderer is drawing the real
        // nodes. Counting those paints as "the classic renderer is working"
        // was enough to conclude v1 on a Nodes 2.0 page and tear a perfectly
        // good theme down. Measured: an adapter reporting `why: "removed"` on
        // a page whose nodes were plainly DOM.
        if (!app?.canvas || this === app.canvas) lastDrawNode = Date.now();
        return orig.apply(this, arguments);
    };
}

/** Read a setting under either of the two APIs, without throwing on neither. */
function readSetting(id) {
    try {
        if (app.extensionManager?.setting?.get) return app.extensionManager.setting.get(id);
        if (app.ui?.settings?.getSettingValue) return app.ui.settings.getSettingValue(id, undefined);
    } catch { /* an id this build does not know */ }
    return undefined;
}

// Only ever used to LABEL what the probe already decided, never to decide it.
const V2_SETTING_IDS = [
    "Comfy.VueNodes.Enabled", "LiteGraph.Canvas.VueNodes", "Comfy.Node.Vue",
    "Comfy.Nodes2", "Comfy.NodeLibrary.Nodes2",
];

/**
 * The element that IS a node, if the node is made of DOM at all.
 *
 * Width alone is not enough to identify one. Under the classic renderer a DOM
 * WIDGET is also parented over the canvas at the node's width, so a node with a
 * panel on it — this one, for instance — would look like a DOM node. What
 * separates them is the TITLE: Nodes 2.0 renders it as text inside the card,
 * and the classic renderer paints it on the canvas where no element can contain
 * it. So the candidate must both match the node's width and carry its name.
 */
function domCardFor(node, point) {
    // Emoji and punctuation are stripped: a node titled "Nova Theme Studio 🎨"
    // is matched on the words, which survive however the emoji is rendered.
    const title = String(node?.title || "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const needle = title.slice(0, 14);
    const slack = Math.max(8, point.width * 0.12);

    for (const hit of document.elementsFromPoint?.(point.x, point.y) || []) {
        if (hit.tagName === "CANVAS" || hit.closest?.(".nts")) continue;
        for (let el = hit; el && el !== document.body; el = el.parentElement) {
            const r = el.getBoundingClientRect();
            if (r.width > point.width + slack) break;      // past the node now
            if (Math.abs(r.width - point.width) > slack) continue;
            if (!needle || (el.textContent || "").includes(needle)) return el;
        }
    }
    return null;
}

/**
 * MEASURED BY WHAT EXISTS, NOT BY WHAT IS RUNNING.
 *
 * The first version of this watched `drawNode` and called it Nodes 2.0 when the
 * canvas went quiet. On a real graph that was wrong: with Nodes 2.0 on, three
 * `lg-node` elements sat at the node's position AND `drawNode` was still
 * firing, because LiteGraph goes on drawing the canvas layer for the links
 * whichever way the nodes are rendered. Silence was never going to come.
 *
 * Whether a node is DOM is not a timing question. It is a question about the
 * document, and the document can simply be asked.
 */
function detectRenderer() {
    installDrawProbe();
    const nodes = styleTargets().nodes;

    let named = null;
    for (const id of V2_SETTING_IDS) {
        const v = readSetting(id);
        if (typeof v === "boolean") { named = { id, on: v }; break; }
    }

    if (!nodes.length) {
        return { mode: named?.on ? "v2" : "unknown", nodes: 0,
                 how: named ? `setting ${named.id}` : "no nodes on the canvas yet" };
    }

    // THE SETTING DECIDES, AND THE PAGE CONFIRMS.
    //
    // `Comfy.VueNodes.Enabled` is the frontend's own statement of which
    // renderer it is running, and every Nodes 2.0 card carries `data-node-id`.
    // Either is a direct answer; neither depends on a node being on screen, on
    // the zoom, on what is drawn over a node or on its title having rendered,
    // which is everything the hit-test below depends on.
    //
    // Retests 1 to 3 of 2.7.0 are why this comes first. With Nodes 2.0 on and
    // 31 cards in the page, this function answered "v1" because the canvas had
    // painted a node 142 ms earlier — and on frontend 1.53.6 the canvas goes on
    // calling `drawNode` under Nodes 2.0 (24 calls in 1.5 s, ComfyUI's own
    // renderFrame -> draw -> drawFrontCanvas). A v1 answer removes the
    // adapter's stylesheet and counts as settled, so Glass was never applied.
    if (named?.on === true) {
        everV2 = true;
        return { mode: "v2", nodes: nodes.length, how: `setting ${named.id}` };
    }
    if (named?.on !== false && document.querySelector("[data-node-id]")) {
        everV2 = true;
        return { mode: "v2", nodes: nodes.length, how: "node cards carry data-node-id" };
    }
    // AND THE SAME RULE THE OTHER WAY. When the setting says Nodes 2.0 is off,
    // the canvas is drawing the nodes. Before this, switching the setting off
    // on an open page left the answer at "unknown" for good (regression pass,
    // R-1): the page had once had cards, so a v1 reading was refused, and the
    // Nodes 2.0 stylesheet stayed in a page that no longer had any cards.
    if (named?.on === false) {
        return { mode: "v1", nodes: nodes.length, how: `setting ${named.id} is off` };
    }

    // SAMPLED FROM WHAT IS ON SCREEN, not from the first eight in the list.
    // This is a hit-test, so a node scrolled out of view cannot answer it —
    // and on a large graph the first eight are very often exactly the ones
    // that have been panned away from.
    const onScreen = [];
    for (const node of nodes) {
        const point = screenPointFor(node, app?.canvas);
        if (!point.why) onScreen.push({ node, point });
        if (onScreen.length >= 8) break;
    }

    for (const { node, point } of onScreen) {
        const el = domCardFor(node, point);
        if (el) {
            everV2 = true;
            return { mode: "v2", nodes: nodes.length,
                     how: `the nodes are DOM (<${el.tagName.toLowerCase()}> carries the title)` };
        }
    }

    // "NO DOM CARD" IS NOT THE SAME AS "THE CANVAS IS DRAWING THEM", and
    // treating it as such cost a working theme.
    //
    // A v1 answer makes `applyPalette` strip the adapter's stylesheet, and it
    // also makes `rendererSettled()` true — so the nodes went to default and
    // nothing ever asked again. Any moment the hit-test came up empty was
    // enough: every node panned off screen, the cards mid-rebuild, a dialog
    // over the canvas. Reported as the theme holding for a while and then
    // showing the default, which is exactly what a teardown with no recovery
    // looks like.
    //
    // The classic renderer has a positive signal of its own: it paints nodes
    // through `LGraphCanvas.drawNode`, which `installDrawProbe` has been
    // timestamping all along without anything ever reading it. So v1 now
    // requires evidence that the canvas really is painting, and the absence of
    // both answers is reported as the absence of an answer.
    const sincePaint = lastDrawNode ? Date.now() - lastDrawNode : Infinity;

    if (sincePaint < 2000) {
        // AUTO-DETECTION MAY DECIDE, BUT IT MAY NOT CHANGE ITS MIND DOWNWARDS.
        //
        // A v1 answer strips the adapter's stylesheet, and the renderer does
        // not actually change while a page is open — switching it is a setting
        // and a reload. So once DOM cards have been seen, "it looks like v1
        // right now" is far likelier to be a bad moment than a real change:
        // cards mid-rebuild, a tab just switched, every node off screen. The
        // cost of believing it is a themed page going grey with no way back;
        // the cost of refusing it is nothing at all, because a genuine switch
        // comes with a reload, and the chips still set it by hand.
        if (everV2 && preset.renderer !== "v1") {
            return { mode: "unknown", nodes: nodes.length, onScreen: onScreen.length,
                     how: "no card found just now, but this page has had them — " +
                          "not treating that as a switch to the classic renderer" };
        }
        return { mode: "v1", nodes: nodes.length,
                 how: `the canvas painted a node ${sincePaint} ms ago` };
    }
    return { mode: "unknown", nodes: nodes.length, onScreen: onScreen.length,
             how: onScreen.length
                 ? "no card carries a title and the canvas has not painted one either"
                 : "no node is on screen to test" };
}

/** The renderer in force: the manual override, or what the probe found. */
function activeRenderer() {
    if (preset.renderer === "v1" || preset.renderer === "v2") {
        return { mode: preset.renderer, how: "set by hand", nodes: styleTargets().nodes.length };
    }
    return detectRenderer();
}

/**
 * What is actually colouring a node right now.
 *
 * WRITTEN TO BE READ BY WHOEVER BUILDS THE ADAPTER, and deliberately not a
 * guess. Rather than hunting for class names that may or may not exist, it
 * converts a node's graph coordinates to screen coordinates and asks the
 * browser what is at that point. Under the classic renderer the answer is the
 * canvas, which is the finding; under Nodes 2.0 it is whatever element the new
 * renderer put there, reported with its computed colours and every CSS custom
 * property in scope on it. That is the list an adapter has to write to, and it
 * comes from the running frontend rather than from anybody's recollection.
 */
/**
 * A node's pos / size, which are NOT plain arrays.
 *
 * LiteGraph keeps them in a Float32Array, and `Array.isArray` says no to one.
 * Guarding with it skipped the whole coordinate block, which is why the first
 * probe came back with `at: []` for every node and no screenPoint at all — a
 * bug here, not a quirk of the frontend. Length and two finite numbers is the
 * question that was meant to be asked.
 */
const isPoint = (v) => !!v && typeof v === "object" && v.length >= 2 &&
    Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]));

/** Where a node's body sits on screen, or why it could not be worked out. */
function screenPointFor(node, canvas) {
    const ds = canvas?.ds;
    const el = canvas?.canvas;
    if (!ds) return { why: "canvas.ds is missing" };
    if (!el?.getBoundingClientRect) return { why: "canvas element is missing" };
    if (!isPoint(node?.pos)) return { why: `node.pos is ${typeof node?.pos}` };
    if (!isPoint(node?.size)) return { why: `node.size is ${typeof node?.size}` };

    const rect = el.getBoundingClientRect();
    const scale = Number(ds.scale) || 1;
    const off = isPoint(ds.offset) ? ds.offset : [0, 0];
    const w = Number(node.size[0]), h = Number(node.size[1]);
    return {
        x: (Number(node.pos[0]) + w / 2 + Number(off[0])) * scale + rect.left,
        // A little below the top edge: inside the body, clear of the title bar.
        y: (Number(node.pos[1]) + Math.min(28, h / 2) + Number(off[1])) * scale + rect.top,
        width: w * scale,
        scale,
    };
}

function probeRenderer() {
    const out = { renderer: activeRenderer(), litegraph: {}, rootVars: {}, nodes: [] };
    const LG = window.LiteGraph || {};
    for (const k of LITEGRAPH_KEYS) {
        if (LG[k] !== undefined) out.litegraph[k] = String(LG[k]).slice(0, 48);
    }
    const rootStyle = getComputedStyle(document.documentElement);
    for (const k of COMFY_KEYS) {
        const v = rootStyle.getPropertyValue(`--${k}`).trim();
        if (v) out.rootVars[k] = v;
    }

    const c = app?.canvas;

    for (const node of styleTargets().nodes.slice(0, 3)) {
        const entry = {
            title: node.title,
            type: node.type ?? node.comfyClass,
            color: node.color ?? null,
            bgcolor: node.bgcolor ?? null,
            colourIsOwnProperty: !!Object.getOwnPropertyDescriptor(node, "bgcolor"),
            at: [],
        };
        const point = screenPointFor(node, c);
        if (point.why) {
            // Reported rather than left as a silent empty list — the first
            // probe's `at: []` said nothing about why it was empty.
            entry.noPoint = point.why;
        } else {
            entry.screenPoint = [Math.round(point.x), Math.round(point.y)];
            const stack = document.elementsFromPoint?.(point.x, point.y) || [];
            if (!stack.length) entry.noPoint = "nothing at that point — node off screen?";
            for (const el of stack.slice(0, 6)) {
                if (el.closest?.(".nts")) continue;          // this panel, not a node
                const cs = getComputedStyle(el);
                const custom = {};
                try {
                    for (const name of Array.from(cs)) {
                        if (!name.startsWith("--")) continue;
                        if (Object.keys(custom).length >= 40) break;
                        custom[name] = cs.getPropertyValue(name).trim();
                    }
                } catch { /* browsers differ on enumerating custom properties */ }
                entry.at.push({
                    tag: el.tagName.toLowerCase(),
                    id: el.id || undefined,
                    class: (typeof el.className === "string" && el.className) || undefined,
                    background: cs.backgroundColor,
                    color: cs.color,
                    borderColor: cs.borderTopColor,
                    customProps: Object.keys(custom).length ? custom : undefined,
                });
            }
        }
        out.nodes.push(entry);
    }
    return out;
}

/* ------------------------------------------------- per-node colour wipe --
 * WHY MOST NODES IGNORE THE THEME ENTIRELY.
 *
 * NODE_DEFAULT_BGCOLOR is a DEFAULT: LiteGraph reads `node.bgcolor` first and
 * only falls back to the palette when the node has none. Any node whose pack
 * sets a colour of its own — as the Nova nodes do — or that was recoloured by
 * hand and saved into the workflow, has its own and never consults the theme.
 * Nothing a palette can say will reach it, which is why a green node stays
 * green through all twenty-four combinations.
 *
 * Since 2.7.0 the studio no longer clears those colours (the "Theme colours"
 * button is gone). The maps below only remain so that a colour an older build
 * cleared in this session can still be put back.
 */
const cleared = new Map();   // node id -> { color, bgcolor }
const clearedGroups = new Map();

/** `_nodes` has been an array, a getter and a Map across frontend versions,
 *  and reading the wrong one silently wipes nothing at all. */
function asArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.values === "function") return [...v.values()];
    return [];
}

/**
 * THE GRAPH, WITHOUT ASKING FOR IT TOO EARLY.
 *
 * `app.graph` is a getter that logs "ComfyApp graph accessed before
 * initialization" when it is read before the app has finished starting. That
 * error was ours, on every reload where this extension got in ahead of the
 * frontend — and the read returns nothing at that point anyway, so it bought
 * console noise and no information.
 *
 * The canvas holds the same graph and carries no such guard, so it is asked
 * first; `app.graph` is only touched once a canvas exists, which is the point
 * after which the question is a fair one.
 */
function liveGraph() {
    // Nothing is asked of either until a canvas exists: `app.graph` is a
    // getter that logs "ComfyApp graph accessed before initialization" when
    // read too early, and has nothing to give at that point anyway.
    if (!app?.canvas) return null;

    const viaCanvas = app.canvas.graph || null;
    let viaApp = null;
    try { viaApp = app.graph || null; } catch { /* still not ready */ }

    // WHICHEVER ACTUALLY HAS NODES — not whichever is merely present.
    //
    // The first version of this took the canvas's graph the moment it was
    // truthy. On a frontend with a root graph and subgraphs those two are not
    // always the same object, and the canvas can be holding an empty one while
    // the workflow restores into the other. The adapter was then handed a
    // graph with nothing in it and reported "no nodes on the canvas to learn
    // the markup from" — on a page plainly full of nodes — so the theme never
    // applied at all. Measured from a live log doing exactly that.
    //
    // Emptiness is the thing worth testing, so it is what gets tested.
    if (graphNodeCount(viaCanvas)) return viaCanvas;
    if (graphNodeCount(viaApp)) return viaApp;
    return viaCanvas || viaApp;          // both empty: either will do
}

/** How many nodes a graph is carrying, across every shape `_nodes` has had. */
function graphNodeCount(graph) {
    if (!graph) return 0;
    const n = asArray(graph._nodes).length;
    return n || asArray(graph.nodes).length;
}

function styleTargets() {
    const graph = liveGraph();
    const nodes = asArray(graph?._nodes);
    const groups = asArray(graph?._groups);
    return {
        nodes: nodes.length ? nodes : asArray(graph?.nodes),
        groups: groups.length ? groups : asArray(graph?.groups),
    };
}

function restoreNodeStyles() {
    const { nodes, groups } = styleTargets();
    let n = 0;
    for (const node of nodes) {
        const saved = cleared.get(node.id);
        if (!saved) continue;
        node.color = saved.color;
        node.bgcolor = saved.bgcolor;
        n++;
    }
    for (const g of groups) {
        if (!clearedGroups.has(g.id)) continue;
        g.color = clearedGroups.get(g.id);
        n++;
    }
    cleared.clear();
    clearedGroups.clear();
    app?.canvas?.setDirty(true, true);
    return { scanned: nodes.length, changed: n };
}

/** A node added after the wipe would arrive wearing its pack's colour, so the
 *  graph is hooked once and new arrivals are wiped as they land. */
/**
 * WHICH graph was hooked, not WHETHER one was.
 *
 * This was a boolean, and it latched: hooked once, never again. Restoring a
 * workflow can hand the app a DIFFERENT graph object, and the hook then sits on
 * the old one where nothing will ever call it. The settle below is started by
 * that hook, so on those loads the Nodes 2.0 half of the theme never applied at
 * all — the node bodies stayed transparent and the widget labels lost the
 * colour the adapter gives them, until a theme chip was clicked and forced a
 * fresh apply. Remembering the graph itself is what makes a swap visible.
 */
let hookedGraph = null;
function hookNodeAdded() {
    const graph = liveGraph();
    if (!graph || hookedGraph === graph) return;
    hookedGraph = graph;
    const prev = graph.onNodeAdded;
    graph.onNodeAdded = function (node) {
        const r = prev?.apply(this, arguments);
        // THE MOMENT THE RENDERER BECOMES KNOWABLE. Detection needs a node to
        // look at, so an empty canvas can only answer "unknown" — and a node
        // joining is precisely the event that changes that. Restoring a
        // workflow calls this for every node in it, which covers page load as
        // well as a node the person drops in by hand.
        if (!rendererSettled()) scheduleSettle(true);
        return r;
    };
}

function loadStore() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
        return {
            palette: raw.palette || null,
            backdrop: { ...BACKDROP_DEFAULTS, ...(raw.backdrop || {}) },
            preset: { ...PRESET_DEFAULTS, ...(raw.preset || {}) },
        };
    } catch {
        // Private window, blocked site data, or something else under this key.
        // A theme is worth less than the session: start clean.
        return {
            palette: null,
            backdrop: { ...BACKDROP_DEFAULTS },
            preset: { ...PRESET_DEFAULTS },
        };
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORE, JSON.stringify({ palette, backdrop, preset }));
    } catch { /* as above */ }
}

const stored = loadStore();
const backdrop = stored.backdrop;
const preset = stored.preset;   // { theme, finish, nodeAlpha } — which chips are lit
let palette = null;      // { id, name, colors: {node_slot, litegraph_base, comfy_base} }
let baseline = null;     // what it was when this session started — what Reset restores

/**
 * How solid a node body looks — and the reason the NODE_DEFAULT_BGCOLOR row
 * behaves as a switch rather than a fade.
 *
 * That key's alpha is not what this frontend fades a node body with; it takes
 * the colour and, past the point where it stops being opaque, the body simply
 * stops being drawn, so the slider reads as on or off with nothing in between.
 * `editor_alpha` is the dial that genuinely fades a node, and it is a canvas
 * property rather than a palette key — which is exactly why no amount of theme
 * editing could reach it.
 *
 * It fades the whole node, text included, so pushing it far hurts readability.
 * The finishes use it sparingly and let the colour alphas do the visible work.
 */
function applyNodeAlpha() {
    const c = app?.canvas;
    if (!c || !studioOn()) return;
    c.editor_alpha = clamp(preset.nodeAlpha ?? 1, 0.2, 1);
    c.setDirty(true, true);
}

/** Apply a theme/finish pair, keeping node_slot and the font sizes. */
function applyPreset(themeId, finishId) {
    preset.theme = themeById(themeId).id;
    preset.finish = finishById(finishId).id;
    preset.nodeAlpha = finishById(finishId).node;
    palette = buildPreset(preset.theme, preset.finish, palette || baseline);
    keepWallpaperLegible();
    saveStore();
    applyAll();
    return palette;
}

/**
 * A see-through finish over a bright wallpaper leaves text with nothing to be
 * read against (Layer 1 report, B-01). The node body stays as transparent as
 * the finish asks for; the wallpaper does the work instead. The first time
 * Glass or Frosted meets a given wallpaper with both sliders still at zero,
 * the backdrop is blurred and dimmed to the values the guide recommends.
 *
 * Once per wallpaper and finish, and only from zero: someone who sets either
 * slider, or puts both back to zero afterwards, is not overruled.
 */
const LEGIBLE_BLUR = 12;
const LEGIBLE_DIM = 0.3;
function keepWallpaperLegible() {
    const finish = finishById(preset.finish);
    const seeThrough = finish.body === null && finish.widget === null;
    if (!seeThrough || !backdrop.image) return false;
    const key = `${preset.finish}|${backdrop.image}`;
    if (preset.legibleFor === key) return false;
    preset.legibleFor = key;
    if (backdrop.blur > 0 || backdrop.dim > 0) return false;
    backdrop.blur = LEGIBLE_BLUR;
    backdrop.dim = LEGIBLE_DIM;
    return true;
}

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
/**
 * A FLOOR UNDER NODES 2.0 TEXT FIELDS, WHATEVER THE PALETTE SAYS.
 *
 * Glass and Frosted store the widget background as `transparent`, and so does
 * every palette saved from them. The frontend copies that value to
 * `--component-node-widget-background` on the page root, and a Nodes 2.0 text
 * field takes its whole box from that variable: transparent means no box at
 * all (Retest 1, "B-12 follow-up": measured on `artist_name`, input and three
 * wrappers transparent, border width 0).
 *
 * The Nodes 2.0 adapter also sets the variable, but only after it has found
 * node cards on screen and settled on a selector for them, and it did not on
 * the machine that retest ran on. A field having a visible edge should not
 * hang on that. So the floor is written here, by the studio, every time a
 * palette is applied, against `[data-node-id]` — the attribute the frontend's
 * own resize code looks cards up by. It needs no sampling and no renderer
 * detection: on the classic renderer no element carries the attribute and the
 * rule matches nothing.
 *
 * Only when the palette's own widget colour is blank. A palette that declares
 * a real one keeps it.
 */
const FLOOR_ID = "nova-theme-studio-fields";
const isBlankColour = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    return !s || s === "transparent"
        || /^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(s)
        || /^#([0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(s);
};

/** The wash a widget gets when the finish declares no widget colour. */
function fieldWash() {
    const theme = THEMES.find((t) => t.id === preset.theme);
    const glass = preset.finish === "glass";
    return theme ? rgba(theme.field, glass ? 0.55 : 0.70)
                 : `rgba(12, 14, 20, ${glass ? 0.55 : 0.70})`;
}

function applyFieldFloor(litegraph_base = {}) {
    const existing = document.getElementById(FLOOR_ID);
    if (!isBlankColour(litegraph_base.WIDGET_BGCOLOR)) {
        existing?.remove();
        return null;
    }
    // The theme's field colour as a wash: dark enough to carry light text over
    // a bright wallpaper, still see-through. A palette loaded from a file may
    // name no theme this build knows, and then a neutral dark does the job.
    const wash = fieldWash();
    const text = isBlankColour(litegraph_base.NODE_TEXT_COLOR) ? null : litegraph_base.NODE_TEXT_COLOR;

    const style = existing || document.createElement("style");
    style.id = FLOOR_ID;
    style.textContent = [
        `[data-node-id] {`,
        `  --component-node-widget-background: ${wash} !important;`,
        text ? `  --node-component-slot-text: ${text} !important;` : "",
        text ? `  --component-node-foreground: ${text} !important;` : "",
        `}`,
    ].filter(Boolean).join("\n");
    if (!existing) document.head.appendChild(style);
    return wash;
}

/* ------------------------------------------------------- the master switch --
 *
 * ENABLED / DISABLED, IN PLACE OF "THEME COLOURS" / "OWN COLOURS".
 *
 * Those two buttons answered a question this pack no longer asks: since 2.7.0
 * no Nova node carries a colour of its own. What was missing was a way to step
 * out of the studio altogether. Picking a palette in ComfyUI's own Settings
 * left the wallpaper and the see-through bodies on, with grey default text
 * over them (test report, R-4), and nothing short of deleting the stored theme
 * turned them off.
 *
 * Disabled means the studio applies NOTHING: no palette, no wallpaper, no node
 * transparency, no Nodes 2.0 stylesheet, no field floor. Everything it had
 * written is taken back, and ComfyUI's own active palette is re-applied by
 * ComfyUI itself, so the canvas matches a stock install. The stored theme is
 * kept and can still be edited; Enabled puts it back without a reload.
 */
const studioOn = () => preset.enabled !== false;

/** Ask ComfyUI to re-apply the palette chosen in its own Settings. */
async function reapplyComfyPalette() {
    const id = readSetting("Comfy.ColorPalette");
    const set = async (value) => {
        if (app.extensionManager?.setting?.set) return app.extensionManager.setting.set("Comfy.ColorPalette", value);
        if (app.ui?.settings?.setSettingValue) return app.ui.settings.setSettingValue("Comfy.ColorPalette", value);
        throw new Error("no settings API");
    };
    if (typeof id !== "string" || !id) return false;
    try {
        // The frontend only loads a palette when the setting CHANGES, so it is
        // moved off the current one and straight back. It ends where it began.
        await set(id === "dark" ? "light" : "dark");
        await set(id);
        return true;
    } catch (e) {
        console.warn("[Nova Theme Studio] could not ask ComfyUI to re-apply its palette:", e);
        return false;
    }
}

/** Take back everything the studio wrote to the page. */
async function disableAll() {
    const c = app?.canvas;

    document.getElementById(LAYER_ID)?.remove();           // wallpaper and scrim
    document.getElementById(FLOOR_ID)?.remove();           // Nodes 2.0 field floor
    try { window.novaThemeRenderers?.v2?.off?.(); } catch { /* not installed */ }
    v2Applied = null;
    lastRenderer = null;
    clearTimeout(settleTimer);
    settleTimer = null;

    // A node whose colour an older build cleared for "Theme colours".
    if (cleared.size) restoreNodeStyles();
    preset.restyleAll = false;

    if (c) {
        c.editor_alpha = 1;
        c.onRenderBackground = null;
        c._pattern = null;
        c._bg_img = null;
    }

    // The colours: ComfyUI's own loader writes every key the studio wrote.
    // Failing that, what the page had when this session started.
    if (!(await reapplyComfyPalette()) && baseline) {
        const { node_slot = {}, litegraph_base = {}, comfy_base = {} } = baseline.colors || {};
        const LG = window.LiteGraph || null;
        if (c?.default_connection_color_byType) Object.assign(c.default_connection_color_byType, node_slot);
        if (LG) for (const [k, v] of Object.entries(litegraph_base)) LG[k] = v;
        for (const [k, v] of Object.entries(comfy_base)) document.documentElement.style.setProperty(`--${k}`, v);
    }
    c?.setDirty(true, true);
}

/** The switch itself. Returns the state it ended in. */
async function setEnabled(on) {
    preset.enabled = !!on;
    saveStore();
    if (preset.enabled) {
        applyAll();
        scheduleSettle(true);
    } else {
        await disableAll();
    }
    return preset.enabled;
}

function applyPalette() {
    if (!studioOn()) return false;
    if (!palette) return false;
    const c = app?.canvas;
    if (!c) return false;

    // `LiteGraph` IS OPTIONAL, AND INSISTING ON IT COST A PAGE ITS THEME.
    //
    // This refused to do anything at all without `window.LiteGraph`. That
    // global is assigned by the frontend, not by us, and an extension can be
    // evaluated before it appears — the pack's own notes say exactly that, and
    // warn against reading it at module scope for the same reason.
    //
    // Under Nodes 2.0 none of those constants are read by anything: the nodes
    // are DOM, the adapter's stylesheet is what colours them, and the CSS
    // variables set below are what the rest of the interface reads. So a
    // missing global was blocking the two halves that never needed it, and the
    // page sat at the default colours with `renderer: null` and an adapter
    // that had not once been asked to apply. Measured on a live page in that
    // exact state.
    //
    // What genuinely needs LiteGraph is the classic canvas renderer, so that
    // half — and only that half — is skipped when the global is absent.
    const LG = window.LiteGraph || null;
    const { node_slot = {}, litegraph_base = {}, comfy_base = {} } = palette.colors || {};

    if (c.default_connection_color_byType) Object.assign(c.default_connection_color_byType, node_slot);
    if (window.LGraphCanvas?.link_type_colors) Object.assign(window.LGraphCanvas.link_type_colors, node_slot);

    if (LG) for (const [k, v] of Object.entries(litegraph_base)) LG[k] = v;
    // WIDGET NAMES ON THE CANVAS, UNDER A SEE-THROUGH FINISH (regression pass,
    // R-2). The classic renderer draws a widget's name in the SECONDARY text
    // colour, a dimmed one that assumes a widget box behind it. Glass and
    // Frosted have no box: the name sat straight on the wallpaper at #8791b0
    // and could not be read, worst on empty text fields and switched-off
    // toggles, where the name is the only text on the row. With no box, the
    // name takes the primary widget text colour. A palette that declares a
    // real widget background keeps its own secondary colour.
    //
    // And the widget itself gets the same wash Nodes 2.0 fields get (B-12), so
    // the name has something dark behind it over a bright wallpaper. The
    // canvas honours the alpha of a widget fill, unlike a node body's. This is
    // set on LiteGraph only; the palette, and anything saved from it, still
    // says `transparent`.
    if (LG && isBlankColour(litegraph_base.WIDGET_BGCOLOR)) {
        const strong = [litegraph_base.WIDGET_TEXT_COLOR, litegraph_base.NODE_TEXT_COLOR]
            .find((v) => !isBlankColour(v));
        if (strong) LG.WIDGET_SECONDARY_TEXT_COLOR = strong;
        const wash = fieldWash();
        if (wash) LG.WIDGET_BGCOLOR = wash;
    }
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

    // The CSS half. This is the part that reaches DOM either way, so it runs
    // before any renderer-specific work and never depends on it.
    const root = document.documentElement;
    for (const [k, v] of Object.entries(comfy_base)) root.style.setProperty(`--${k}`, v);
    applyFieldFloor(litegraph_base);

    // The renderer-specific half. Under Nodes 2.0 everything assigned above to
    // LiteGraph still sits there correctly and simply has no canvas reading it,
    // so an adapter is asked to carry it across. There is no guessed fallback:
    // a wrong guess here paints somebody's graph the wrong colour and looks
    // like a bug in the theme rather than a missing file.
    const renderer = activeRenderer();
    // AN UNANSWERED QUESTION CHANGES NOTHING.
    //
    // `lastRenderer` is what `rendererSettled()` reads, and the branch below
    // is what tears the adapter down. Recording "unknown" in either would turn
    // a moment when nothing could be measured — every node off screen, cards
    // mid-rebuild — into a decision about how the graph is being drawn. What
    // is already applied stays applied, and the settle keeps asking.
    if (renderer.mode !== "unknown") lastRenderer = renderer;
    if (renderer.mode === "unknown") {
        // nothing to do: not a v2 apply, and emphatically not a v1 teardown
    } else if (renderer.mode === "v2") {
        const adapter = window.novaThemeRenderers?.v2;
        v2Applied = typeof adapter?.apply === "function";
        if (v2Applied) {
            try {
                // `app` is handed over rather than left to be found. The
                // adapter's fallback is `window.app`, which is the same object
                // in a normal page and is NOT in every host that loads these
                // files — and when it is missing the adapter reports "no nodes
                // on the canvas", which reads as a renderer problem rather than
                // as a graph it was never given.
                adapter.apply(palette, { app, preset, THEMES, FINISHES, layer, rgba });
            } catch (e) {
                v2Applied = false;
                console.error("[Nova Theme Studio] the Nodes 2.0 adapter failed:", e);
            }
        }
    } else {
        // The adapter's stylesheet has to GO, not merely stop being updated.
        // Switching back to Classic left it in place and its colours on the
        // nodes, which read as the classic renderer having quietly adopted a
        // theme it cannot actually see.
        try { window.novaThemeRenderers?.v2?.off?.(); } catch { /* not installed */ }
        v2Applied = null;
    }

    applyNodeAlpha();
    hookNodeAdded();
    // Re-run after every repaint: a preset that changes the defaults is only
    // visible on nodes that are actually using the defaults.
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
    if (!studioOn()) return;
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
    if (!studioOn()) return false;
    applyBackdrop();
    const r = applyPalette();
    scheduleSettle();
    return r;
}

/* ------------------------------------------------------------- settling --
 *
 * WHICH RENDERER IS DRAWING CANNOT BE ANSWERED ON AN EMPTY CANVAS, and at
 * `setup()` the canvas is always empty — the workflow is restored a moment
 * later. Detection therefore reported "unknown", `applyPalette` took that for
 * "not Nodes 2.0" and called the adapter's `off()`, and nothing ever asked
 * again. The whole Nodes 2.0 half of a theme was missing from the moment the
 * page loaded until the first time a theme chip was clicked, which is exactly
 * the report: it works after a theme change, never before one.
 *
 * A node arriving is the event that makes the question answerable, so that is
 * what this waits for, with a bounded backoff behind it for the case where the
 * DOM for that node is not built the instant it joins the graph. It stops as
 * soon as the answer is definite — v1, or v2 with the adapter reporting that
 * it actually landed — so a graph left genuinely empty costs a handful of
 * cheap checks and then nothing.
 */
// Long enough for a slow restore, and it stops the moment the answer is
// definite, so the cost of the extra patience is a handful of cheap checks on a
// graph that really is empty.
const SETTLE_TRIES = 14;
let settleTimer = null;
let settleTries = 0;

/** Definite, as opposed to merely answered. Under v2 the adapter has to have
 *  found the markup as well: a node that joined the graph before the renderer
 *  built its DOM gives a confident "v2" and an apply that reached nothing. */
function rendererSettled() {
    if (lastRenderer?.mode === "v1") return true;
    if (lastRenderer?.mode !== "v2") return false;
    if (!v2Applied) return false;
    try {
        // `status()` is the silent form. `report()` prints itself, and this is
        // asked several times a second while a page is still settling — which
        // buried the console in copies of the same line and made the logs that
        // mattered unreadable. Older adapters only have `report`.
        const v2 = window.novaThemeRenderers?.v2;
        const r = v2?.status ? v2.status() : v2?.report?.();
        return !!r?.ok;
    } catch { return false; }
}

/**
 * NOTICING THAT THE GRAPH ITSELF WAS REPLACED.
 *
 * Re-hooking inside the settle is not enough on its own: the settle is started
 * BY the hook, so once the hook is orphaned there is nothing left to start
 * anything. Something outside both has to notice, and the only thing that
 * survives a graph being swapped is the app.
 *
 * It is one identity comparison every two seconds — nothing is read, walked or
 * measured unless the answer changes — and it earns that by covering switching
 * workflow tabs as well as the restore at page load, both of which hand the app
 * a different graph.
 */
let graphWatch = null;
let watchedCount = -1;
function watchGraphSwap() {
    if (graphWatch) return;
    graphWatch = setInterval(() => {
        if (!studioOn()) return;
        const graph = liveGraph();
        if (!graph) return;

        // The renderer was switched in Settings while the page stayed open.
        // Nothing else re-applies on that, so the Nodes 2.0 stylesheet stayed
        // behind in a Classic page, or was missing from a Nodes 2.0 one.
        const now = activeRenderer().mode;
        if (now !== "unknown" && lastRenderer && now !== lastRenderer.mode) {
            applyAll();
            return;
        }

        // A CONDITION, NOT AN EVENT — and that distinction is the whole bug.
        //
        // This used to act only when the node COUNT CHANGED, which gave it
        // exactly one attempt per restore. If that single attempt landed
        // before the renderer had built the cards — and on a workflow restore
        // it reliably does, because the nodes exist in the graph a moment
        // before they exist in the DOM — the apply failed, the count never
        // changed again, and nothing ever retried. The page then stayed at the
        // default colours unless the Theme Studio node happened to be in the
        // workflow, because that node's own creation re-applies at precisely
        // the moment the cards are up. Diagnosed from a log showing four
        // applies against an empty graph, the restore, and then silence.
        //
        // So the test is now the state rather than the transition: while the
        // theme is NOT in place and there are nodes to put it on, try again.
        // A working page is settled, so it does nothing at all; an unsettled
        // one costs one apply every two seconds until it takes.
        const count = graphNodeCount(graph);
        watchedCount = count;
        const swapped = graph !== hookedGraph;
        if (!swapped && (rendererSettled() || !count)) return;

        hookNodeAdded();          // onto the new graph

        // APPLIED OUTRIGHT, not merely scheduled.
        //
        // `scheduleSettle` exists to keep asking until the renderer can be
        // identified, so it does nothing at all once the answer is definite —
        // which it still is after a workflow switch. The adapter was therefore
        // left holding the previous graph's work: its stylesheet still matched,
        // so everything looked themed, but not one of the new nodes had a fold
        // button and `report()` went on describing a graph that was no longer
        // open. Measured on a switch from a 15-node workflow to a 2-node one:
        // `applies: 1`, `nodesSeen: 15`, and no buttons anywhere.
        //
        // A new graph is new work whether or not the old question was answered.
        settleTries = 0;
        settleStart = 0;
        gaveUpLogged = false;     // a new graph deserves a fresh explanation
        applyPalette();
        scheduleSettle();         // and keep trying if its nodes are not up yet
    }, 2000);
}

/**
 * AN EMPTY PAGE IS NOT A FAILED ATTEMPT.
 *
 * `SETTLE_TRIES` exists to stop asking a question that keeps being answered
 * badly — but it was also counting the attempts made before there was anything
 * to ask ABOUT. On a slow reload of a large workflow all fourteen could be
 * spent against a graph with no nodes in it yet: the budget ran out,
 * `scheduleSettle` refused to schedule anything further, and the nodes then
 * arrived to a theme that had already given up. Reported as "sometimes the
 * nodes load with no theme", and cured by clicking any chip — which is exactly
 * what an apply that was never re-run looks like.
 *
 * So a try is spent only when there was a populated graph to spend it on.
 * Waiting for a page to finish loading is bounded by the clock instead, and
 * generously: the cost of that patience is one cheap check a second against a
 * graph that really is empty.
 */
const SETTLE_WINDOW_MS = 90000;
let settleStart = 0;

/**
 * SAYING WHY, ONCE, WHEN IT STOPS TRYING.
 *
 * A page that comes up unthemed is silent about it: the theme simply is not
 * there, and every explanation looks the same from the outside. That cost
 * several rounds of guessing at logs which recorded everything except the one
 * thing that mattered. If this gives up, it now leaves a line saying what it
 * last decided, whether the adapter was reached, and what it could see —
 * enough to tell a renderer misread from an adapter that never loaded from a
 * graph that never arrived.
 */
let gaveUpLogged = false;
function reportGivingUp(why) {
    if (gaveUpLogged) return;
    gaveUpLogged = true;
    let adapter = "not installed";
    try {
        const r = window.novaThemeRenderers?.v2?.report?.();
        if (r) adapter = r.ok ? `applied (${r.selector})` : `refused: ${r.why}`;
    } catch (e) { adapter = `threw: ${e?.message || e}`; }
    console.warn("[Nova Theme Studio] stopped trying to theme this page —", {
        why,
        tries: settleTries,
        renderer: lastRenderer,
        v2Applied,
        adapter,
        nodes: graphNodeCount(liveGraph()),
        hint: "run novaTheme.live() to apply now, or novaTheme.probe() for the full picture",
    });
}

function scheduleSettle(fresh = false) {
    if (!studioOn()) return;
    if (fresh) { settleTries = 0; settleStart = 0; gaveUpLogged = false; }
    if (!settleStart) settleStart = Date.now();
    if (settleTimer || rendererSettled()) return;
    if (settleTries >= SETTLE_TRIES) { reportGivingUp(`${settleTries} attempts used`); return; }
    if (Date.now() - settleStart > SETTLE_WINDOW_MS) {
        reportGivingUp(`the ${SETTLE_WINDOW_MS / 1000}s window elapsed`);
        return;
    }
    // Backing off rather than polling: a slow restore gets the later, longer
    // waits without a fast machine paying for them.
    const wait = Math.min(1000, 120 * (settleTries + 1));
    settleTimer = setTimeout(() => {
        settleTimer = null;
        // Counted only if there was something to count it against.
        if (graphNodeCount(liveGraph())) settleTries++;
        // Re-hooked on every attempt, because the graph this is waiting for may
        // be one that did not exist when the last attempt ran.
        hookNodeAdded();
        applyPalette();
        scheduleSettle();
    }, wait);
}

/* ------------------------------------------------------------- exporting -- */

function exportPalette() {
    return {
        id: palette?.id || "nova-custom",
        name: palette?.name || "Nova Custom",
        colors: JSON.parse(JSON.stringify(palette?.colors || {})),
        // Keys ComfyUI ignores and this node reads back, so one file carries
        // the wallpaper and which chips were lit as well as the colours.
        [BACKDROP_KEY]: { ...backdrop },
        [PRESET_KEY]: { ...preset },
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
    if (obj[PRESET_KEY] && typeof obj[PRESET_KEY] === "object") {
        const p = obj[PRESET_KEY];
        // Only adopt ids this build actually has, so a file naming a theme
        // added later lights no chip rather than an arbitrary one.
        preset.theme = THEMES.some(t => t.id === p.theme) ? p.theme : "";
        preset.finish = FINISHES.some(f => f.id === p.finish) ? p.finish : "";
        preset.nodeAlpha = clamp(p.nodeAlpha ?? 1, 0.2, 1);
    }
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
async function saveToComfy(name) {
    const body = exportPalette();
    // SAVE AS, rather than save over. A typed name becomes both the palette's
    // display name and its id, so saving under a new name adds an entry beside
    // the old one instead of replacing it — and the same name is what the
    // download is filed under, so the theme in ComfyUI's list and the file on
    // disk cannot end up called different things.
    if (name && name.trim()) {
        body.name = name.trim();
        body.id = slug(name);
        palette.name = body.name;
        palette.id = body.id;
        saveStore();
    }
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
function makeDomHost(inner, initialH, vueMin) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative; overflow:visible; pointer-events:none; width:100%; height:100%;";
    inner.style.cssText += ";position:absolute; left:0; top:0; width:300px;" +
                           `height:${initialH}px; box-sizing:border-box; pointer-events:auto;`;
    host.appendChild(inner);
    // Nodes 2.0 measures minimum size from the page, not from getMinHeight.
    return vueSize(host, inner, vueMin);
}

/**
 * Makes a slider safe to have in a dense, scrolling list.
 *
 * TWO WAYS AN ALPHA CHANGES WITHOUT ANYONE MEANING IT.
 *
 * A bare click on a range input jumps the value to wherever the pointer landed
 * and fires `input` — measured, a click 3px from the left edge of a 52px
 * slider commits 0. These sliders sit between a colour swatch and a text
 * field, both of which are things you click, so a near-miss silently zeroes a
 * colour. After this, only a grab on the thumb moves it; a click anywhere else
 * does nothing.
 *
 * And a wheel over a focused range input changes it in some browsers instead
 * of scrolling the list under it. Here the wheel always scrolls the list.
 */
function guardSlider(el, scroller) {
    el.addEventListener("pointerdown", (e) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const min = parseFloat(el.min) || 0;
        const max = parseFloat(el.max);
        const span = (Number.isFinite(max) ? max : 1) - min;
        const cur = parseFloat(el.value);
        const thumbX = r.left + (span ? (cur - min) / span : 0) * r.width;
        // Preventing the default on pointerdown stops the range engaging at
        // all for this gesture — no jump, and no drag either, which is exactly
        // right for a click that was aimed at something else.
        if (Math.abs(e.clientX - thumbX) > 11) e.preventDefault();
    });

    el.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (scroller) scroller.scrollTop += e.deltaY;
    }, { passive: false });
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
.nts__row input[type=range] { flex:0 0 66px; padding:0; accent-color:currentColor; }
.nts__row input[type=text], .nts__row input[type=number] { flex:1 1 60px; }
.nts__row.wide input[type=text] { flex:1 1 100%; }
.nts__msg { flex:0 0 auto; min-height:13px; opacity:.7; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; }
.nts__msg.err { color:var(--error-text, #ff8a5c); opacity:1; }
.nts__presets { display:flex; gap:4px; align-items:center; flex-wrap:wrap;
                flex:0 0 auto; padding:5px 6px; border-radius:4px;
                background:var(--comfy-menu-bg, rgba(0,0,0,.4)); }
.nts__lbl { letter-spacing:.06em; text-transform:uppercase; font-size:9px;
            opacity:.6; flex:0 0 auto; margin-right:1px; }
.nts__chip { display:inline-flex; align-items:center; gap:4px; padding:2px 7px;
             border-radius:11px; cursor:pointer; font:inherit; flex:0 0 auto;
             color:inherit; background:transparent;
             border:1px solid var(--border-color, #ffffff24); }
.nts__chip:hover { background:var(--content-hover-bg, rgba(255,255,255,.12)); }
/* The lit chip is outlined rather than filled: a filled one would be a block
   of colour next to the theme dots and read as a seventh swatch. */
.nts__chip.on { border-color:currentColor; box-shadow:inset 0 0 0 1px currentColor; }
.nts__dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto;
            border:1px solid rgba(0,0,0,.35); }
.nts__sep { width:100%; height:0; }
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
            <button data-act="load" title="Load a theme JSON from a file">Load</button>
            <input class="nts__file" type="file" accept=".json,application/json" hidden>
        </div>
        <div class="nts__presets">
            <span class="nts__lbl">theme</span>
            <span class="nts__chips" data-kind="theme"></span>
            <span class="nts__sep"></span>
            <span class="nts__lbl">finish</span>
            <span class="nts__chips" data-kind="finish"></span>
            <span class="nts__sep"></span>
            <span class="nts__lbl">theme studio</span>
            <span class="nts__chips" data-kind="enabled"></span>
            <span class="nts__sep"></span>
            <span class="nts__lbl">renderer</span>
            <span class="nts__chips" data-kind="renderer"></span>
            <span class="nts__sep"></span>
            <span class="nts__lbl">top panel</span>
            <span class="nts__chips" data-kind="panel"></span>
            <button class="nts__chip" data-act="probe"
                    title="Report what this renderer uses to colour a node, for building the Nodes 2.0 adapter">Probe</button>
        </div>
        <div class="nts__bar">
            <input class="nts__name" type="text" maxlength="48"
                   placeholder="theme name — used for Save as and the file name">
            <button data-act="saveas" title="Save under this name into ComfyUI's custom themes">Save as</button>
            <button data-act="download" title="Download as &lt;name&gt;.json">Download</button>
        </div>
        <div class="nts__rows"></div>
        <div class="nts__msg"></div>`;

    const rows = root.querySelector(".nts__rows");
    const search = root.querySelector(".nts__search");
    const groupSel = root.querySelector(".nts__group");
    const file = root.querySelector(".nts__file");
    const name = root.querySelector(".nts__name");
    const msg = root.querySelector(".nts__msg");
    const say = (t, err = false) => { msg.textContent = t || ""; msg.classList.toggle("err", !!err); };

    // The canvas listens for bare keys — "n" adds a node, Delete removes the
    // selected one. Without this, typing a colour name deletes the node it is
    // being typed into.
    root.addEventListener("keydown", (e) => e.stopPropagation());
    root.addEventListener("pointerdown", (e) => e.stopPropagation());

    /* ------------------------------------------------------ preset chips -- */

    // Once the name has been typed in, presets stop overwriting it: a name is
    // the one thing here the user authored, and clicking through finishes to
    // compare them should not keep throwing it away.
    let nameTouched = false;
    name.addEventListener("input", () => { nameTouched = true; });
    name.value = palette?.name || "";

    const suggestName = () => {
        if (nameTouched) return;
        name.value = palette?.name || "";
    };

    function paintChips() {
        for (const box of root.querySelectorAll(".nts__chips")) {
            const kind = box.dataset.kind;
            const active = kind === "theme" ? preset.theme
                : kind === "finish" ? preset.finish
                : kind === "renderer" ? preset.renderer
                : kind === "panel" ? (preset.collapsible ? "on" : "off")
                : (studioOn() ? "on" : "off");
            for (const chip of box.children) {
                chip.classList.toggle("on", chip.dataset.id === active);
            }
        }
    }

    function buildChips() {
        const themeBox = root.querySelector('.nts__chips[data-kind="theme"]');
        const finishBox = root.querySelector('.nts__chips[data-kind="finish"]');

        for (const t of THEMES) {
            const chip = document.createElement("button");
            chip.className = "nts__chip";
            chip.dataset.id = t.id;
            chip.title = `${t.name} — applies the hues, leaves link colours alone`;
            const dot = document.createElement("span");
            dot.className = "nts__dot";
            dot.style.background = t.swatch;
            chip.append(dot, document.createTextNode(t.name));
            chip.addEventListener("click", () => {
                // Clicking a theme before any finish is chosen should still do
                // something sensible, so the finish falls back to the first.
                applyPreset(t.id, preset.finish || FINISHES[0].id);
                paintChips();
                suggestName();
                render();
                say(`${palette.name} applied`);
            });
            themeBox.appendChild(chip);
        }

        for (const f of FINISHES) {
            const chip = document.createElement("button");
            chip.className = "nts__chip";
            chip.dataset.id = f.id;
            chip.title = `${f.name} — how much of the wallpaper comes through`;
            chip.textContent = f.name;
            chip.addEventListener("click", () => {
                applyPreset(preset.theme || THEMES[0].id, f.id);
                paintChips();
                suggestName();
                render();
                say(`${palette.name} applied`);
            });
            finishBox.appendChild(chip);
        }

        // THE MASTER SWITCH. It sits with the finishes because that is where the
        // question comes up: "how do I get my own ComfyUI look back?"
        const enabledBox = root.querySelector('.nts__chips[data-kind="enabled"]');
        const ENABLED_MODES = [
            ["on", "Enabled",
             "Theme Studio applies its theme, finish, wallpaper and node " +
             "transparency."],
            ["off", "Disabled",
             "Theme Studio applies nothing. The canvas looks the way ComfyUI " +
             "draws it, with the palette chosen in ComfyUI's Settings: no " +
             "wallpaper and no see-through nodes. Your theme is kept, and " +
             "Enabled puts it back."],
        ];
        for (const [id, label, tip] of ENABLED_MODES) {
            const chip = document.createElement("button");
            chip.className = "nts__chip";
            chip.dataset.id = id;
            chip.title = tip;
            chip.textContent = label;
            chip.addEventListener("click", async () => {
                await setEnabled(id === "on");
                paintChips();
                render();
                say(studioOn() ? `${palette?.name || "Theme"} applied`
                               : "Disabled — the canvas is as ComfyUI draws it");
            });
            enabledBox.appendChild(chip);
        }

        // Auto is the default and should stay it; the two overrides are for the
        // case where the probe reads the situation wrongly, which is worth
        // being able to correct without editing a file.
        const rendererBox = root.querySelector('.nts__chips[data-kind="renderer"]');
        const RENDERER_LABELS = {
            auto: ["Auto", "Work out which renderer is drawing the nodes, and re-check on every change"],
            v1: ["Classic", "Treat nodes as canvas-drawn, whatever the probe says"],
            v2: ["Nodes 2.0", "Treat nodes as DOM, whatever the probe says"],
        };
        for (const id of RENDERER_MODES) {
            const [label, tip] = RENDERER_LABELS[id];
            const chip = document.createElement("button");
            chip.className = "nts__chip";
            chip.dataset.id = id;
            chip.title = tip;
            chip.textContent = label;
            chip.addEventListener("click", () => {
                preset.renderer = id;
                saveStore();
                applyAll();
                paintChips();
                render();
                sayRenderer();
            });
            rendererBox.appendChild(chip);
        }

        // NODES 2.0 ONLY, AND THE ROW SAYS SO RATHER THAN DISAPPEARING. A
        // control that vanishes reads as a bug; one that explains itself in a
        // tooltip can be understood without a trip to the README.
        const panelBox = root.querySelector('.nts__chips[data-kind="panel"]');
        const PANEL_MODES = [
            ["off", "Always shown",
             "Nodes look after themselves — slots and widgets are always on show."],
            ["on", "Collapsible",
             "Put a fold button at the right of each title bar, on nodes that " +
             "have a panel of their own. Folding hides the slots and widgets " +
             "between the title bar and the panel, and leaves the panel usable. " +
             "Nodes 2.0 only: the classic renderer paints nodes on a canvas, " +
             "where there is nothing to fold."],
        ];
        for (const [id, label, tip] of PANEL_MODES) {
            const chip = document.createElement("button");
            chip.className = "nts__chip";
            chip.dataset.id = id;
            chip.title = tip;
            chip.textContent = label;
            chip.addEventListener("click", () => {
                preset.collapsible = id === "on";
                saveStore();
                applyAll();
                paintChips();
                render();
                // COUNTED, NOT CLAIMED. This said "fold buttons added" whether
                // or not any had been, which is the least useful thing it could
                // have said: a title bar the adapter fails to recognise looks
                // exactly like a switch that was never clicked. The adapter
                // reports what it actually managed, and so does this.
                const r = lastRenderer || activeRenderer();
                const c = window.novaThemeRenderers?.v2?.report?.()?.collapse;
                if (!preset.collapsible) say("Top panels always shown");
                else if (r.mode !== "v2") say("Saved — it takes effect under Nodes 2.0", true);
                else if (c && c.buttons > 0) {
                    say(`Fold button added to ${c.buttons} node${c.buttons === 1 ? "" : "s"} — ` +
                        `look at the right of the title bar`);
                } else if (c && !c.folds?.length) {
                    say("On, but nothing to fold was recognised — run Probe", true);
                } else {
                    say("On, but no title bar was recognised — run Probe", true);
                }
            });
            panelBox.appendChild(chip);
        }

        root.querySelector('[data-act="probe"]').addEventListener("click", async () => {
            const report = probeRenderer();
            const text = JSON.stringify(report, null, 2);
            console.log("[Nova Theme Studio] renderer probe\n" + text);
            try {
                await navigator.clipboard.writeText(text);
                say(`Probe copied — ${report.renderer.mode}, ${report.nodes.length} node(s) sampled`);
            } catch {
                say(`Probe printed to the console — ${report.renderer.mode}`);
            }
        });

        paintChips();
    }

    /** What the renderer row currently amounts to, in one line. */
    function sayRenderer() {
        const r = lastRenderer || activeRenderer();
        if (r.mode === "v1") return say(`Classic renderer — ${r.how}`);
        if (r.mode === "unknown") return say(`Renderer not determined — ${r.how}`);
        say(v2Applied
            ? `Nodes 2.0 — colours applied through the adapter`
            : `Nodes 2.0 — the CSS half is applied; node bodies need ` +
              `nova_theme_studio_v2.js, which is not installed`,
            !v2Applied);
    }

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

        // A VALUE OF `transparent` HAS NO COLOUR TO FADE, and that is the whole
        // of what looked like a broken slider on NODE_DEFAULT_BGCOLOR.
        //
        // The browser resolves `transparent` to rgba(0, 0, 0, 0) — it is black
        // with the alpha turned off — so the swatch collapsed to #000000 and
        // every step of the slider produced black at some opacity. Not a fade
        // of the node's colour: a fade of black, over a dark canvas, which
        // reads as "either the colour or nothing".
        const blank = colour.a <= 0.001 && !colour.r && !colour.g && !colour.b;
        const seed = blank ? seedFor(group, key) : colour;

        const swatch = document.createElement("input");
        swatch.type = "color";
        swatch.value = toHex(seed);
        if (blank) {
            swatch.title = `${key} is "transparent", which carries no colour. ` +
                           `The swatch is seeded from ${seed.from} so the alpha ` +
                           `slider has something to fade — change it to anything ` +
                           `you like.`;
        }

        const alpha = document.createElement("input");
        alpha.type = "range";
        alpha.min = "0"; alpha.max = "1"; alpha.step = "0.01";
        alpha.value = String(colour.a);
        alpha.title = "alpha — drag the handle; a click beside it does nothing";
        guardSlider(alpha, rows);

        const text = document.createElement("input");
        text.type = "text";
        text.value = String(value);

        const push = (next) => { text.value = next; onChange(next); };

        // composeKeep, not compose: at zero this writes rgba(r, g, b, 0) rather
        // than the literal `transparent`, so the colour survives a trip to the
        // bottom of the slider and comes back when it is raised again. Writing
        // `transparent` there threw the channels away for good — drag down,
        // drag up, and the key was black.
        const fromControls = () => {
            const c = parseColour(swatch.value);
            push(composeKeep({ ...c, a: parseFloat(alpha.value) }));
        };
        swatch.addEventListener("input", fromControls);
        alpha.addEventListener("input", fromControls);
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
            // `node opacity` is not a palette key and cannot be one — it is
            // `editor_alpha` on the canvas, which is the dial that actually
            // fades a node body. It sits here, beside the other things a theme
            // file has no way to express.
            const fields = [
                ["image", "text", "file in ComfyUI/input, or a URL", backdrop, applyBackdrop],
                ["fit", "combo", FITS, backdrop, applyBackdrop],
                ["blur", "range", [0, 40, 1], backdrop, applyBackdrop],
                ["dim", "range", [0, 0.9, 0.01], backdrop, applyBackdrop],
                ["hideGrid", "check", null, backdrop, applyBackdrop],
                ["nodeAlpha", "range", [0.2, 1, 0.01], preset, applyNodeAlpha],
            ].filter(([k]) => !q || k.toLowerCase().includes(q));
            if (fields.length) {
                rows.appendChild(section("canvas & backdrop — not part of a theme file"));
                for (const [key, kind, extra, store, apply] of fields) {
                    const row = document.createElement("div");
                    row.className = "nts__row wide";
                    const LABELS = {
                        nodeAlpha: ["node opacity",
                            "Fades the WHOLE node — title bar, labels and " +
                            "values with it — because it is the canvas's " +
                            "editor_alpha, one alpha over the entire draw. " +
                            "For see-through nodes use a Tinted/Frosted/Glass " +
                            "finish instead; those leave the text crisp. " +
                            "Choosing any finish puts this back to 1."],
                    };
                    const label = document.createElement("label");
                    const [text, tip] = LABELS[key] || [key, key];
                    label.textContent = text;
                    label.title = tip;
                    row.appendChild(label);

                    let input;
                    if (kind === "combo") {
                        input = document.createElement("select");
                        input.innerHTML = extra.map(v =>
                            `<option${v === store[key] ? " selected" : ""}>${v}</option>`).join("");
                        input.style.flex = "1 1 60px";
                    } else if (kind === "check") {
                        input = document.createElement("input");
                        input.type = "checkbox";
                        input.checked = !!store[key];
                        input.style.flex = "0 0 auto";
                    } else if (kind === "range") {
                        input = document.createElement("input");
                        input.type = "range";
                        [input.min, input.max, input.step] = extra.map(String);
                        input.value = String(store[key]);
                        input.style.flex = "1 1 60px";
                        guardSlider(input, rows);
                    } else {
                        input = document.createElement("input");
                        input.type = "text";
                        input.value = store[key];
                        input.placeholder = extra;
                    }

                    const read = () => kind === "check" ? input.checked
                        : kind === "range" ? parseFloat(input.value)
                        : input.value;
                    const push = () => { store[key] = read(); saveStore(); apply(); };
                    input.addEventListener("input", push);
                    input.addEventListener("change", push);
                    // A wallpaper chosen while Glass or Frosted is on gets the
                    // same first-time blur and dim as choosing the finish does.
                    // On `change`, not `input`: redrawing the rows while the
                    // name is still being typed would take the focus away.
                    if (key === "image") {
                        input.addEventListener("change", () => {
                            if (!keepWallpaperLegible()) return;
                            saveStore();
                            applyBackdrop();
                            render();
                        });
                    }
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
        preset.theme = "";
        preset.finish = "";
        preset.nodeAlpha = 1;
        saveStore();
        applyAll();
        paintChips();
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

    /** The typed name, or the palette's own if the field is empty. */
    const chosenName = () => name.value.trim() || palette?.name || "Nova Custom";

    function download(text, filename) {
        const blob = new Blob([text], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename || `${slug(chosenName())}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    root.querySelector('[data-act="download"]').addEventListener("click", () => {
        const chosen = chosenName();
        // Name the palette the same thing the file is called, so a download
        // and a later Load do not disagree about what this theme is called.
        palette.name = chosen;
        palette.id = slug(chosen);
        saveStore();
        download(JSON.stringify(exportPalette(), null, 2));
        say(`Downloaded ${slug(chosen)}.json`);
    });

    root.querySelector('[data-act="saveas"]').addEventListener("click", async () => {
        const chosen = name.value.trim();
        if (!chosen) {
            say("Type a name first — that is what it gets saved as", true);
            name.focus();
            return;
        }
        try {
            const id = await saveToComfy(chosen);
            nameTouched = true;
            say(`Saved as "${chosen}" — pick it in Settings ▸ Appearance`);
            void id;
        } catch (e) {
            say(`Could not save to ComfyUI (${e.message}) — use Download`, true);
        }
    });

    // Enter in the name field is Save as, which is what it looks like it does.
    name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            root.querySelector('[data-act="saveas"]').click();
        }
    });

    root.querySelector('[data-act="load"]').addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
            importPalette(JSON.parse(await f.text()));
            nameTouched = false;
            suggestName();
            paintChips();
            render();
            say(`Loaded "${palette.name}"`);
        } catch (e) {
            say(`Could not load: ${e.message}`, true);
        }
        file.value = "";
    });

    buildChips();

    return { element: root, render, say, paintChips, suggestName };
}

/* ----------------------------------------------------------- extension -- */

function bootstrap() {
    // The canvas is the one thing genuinely needed — see `applyPalette` for
    // why `window.LiteGraph` is no longer a condition of starting at all.
    if (!app?.canvas) return false;
    // The live palette is the starting point, so opening the node shows what is
    // on screen rather than a set of defaults that would repaint everything the
    // moment it appears.
    baseline = readLive();
    palette = stored.palette
        ? JSON.parse(JSON.stringify(stored.palette))
        : JSON.parse(JSON.stringify(baseline));
    // "Theme colours" is gone; a store that still has it on is brought in line.
    if (preset.restyleAll) { preset.restyleAll = false; saveStore(); }
    applyAll();          // does nothing at all when the studio is disabled
    watchGraphSwap();
    return true;
}

/**
 * WAITING LONGER, AND SAYING SO IF IT STOPS.
 *
 * This was a hundred tries at a hundred milliseconds: ten seconds, then
 * silence. Nothing downstream can recover from that — `applyPalette` is never
 * called, `watchGraphSwap` is never started, no settle is ever scheduled — so
 * a page that was slow to present a canvas stayed at the default colours for
 * as long as it was open, with `novaTheme.renderer()` answering `null` because
 * there had been nothing to decide. That is what was measured on the page that
 * kept coming up unthemed.
 *
 * Ten seconds is also an odd thing to be strict about: this is waiting for
 * someone else's startup on a machine loading a large workflow and a dozen
 * extensions. The wait is now two minutes, backing off so a page that is ready
 * immediately still starts immediately and a slow one costs a check a second.
 * And if it ever does stop, it says which of the two things it was waiting for
 * never arrived, rather than leaving the page to be explained from a log that
 * contains nothing about it.
 */
const BOOTSTRAP_WINDOW_MS = 120000;
let bootstrapStart = 0;
let bootstrapGaveUp = false;

let bootstrapAnnounced = false;
let bootstrapWaitNoted = false;

function bootstrapWhenReady() {
    if (!bootstrapStart) bootstrapStart = Date.now();
    if (bootstrap()) {
        // SAY IT STARTED, ONCE.
        //
        // Three rounds of this were spent on logs that could not distinguish
        // "started and decided wrongly" from "never started at all", because
        // a studio that never starts writes nothing whatsoever. One line ends
        // that ambiguity for good, and costs a single console entry.
        if (!bootstrapAnnounced) {
            bootstrapAnnounced = true;
            let r = null;
            try { r = activeRenderer(); } catch { /* not worth failing over */ }
            console.info("[Nova Theme Studio] started —", {
                after: `${Date.now() - bootstrapStart}ms`,
                renderer: r?.mode, how: r?.how, nodes: r?.nodes,
            });
        }
        return;
    }

    const waited = Date.now() - bootstrapStart;
    // Halfway to nowhere, said once: a page that is merely slow looks exactly
    // like a page that is broken until something distinguishes them.
    if (waited > 8000 && !bootstrapWaitNoted) {
        bootstrapWaitNoted = true;
        console.info("[Nova Theme Studio] waiting for a canvas before it can start —", {
            waited: `${Math.round(waited / 1000)}s`,
            canvas: !!app?.canvas, LiteGraph: !!window.LiteGraph,
        });
    }
    if (waited > BOOTSTRAP_WINDOW_MS) {
        if (!bootstrapGaveUp) {
            bootstrapGaveUp = true;
            console.warn("[Nova Theme Studio] never started — the page did not present a canvas.", {
                waited: `${Math.round(waited / 1000)}s`,
                canvas: !!app?.canvas,
                LiteGraph: !!window.LiteGraph,     // no longer required, reported anyway
                LGraphCanvas: !!window.LGraphCanvas,
                hint: "novaTheme.start() tries again now",
            });
        }
        return;
    }
    // Eager at first, patient later.
    const wait = waited < 5000 ? 100 : waited < 20000 ? 400 : 1000;
    setTimeout(bootstrapWhenReady, wait);
}

/* ------------------------------------------------------------ the node --
 * One set of behaviours, installed onto a prototype, because the node can
 * arrive two ways: from the companion .py (a real node definition, indexed and
 * searchable like the rest of the pack) or, with no .py present, registered
 * here as a frontend-only type. Both end up with the same prototype.
 */

let hasBackendDef = false;
let frontendClass = null;   // set only when this file registers the node itself

function installBehaviour(proto) {
    // Both registration paths can fire in the same session, and the hooks can
    // run in either order, so this has to be safe to call twice on one
    // prototype — otherwise onNodeCreated ends up wrapped around itself.
    if (proto.__novaThemeStudio) return;
    proto.__novaThemeStudio = true;

    const prevCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
        const r = prevCreated?.apply(this, arguments);

        // The line that keeps this node harmless whichever way it was
        // registered: graphToPrompt skips virtual nodes, so it is never sent
        // to the backend and never runs, even though a definition exists for
        // it. The .py is there to name and categorise the node, nothing more.
        this.isVirtualNode = true;
        this.serialize_widgets = false;
        if (!palette) bootstrap();

        // Sizing is NOT done here, and that is why the node kept arriving
        // narrow. `createNode` calls onNodeCreated and then sizes the node
        // from `computeSize()`, so anything set at this point is measured over
        // the top of a moment later. It happens in _ensurePanel, on the next
        // frame, once the widget the size is meant to fit actually exists.

        // The panel is built in _ensurePanel rather than here. A DOM widget
        // registers itself with the frontend's widget store under the node's
        // id, and a node still being created does not have one — it gets it
        // when it joins the graph. `onAdded` is the path every node takes; the
        // animation frame covers a node created some other way, and the guard
        // inside makes whichever arrives first the only one that builds.
        requestAnimationFrame(() => this._ensurePanel());
        return r;
    };

    proto._ensurePanel = function () {
        if (this._panel) { this._panel.render(); return; }
        if (this._panelFailed) return;

        // A node that cannot take a DOM widget is reported once and left as a
        // plain node. Throwing out of here instead lands the exception in a
        // requestAnimationFrame callback, where nothing catches it and the
        // stack says nothing about why — which is exactly how a missing
        // `addCustomWidget` read as "the node will not open".
        if (typeof this.addDOMWidget !== "function" ||
            typeof this.addCustomWidget !== "function") {
            this._panelFailed = true;
            console.warn("[Nova Theme Studio] this node cannot host a DOM " +
                         "widget, so the panel was skipped. The node itself is " +
                         "fine; novaTheme.help() in the console does the same job.");
            return;
        }

        if (!palette) bootstrap();
        const panel = buildPanel(this);

        let widget;
        try {
            widget = this.addDOMWidget("nova_theme_studio", "HTML",
                makeDomHost(panel.element, PANEL_MIN_H, { minWidth: 430, minHeight: 300 }), {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => PANEL_MIN_H,
                });
        } catch (e) {
            // The panel element is already built and parented; leaving it
            // behind would stack an orphan copy on the page on every retry.
            this._panelFailed = true;
            panel.element.remove();
            console.error("[Nova Theme Studio] could not attach its panel:", e);
            return;
        }

        // Claimed only once the widget really exists, so a failed attempt is
        // not mistaken for a built panel on the next call.
        this._panel = panel;
        widget.computeSize = (width) => [width ?? this.size[0], PANEL_MIN_H + DOM_MARGIN];
        pinDomSize(this, widget, panel.element, PANEL_MIN_H);
        keepMinimumWidth(this, 430);
        panel.render();

        // A node restored from a workflow keeps the size it was saved at; only
        // a freshly added one takes the default.
        if (!this._hasSavedSize) {
            this.setSize([...DEFAULT_SIZE]);
        } else {
            this.setSize([Math.max(this.size[0], MIN_SIZE[0]),
                          Math.max(this.size[1], MIN_SIZE[1])]);
        }
        this.setDirtyCanvas(true, true);
    };

    // The floor, enforced where the frontend actually reads it. The resize
    // handle clamps against computeSize, and so does createNode — which is
    // what was shrinking this node to the width of its (nonexistent) slots.
    const prevComputeSize = proto.computeSize;
    proto.computeSize = function () {
        const s = prevComputeSize?.apply(this, arguments) || [...MIN_SIZE];
        return [Math.max(s[0], MIN_SIZE[0]), Math.max(s[1], MIN_SIZE[1])];
    };

    const prevAdded = proto.onAdded;
    proto.onAdded = function () {
        const r = prevAdded?.apply(this, arguments);
        this._ensurePanel();
        return r;
    };

    // The palette is carried IN THE WORKFLOW as well as in localStorage, so a
    // graph shared with someone else arrives looking the way it was built.
    const prevSerialize = proto.onSerialize;
    proto.onSerialize = function (o) {
        const r = prevSerialize?.apply(this, arguments);
        o.properties = o.properties || {};
        o.properties.palette = exportPalette();
        return r;
    };

    const prevConfigure = proto.onConfigure;
    proto.onConfigure = function (o) {
        const r = prevConfigure?.apply(this, arguments);
        // Noted before the panel is built, so _ensurePanel knows whether this
        // node has a size of its own to respect or is a fresh one to size.
        if (Array.isArray(o?.size) && o.size[0] > 0) this._hasSavedSize = true;
        const saved = o?.properties?.palette;
        if (saved) {
            try {
                importPalette(saved);
                this._panel?.render();
            } catch {
                // A workflow from a newer build of this node, or a hand-edited
                // one. The graph matters more than its colours.
            }
        }
        return r;
    };
}

/**
 * ONE REGISTRATION, HOWEVER MANY COPIES OF THIS FILE ARE SERVED.
 *
 * ComfyUI throws "Extension named 'Nova.ThemeStudio' already registered" if the
 * name is claimed twice, and it throws from inside the extension loader — which
 * reports it as a preload error against a null url, so the message names
 * neither file. A second copy in a sub-folder of the web directory is enough to
 * cause it, and the first copy is left half-installed.
 *
 * The flag makes a duplicate harmless and, more usefully, makes it SAY so, with
 * the path of the copy that is standing down. Deleting that file is the actual
 * fix; this only stops it breaking the one that works.
 */
if (window.__novaThemeStudio) {
    console.warn(
        "[Nova Theme Studio] already loaded from another copy of this file — " +
        `this one (${import.meta.url}) is standing down. Delete the duplicate: ` +
        "two copies in the web folder is the usual cause.");
} else {
    window.__novaThemeStudio = import.meta.url;

app.registerExtension({
    name: "Nova.ThemeStudio",

    /**
     * A SECOND WAY IN, because polling from `setup()` is one assumption.
     *
     * `setup()` can run before the app has a canvas, and everything this
     * extension does hangs off `bootstrap()` having succeeded: no palette, no
     * apply, no settle, no graph watch. Polling for the canvas covers the
     * common case, but it is a guess about someone else's startup, and a page
     * where that guess was wrong was simply never themed — silently, with
     * nothing in the console to say so.
     *
     * `afterConfigureGraph` fires once a workflow has been loaded into the
     * graph. By then a canvas certainly exists and the nodes certainly do too,
     * which makes it the one moment that cannot be too early. Whichever of the
     * two gets there first wins; `bootstrap()` is idempotent in the sense that
     * the second caller finds the work already done and simply re-applies.
     */
    async afterConfigureGraph() {
        bootstrapWhenReady();
        // Already running: a restored workflow is new nodes either way, and
        // the settle is what notices them.
        scheduleSettle(true);
    },

    async setup() {
        // Every node definition has landed by now, so the pack's own section
        // can be read off one of them (see novaCategory).
        if (frontendClass) frontendClass.category = novaCategory();
        bootstrapWhenReady();

        // The escape hatch, for the day this node is not in the open graph.
        window.novaTheme = {
            help() {
                console.log(
                    "novaTheme.get()            the palette as JSON text\n" +
                    "novaTheme.set(obj|text)    load a palette and apply it\n" +
                    "novaTheme.reset()          back to this tab's starting palette\n" +
                    "novaTheme.backdrop({image,fit,blur,dim,hideGrid})\n" +
                    "novaTheme.preset(theme, finish)\n" +
                    `    themes:   ${THEMES.map(t => t.id).join(", ")}\n` +
                    `    finishes: ${FINISHES.map(f => f.id).join(", ")}\n` +
                    "novaTheme.nodeAlpha(0.2-1) fade whole nodes (editor_alpha)\n" +
                    "novaTheme.enabled(false)   switch the studio off: nothing applied,\n" +
                    "                           ComfyUI's own palette back; true undoes it\n" +
                    "novaTheme.unfade()         put back any alpha knocked to 0\n" +
                    "novaTheme.renderer()       which renderer is drawing the nodes\n" +
                    "novaTheme.probe()          what is colouring a node right now\n" +
                    "novaTheme.live()           re-read what is on screen now\n" +
                    "novaTheme.start()          start it if the page was not ready in time"
                );
            },
            preset(theme, finish) {
                return applyPreset(theme ?? preset.theme, finish ?? preset.finish).name;
            },
            nodeAlpha(v) {
                preset.nodeAlpha = clamp(v, 0.2, 1);
                saveStore();
                applyNodeAlpha();
                return preset.nodeAlpha;
            },
            /**
             * Undo an accidentally zeroed alpha, wherever one is left.
             *
             * Targets exactly the damage a stray slider click does: a colour
             * that still has its channels but has had its alpha taken to
             * nothing. A literal `transparent`, and rgba(0, 0, 0, 0), are left
             * alone — those are deliberate, and Dark-Custom uses both.
             */
            unfade() {
                const zeroed = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*0(?:\.0+)?\s*\)$/;
                const fixed = [];
                for (const group of ["node_slot", "litegraph_base", "comfy_base"]) {
                    const table = palette?.colors?.[group];
                    if (!table) continue;
                    for (const [k, v] of Object.entries(table)) {
                        const m = zeroed.exec(String(v));
                        if (!m) continue;
                        const [r, g, b] = [+m[1], +m[2], +m[3]];
                        if (!r && !g && !b) continue;
                        table[k] = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
                        fixed.push(`${k} -> ${table[k]}`);
                    }
                }
                saveStore();
                applyAll();
                return fixed;
            },
            renderer(mode) {
                if (RENDERER_MODES.includes(mode)) {
                    preset.renderer = mode;
                    saveStore();
                    applyAll();
                }
                return activeRenderer();
            },
            probe() {
                const report = probeRenderer();
                console.log(JSON.stringify(report, null, 2));
                return report;
            },
            /** The master switch: novaTheme.enabled(false) applies nothing. */
            enabled(on) {
                if (on === undefined) return studioOn();
                return setEnabled(!!on);
            },
            get: () => JSON.stringify(exportPalette(), null, 2),
            set(v) { importPalette(typeof v === "string" ? JSON.parse(v) : v); },
            reset() { palette = JSON.parse(JSON.stringify(baseline)); saveStore(); applyAll(); },
            backdrop(patch) {
                Object.assign(backdrop, patch || {});
                if (patch && "image" in patch) keepWallpaperLegible();
                backdrop.blur = clamp(backdrop.blur, 0, 40);
                backdrop.dim = clamp(backdrop.dim, 0, 0.9);
                saveStore();
                applyBackdrop();
            },
            live() { baseline = readLive(); return baseline; },
            /** Start, or start over, when the page was not ready in time. */
            start() {
                bootstrapStart = 0;
                bootstrapGaveUp = false;
                bootstrapWhenReady();
                return palette ? "started" : "still waiting for a canvas";
            },
        };
    },

    /**
     * The preferred path: `nova_theme_studio.py` shipped a real node
     * definition, so this node is indexed like every other node in the pack —
     * proper title, description, and the pack's own submenu — and all this has
     * to do is give the definition its behaviour.
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;
        hasBackendDef = true;
        installBehaviour(nodeType.prototype);
    },

    /**
     * The fallback: no .py, so the node is registered here, frontend-only.
     *
     * It works, with one thing it cannot have. ComfyUI builds its search index
     * from the backend's node definitions; for a type it has never heard of it
     * SYNTHESISES one, and that synthetic definition hardcodes the raw type
     * name as the display name and `__frontend_only__` as the category. Nothing
     * set on the class reaches it. The right-click Add Node menu is LiteGraph's
     * own and does read the class, so the node lands in the pack's submenu
     * either way — but the search dialog will show "NovaThemeStudio" under
     * `__frontend_only__` until the .py is installed.
     *
     * ComfyUI runs this hook AFTER registering every backend definition, which
     * is what makes the flag above reliable: by now beforeRegisterNodeDef has
     * either fired or never will.
     */
    registerCustomNodes() {
        if (hasBackendDef) return;
        const LG = window.LiteGraph;
        if (!LG?.registerNodeType) return;

        // Already registered means the backend definition got here first —
        // these two hooks do not run in a guaranteed order, and on some builds
        // registerCustomNodes runs BEFORE the node definitions, so the flag
        // above cannot be the only guard.
        if (LG.registered_node_types?.[NODE_TYPE]) return;

        // EXTENDING LGraphNode IS NOT OPTIONAL, and assuming otherwise is what
        // broke this node.
        //
        // `registerNodeType` grafts the base class onto a registered class with
        // `for (const i in LGraphNode.prototype)`, and `for...in` only sees
        // ENUMERABLE properties. Modern LiteGraph defines LGraphNode as a
        // class, whose methods are non-enumerable, so that loop copies none of
        // them. What it does copy is the handful ComfyUI bolts on afterwards by
        // assignment — `addDOMWidget` among them — which are enumerable.
        //
        // The result is a node that has `addDOMWidget` but not the
        // `addCustomWidget` it calls, and no `computeSize` for createNode to
        // size it with: "e.addCustomWidget is not a function", and a createNode
        // that fails before it can even set `type`. Inheriting properly is the
        // fix; the graft then has nothing left to do.
        const Base = LG.LGraphNode || window.LGraphNode;
        if (!Base) {
            console.warn("[Nova Theme Studio] LGraphNode is not exposed by this " +
                         "frontend, so the node was not registered. The panel's " +
                         "whole job is still available as novaTheme.* in the " +
                         "console — novaTheme.help() lists it. Installing " +
                         "nova_theme_studio.py registers the node properly.");
            return;
        }

        class NovaThemeStudio extends Base {
            constructor(title) {
                super(title);
                this.size = [430, 460];
            }
        }

        // Set BEFORE registering: registerNodeType fills in a missing title
        // from the class name, and keeps one that is already there.
        NovaThemeStudio.title = NODE_TITLE;
        NovaThemeStudio.collapsable = true;
        NovaThemeStudio.desc = NODE_DESC;

        LG.registerNodeType(NODE_TYPE, NovaThemeStudio);

        // Set AFTER registering, and this ordering is the whole bug that put
        // this node in the wrong menu. `registerNodeType` DERIVES the category
        // from the type string — everything before the last "/" — and assigns
        // it over whatever the class had. A type with no slash therefore gets
        // an empty category, which drops the node at the root of the Add Node
        // menu. Assigning afterwards is what ComfyUI's own Note node does.
        NovaThemeStudio.category = novaCategory();
        // ASKED AGAIN LATER, because of the ordering noted above: on some
        // builds this hook runs BEFORE the node definitions, so at this moment
        // there may be no other node registered to read the section from and
        // the answer would be the fallback. `setup` runs after every
        // definition has landed, and the Add Node menu reads `category` when
        // it is opened, so a second assignment then costs nothing and is right.
        frontendClass = NovaThemeStudio;

        // After registration too: registerNodeType copies LGraphNode's
        // prototype onto the class, and addDOMWidget has to exist before the
        // panel can be built.
        installBehaviour(NovaThemeStudio.prototype);
    },
});

}   // end of the single-registration guard
