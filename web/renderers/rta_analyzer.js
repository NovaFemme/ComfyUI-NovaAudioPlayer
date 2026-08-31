/**
 * rta_analyzer.js
 * Real-Time Analyzer (RTA) view mode.
 * Filters and aggregates frequency spectrum bins into fractional 1/3 octave bands.
 */

import { byteToNorm, clipped, drawBar, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";

// ISO standard 1/3 octave center frequencies between 20Hz and 20kHz
const ISO_1_3_BANDS = [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
    1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

export default {
    id: "rta_analyzer",
    label: "RTA 1/3 OCTAVE",

    needs: { freq: true, time: false, peaks: false },

    params: {
        // Fraction of the previous value retained per 1/60 s: higher = slower
        // ballistics. Applied through smoothingAlpha() so the response is the
        // same on a 60 Hz and a 144 Hz display.
        smoothing: { type: "range", min: 0.05, max: 0.95, step: 0.05, default: 0.5, label: "Smoothing" },
        weighting: { type: "toggle", default: false, label: "A-Weighting" },
    },

    roles: ["text.dim", "spectrum.fill", "spectrum.rim", "grid.line"],
    ramps: [],

    minSize: { w: 100, h: 60 },

    resize(gfx) {
        gfx.store.bandLevels = null;
        gfx.store.lastNow = undefined;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData || !sig.freq) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "RTA ACTIVE ▶"], palette.get("text.dim"));
            return;
        }

        const numBands = ISO_1_3_BANDS.length;
        const binCount = sig.binCount || sig.freq.length;
        const sampleRate = sig.sampleRate || 44100;
        const nyquist = sampleRate / 2;

        // Initialize smoothing store arrays
        if (!store.bandLevels || store.bandLevels.length !== numBands) {
            store.bandLevels = new Float32Array(numBands).fill(0);
        }

        // A-weighting approximation filter helper function
        const getAWeighting = (f) => {
            const f2 = f * f;
            const f4 = f2 * f2;
            const r1 = (12194 * 12194 * f4) / ((f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194));
            return 2.0 + 20 * Math.log10(r1);
        };

        // Time-based smoothing coefficient for this frame.
        const dt = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
        store.lastNow = gfx.now;
        const alpha = smoothingAlpha(params.smoothing ?? 0.5,
                                     dt > 0 && dt < 0.5 ? dt : 1 / 60);

        // Aggregate raw spectrum bins into fractional octave bands
        for (let b = 0; b < numBands; b++) {
            const centerF = ISO_1_3_BANDS[b];
            // 1/3 octave band boundaries calculation
            const lowerF = centerF / Math.pow(2, 1/6);
            const upperF = centerF * Math.pow(2, 1/6);

            const startBin = Math.max(0, Math.floor((lowerF / nyquist) * binCount));
            const endBin = Math.min(binCount - 1, Math.ceil((upperF / nyquist) * binCount));

            let sumEnergy = 0;
            let binsInBand = 0;

            for (let bin = startBin; bin <= endBin; bin++) {
                // NORMALISE FIRST. sig.freq holds bytes (0-255), not amplitudes:
                // squaring the raw byte and taking 20*log10 of the result gives
                // 0..+48 dB, which is above any sensible ceiling, so every band
                // clamped to full height and the meter read as a solid block.
                const v = byteToNorm(sig.freq[bin] || 0);
                sumEnergy += v * v;
                binsInBand++;
            }

            const avgLinear = binsInBand > 0 ? Math.sqrt(sumEnergy / binsInBand) : 0;
            const db = 20 * Math.log10(Math.max(avgLinear, 1e-6));

            if (params.weighting) {
                db += getAWeighting(centerF);
            }

            // Map dB range (-90dB to 0dB) into a normalized 0.0 - 1.0 window value
            let normLevel = (db + 90) / 90;
            if (normLevel < 0) normLevel = 0;
            if (normLevel > 1) normLevel = 1;

            // Apply ballistics response smoothing parameters
            store.bandLevels[b] += (normLevel - store.bandLevels[b]) * alpha;
        }

        // Draw structural bar blocks inside frame context
        clipped(ctx, rect, () => {
            // 31 bands in a narrow node leaves sub-pixel bars; drop the
            // spacing before the bars themselves disappear.
            const barSpacing = rect.w / numBands >= 4 ? 2 : 0;
            const totalSpacing = barSpacing * (numBands - 1);
            const barWidth = Math.max(1, (rect.w - totalSpacing) / numBands);

            // Decade grid, so the bars can be read against something.
            ctx.strokeStyle = palette.get("grid.line");
            ctx.lineWidth = 1;
            for (const f of [100, 1000, 10000]) {
                let nearest = 0;
                for (let b = 1; b < numBands; b++) {
                    if (Math.abs(ISO_1_3_BANDS[b] - f) < Math.abs(ISO_1_3_BANDS[nearest] - f)) nearest = b;
                }
                const gx = rect.x + nearest * (barWidth + barSpacing) + barWidth / 2;
                ctx.beginPath();
                ctx.moveTo(gx, rect.y);
                ctx.lineTo(gx, rect.y + rect.h);
                ctx.stroke();
            }

            const fill = palette.get("spectrum.fill");

            for (let b = 0; b < numBands; b++) {
                const barHeight = store.bandLevels[b] * rect.h;
                const bx = rect.x + b * (barWidth + barSpacing);
                const by = rect.y + rect.h - barHeight;

                if (barHeight > 1) {
                    // vertical: true so the relief runs left-to-right across
                    // the column, not top-to-bottom along its length.
                    drawBar(ctx, bx, by, barWidth, barHeight, fill, { vertical: true });
                }
            }
        });
    },

    hit(pt, rect) {
        return null;
    },

    dispose(gfx) {
        gfx.store.bandLevels = null;
        gfx.store.lastNow = undefined;
    }
};
