/**
 * fft_analyzer.js
 * Spectrum Analyzer (Fast Fourier Transform - FFT) view mode.
 * Plots high-resolution frequency magnitudes (dBFS) across the human hearing range.
 */

import { byteToNorm, clipped, drawPlaceholder } from "../core/gfx.js";

export default {
    id: "fft_analyzer",
    label: "FFT SPECTRUM",

    // Requests frequency data array from the audio engine
    needs: { freq: true, time: false, peaks: false },

    params: {
        gain: { type: "range", min: 0.2, max: 4, step: 0.05, default: 1, label: "Intensity" },
        // Positive tilt lifts the top end relative to 1 kHz. It is ADDED in
        // dB below the 0 dB ceiling, so a large tilt pushes the whole upper
        // half into the ceiling and flattens the trace — default off, turn it
        // up deliberately.
        tilt: { type: "range", min: 0, max: 6, step: 0.5, default: 0, label: "Tilt (dB/Oct)" },
        floor: { type: "range", min: -120, max: -40, step: 5, default: -90, label: "Floor (dB)" },
        showGrid: { type: "toggle", default: true, label: "Grid" },
    },

    roles: ["text.dim", "spectrum.rim", "spectrum.fill", "grid.line"],
    ramps: [],

    minSize: { w: 120, h: 80 },

    resize(gfx) {
        gfx.store.peaksArray = null;
        gfx.store.lastNow = undefined;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData || !sig.freq) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "FFT ANALYZER ▶"], palette.get("text.dim"));
            return;
        }

        clipped(ctx, rect, () => {
            // Clear background implicitly or rely on container. Draw grid if enabled.
            if (params.showGrid) {
                ctx.strokeStyle = palette.get("grid.line");
                ctx.lineWidth = 1;
                // Draw simple reference lines at 100Hz, 1kHz, 10kHz
                const frequencies = [100, 1000, 10000];
                frequencies.forEach(f => {
                    const logF = Math.log10(f);
                    const logMin = Math.log10(20);
                    const logMax = Math.log10(sig.sampleRate / 2 || 22050);
                    const pct = (logF - logMin) / (logMax - logMin);
                    if (pct >= 0 && pct <= 1) {
                        const gx = rect.x + pct * rect.w;
                        ctx.beginPath();
                        ctx.moveTo(gx, rect.y);
                        ctx.lineTo(gx, rect.y + rect.h);
                        ctx.stroke();
                    }
                });
            }

            const binCount = sig.binCount || sig.freq.length;
            const sampleRate = sig.sampleRate || 44100;
            const nyquist = sampleRate / 2;
            const minFreq = 20;
            const maxFreq = nyquist;
            const logMin = Math.log10(minFreq);
            const logMax = Math.log10(maxFreq);

            const floorDb = params.floor ?? -90;
            const ceilDb = 0;
            const dbRange = ceilDb - floorDb;

            // Initialize peak array if needed. Width is floored: a typed array
            // length must be an integer, and rect.w is not guaranteed to be one.
            const cols = Math.max(1, Math.floor(rect.w));
            if (!store.peaksArray || store.peaksArray.length !== cols) {
                store.peaksArray = new Float32Array(cols).fill(floorDb);
            }

            // Peak decay in dB per SECOND, not per frame — the original dropped
            // a fixed 0.2 dB every paint, so the hold line fell more than twice
            // as fast on a 144 Hz display as on a 60 Hz one.
            const dt = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
            store.lastNow = gfx.now;
            const decay = 12 * (dt > 0 && dt < 0.5 ? dt : 1 / 60);   // 12 dB/s

            ctx.beginPath();
            ctx.strokeStyle = palette.get("spectrum.rim");
            ctx.lineWidth = 2;

            for (let x = 0; x < cols; x++) {
                // Map horizontal pixel to logarithmic frequency
                const pct = x / cols;
                const targetFreq = Math.pow(10, logMin + pct * (logMax - logMin));
                
                // Find nearest bin in FFT array
                const binIndex = Math.min(binCount - 1, Math.max(0, Math.floor((targetFreq / nyquist) * binCount)));
                
                // sig.freq holds BYTES (0-255), not a linear magnitude. Taking
                // 20*log10 of the byte directly produced 0..+48 dB, every value
                // of which is above the 0 dB ceiling below — so the trace was a
                // flat line pinned to the top of the window. Normalise first,
                // and apply gain to the magnitude rather than to the decibels.
                const mag = byteToNorm(sig.freq[binIndex] || 0) * (params.gain ?? 1);
                let db = 20 * Math.log10(Math.max(mag, 1e-6));

                // Apply perceptual tilt adjustment (e.g., 3dB per octave relative to 1kHz reference)
                if (params.tilt > 0) {
                    const octavesFromRef = Math.log2(targetFreq / 1000);
                    db += octavesFromRef * params.tilt;
                }

                // Clamp to window boundaries
                if (db > ceilDb) db = ceilDb;
                if (db < floorDb) db = floorDb;

                // Peak tracking
                if (db > store.peaksArray[x]) {
                    store.peaksArray[x] = db;
                } else {
                    store.peaksArray[x] -= decay;
                    if (store.peaksArray[x] < floorDb) store.peaksArray[x] = floorDb;
                }

                // Calculate Y coordinates
                const yPct = (db - floorDb) / dbRange;
                const gy = rect.y + rect.h - (yPct * rect.h);

                if (x === 0) {
                    ctx.moveTo(rect.x + x, gy);
                } else {
                    ctx.lineTo(rect.x + x, gy);
                }
            }
            ctx.stroke();

            // Draw peak hold line
            ctx.beginPath();
            ctx.strokeStyle = palette.get("text.dim");
            ctx.lineWidth = 1;
            for (let x = 0; x < cols; x++) {
                const yPct = (store.peaksArray[x] - floorDb) / dbRange;
                const gy = rect.y + rect.h - (yPct * rect.h);
                if (x === 0) {
                    ctx.moveTo(rect.x + x, gy);
                } else {
                    ctx.lineTo(rect.x + x, gy);
                }
            }
            ctx.stroke();
        });
    },

    hit(pt, rect) {
        return null;
    },

    dispose(gfx) {
        gfx.store.peaksArray = null;
        gfx.store.lastNow = undefined;
    }
};
