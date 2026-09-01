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
};

function roleLabel(role) {
    if (ROLE_LABELS[role]) return ROLE_LABELS[role];
    const parts = role.split(".");
    const tail = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
    return tail.charAt(0).toUpperCase() + tail.slice(1);
}

const STYLE_ID = "nova-player-panel-style";

function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.nova-panel {
    /* --nova-text-scale is set from the appearance preference by sync(). Font
       sizes below are multiplied by it via calc(), so the one slider moves the
       canvas type and this drawer together rather than leaving the drawer as
       the only thing still tiny on a high-resolution display. */
    --nova-text-scale: 1;
    /* The bottom offset is set from the layout by host.js so the drawer never
       covers the transport row - see the note there. */
    position: absolute; top: 0; right: 0; bottom: 0;
    box-sizing: border-box;
    display: flex; flex-direction: column;
    background: var(--nova-panel-bg);
    border-left: 1px solid var(--nova-panel-border);
    border-radius: 0 10px 0 0;
    color: var(--nova-panel-text);
    font: 11px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    backdrop-filter: blur(6px);
    z-index: 3;
    overflow: hidden;
}
.nova-panel[hidden] { display: none !important; }
/* Every element here sets an explicit display value, which outranks the UA
   rule for [hidden]. Without this, hiding the name dialog does nothing. */
.nova-panel [hidden] { display: none !important; }

/* Drag the left edge to widen. */
.nova-panel__grip {
    position: absolute; left: 0; top: 0; bottom: 0; width: 7px;
    cursor: ew-resize; z-index: 4; touch-action: none;
}
.nova-panel__grip::after {
    content: ""; position: absolute; left: 3px; top: 50%;
    width: 1px; height: 26px; margin-top: -13px;
    background: var(--nova-panel-border);
}
.nova-panel__grip:hover::after { background: var(--nova-panel-accent); }

.nova-panel__head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 10px 8px 14px;
    border-bottom: 1px solid var(--nova-panel-border);
    flex: 0 0 auto;
}
.nova-panel__title {
    font-size: calc(10px * var(--nova-text-scale)); letter-spacing: .13em; text-transform: uppercase;
    color: var(--nova-panel-dim); margin: 0; white-space: nowrap;
}
/* flex: 0 1 auto, not 0 0 auto. The theme block grows with every row added to
   it, and at 0 0 it grew without bound: on a short node it pushed the section
   accordion down behind the footer until the sections could not be clicked at
   all. Capping it and letting it scroll keeps the sections reachable at any
   node height, and means the next row added here cannot resurrect this. */
.nova-panel__theme {
    flex: 0 1 auto; padding: 8px 10px 9px 14px;
    max-height: 46%;
    overflow-y: auto; overflow-x: hidden;
    border-bottom: 1px solid var(--nova-panel-border);
    display: grid; gap: 6px;
}
.nova-panel__theme::-webkit-scrollbar { width: 8px; }
.nova-panel__theme::-webkit-scrollbar-thumb {
    background: var(--nova-panel-border); border-radius: 4px;
}
.nova-panel__themerow { display: grid; grid-template-columns: 1fr auto auto; gap: 5px; }

/* Scope switch: where an edit lands. */
.nova-scope { display: grid; grid-template-columns: auto 1fr 1fr; gap: 4px; align-items: center; }
.nova-scope__label {
    font-size: calc(10px * var(--nova-text-scale)); letter-spacing: .06em; text-transform: uppercase;
    color: var(--nova-panel-dim); padding-right: 2px;
}
.nova-scope button {
    padding: 3px 6px; border-radius: 4px; cursor: pointer; font: inherit; font-size: calc(10px * var(--nova-text-scale));
    background: transparent; color: var(--nova-panel-dim);
    border: 1px solid var(--nova-panel-border);
}
.nova-scope button[aria-pressed="true"] {
    background: var(--nova-panel-accent); border-color: transparent; color: #fff;
}
.nova-panel__promote { width: 100%; }

/* A row whose value this node is overriding, rather than taking from the theme. */
.nova-row--local > label { position: relative; }
.nova-row--local > label::before {
    content: ""; position: absolute; left: -9px; top: 50%;
    width: 2px; height: 13px; margin-top: -7px; border-radius: 1px;
    background: var(--nova-panel-accent);
}
.nova-row--local > label { font-weight: 600; }

/* min-height: 0 is load-bearing. A flex child will not shrink below its content
   size without it, so the body would refuse to scroll and overflow the drawer
   instead — the same failure the theme block above had. */
