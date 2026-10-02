/**
 * settings-panel.js — the in-node settings drawer.
 *
 * Real DOM, not canvas. Because the widget is already a DOM element (see
 * host.js), an HTML panel costs almost nothing and buys native colour pickers,
 * sliders, keyboard access and focus rings — none of which a hand-drawn canvas
 * panel would have without a great deal of work.
 *
 * NOTHING in here is per-control code. Every row is generated:
 *   - parameter rows from the active renderer's `params` schema;
 *   - colour rows from the roles it declares, plus shared player chrome.
 * Add a renderer with three params and five roles and its section appears here
 * on the next load with no edit to this file.
 *
 * Design rules, all learned from using it:
 *
 *   SCOPED. Only the renderer you are currently looking at gets a section.
 *   Listing all five made the panel a wall of accordions you had to scroll.
 *   Switch the view with the pill and the panel follows.
 *
 *   ONE SECTION AT A TIME. Opening one closes the others, so the open section
 *   always has the full height to itself.
 *
 *   NO SAVE BUTTONS FOR VALUES. Every edit applies instantly and persists on
 *   its own. The only Save is "save as a new theme", which is a naming
 *   decision, not a persistence one.
 *
 *   SCOPE IS EXPLICIT. An edit either belongs to this player or to the theme
 *   every player shares, and which one is a genuine choice — so it is a switch
 *   sitting next to the theme picker, not a hidden default. Rows this node is
 *   overriding carry a dot, so local and inherited values are distinguishable
 *   at a glance.
 *
 *   NEVER REBUILD ON EDIT. Rebuilding resets which section is open. Edits call
 *   sync(), which only writes values into existing controls; the DOM is only
 *   rebuilt when the active renderer actually changes.
 *
 * Each colour row is a colour well AND an opacity slider, which together
 * produce an 8-digit hex value. That is the visible end of the pipeline fix:
 * the old code could not carry an alpha channel through interpolation at all.
 */

import { parse } from "../core/color.js";
import { getRenderer, paramSchema } from "../renderers/registry.js";
import { cleanName as cleanSeqName } from "../core/sequences.js";

/** Roles shared by the whole player rather than owned by one renderer. */
const CHROME_ROLES = [
    "surface", "text", "text.dim", "divider",
    "btn.bg", "btn.active", "btn.icon", "hover.glow",
    "scrub.bg", "scrub.fill",
    "vol.track", "vol.fill", "vol.knob", "speaker.muted",
    "meter.green.lit", "meter.green.dim",
    "meter.yellow.lit", "meter.yellow.dim",
    "meter.red.lit", "meter.red.dim",
    "meter.peak", "clip.led",
];

/**
 * Readable names for role tokens.
 * Only the awkward ones need an entry; everything else is prettified from the
 * token itself, minus the group prefix that the section heading already says.
 */
const ROLE_LABELS = {
    "surface": "Background",
    "text.dim": "Text dim",
    "divider": "Divider",
    "btn.bg": "Button",
    "btn.active": "Button active",
    "btn.icon": "Button icon",
    "hover.glow": "Hover glow",
    "scrub.bg": "Scrub track",
    "scrub.fill": "Scrub fill",
    "vol.track": "Volume track",
    "vol.fill": "Volume fill",
    "vol.knob": "Volume knob",
    "speaker.muted": "Muted icon",
    "meter.green.lit": "Meter green",
    "meter.green.dim": "Meter green off",
    "meter.yellow.lit": "Meter yellow",
    "meter.yellow.dim": "Meter yellow off",
    "meter.red.lit": "Meter red",
    "meter.red.dim": "Meter red off",
    "meter.peak": "Peak hold",
    "clip.led": "Clip LED",
    "gonio.bg": "Scope background",
    "gonio.ring": "Scope rings",
    "gonio.ring.outer": "Scope outer ring",
    "gonio.border": "Scope border",
    "gonio.grid": "Scope grid",
    "gonio.trace": "Trace",
    "gonio.trace.glow": "Trace glow",
    "gonio.trace.frozen": "Trace paused",
    "gauge.box.bg": "Gauge box",
    "gauge.box.border": "Gauge border",
    "gauge.needle": "Needle",
    "gauge.needle.tip": "Needle tip",
    "gauge.pivot": "Needle pivot",
    "gauge.title": "Gauge label",
    "gauge.readout.pos": "Readout, in phase",
    "gauge.readout.neg": "Readout, out of phase",
    "gauge.seg.green": "Zone: great",
    "gauge.seg.lime": "Zone: good",
    "gauge.seg.yellow": "Zone: neutral",
    "gauge.seg.orange": "Zone: poor",
    "gauge.seg.red": "Zone: phase issue",
    "wave.left": "Left channel",
    "wave.left.pulse": "Left pulse",
    "wave.right": "Right channel",
    "wave.right.pulse": "Right pulse",
    "wave.idle": "Left unplayed",
    "wave.idle.right": "Right unplayed",
    "wave.label": "Channel label",
    "wave.label.bg": "Label backing",
    "playhead": "Playhead",
    "spectrum.fill.low": "Fill, low end",
    "spectrum.fill.high": "Fill, high end",
    "spectrum.rim": "Curve",
    "spectrum.rim.glow": "Curve glow",
    "spectrum.label.bg": "Label strip",
    "spectrum.label.rule": "Label rule",
    "spectrum.label.text": "Label text",
    "spectrogram.bg": "Background",
    "spectrogram.grid": "Frequency lines",
    "spectrogram.label": "Frequency labels",
    "halo.bg": "Background",
    "halo.spike.low": "Spikes, quiet",
    "halo.spike.mid": "Spikes, mid",
    "halo.spike.high": "Spikes, loud",
    "halo.spike.tip": "Spike tips (gradient)",
    "halo.core": "Ring core",
    "halo.bubble.a": "Bubble 1",
    "halo.bubble.b": "Bubble 2",
    "halo.bubble.c": "Bubble 3",
    "halo.bubble.d": "Bubble 4",
};

function roleLabel(role) {
    if (ROLE_LABELS[role]) return ROLE_LABELS[role];
    const parts = role.split(".");
    const tail = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
    return tail.charAt(0).toUpperCase() + tail.slice(1);
}

const STYLE_ID = "nova-player-panel-style-v2";

/**
 * Paint a slider's filled track.
 *
 * The fill is a gradient on the track between --pa and --pb. An ordinary
 * slider fills from its left edge to the thumb; one that runs from negative to
 * positive (tilt, spin speed) fills from its zero point, so the bar shows how
 * far it is from neutral and in which direction. Positions allow for the
 * thumb's width so the fill ends under the thumb's centre.
 */
function paintRange(input) {
    const min = parseFloat(input.min || "0"), max = parseFloat(input.max || "100");
    const v = parseFloat(input.value);
    if (!(max > min) || !Number.isFinite(v)) return;
    const f = Math.max(0, Math.min(1, (v - min) / (max - min)));
    const zero = min < 0 && max > 0 ? -min / (max - min) : 0;
    const a = Math.min(zero, f), b = Math.max(zero, f);
    const at = x => `calc(var(--np-thumb) / 2 + (100% - var(--np-thumb)) * ${x.toFixed(4)})`;
    const key = a + "|" + b;
    if (input.dataset.fill === key) return;
    input.dataset.fill = key;
    input.style.setProperty("--pa", a <= 0 ? "0px" : at(a));
    input.style.setProperty("--pb", at(b));
}

