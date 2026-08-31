/**
 * _template.js — copy this to add a view mode.
 *
 * Three steps, total:
 *   1. cp _template.js myview.js  and fill it in
 *   2. import it in registry.js
 *   3. add it to the RENDERERS array
 *
 * Everything else is derived: the view button's label and width, its pill
 * colour (add a "mode.myview" role to your theme), the settings panel section
 * for your params, which analyser data the engine bothers to compute, and the
 * minimum size clamp.
 *
 * This file is NOT imported by registry.js — it is a reference, not a mode.
 */

import {
    byteToDb, byteToNorm, clipped, dbToNorm, drawPlaceholder, smoothingAlpha,
} from "../core/gfx.js";

export default {
    // Identity ------------------------------------------------------------
    id: "myview",              // also the params key and the "mode.myview" role
    label: "MY VIEW",          // shown on the pill; width is measured, not guessed

    // What the audio engine must produce for you. Ask for nothing you do not
    // read — the engine skips the work.
    needs: { freq: true, time: false, peaks: false },

    // Parameters. This IS the settings-panel schema; there is no second list.
    //   type: "range"  -> min, max, step, default
    //   type: "toggle" -> default
    params: {
        gain: { type: "range", min: 0.2, max: 4, step: 0.05, default: 1, label: "Intensity" },
        showGrid: { type: "toggle", default: true, label: "Grid" },
    },

    // Colour roles you read. Listing them groups them in the panel and lets
    // the role-coverage check catch a typo before a user sees magenta.
    roles: ["text.dim", "spectrum.rim"],
    ramps: [],                 // named ramps you read via palette.ramp(name)

    // Below this the host does not call frame() at all.
    minSize: { w: 60, h: 40 },

    // Lifecycle -----------------------------------------------------------

    /** Optional. Invalidate any offscreen buffer you keep in gfx.store. */
    resize(gfx) {
        gfx.store.buffer = null;
    },

    /**
     * Draw one frame.
     *
     * @param {object} gfx   { ctx, palette, params, store, peaks, stereo, layout, phase }
     * @param {object} rect  { x, y, w, h } — draw only inside this
     * @param {object} sig   the shared signal bag from audio-engine.js:
     *                       ready, hasData, playing, freq, timeL, timeR,
     *                       levelL, levelR, peakHold, clip, corrRaw,
     *                       sampleRate, binCount, fftSize,
     *                       currentTime, progress, duration
     *
     * TWO TRAPS, both of which fail quietly rather than loudly:
     *
     * 1. `sig.freq` is Uint8Array BYTES (0-255) from getByteFrequencyData —
     *    not decibels, not a linear magnitude. `20 * Math.log10(byte)` gives
     *    0..+48, above any sensible ceiling, so the view pins to full scale and
     *    looks alive while showing nothing. Use byteToDb() or byteToNorm().
     *    `sig.peakHold` is likewise a single NUMBER, not { L, R }.
     *
     * 2. Anything that moves or smooths must be driven by `gfx.now` (wall-clock
     *    ms), not by "one step per frame" — otherwise it runs at whatever rate
     *    the monitor happens to be. smoothingAlpha(factor, dt) gives a
     *    frame-rate independent coefficient.
     */
    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "PLAY ▶"],
                            palette.get("text.dim"));
            return;
        }

        // Frame-rate independent smoothing (see trap 2 above).
        const dt = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
        store.lastNow = gfx.now;
        const alpha = smoothingAlpha(0.8, dt > 0 && dt < 0.5 ? dt : 1 / 60);
        store.level = (store.level ?? 0) + ((sig.levelL ?? 0) - (store.level ?? 0)) * alpha;

        clipped(ctx, rect, () => {
            // Never write a colour literal here — ask the palette for a role.
            // Every role you use must exist in the theme, or palette.get()
            // returns magenta and warns; add it to nova_player/defaults.py.
            ctx.fillStyle = palette.get("spectrum.rim");
            const h = Math.min(rect.h, store.level * rect.h * (params.gain ?? 1));
            ctx.fillRect(rect.x, rect.y + rect.h - h, rect.w, h);

            // Reading the spectrum? Convert the bytes first:
            //   const db  = byteToDb(sig.freq[i]);     // -100..-30 dB
            //   const mag = byteToNorm(sig.freq[i]);   // 0..1
            //   const y   = dbToNorm(db, -90, 0);      // 0..1, clamped
        });
    },

    /** Optional. Return { action: "seek", fraction } to make the view scrub. */
    hit(pt, rect) {
        return null;
    },

    /** Optional. Release anything you allocated in gfx.store. */
    dispose(gfx) {
        gfx.store.buffer = null;
        gfx.store.lastNow = undefined;
    },
};
