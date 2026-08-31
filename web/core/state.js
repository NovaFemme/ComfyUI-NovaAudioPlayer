/**
 * state.js — the serialised widget value.
 *
 * This is what ComfyUI saves into the workflow JSON, so its size matters: a
 * workflow with twenty player nodes should not carry twenty copies of a
 * resolved 76-role palette.  The rule enforced here is DELTAS ONLY — a node
 * stores the theme's *name* plus whatever it changed, and nothing else.
 *
 * Shape:
 *   {
 *     viewMode:  "combined",
 *     volume:    0.8,
 *     muted:     false,
 *     looping:   false,
 *     theme:     "nova-dark" | null,   // null = follow the server's active theme
 *     panelOpen: false,
 *     panelWidth: 248,                // px, set by dragging the panel edge
 *     openSection: "settings",        // which accordion section was last open
 *     colorScope: "node",             // where panel edits land: "node" | "theme"
 *     overrides: {
 *       roles:     { "wave.left": "#00e5ff" },
 *       renderers: { spectrogram: { gain: 1.6 } }
 *     }
 *   }
 *
 * Legacy formats still in the wild:
 *   - a bare string   -> just the viewMode
 *   - { viewMode, volume, muted } with no theme/overrides
 * Both are migrated by normalise() rather than crashing the widget.
 */

import { parse, toCss } from "./color.js";

export const DEFAULT_STATE = Object.freeze({
    viewMode: "waveform",
    volume: 1,
    muted: false,
    looping: false,
    theme: null,
    panelOpen: false,
    panelWidth: 248,
    benchOpen: false,
    benchHeight: 152,
    openSection: "settings",
    colorScope: "node",
    overrides: { roles: {}, renderers: {} },
});

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * Coerce any saved value — legacy or current — into the current shape.
 * Never throws; an unrecognised value yields the defaults.
 */
export function normalise(value, validModes = null) {
    const out = {
        viewMode: DEFAULT_STATE.viewMode,
        volume: DEFAULT_STATE.volume,
        muted: DEFAULT_STATE.muted,
        looping: DEFAULT_STATE.looping,
        benchOpen: DEFAULT_STATE.benchOpen,
        benchHeight: DEFAULT_STATE.benchHeight,
        theme: null,
        panelOpen: false,
        panelWidth: DEFAULT_STATE.panelWidth,
        openSection: DEFAULT_STATE.openSection,
        colorScope: DEFAULT_STATE.colorScope,
        overrides: { roles: {}, renderers: {} },
    };

    if (typeof value === "string") {
        // Legacy: the whole value was just the view mode name.
        out.viewMode = value;
    } else if (value && typeof value === "object") {
        if (typeof value.viewMode === "string") out.viewMode = value.viewMode;
        if (typeof value.volume === "number" && Number.isFinite(value.volume)) {
            out.volume = clamp01(value.volume);
        }
        if (typeof value.muted === "boolean") out.muted = value.muted;
        if (typeof value.looping === "boolean") out.looping = value.looping;
        if (typeof value.theme === "string" && value.theme) out.theme = value.theme;
        if (typeof value.panelOpen === "boolean") out.panelOpen = value.panelOpen;
        if (typeof value.panelWidth === "number" && Number.isFinite(value.panelWidth)) {
            out.panelWidth = Math.max(200, Math.min(640, value.panelWidth));
        }
        if (typeof value.openSection === "string") out.openSection = value.openSection;
        if (value.colorScope === "node" || value.colorScope === "theme") {
            out.colorScope = value.colorScope;
        }

        const ov = value.overrides;
        if (ov && typeof ov === "object") {
            if (ov.roles && typeof ov.roles === "object") {
                for (const [k, v] of Object.entries(ov.roles)) {
                    if (typeof v === "string") out.overrides.roles[k] = v;
                }
            }
            if (ov.renderers && typeof ov.renderers === "object") {
                for (const [id, params] of Object.entries(ov.renderers)) {
                    if (params && typeof params === "object") {
                        const clean = {};
                        for (const [k, v] of Object.entries(params)) {
                            const t = typeof v;
                            if (t === "number" || t === "boolean" || t === "string") clean[k] = v;
                        }
                        if (Object.keys(clean).length) out.overrides.renderers[id] = clean;
                    }
                }
            }
        }
    }

    // A view mode saved by an older build (or a renderer that has since been
    // removed) must not leave the node with nothing to draw.
    if (validModes && validModes.length && !validModes.includes(out.viewMode)) {
        out.viewMode = validModes.includes(DEFAULT_STATE.viewMode)
            ? DEFAULT_STATE.viewMode
            : validModes[0];
    }

    return out;
}

/**
 * Drop overrides that merely restate what the theme or server already says.
 *
 * Called before every save.  Without it, a settings panel that writes back
 * every control on every change would grow the workflow JSON by the full
 * palette the first time anyone touches a slider.
 *
 * @param {object} state     normalised state
 * @param {object} palette   palette resolved WITHOUT this node's overrides
 * @param {function} serverParams  (rendererId) => the server's param values
 */
export function prune(state, basePalette, serverParams) {
    const roles = {};
    for (const [role, value] of Object.entries(state.overrides.roles || {})) {
        // Compare *resolved* CSS, not raw strings: "#6c63ff" and
        // "rgb(108,99,255)" are the same colour, and storing either as an
        // override when the theme already says it is pure workflow bloat.
        const themeCss = basePalette && basePalette.roles ? basePalette.roles[role] : undefined;
        const parsed = parse(value);
        const valueCss = parsed ? toCss(parsed) : null;
        if (valueCss === null) continue;          // unparseable — never store it
        if (themeCss !== valueCss) roles[role] = value;
    }

    const renderers = {};
    for (const [id, params] of Object.entries(state.overrides.renderers || {})) {
        const base = (serverParams && serverParams(id)) || {};
        const diff = {};
        for (const [k, v] of Object.entries(params)) {
            if (base[k] !== v) diff[k] = v;
        }
        if (Object.keys(diff).length) renderers[id] = diff;
    }

    return {
        viewMode: state.viewMode,
        volume: state.volume,
        muted: state.muted,
        looping: state.looping,
        theme: state.theme,
        panelOpen: state.panelOpen,
        panelWidth: state.panelWidth,
        openSection: state.openSection,
        colorScope: state.colorScope,
        overrides: { roles, renderers },
    };
}