function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* ==========================================================================
   The settings drawer.

   THREE RULES THIS STYLESHEET FOLLOWS

   1. It owns the look of every control. ComfyUI and other extensions ship
      page-wide rules for inputs, buttons and scrollbars; left to them, the
      sliders here rendered as flat grey bars with square thumbs and the
      scrollbar as a hairline. So native appearance is switched off and the
      properties that define a control are marked !important.
   2. Nothing that must be SEEN depends on a theme colour alone. Tracks,
      scrollbar thumbs and field backgrounds are mixed from the panel's text
      colour, so they contrast with the background in any theme.
   3. Every size is a multiple of --nova-text-scale, so the Text size slider
      scales the whole drawer, hit targets included.
   ========================================================================== */
.nova-panel {
    --nova-text-scale: 1;
    --np-u: calc(1px * var(--nova-text-scale));
    --np-accent: var(--nova-panel-accent);
    --np-track: color-mix(in srgb, var(--nova-panel-text) 20%, transparent);
    --np-field: color-mix(in srgb, var(--nova-panel-text) 8%, transparent);
    --np-field-hover: color-mix(in srgb, var(--nova-panel-text) 14%, transparent);
    --np-line: color-mix(in srgb, var(--nova-panel-text) 16%, transparent);
    --np-ring: color-mix(in srgb, var(--nova-panel-accent) 38%, transparent);
    --np-ctl: calc(30 * var(--np-u));          /* height of a button or field */
    --np-radius: calc(7 * var(--np-u));
    --np-thumb: calc(16 * var(--np-u));

    /* The bottom offset is set from the layout by host.js so the drawer never
       covers the transport row - see the note there. */
    position: absolute; top: 0; right: 0; bottom: 0;
    box-sizing: border-box;
    display: flex; flex-direction: column;
    background: var(--nova-panel-bg);
    border-left: 1px solid var(--nova-panel-border);
    border-radius: 0 10px 0 0;
    color: var(--nova-panel-text);
    font: calc(12 * var(--np-u))/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    backdrop-filter: blur(10px);
    box-shadow: -8px 0 24px rgba(0, 0, 0, .28);
    z-index: 3;
    overflow: hidden;
}
.nova-panel *, .nova-panel *::before, .nova-panel *::after { box-sizing: border-box; }
.nova-panel[hidden] { display: none !important; }
/* Every element here sets an explicit display value, which outranks the UA
   rule for [hidden]. Without this, hiding the name dialog does nothing. */
.nova-panel [hidden] { display: none !important; }

/* -- resize grip: drag the left edge ------------------------------------- */
.nova-panel__grip {
    position: absolute; left: 0; top: 0; bottom: 0; width: 10px;
    cursor: ew-resize; z-index: 4; touch-action: none;
}
.nova-panel__grip::after {
    content: ""; position: absolute; left: 3px; top: 50%;
    width: 4px; height: 44px; margin-top: -22px; border-radius: 999px;
    background: var(--np-track);
    transition: background .15s, height .15s, margin-top .15s;
}
.nova-panel__grip:hover::after, .nova-panel__grip:active::after {
    background: var(--np-accent); height: 64px; margin-top: -32px;
}

/* -- head ------------------------------------------------------------------ */
.nova-panel__head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: calc(10 * var(--np-u)) calc(12 * var(--np-u)) calc(10 * var(--np-u)) calc(18 * var(--np-u));
    border-bottom: 1px solid var(--np-line);
    flex: 0 0 auto;
}
.nova-panel__title {
    font-size: calc(13 * var(--np-u)); font-weight: 600; letter-spacing: .02em;
    color: var(--nova-panel-text); margin: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}

/* -- theme block ------------------------------------------------------------
   Only the theme picker and the scope switch live here now, so it is a fixed,
   short block. It is still capped and scrollable: an uncapped block once grew
   until it pushed the accordion behind the footer on a short node. */
.nova-panel__theme {
    flex: 0 0 auto;
    padding: calc(12 * var(--np-u)) calc(12 * var(--np-u)) calc(12 * var(--np-u)) calc(18 * var(--np-u));
    max-height: 46%;
    overflow-y: auto; overflow-x: hidden;
    border-bottom: 1px solid var(--np-line);
    display: grid; gap: calc(10 * var(--np-u));
}
.nova-panel__themerow { display: grid; grid-template-columns: 1fr 1fr auto; gap: calc(6 * var(--np-u)); }

