/**
 * Spectrogram — rolling psychoacoustic heatmap.
 *
 * X = time (scrolling left), Y = frequency (log-scaled, bass at the bottom).
 *
 * The performance trick from the original is preserved: an offscreen canvas
 * acts as a rolling buffer that is shifted left and given a new column, rather
 * than the whole field being repainted.
 *
 * Two things did change.
 *
 *   1. The LUT comes from the theme's `spectrogram` ramp instead of a hardcoded
 *      module constant, so it can be re-themed live.
 *   2. The scroll advances on WALL-CLOCK time, not one column per frame. The
 *      original moved a fixed number of pixels per paint, which made the X axis
 *      "one column per refresh" — the same audio scrolled roughly 2.4x faster
 *      on a 144 Hz monitor than on a 60 Hz one, and changed speed whenever the
 *      frame rate dipped. `scrollSpeed` is now pixels per second, so a second
 *      of audio occupies the same width everywhere, and timeSpan() can answer
 *      how much audio is on screen.
 */

import { clipped, drawPlaceholder, offscreen } from "../core/gfx.js";

export default {
    id: "spectrogram",
    label: "SPECTROGRAM",

    needs: { freq: true, time: false, peaks: false },

    params: {
        gain:        { type: "range", min: 0.2, max: 4,   step: 0.05, default: 1.0, label: "Intensity" },
        noiseFloor:  { type: "range", min: 0,   max: 40,  step: 1,    default: 4,   label: "Noise floor" },
        usableBinFraction: {
                       type: "range", min: 0.3, max: 1,   step: 0.05, default: 0.75, label: "Bandwidth" },
        // Pixels per SECOND, not per frame — see the scroll block in frame().
        scrollSpeed: { type: "range", min: 10, max: 240, step: 5, default: 60, label: "Scroll px/sec" },
        showFreqTicks: { type: "toggle", default: true, label: "Frequency ticks" },
    },

    roles: ["spectrogram.bg", "spectrogram.grid", "spectrogram.label", "text.dim"],
    ramps: ["spectrogram"],
    minSize: { w: 60, h: 40 },

    resize(gfx) {
        // Dropping the buffer forces a clean reallocation at the new size.
        // The old code invalidated this from inside draw() by comparing two
        // remembered numbers; the host now tells us instead.
        gfx.store.buffer = null;
    },

    /**
     * Seconds of audio currently visible, given the rect width.
     * Only meaningful because the scroll is time-based; with the old
     * per-frame advance there was no answer to this question.
     */
    timeSpan(rect, params) {
        return rect.w / Math.max(1, params.scrollSpeed ?? 60);
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params } = gfx;
        const x = Math.round(rect.x), y = Math.round(rect.y);
        const w = Math.round(rect.w), h = Math.round(rect.h);
        if (w < 4 || h < 4) return;

        const buf = gfx.store.buffer;

        // Never played: nothing to show but an invitation.
        if (!sig.ready || !sig.hasData) {
            if (buf) {
                clipped(ctx, rect, () => ctx.drawImage(buf.canvas, x, y));
            } else {
                drawPlaceholder(ctx, rect,
                    ["SPECTROGRAM ACTIVE DURING PLAYBACK", "ACTIVE DURING PLAYBACK",
                     "PLAY TO ACTIVATE", "PLAY ▶"],
                    palette.get("text.dim"));
            }
            return;
        }

        // Paused: freeze the last field rather than scrolling black into it.
        // Clearing lastNow means resuming restarts the clock instead of
        // scrolling the whole pause duration in one frame.
        if (!sig.playing) {
            if (buf) {
                buf.lastNow = undefined;
                clipped(ctx, rect, () => ctx.drawImage(buf.canvas, x, y));
            }
            return;
        }

        // -- allocate / reallocate the rolling buffer ----------------------
        let store = gfx.store.buffer;
        if (!store || store.w !== w || store.h !== h) {
            store = offscreen(gfx.store, "buffer", w, h, { willReadFrequently: true });
            store.ctx.fillStyle = palette.get("spectrogram.bg");
            store.ctx.fillRect(0, 0, w, h);
            store.column = store.ctx.createImageData(1, h);
            gfx.store.buffer = store;
        }
        if (!store.column || store.column.height !== h) {
            store.column = store.ctx.createImageData(1, h);
        }

        // -- log-frequency mapping -----------------------------------------
        const binCount = sig.binCount;
        const usable = Math.max(2, Math.floor(binCount * (params.usableBinFraction ?? 0.75)));
        const nyquist = sig.sampleRate / 2;
        const hzPerBin = nyquist / binCount;
        const fMin = Math.max(20, hzPerBin);
        const fMax = usable * hzPerBin;
        const logFMin = Math.log2(fMin);
        const logRange = Math.log2(fMax) - logFMin;

        const lut = palette.ramp("spectrogram");
        const freq = sig.freq;
        const px = store.column.data;
        const floor = params.noiseFloor ?? 4;
        const gain = params.gain ?? 1;
        const denom = Math.max(1, h - 1);

        for (let row = 0; row < h; row++) {
            // row 0 is the top = highest frequency.
            const logFrac = 1 - row / denom;
            const hz = Math.pow(2, logFMin + logFrac * logRange);
            const binF = hz / hzPerBin;
            const b0 = Math.floor(binF);
            const t = binF - b0;

            let amp = b0 >= usable - 1
                ? freq[usable - 1]
                : freq[b0] * (1 - t) + freq[b0 + 1] * t;

            amp = Math.max(0, (amp - floor) * gain);

            const vi = Math.min(255, Math.round(amp)) * 3;
            const base = row * 4;
            px[base]     = lut[vi];
            px[base + 1] = lut[vi + 1];
            px[base + 2] = lut[vi + 2];
            px[base + 3] = 255;
        }

        // -- roll left, append the new column(s) ---------------------------
        //
        // Advance by WALL-CLOCK time, not one column per frame. The original
        // shifted a fixed number of pixels every time it was painted, so the
        // time axis was really "one column per refresh": the same audio
        // scrolled 2.4x faster on a 144 Hz monitor than on a 60 Hz one, and
        // sped up or slowed down whenever the frame rate moved. Now a second of
        // audio is a fixed number of pixels on every machine.
        const pxPerSecond = Math.max(1, params.scrollSpeed ?? 60);
        const last = store.lastNow;
        store.lastNow = gfx.now;

        // First frame after a pause, a tab switch or a resize has no usable
        // delta — draw one column and start the clock rather than jumping.
        let dt = last === undefined ? 0 : (gfx.now - last) / 1000;
        if (!(dt >= 0) || dt > 0.5) dt = 0;          // NaN, clock jump, or long stall

        store.debt = (store.debt || 0) + (last === undefined ? 1 : dt * pxPerSecond);

        let cols = Math.floor(store.debt);
        if (cols > 0) {
            store.debt -= cols;
            cols = Math.min(cols, w);                // never scroll past a full field
            store.ctx.drawImage(store.canvas, -cols, 0);
            for (let s = 0; s < cols; s++) {
                store.ctx.putImageData(store.column, w - 1 - s, 0);
            }
        }

        // -- blit + frequency ticks ----------------------------------------
        clipped(ctx, rect, () => {
            ctx.drawImage(store.canvas, x, y);
            if (params.showFreqTicks === false) return;

            ctx.font = "bold 8px sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            const gridColor = palette.get("spectrogram.grid");
            const labelColor = palette.get("spectrogram.label");

            for (const tick of [100, 500, 1000, 5000, 10000, 20000]) {
                if (tick < fMin || tick > fMax) continue;
                const frac = (Math.log2(tick) - logFMin) / logRange;
                const ty = y + h - frac * h;
                ctx.fillStyle = gridColor;
                ctx.fillRect(x, Math.round(ty) - 0.5, w, 1);
                ctx.fillStyle = labelColor;
                ctx.fillText(tick >= 1000 ? `${tick / 1000}k` : `${tick}`, x + w - 3, ty);
            }
        });
    },

    dispose(gfx) {
        gfx.store.buffer = null;
    },
};