.nova-panel__body { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-height: 0; }
.nova-panel__body::-webkit-scrollbar { width: 8px; }
.nova-panel__body::-webkit-scrollbar-thumb {
    background: var(--nova-panel-border); border-radius: 4px;
}
.nova-panel details { border-bottom: 1px solid var(--nova-panel-border); }
.nova-panel summary {
    /* Sticky so you can always see which section you are editing, however far
       down the chrome list you have scrolled. */
    position: sticky; top: 0; z-index: 1;
    background: var(--nova-panel-surface);
    cursor: pointer; padding: 8px 10px 8px 14px; list-style: none;
    font-size: calc(10px * var(--nova-text-scale)); letter-spacing: .1em; text-transform: uppercase;
    color: var(--nova-panel-dim); user-select: none; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}
.nova-panel summary::-webkit-details-marker { display: none; }
.nova-panel summary::before { content: "\\25B8 "; display: inline-block; width: 11px; }
.nova-panel details[open] > summary::before { content: "\\25BE "; }
.nova-panel details[open] > summary { color: var(--nova-panel-text); }
.nova-panel summary:hover { color: var(--nova-panel-text); }
.nova-panel__group { padding: 2px 10px 10px 14px; display: grid; gap: 7px; }

.nova-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
.nova-row > label {
    color: var(--nova-panel-text); min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nova-row__value {
    color: var(--nova-panel-dim); font-variant-numeric: tabular-nums;
    font-size: calc(10px * var(--nova-text-scale)); min-width: 32px; text-align: right;
}
.nova-row__wide { grid-column: 1 / -1; }

.nova-color { display: grid; grid-template-columns: 52px 24px; gap: 6px; align-items: center; }
.nova-color input[type="color"] {
    width: 24px; height: 19px; padding: 0; border: 1px solid var(--nova-panel-border);
    border-radius: 4px; background: none; cursor: pointer;
}
.nova-color input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
.nova-color input[type="color"]::-webkit-color-swatch { border: none; border-radius: 2px; }

.nova-panel input[type="range"] {
    width: 100%; height: 14px; accent-color: var(--nova-panel-accent);
    background: none; cursor: pointer; margin: 0;
}
.nova-panel input[type="checkbox"] { accent-color: var(--nova-panel-accent); cursor: pointer; }
.nova-panel select, .nova-panel input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    background: var(--nova-panel-surface); color: var(--nova-panel-text);
    border: 1px solid var(--nova-panel-border); border-radius: 4px;
    font: inherit;
}
.nova-btn {
    padding: 4px 8px; border-radius: 4px; cursor: pointer; font: inherit;
    background: var(--nova-panel-surface); color: var(--nova-panel-text);
    border: 1px solid var(--nova-panel-border); white-space: nowrap;
}
.nova-btn:hover { border-color: var(--nova-panel-accent); }
.nova-btn:disabled { opacity: .45; cursor: default; }
.nova-btn--primary { background: var(--nova-panel-accent); border-color: transparent; color: #fff; }
.nova-btn--icon { padding: 2px 7px; line-height: 1.2; font-size: calc(13px * var(--nova-text-scale)); }
.nova-panel__dialog { display: grid; grid-template-columns: 1fr auto auto; gap: 5px; }
.nova-panel__foot {
    flex: 0 0 auto; padding: 6px 10px 8px 14px;
    border-top: 1px solid var(--nova-panel-border);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.nova-panel__status {
    font-size: calc(10px * var(--nova-text-scale)); color: var(--nova-panel-dim); min-height: 13px;
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nova-panel__foot .nova-btn { flex: 0 0 auto; }
.nova-panel__status[data-tone="error"] { color: #ff8f8f; }
.nova-panel__status[data-tone="ok"] { color: #8fe0b4; }
.nova-panel :focus-visible { outline: 2px solid var(--nova-panel-accent); outline-offset: 1px; }
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
    const tipWide = el("div", "nova-row__wide");
    tipWide.appendChild(tipBox);
    tipRow.append(tipLabel, tipWide);

    themeBlock.append(select, themeRow, dialog, scopeRow, textRow, reliefRow,
                      tipRow, promote);
    root.appendChild(themeBlock);

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

        const own = (renderer.roles || []).filter(r => !CHROME_ROLES.includes(r));
        if (own.length) {
            const g = section("colours", `${renderer.label} · colours`);
            for (const role of own) g.appendChild(colorRow(role));
        }

        const chrome = section("chrome", "Player chrome · colours");
        for (const role of CHROME_ROLES) chrome.appendChild(colorRow(role));

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
        root.style.width = (ctl.getPanelWidth() || 248) + "px";
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