/* Scope switch: where an edit lands. A segmented control. */
.nova-scope {
    display: grid; grid-template-columns: auto 1fr 1fr; gap: calc(3 * var(--np-u)); align-items: center;
    padding: calc(3 * var(--np-u)); border-radius: calc(9 * var(--np-u));
    background: var(--np-field);
}
.nova-scope__label {
    font-size: calc(10 * var(--np-u)); font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    color: var(--nova-panel-dim); padding: 0 calc(7 * var(--np-u));
}
.nova-panel .nova-scope button {
    appearance: none !important; -webkit-appearance: none !important;
    height: calc(26 * var(--np-u)); padding: 0 calc(8 * var(--np-u));
    border: 0 !important; border-radius: calc(6 * var(--np-u)) !important;
    cursor: pointer; font: inherit; font-weight: 500;
    background: transparent !important; color: var(--nova-panel-dim) !important;
    transition: background .15s, color .15s;
}
.nova-panel .nova-scope button:hover { color: var(--nova-panel-text) !important; background: var(--np-field-hover) !important; }
.nova-panel .nova-scope button[aria-pressed="true"] {
    background: var(--np-accent) !important; color: #fff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
.nova-panel__promote { width: 100%; }

/* -- scrolling ---------------------------------------------------------------
   min-height: 0 is load-bearing. A flex child will not shrink below its
   content size without it, so the body would refuse to scroll and overflow
   the drawer instead.

   scrollbar-color and scrollbar-width are reset to auto ON PURPOSE. Both
   properties, when set to anything else - and scrollbar-color is inherited,
   so a rule on the page body is enough - make Chromium ignore every
   ::-webkit-scrollbar rule below and draw its thin overlay bar instead. That
   is why the old 8px rule here never showed. */
.nova-panel__body { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-height: 0; }
.nova-panel__body, .nova-panel__theme {
    scrollbar-color: auto !important; scrollbar-width: auto !important;
    scrollbar-gutter: stable;
}
.nova-panel__body::-webkit-scrollbar, .nova-panel__theme::-webkit-scrollbar {
    width: 14px !important; height: 14px !important; background: transparent;
}
/* Fixed neutral greys, deliberately NOT theme variables: custom properties
   set on the panel after creation do not reliably repaint a scrollbar
   pseudo-element, and a mid grey is visible on dark and light panels alike. */
.nova-panel__body::-webkit-scrollbar-track, .nova-panel__theme::-webkit-scrollbar-track {
    background: rgba(128, 128, 140, .16) !important;
}
.nova-panel__body::-webkit-scrollbar-thumb, .nova-panel__theme::-webkit-scrollbar-thumb {
    /* The transparent border insets the thumb: an 8px pill in a 14px lane. */
    background: rgba(150, 150, 165, .8) !important;
    background-clip: padding-box !important;
    border: 3px solid transparent !important; border-radius: 999px !important;
    min-height: 44px;
}
.nova-panel__body::-webkit-scrollbar-thumb:hover, .nova-panel__theme::-webkit-scrollbar-thumb:hover {
    background: rgba(190, 190, 205, .95) !important; background-clip: padding-box !important;
}
.nova-panel__body::-webkit-scrollbar-thumb:active, .nova-panel__theme::-webkit-scrollbar-thumb:active {
    background: rgba(215, 215, 230, 1) !important; background-clip: padding-box !important;
}
/* Browsers without ::-webkit-scrollbar (Firefox) take the standard properties. */
@supports not selector(::-webkit-scrollbar) {
    .nova-panel__body, .nova-panel__theme {
        scrollbar-width: auto !important;
        scrollbar-color: rgba(150, 150, 165, .8) rgba(128, 128, 140, .16) !important;
    }
}

/* -- sections ---------------------------------------------------------------- */
.nova-panel details { border-bottom: 1px solid var(--np-line); }
.nova-panel summary {
    /* Sticky so you can always see which section you are editing, however far
       down the list you have scrolled. */
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: calc(10 * var(--np-u));
    background: var(--nova-panel-surface);
    cursor: pointer; list-style: none;
    padding: calc(11 * var(--np-u)) calc(12 * var(--np-u)) calc(11 * var(--np-u)) calc(18 * var(--np-u));
    font-size: calc(11 * var(--np-u)); font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    color: var(--nova-panel-dim); user-select: none; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    transition: color .15s, background .15s;
}
.nova-panel summary::-webkit-details-marker { display: none; }
.nova-panel summary::before {
    content: ""; flex: 0 0 auto;
    width: calc(7 * var(--np-u)); height: calc(7 * var(--np-u));
    border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
    transform: rotate(-45deg); transition: transform .18s ease;
    margin-left: calc(-2 * var(--np-u));
}
.nova-panel details[open] > summary::before { transform: rotate(45deg) translate(-2px, -2px); }
.nova-panel details[open] > summary { color: var(--nova-panel-text); }
.nova-panel summary:hover {
    color: var(--nova-panel-text);
    background: color-mix(in srgb, var(--nova-panel-text) 9%, var(--nova-panel-surface));
}
.nova-panel__group {
    padding: calc(6 * var(--np-u)) calc(12 * var(--np-u)) calc(16 * var(--np-u)) calc(18 * var(--np-u));
    display: grid; gap: calc(13 * var(--np-u));
}

/* -- rows ----------------------------------------------------------------------- */
.nova-row {
    display: grid; grid-template-columns: 1fr auto; align-items: center;
    gap: calc(5 * var(--np-u)) calc(10 * var(--np-u));
    min-height: calc(22 * var(--np-u));
}
.nova-row > label {
    color: var(--nova-panel-text); min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nova-row__value {
    color: var(--nova-panel-text); font-variant-numeric: tabular-nums;
    font-size: calc(11 * var(--np-u)); font-weight: 500;
    min-width: calc(42 * var(--np-u)); text-align: center;
    padding: calc(2 * var(--np-u)) calc(7 * var(--np-u));
    border-radius: calc(6 * var(--np-u)); background: var(--np-field);
}
.nova-row__wide { grid-column: 1 / -1; }
/* A row whose value this node is overriding, rather than taking from the theme. */
.nova-row--local > label { position: relative; font-weight: 600; }
.nova-row--local > label::before {
    content: ""; position: absolute; left: calc(-10 * var(--np-u)); top: 50%;
    width: 3px; height: calc(14 * var(--np-u)); margin-top: calc(-7 * var(--np-u));
    border-radius: 2px; background: var(--np-accent);
}
.nova-row--local > .nova-row__value {
    background: color-mix(in srgb, var(--nova-panel-accent) 26%, transparent);
}

/* -- sliders -----------------------------------------------------------------------
   Fully custom. --pa and --pb are the start and end of the filled part, set by
   paintRange() in the script: from the left edge for an ordinary slider, from
   the zero point for one that runs negative to positive (tilt, spin speed). */
.nova-panel input[type="range"] {
    -webkit-appearance: none !important; appearance: none !important;
    display: block; width: 100% !important; height: calc(22 * var(--np-u)) !important;
    margin: 0 !important; padding: 0 !important;
    background: transparent !important; border: 0 !important; border-radius: 999px;
    box-shadow: none !important; outline-offset: 3px;
    cursor: pointer; --pa: 0px; --pb: 50%;
}
.nova-panel input[type="range"]::-webkit-slider-runnable-track {
    -webkit-appearance: none !important; appearance: none !important;
    height: calc(6 * var(--np-u)) !important; border: 0 !important; border-radius: 999px !important;
    background: linear-gradient(to right,
        var(--np-track) 0, var(--np-track) var(--pa),
        var(--np-accent) var(--pa), var(--np-accent) var(--pb),
        var(--np-track) var(--pb), var(--np-track) 100%) !important;
    box-shadow: none !important;
}
.nova-panel input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none !important; appearance: none !important;
    width: var(--np-thumb) !important; height: var(--np-thumb) !important;
    margin-top: calc((6 * var(--np-u) - var(--np-thumb)) / 2);
    border-radius: 50% !important; border: 2px solid var(--np-accent) !important;
    background: #fff !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .5) !important;
    transition: transform .12s ease, box-shadow .12s ease;
}
.nova-panel input[type="range"]:hover::-webkit-slider-thumb { transform: scale(1.15); }
.nova-panel input[type="range"]:active::-webkit-slider-thumb,
.nova-panel input[type="range"]:focus-visible::-webkit-slider-thumb {
    transform: scale(1.2);
    box-shadow: 0 0 0 5px var(--np-ring), 0 1px 4px rgba(0, 0, 0, .5) !important;
}
.nova-panel input[type="range"]::-moz-range-track {
    height: calc(6 * var(--np-u)); border: 0; border-radius: 999px;
    background: linear-gradient(to right,
        var(--np-track) 0, var(--np-track) var(--pa),
        var(--np-accent) var(--pa), var(--np-accent) var(--pb),
        var(--np-track) var(--pb), var(--np-track) 100%);
}
.nova-panel input[type="range"]::-moz-range-thumb {
    width: var(--np-thumb); height: var(--np-thumb);
    border-radius: 50%; border: 2px solid var(--np-accent); background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}

/* -- toggles: a checkbox drawn as a switch --------------------------------------- */
.nova-panel input[type="checkbox"] {
    -webkit-appearance: none !important; appearance: none !important;
    position: relative; flex: 0 0 auto;
    width: calc(36 * var(--np-u)) !important; height: calc(20 * var(--np-u)) !important;
    margin: 0 !important; padding: 0 !important;
    border: 0 !important; border-radius: 999px !important;
    background: var(--np-track) !important; box-shadow: none !important;
    cursor: pointer; transition: background .16s ease;
}
.nova-panel input[type="checkbox"]::after {
    content: ""; position: absolute; top: calc(2 * var(--np-u)); left: calc(2 * var(--np-u));
    width: calc(16 * var(--np-u)); height: calc(16 * var(--np-u)); border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .45);
    transition: transform .16s ease;
}
.nova-panel input[type="checkbox"]:checked { background: var(--np-accent) !important; }
.nova-panel input[type="checkbox"]:checked::after { transform: translateX(calc(16 * var(--np-u))); }
.nova-panel input[type="checkbox"]:disabled { opacity: .45; cursor: default; }

