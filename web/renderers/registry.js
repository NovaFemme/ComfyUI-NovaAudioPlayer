/**
 * registry.js — the single list of renderers.
 *
 * This file is the reason adding a view mode is now one file plus one import.
 * Everything that used to be hand-maintained in a different part of draw() is
 * derived from this array instead:
 *
 *   - the order the view button cycles through      (was VIEW_MODES)
 *   - the button's label                            (was a 5-branch ternary)
 *   - the button's width                            (was two separate literals
 *                                                    at lines 2733 and 2819
 *                                                    that had to agree)
 *   - the pill's colour                             (was a switch statement)
 *   - which analyser data the engine must produce   (was always all of it)
 *   - the settings panel's sections                 (did not exist)
 *
 * To add a mode: write the module, import it here, add it to RENDERERS.
 */

import waveform from "./waveform.js";
import spectrum from "./spectrum.js";
import analyzer from "./analyzer.js";
import spectrogram from "./spectrogram.js";
import combined from "./combined.js";

// Import the 7 new custom audio visualizer modules
import peak_rms from "./peak_rms.js";
import lr_correlation from "./lr_correlation.js";
import freq_percentages from "./freq_percentages.js";
import combined_suite from "./combined_suite.js";
import fft_analyzer from "./fft_analyzer.js";
import rta_analyzer from "./rta_analyzer.js";
import projected_guidance from "./projected_guidance.js";

/** Cycle order of the view button. */
export const RENDERERS = [
    waveform, 
    spectrum, 
    analyzer, 
    spectrogram, 
    combined,
    peak_rms,
    lr_correlation,
    freq_percentages,
    combined_suite,
    fft_analyzer,
    rta_analyzer,
    projected_guidance
];

export const RENDERER_IDS = RENDERERS.map(r => r.id);

const BY_ID = new Map(RENDERERS.map(r => [r.id, r]));

export function getRenderer(id) {
    return BY_ID.get(id) || RENDERERS[0];
}

export function nextRendererId(id) {
    const i = RENDERER_IDS.indexOf(id);
    return RENDERER_IDS[(i + 1) % RENDERER_IDS.length];
}

/** Default values pulled from a renderer's param schema. */
export function defaultParams(id) {
    const r = BY_ID.get(id);
    if (!r || !r.params) return {};
    const out = {};
    for (const [key, spec] of Object.entries(r.params)) out[key] = spec.default;
    return out;
}

/** Every param schema, for the settings panel. */
export function paramSchema(id) {
    const r = BY_ID.get(id);
    return (r && r.params) || {};
}

/** Colour role for a mode's pill — themes name them "mode.<id>". */
export function modeRole(id) {
    return `mode.${id}`;
}

/**
 * Width of the view pill, measured rather than guessed.
 * The original hardcoded 74 or 90 depending on the mode, in two places; a
 * sixth mode with a longer label would simply have been clipped.
 */
export function measurePillWidth(ctx, id) {
    const r = getRenderer(id);
    ctx.save();
    ctx.font = "bold 8px sans-serif";
    const w = ctx.measureText(r.label).width;
    ctx.restore();
    return Math.max(64, Math.ceil(w) + 24);
}

/** Union of the analyser data the active renderer requires. */
export function needsOf(id) {
    const r = getRenderer(id);
    return r.needs || { freq: true, time: true, peaks: true };
}

/** Every colour role any renderer declares — used to group the panel. */
export function rolesByRenderer() {
    const out = {};
    for (const r of RENDERERS) out[r.id] = r.roles || [];
    return out;
}