/* -- fields: dropdowns, text and number boxes --------------------------------------- */
.nova-panel select, .nova-panel input[type="text"], .nova-panel input[type="number"] {
    -webkit-appearance: none !important; appearance: none !important;
    width: 100%; height: var(--np-ctl) !important;
    padding: 0 calc(10 * var(--np-u)) !important; margin: 0;
    background-color: var(--np-field) !important; color: var(--nova-panel-text) !important;
    border: 1px solid var(--np-line) !important; border-radius: var(--np-radius) !important;
    font: inherit; outline: none; box-shadow: none;
    transition: border-color .15s, box-shadow .15s, background-color .15s;
}
.nova-panel select {
    cursor: pointer; padding-right: calc(28 * var(--np-u)) !important;
    text-overflow: ellipsis;
    /* A chevron drawn from two gradients, so it takes the text colour. */
    background-image:
        linear-gradient(45deg, transparent 50%, currentColor 50%),
        linear-gradient(135deg, currentColor 50%, transparent 50%) !important;
    background-position:
        calc(100% - 15 * var(--np-u)) 50%, calc(100% - 10 * var(--np-u)) 50% !important;
    background-size: calc(5 * var(--np-u)) calc(5 * var(--np-u)) !important;
    background-repeat: no-repeat !important;
}
/* The open list is drawn by the browser; give it solid, readable colours. */
.nova-panel select option { background: var(--nova-panel-surface); color: var(--nova-panel-text); }
.nova-panel select:hover, .nova-panel input[type="text"]:hover, .nova-panel input[type="number"]:hover {
    background-color: var(--np-field-hover) !important;
}
.nova-panel select:focus-visible, .nova-panel input[type="text"]:focus, .nova-panel input[type="number"]:focus {
    border-color: var(--np-accent) !important; box-shadow: 0 0 0 3px var(--np-ring) !important;
}
.nova-panel select:disabled, .nova-panel input:disabled { opacity: .5; cursor: default; }
.nova-panel input::placeholder { color: var(--nova-panel-dim); opacity: 1; }
/* A select that is the control of a settings row sits beside its label. */
.nova-row > select { width: auto; min-width: calc(110 * var(--np-u)); max-width: 62%; }

/* -- buttons -------------------------------------------------------------------------- */
.nova-panel .nova-btn {
    -webkit-appearance: none !important; appearance: none !important;
    display: inline-flex; align-items: center; justify-content: center; gap: calc(6 * var(--np-u));
    height: var(--np-ctl); padding: 0 calc(13 * var(--np-u));
    border-radius: var(--np-radius) !important; cursor: pointer;
    font: inherit; font-weight: 500; white-space: nowrap;
    background: var(--np-field) !important; color: var(--nova-panel-text) !important;
    border: 1px solid var(--np-line) !important; box-shadow: none;
    transition: background .15s, border-color .15s, transform .08s, box-shadow .15s;
}
.nova-panel .nova-btn:hover { background: var(--np-field-hover) !important; border-color: color-mix(in srgb, var(--nova-panel-text) 34%, transparent) !important; }
.nova-panel .nova-btn:active { transform: translateY(1px); }
.nova-panel .nova-btn:disabled { opacity: .4; cursor: default; transform: none; }
.nova-panel .nova-btn--primary {
    background: var(--np-accent) !important; border-color: transparent !important; color: #fff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
.nova-panel .nova-btn--primary:hover {
    background: color-mix(in srgb, var(--nova-panel-accent) 84%, #fff) !important;
    border-color: transparent !important;
}
.nova-panel .nova-btn--danger {
    background: #c8384a !important; border-color: transparent !important; color: #fff !important;
}
.nova-panel .nova-btn--danger:hover { background: #dc4a5c !important; border-color: transparent !important; }
.nova-panel .nova-btn--icon {
    width: var(--np-ctl); padding: 0; flex: 0 0 auto;
    font-size: calc(14 * var(--np-u)); line-height: 1;
}
.nova-panel__dialog { display: grid; grid-template-columns: 1fr auto auto; gap: calc(6 * var(--np-u)); }

/* -- colour rows ------------------------------------------------------------------------ */
.nova-color {
    display: grid; grid-template-columns: calc(72 * var(--np-u)) calc(34 * var(--np-u));
    gap: calc(8 * var(--np-u)); align-items: center;
}
.nova-panel .nova-color input[type="color"] {
    -webkit-appearance: none !important; appearance: none !important;
    width: calc(34 * var(--np-u)) !important; height: calc(24 * var(--np-u)) !important;
    padding: 0 !important; border: 1px solid var(--np-line) !important;
    border-radius: calc(6 * var(--np-u)) !important; background: none !important; cursor: pointer;
    transition: border-color .15s, box-shadow .15s;
}
.nova-panel .nova-color input[type="color"]:hover {
    border-color: var(--np-accent) !important; box-shadow: 0 0 0 3px var(--np-ring);
}
.nova-color input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
.nova-color input[type="color"]::-webkit-color-swatch { border: none; border-radius: calc(4 * var(--np-u)); }
.nova-color input[type="color"]::-moz-color-swatch { border: none; border-radius: calc(4 * var(--np-u)); }

/* -- foot ---------------------------------------------------------------------------------- */
.nova-panel__foot {
    flex: 0 0 auto;
    padding: calc(9 * var(--np-u)) calc(12 * var(--np-u)) calc(10 * var(--np-u)) calc(18 * var(--np-u));
    border-top: 1px solid var(--np-line);
    display: flex; align-items: center; justify-content: space-between; gap: calc(10 * var(--np-u));
}
.nova-panel__status {
    font-size: calc(11 * var(--np-u)); color: var(--nova-panel-dim); min-height: calc(15 * var(--np-u));
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nova-panel__foot .nova-btn { flex: 0 0 auto; }
.nova-panel__status[data-tone="error"] { color: #ff9a9a; }
.nova-panel__status[data-tone="ok"] { color: #8fe0b4; }

/* -- sequences ------------------------------------------------------------------------------- */
.nova-seq__row { display: flex; align-items: center; gap: calc(6 * var(--np-u)); min-width: 0; }
.nova-seq__pick { flex: 1 1 auto; min-width: 0; }
.nova-seq__row input[type="text"] { flex: 1 1 auto; min-width: 0; }
.nova-panel .nova-seq__repeat input[type="number"] { width: calc(58 * var(--np-u)); flex: 0 0 auto; text-align: center; }
.nova-seq__loop { margin-left: auto; display: flex; align-items: center; gap: calc(7 * var(--np-u)); cursor: pointer; }
.nova-seq__dim, .nova-seq__folder { color: var(--nova-panel-dim); font-size: calc(11 * var(--np-u)); }
.nova-seq__folder { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nova-seq__confirm {
    display: flex; align-items: center; gap: calc(6 * var(--np-u));
    padding: calc(8 * var(--np-u)); border-radius: var(--np-radius);
    background: color-mix(in srgb, #c8384a 22%, transparent); color: #ffc9cf;
}
.nova-seq__confirm span { flex: 1 1 auto; min-width: 0; }
.nova-seq__rec { justify-self: start; }
.nova-seq__recording {
    display: grid; gap: calc(8 * var(--np-u)); justify-items: start;
    padding: calc(9 * var(--np-u)); border-radius: var(--np-radius);
    background: color-mix(in srgb, #ff5a6a 16%, transparent); color: #ffb0b8;
}
.nova-seq__rectext { overflow-wrap: anywhere; font-weight: 500; }

.nova-panel :focus-visible { outline: 2px solid var(--np-accent); outline-offset: 2px; }
.nova-panel input[type="range"]:focus-visible { outline: none; }
@media (prefers-reduced-motion: reduce) {
    .nova-panel *, .nova-panel *::before, .nova-panel *::after { transition: none !important; }
}
`;
    document.head.appendChild(style);
}

const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

/** Split a colour into a #rrggbb well value and a 0-1 alpha. */
function splitColor(css) {
    const p = parse(css) || { r: 0, g: 0, b: 0, a: 1 };
    const hex = "#" + [p.r, p.g, p.b]
        .map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
        .join("");
    return { hex, alpha: p.a };
}

/** Recombine a well value and alpha into #rrggbb or #rrggbbaa. */
function joinColor(hex, alpha) {
    if (alpha >= 0.999) return hex;
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
        .toString(16).padStart(2, "0");
    return hex + a;
}

const fmtNum = v => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));

/**
 * Build the panel.
 *
 * @param {object} ctl controller supplied by host.js:
 *   close()
 *   getPalette()                     -> resolved palette (with overrides)
 *   activeRenderer()                 -> current renderer id
 *   getRoleValue(role)               -> effective css for a role
 *   setRole(role, value)             -> apply live; autosaves shortly after
 *   getParam(id, key)                -> effective param value
 *   setParam(id, key, value)         -> apply live; autosaves shortly after
 *   getThemeName() / setThemeName(name)
 *   listThemes()                     -> [{ name, label }]
 *   createTheme(name)                -> Promise<{ok, message}>
 *   saveThemeAs(name)                -> Promise<{ok, message}>
 *   deleteTheme(name)                -> Promise<{ok, message}>
 *   canDeleteTheme(name)             -> boolean
 *   resetOverrides()
 *   getTextScale() / setTextScale(v) -> Promise<{ok, message}>
 *   previewTextScale(v)              (apply without persisting, for dragging)
 *   getBarRelief() / setBarRelief(v) -> Promise<{ok, message}>
 *   previewBarRelief(v)              (apply without persisting, for dragging)
 *   getShowTooltips() / setShowTooltips(v) -> Promise<{ok, message}>
 *   getPanelWidth() / setPanelWidth(px)
 *   getOpenSection() / setOpenSection(id)
 */
export function createSettingsPanel(ctl) {
    ensureStylesheet();

    const root = el("div", "nova-panel");
    root.hidden = true;
    // Keep every slider's filled track in step while it is dragged.
    root.addEventListener("input", e => {
        if (e.target && e.target.type === "range") paintRange(e.target);
    });
    // Keep pointer events off the canvas underneath (which would seek).
    for (const evt of ["pointerdown", "pointerup", "pointermove", "wheel", "click", "dblclick"]) {
        root.addEventListener(evt, e => e.stopPropagation());
    }

    // -- resize grip -------------------------------------------------------
    const grip = el("div", "nova-panel__grip");
    grip.title = "Drag to resize";
    let gripDrag = null;
    grip.addEventListener("pointerdown", e => {
        gripDrag = { startX: e.clientX, startW: root.offsetWidth };
        try { grip.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    });
    grip.addEventListener("pointermove", e => {
        if (!gripDrag) return;
        // Dragging left widens, so the delta is inverted.
        const raw = gripDrag.startW + (gripDrag.startX - e.clientX);
        const max = Math.max(200, (root.parentElement?.clientWidth || 900) - 120);
        const width = Math.round(Math.max(200, Math.min(max, raw)));
        root.style.width = width + "px";
    });
    const endGrip = e => {
        if (!gripDrag) return;
        gripDrag = null;
        try { grip.releasePointerCapture(e.pointerId); } catch {}
        ctl.setPanelWidth(root.offsetWidth);
    };
    grip.addEventListener("pointerup", endGrip);
    grip.addEventListener("pointercancel", endGrip);
    root.appendChild(grip);

    // -- head --------------------------------------------------------------
    const head = el("div", "nova-panel__head");
    const title = el("p", "nova-panel__title", "Appearance");
    const closeBtn = el("button", "nova-btn nova-btn--icon", "✕");
    closeBtn.title = "Close settings";
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.onclick = () => ctl.close();
    head.append(title, closeBtn);
    root.appendChild(head);

    // -- theme block (always visible, never an accordion) ------------------
    const themeBlock = el("div", "nova-panel__theme");
    const select = el("select");
    select.title = "Active theme";
    select.onchange = () => ctl.setThemeName(select.value);

    const themeRow = el("div", "nova-panel__themerow");
    const newBtn = el("button", "nova-btn", "New");
    newBtn.title = "Create a new theme from the current colours";
    const saveAsBtn = el("button", "nova-btn nova-btn--primary", "Save as");
    saveAsBtn.title = "Save the current colours under a new name";
    const delBtn = el("button", "nova-btn nova-btn--icon", "✕");
    delBtn.title = "Delete this theme";
    themeRow.append(newBtn, saveAsBtn, delBtn);

    // Inline name dialog — replaces window.prompt(), which is a browser chrome
    // popup that looks nothing like the rest of the node.
    const dialog = el("div", "nova-panel__dialog");
    dialog.hidden = true;
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.placeholder = "Theme name";
    nameInput.spellcheck = false;
    const okBtn = el("button", "nova-btn nova-btn--primary", "Create");
    const cancelBtn = el("button", "nova-btn nova-btn--icon", "✕");
    cancelBtn.title = "Cancel";
    dialog.append(nameInput, okBtn, cancelBtn);

    // Scope switch. This is the difference between "recolour this player" and
    // "recolour every player using this theme", and it needs to be visible at
    // the moment of editing rather than buried in a menu.
    const scopeRow = el("div", "nova-scope");
    scopeRow.appendChild(el("span", "nova-scope__label", "Edits"));
    const scopeNode = el("button", null, "This node");
    scopeNode.title = "Changes apply to this player only and are saved with the workflow";
    const scopeTheme = el("button", null, "Theme");
    scopeTheme.title = "Changes are written to the theme on disk, for every player using it";
    scopeNode.onclick = () => { ctl.setScope("node"); sync(); };
    scopeTheme.onclick = () => { ctl.setScope("theme"); sync(); };
    scopeRow.append(scopeNode, scopeTheme);

    const promote = el("button", "nova-btn nova-panel__promote", "Apply node colours to theme");
    promote.title = "Move this node's overrides into the theme, so other players get them too";
    promote.onclick = async () => {
        const res = await ctl.promoteToTheme();
        say(res.message, res.ok ? "ok" : "error");
        sync();
    };

    // Text size. Sits with the theme controls because that is where a user
    // looks for "make this look right on my screen", but it is NOT part of the
    // theme: it is an app-level display preference, so switching theme does not
    // change it and it applies to every player at once.
    const textRow = el("div", "nova-row");
    const textLabel = el("label", null, "Text size");
    textLabel.title = "Scales every label in the player. Applies to all players, not just this one.";
    const textValue = el("span", "nova-row__value", "");
    const textSlider = el("input");
    textSlider.type = "range";
    textSlider.min = "0.7";
    textSlider.max = "2";
    textSlider.step = "0.05";

    // Dragging a slider fires oninput per pixel and each one would be an HTTP
    // write. Paint immediately, persist once the drag settles.
    let textTimer = null;
    textSlider.oninput = () => {
        const v = parseFloat(textSlider.value);
        textValue.textContent = `${Math.round(v * 100)}%`;
        ctl.previewTextScale(v);
        clearTimeout(textTimer);
        textTimer = setTimeout(async () => {
            const res = await ctl.setTextScale(v);
            if (!res.ok) say(res.message, "error");
        }, 350);
    };

    const textWide = el("div", "nova-row__wide");
    textWide.appendChild(textSlider);
    textRow.append(textLabel, textValue, textWide);
    // Bar relief. Same reasoning as text size: a display preference rather than
    // theme content, because the shading is DERIVED from whatever colour the
    // theme supplies rather than being a colour of its own.
    const reliefRow = el("div", "nova-row");
    const reliefLabel = el("label", null, "Bar relief");
    reliefLabel.title = "3D shading on every bar, derived from the bar's own colour. 0 is flat.";
    const reliefValue = el("span", "nova-row__value", "");
    const reliefSlider = el("input");
    reliefSlider.type = "range";
    reliefSlider.min = "0";
    reliefSlider.max = "1";
    reliefSlider.step = "0.05";

    let reliefTimer = null;
    reliefSlider.oninput = () => {
        const v = parseFloat(reliefSlider.value);
        reliefValue.textContent = `${Math.round(v * 100)}%`;
        ctl.previewBarRelief(v);
        clearTimeout(reliefTimer);
        reliefTimer = setTimeout(async () => {
            const res = await ctl.setBarRelief(v);
            if (!res.ok) say(res.message, "error");
        }, 350);
    };

    const reliefWide = el("div", "nova-row__wide");
    reliefWide.appendChild(reliefSlider);
    reliefRow.append(reliefLabel, reliefValue, reliefWide);

    // Control hints. Same class of setting again: useful while the transport is
    // unfamiliar, noise once it is not, and that is a property of the person
    // rather than of the theme.
    const tipRow = el("div", "nova-row");
    const tipLabel = el("label", null, "Control hints");
    tipLabel.title = "Show a hint when the pointer rests on a transport control. " +
                     "Applies to all players, not just this one.";
    const tipBox = el("input");
    tipBox.type = "checkbox";
    tipBox.onchange = async () => {
        const res = await ctl.setShowTooltips(tipBox.checked);
        if (!res.ok) {
            // Never leave the box showing a state that was not stored.
            tipBox.checked = ctl.getShowTooltips();
            say(res.message, "error");
        }
    };
    tipRow.append(tipLabel, tipBox);

    // The theme block holds only what you reach for constantly: which theme,
    // and where edits land. Text size, bar relief and hints are display
    // preferences set once; they live in a "Display" section of the accordion
    // (built once here, re-attached by build()) so they no longer take half
    // the drawer away from the settings you are actually adjusting.
    themeBlock.append(select, themeRow, dialog, scopeRow, promote);
    root.appendChild(themeBlock);

    const displaySection = el("details");
    displaySection.dataset.section = "display";
    displaySection.appendChild(el("summary", null, "Display"));
    const displayGroup = el("div", "nova-panel__group");
    displayGroup.append(textRow, reliefRow, tipRow);
    displaySection.appendChild(displayGroup);
    displaySection.addEventListener("toggle", () => {
        if (!displaySection.open) return;
        for (const other of body.querySelectorAll("details")) {
            if (other !== displaySection) other.open = false;
        }
        ctl.setOpenSection("display");
    });

    let dialogAction = null;
    const openDialog = (action, label, seed) => {
        dialogAction = action;
        okBtn.textContent = label;
        nameInput.value = seed || "";
        themeRow.hidden = true;
        dialog.hidden = false;
        nameInput.focus();
        nameInput.select();
    };
    const closeDialog = () => {
        dialogAction = null;
        dialog.hidden = true;
        themeRow.hidden = false;
    };
    const submitDialog = async () => {
        const name = nameInput.value.trim();
        if (!name) { say("Enter a name", "error"); nameInput.focus(); return; }
        const action = dialogAction;
        closeDialog();
        const res = action === "new" ? await ctl.createTheme(name) : await ctl.saveThemeAs(name);
        say(res.message, res.ok ? "ok" : "error");
        if (res.ok) sync();
    };

    newBtn.onclick = () => openDialog("new", "Create", "");
    saveAsBtn.onclick = () => openDialog("saveAs", "Save", ctl.getThemeName() + " copy");
    okBtn.onclick = submitDialog;
    cancelBtn.onclick = closeDialog;
    nameInput.addEventListener("keydown", e => {
        e.stopPropagation();                       // keep ComfyUI shortcuts out
        if (e.key === "Enter") submitDialog();
        if (e.key === "Escape") closeDialog();
    });
    delBtn.onclick = async () => {
        const name = ctl.getThemeName();
        const res = await ctl.deleteTheme(name);
        say(res.message, res.ok ? "ok" : "error");
        if (res.ok) sync();
    };

    // -- body / footer -----------------------------------------------------
    const body = el("div", "nova-panel__body");
    root.appendChild(body);

    const foot = el("div", "nova-panel__foot");
    const status = el("div", "nova-panel__status", "");
    const resetBtn = el("button", "nova-btn", "Reset node");
    resetBtn.title = "Discard this node's unsaved overrides and follow the theme";
    resetBtn.onclick = () => { ctl.resetOverrides(); say("Overrides cleared", "ok"); sync(); };
    foot.append(status, resetBtn);
    root.appendChild(foot);

    let statusTimer = null;
    function say(msg, tone = "") {
        status.textContent = msg || "";
        status.dataset.tone = tone;
        clearTimeout(statusTimer);
        if (msg) {
            statusTimer = setTimeout(() => {
                status.textContent = "";
                status.dataset.tone = "";
            }, 3500);
        }
    }

    // -- row builders ------------------------------------------------------

    let syncers = [];

    function colorRow(role) {
        const row = el("div", "nova-row");
        const label = el("label", null, roleLabel(role));
        label.title = role;

        const wrap = el("div", "nova-color");
        const alpha = el("input");
        alpha.type = "range";
        alpha.min = "0"; alpha.max = "1"; alpha.step = "0.01";
        alpha.title = "Opacity";
        const well = el("input");
        well.type = "color";
        well.title = role;

        const push = () => ctl.setRole(role, joinColor(well.value, parseFloat(alpha.value)));
        // "input" fires live while the picker is open; "change" catches the
        // final commit in browsers that only fire it on close.
        well.addEventListener("input", push);
        well.addEventListener("change", push);
        alpha.addEventListener("input", push);

        wrap.append(alpha, well);
        row.append(label, wrap);

        syncers.push(() => {
            const { hex, alpha: a } = splitColor(ctl.getRoleValue(role));
            if (document.activeElement !== well) well.value = hex;
            if (document.activeElement !== alpha) alpha.value = String(a);
            const local = ctl.isRoleLocal(role);
            row.classList.toggle("nova-row--local", local);
            label.title = local ? `${role} — overridden on this node` : role;
        });
        return row;
    }

    function paramRow(id, key, spec) {
        const row = el("div", "nova-row");
        const label = el("label", null, spec.label || key);
        label.title = `${id}.${key}`;

        if (spec.type === "select") {
            // options: [{ value, label }] or plain strings. The stored value is
            // the option's string; an unknown stored value shows the default.
            // Optional aliases: { oldValue: currentValue }.
            const opts = (spec.options || []).map(o =>
                typeof o === "string" ? { value: o, label: o } : o);
            const sel = el("select");
            for (const o of opts) {
                const opt = el("option", null, o.label ?? o.value);
                opt.value = o.value;
                sel.appendChild(opt);
            }
            sel.onchange = () => ctl.setParam(id, key, sel.value);
            row.append(label, sel);
            syncers.push(() => {
                // `aliases` maps values saved by an older build onto current
                // options, so the dropdown shows what the renderer is doing.
                const raw = ctl.getParam(id, key);
                const v = (spec.aliases && spec.aliases[raw]) || raw;
                const known = opts.some(o => o.value === v);
                if (document.activeElement !== sel) sel.value = known ? v : spec.default;
                row.classList.toggle("nova-row--local", ctl.isParamLocal(id, key));
            });
            return row;
        }

        if (spec.type === "toggle") {
            const box = el("input");
            box.type = "checkbox";
            box.onchange = () => ctl.setParam(id, key, box.checked);
            row.append(label, box);
            syncers.push(() => {
                box.checked = !!ctl.getParam(id, key);
                row.classList.toggle("nova-row--local", ctl.isParamLocal(id, key));
            });
            return row;
        }

        const value = el("span", "nova-row__value", "");
        const slider = el("input");
        slider.type = "range";
        slider.min = String(spec.min ?? 0);
        slider.max = String(spec.max ?? 1);
        slider.step = String(spec.step ?? 0.01);
        slider.oninput = () => {
            const v = parseFloat(slider.value);
            value.textContent = fmtNum(v);
            ctl.setParam(id, key, v);
        };

        // Double-click a slider to put it back to its default.
        if (spec.default !== undefined) {
            slider.title = `Double-click to reset to ${fmtNum(Number(spec.default))}`;
            slider.ondblclick = () => {
                slider.value = String(spec.default);
                slider.oninput();
            };
        }

        const wide = el("div", "nova-row__wide");
        wide.appendChild(slider);
        row.append(label, value, wide);

        syncers.push(() => {
            const v = Number(ctl.getParam(id, key));
            if (document.activeElement !== slider) slider.value = String(v);
            value.textContent = fmtNum(v);
            row.classList.toggle("nova-row--local", ctl.isParamLocal(id, key));
        });
        return row;
    }

    /** One accordion section. Opening it closes its siblings. */
    function section(id, heading) {
        const d = el("details");
        d.dataset.section = id;
        const s = el("summary", null, heading);
        d.appendChild(s);
        const group = el("div", "nova-panel__group");
        d.appendChild(group);

        d.addEventListener("toggle", () => {
            if (!d.open) return;
            for (const other of body.querySelectorAll("details")) {
                if (other !== d) other.open = false;
            }
            ctl.setOpenSection(id);
        });

        body.appendChild(d);
        return group;
    }

    // -- build -------------------------------------------------------------

    let builtFor = null;

    /**
     * "Sequences" — record yourself playing with this view's settings, then
     * replay it. Only for renderers that opt in (`sequences: true`); the
     * section is identical for every one of them. See core/sequences.js.
     */
    function sequencesSection(id, renderer) {
        const g = section("sequences", `${renderer.label} · sequences`);
        const fmtT = ms => {
            const t = Math.max(0, Math.round(ms / 1000));
            return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
        };
        let items = [];
        let naming = false;
        let confirming = false;

        // -- the list, Play/Stop, Delete ------------------------------------
        const listRow = el("div", "nova-seq__row");
        const pick = el("select", "nova-seq__pick");
        pick.title = "Saved sequences for this view";
        const playBtn = el("button", "nova-btn nova-btn--primary", "▶ Play");
        const delSeq = el("button", "nova-btn nova-btn--icon", "🗑");
        delSeq.title = "Delete this sequence";
        delSeq.setAttribute("aria-label", "Delete this sequence");
        listRow.append(pick, playBtn, delSeq);

        const repeatRow = el("div", "nova-seq__row nova-seq__repeat");
        const repLabel = el("label", null, "Play");
        const times = el("input");
        times.type = "number"; times.min = "1"; times.max = "99"; times.step = "1"; times.value = "1";
        times.title = "How many times to play it";
        const timesLabel = el("span", "nova-seq__dim", "time(s)");
        const loopLabel = el("label", "nova-seq__loop");
        const loop = el("input");
        loop.type = "checkbox"; loop.checked = true;
        loopLabel.append(loop, document.createTextNode(" loop"));
        repeatRow.append(repLabel, times, timesLabel, loopLabel);

        const confirmRow = el("div", "nova-seq__confirm");
        const confirmText = el("span", null, "Are you sure?");
        const yes = el("button", "nova-btn nova-btn--danger", "Delete");
        const no = el("button", "nova-btn", "Keep");
        confirmRow.append(confirmText, yes, no);
        confirmRow.hidden = true;

        // -- recording ---------------------------------------------------------
        const recBtn = el("button", "nova-btn nova-seq__rec", "● Record new…");
        recBtn.title = "Record yourself changing this view's settings";
        const nameRow = el("div", "nova-seq__row");
        const nameIn = el("input");
        nameIn.type = "text"; nameIn.placeholder = "Name, e.g. Spinning Fury";
        nameIn.maxLength = 80;
        const startBtn = el("button", "nova-btn nova-btn--primary", "Start");
        const cancelBtn = el("button", "nova-btn", "Cancel");
        nameRow.append(nameIn, startBtn, cancelBtn);
        nameRow.hidden = true;
        const nameHint = el("div", "nova-seq__dim");
        nameHint.hidden = true;

        // Status on its own line: in a narrow drawer, sharing a row with the
        // button truncated the change count and the timer.
        const recRow = el("div", "nova-seq__recording");
        const recText = el("div", "nova-seq__rectext", "");
        const stopRecBtn = el("button", "nova-btn nova-btn--primary", "■ Stop & save");
        recRow.append(recText, stopRecBtn);
        recRow.hidden = true;

        const playText = el("div", "nova-seq__dim", "");
        const folder = el("div", "nova-seq__folder", "");

        g.append(listRow, repeatRow, confirmRow, playText, recBtn, nameRow, nameHint, recRow, folder);

        // -- behaviour -----------------------------------------------------------
        async function load(select) {
            const res = await ctl.seqList(id);
            if (ctl.activeRenderer() !== id) return;            // switched away meanwhile
            if (!res.ok) { items = []; say(`Sequences: ${res.message}`, "error"); }
            else {
                items = res.items || [];
                folder.textContent = res.folder ? `Files: ${res.folder}` : "";
                folder.title = res.folder ? `${res.folder}\nBack this folder up, or drop sequence files into it.` : "";
            }
            const keep = select ?? pick.value;
            pick.replaceChildren();
            if (!items.length) {
                const o = el("option", null, "No sequences yet — record one");
                o.value = ""; o.disabled = true; o.selected = true;
                pick.appendChild(o);
            }
            for (const it of items) {
                const o = el("option", null, it.error ? `${it.name} (unreadable)` :
                    `${it.name}  ·  ${fmtT(it.duration_ms || 0)}`);
                o.value = it.name;
                pick.appendChild(o);
            }
            if (keep && items.some(i => i.name === keep)) pick.value = keep;
            sync();
        }

        playBtn.onclick = async () => {
            if (ctl.seqState().playing) { ctl.seqStop(); sync(); return; }
            if (!pick.value) return;
            const n = Math.max(1, Math.min(99, parseInt(times.value, 10) || 1));
            times.value = String(n);
            const res = await ctl.seqPlay(pick.value, { loop: loop.checked, times: n });
            say(res.message, res.ok ? "ok" : "error");
            sync();
        };

        delSeq.onclick = () => {
            if (!pick.value) return;
            confirming = true;
            confirmText.textContent = `Delete "${pick.value}"? Are you sure?`;
            sync();
            no.focus();
        };
        no.onclick = () => { confirming = false; sync(); };
        yes.onclick = async () => {
            const name = pick.value;
            confirming = false;
            const res = await ctl.seqDelete(id, name);
            say(res.ok ? `Deleted "${name}"` : `Not deleted: ${res.message}`, res.ok ? "ok" : "error");
            await load("");
        };

        const nameState = () => {
            const clean = cleanSeqName(nameIn.value);
            const taken = items.some(i => i.name.toLowerCase() === clean.toLowerCase());
            startBtn.disabled = !clean;
            nameHint.hidden = !clean || (!taken && clean === nameIn.value.trim());
            nameHint.textContent = taken ? `"${clean}" exists — this one will be saved as "${clean} (2)"`
                                         : `Will be saved as "${clean}"`;
        };
        recBtn.onclick = () => { naming = true; nameIn.value = ""; nameState(); sync(); nameIn.focus(); };
        cancelBtn.onclick = () => { naming = false; sync(); };
        nameIn.addEventListener("input", nameState);
        nameIn.addEventListener("keydown", e => {
            // The canvas listens for bare keys; keep typing inside the box.
            e.stopPropagation();
            if (e.key === "Enter" && !startBtn.disabled) startBtn.click();
            if (e.key === "Escape") cancelBtn.click();
        });
        startBtn.onclick = () => {
            const res = ctl.seqStartRecording(nameIn.value);
            if (!res.ok) { say(res.message, "error"); return; }
            naming = false;
            say(`Recording "${res.name}" — change settings above, then Stop & save`, "ok");
            // Open the settings so there is something to play with.
            const settings = body.querySelector('details[data-section="settings"]');
            if (settings) settings.open = true;
            sync();
        };
        stopRecBtn.onclick = async () => {
            stopRecBtn.disabled = true;
            const res = await ctl.seqStopRecording();
            stopRecBtn.disabled = false;
            say(res.message, res.ok ? "ok" : "error");
            await load(res.ok ? res.name : undefined);
        };

        syncers.push(() => {
            const st = ctl.seqState();
            const rec = st.recording, play = st.playing;
            const has = !!pick.value;
            playBtn.textContent = play ? "■ Stop" : "▶ Play";
            playBtn.disabled = !!rec || (!play && !has);
            delSeq.disabled = !!rec || !!play || !has;
            pick.disabled = !!rec || !!play;
            times.disabled = loop.checked || !!play;
            loop.disabled = !!play;
            confirmRow.hidden = !confirming;
            recBtn.hidden = !!rec || naming;
            recBtn.disabled = !!play;
            nameRow.hidden = !naming || !!rec;
            if (nameRow.hidden) nameHint.hidden = true;
            recRow.hidden = !rec;
            if (rec) recText.textContent = `● REC  ${rec.name} — ${rec.steps} change${rec.steps === 1 ? "" : "s"} · ${fmtT(rec.elapsedMs)}`
                + (rec.paused ? "  ·  clock paused with the song — take your time" : "");
            playText.hidden = !play;
            if (play) playText.textContent = `${play.paused ? "Paused with the song" : "Playing"} ${play.name} — ${play.loop ? `loop ${play.pass}` : `${play.pass} of ${play.times}`} · ${Math.round(play.progress * 100)}%`;
        });

        // Each time this view is chosen the section is rebuilt, and the list
        // is read fresh from disk — files dropped into the folder show up.
        load();
    }

    function build() {
        const id = ctl.activeRenderer();
        const renderer = getRenderer(id);
        builtFor = id;

        body.replaceChildren();
        syncers = [];

        title.textContent = renderer.label.toLowerCase()
            .replace(/^./, c => c.toUpperCase());

        const schema = paramSchema(id);
        if (Object.keys(schema).length) {
            const g = section("settings", `${renderer.label} · settings`);
            for (const [key, spec] of Object.entries(schema)) {
                g.appendChild(paramRow(id, key, spec));
            }
        }

        if (ctl.seqSupported && ctl.seqSupported(id)) sequencesSection(id, renderer);

        const own = (renderer.roles || []).filter(r => !CHROME_ROLES.includes(r));
        if (own.length) {
            const g = section("colours", `${renderer.label} · colours`);
            for (const role of own) g.appendChild(colorRow(role));
        }

        const chrome = section("chrome", "Player chrome · colours");
        for (const role of CHROME_ROLES) chrome.appendChild(colorRow(role));

        displaySection.open = false;
        body.appendChild(displaySection);

        // Restore the section the user last had open, defaulting to settings.
        const wanted = ctl.getOpenSection() || "settings";
        const target = body.querySelector(`details[data-section="${wanted}"]`)
                    || body.querySelector("details");
        if (target) target.open = true;

        sync();
    }

    /**
     * Write current values into the existing controls.
     * Never touches structure — that is what keeps the open section open when
     * a colour changes.
     */
    function sync() {
        const p = ctl.getPalette();
        root.style.setProperty("--nova-panel-bg", p.get("panel.bg"));
        root.style.setProperty("--nova-panel-surface", p.get("panel.surface"));
        root.style.setProperty("--nova-panel-border", p.get("panel.border"));
        root.style.setProperty("--nova-panel-text", p.get("panel.text"));
        root.style.setProperty("--nova-panel-dim", p.get("panel.text.dim"));
        root.style.setProperty("--nova-panel-accent", p.get("panel.accent"));
        // Not while the grip is being dragged: sync() runs several times a
        // second during a recording or playback, and writing the saved width
        // mid-drag snapped the drawer back to it under the pointer.
        if (!gripDrag) root.style.width = (ctl.getPanelWidth() || 248) + "px";
        root.style.setProperty("--nova-text-scale", String(ctl.getTextScale() || 1));

        // Theme list
        const themes = ctl.listThemes();
        const current = ctl.getThemeName();
        const key = themes.map(t => t.name + ":" + (t.label || "")).join("|");
        if (select.dataset.keys !== key) {
            select.dataset.keys = key;
            select.replaceChildren(...themes.map(t => {
                const o = el("option", null, t.label || t.name);
                o.value = t.name;
                return o;
            }));
        }
        if (select.value !== current) select.value = current;
        delBtn.disabled = !ctl.canDeleteTheme(current);

        // Theme-block controls sync here rather than through `syncers`: that
        // array is emptied on every rebuild, and these outlive rebuilds.
        const ts = Number(ctl.getTextScale());
        if (document.activeElement !== textSlider) textSlider.value = String(ts);
        textValue.textContent = `${Math.round(ts * 100)}%`;

        const br = Number(ctl.getBarRelief());
        if (document.activeElement !== reliefSlider) reliefSlider.value = String(br);
        reliefValue.textContent = `${Math.round(br * 100)}%`;

        if (document.activeElement !== tipBox) tipBox.checked = ctl.getShowTooltips();

        const scope = ctl.getScope();
        scopeNode.setAttribute("aria-pressed", String(scope === "node"));
        scopeTheme.setAttribute("aria-pressed", String(scope === "theme"));

        // Only offer to promote when there is something to promote, and only
        // in node scope — in theme scope the edits are already going there.
        const n = ctl.localCount();
        promote.hidden = scope !== "node" || n === 0;
        promote.textContent = `Apply ${n} node change${n === 1 ? "" : "s"} to theme`;

        for (const fn of syncers) {
            try { fn(); } catch (e) { console.warn("[NovaPlayer] panel sync:", e); }
        }
        // Values may have been written by code (playback, reset, theme change).
        for (const r of root.querySelectorAll('input[type="range"]')) paintRange(r);
    }

    /** Rebuild only if the active renderer changed; otherwise just sync. */
    function refresh() {
        if (ctl.activeRenderer() !== builtFor) build();
        else sync();
    }

    build();

    return {
        element: root,
        // Exposed so tests can drive the same controller the UI drives, rather
        // than reaching past it into internals.
        controller: ctl,
        refresh,
        sync,
        rebuild: build,
        notify: say,
        setOpen(open) {
            root.hidden = !open;
            if (open) refresh();
        },
        get isOpen() { return !root.hidden; },
        destroy() { clearTimeout(statusTimer); root.remove(); },
    };
}
