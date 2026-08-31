/**
 * lr_correlation.js — Phase and Stereo Image Correlation Meter
 * Built using the application framework template.
 */

import { clipped, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";

export default {
    id: "lr_correlation",
    label: "L/R CORRELATION",

    // Needs time domain data or explicit engine phase properties
    needs: { freq: false, time: true, peaks: false },

    params: {
        smoothing: { type: "range", min: 0.05, max: 0.95, step: 0.05, default: 0.2, label: "Smoothing" },
    },

    roles: ["text.dim", "phase.in", "phase.out", "phase.center"],
    ramps: [],

    minSize: { w: 80, h: 40 },

    resize(gfx) {
        gfx.store.smoothCorr = 0;
        gfx.store.lastNow = undefined;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "L/R CORRELATION"], palette.get("text.dim"));
            return;
        }

        clipped(ctx, rect, () => {
            // Pull the raw stereo correlation indicator (-1 to +1) from the engine
            const rawCorr = sig.corrRaw ?? 0;

            // Time-based, so the needle settles at the same rate whatever the
            // refresh rate. `smoothing` is the fraction retained per 1/60 s.
            const dt = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
            store.lastNow = gfx.now;
            const alpha = smoothingAlpha(1 - (params.smoothing ?? 0.2),
                                         dt > 0 && dt < 0.5 ? dt : 1 / 60);
            store.smoothCorr = (store.smoothCorr ?? 0) + (rawCorr - (store.smoothCorr ?? 0)) * alpha;

            const centerY = rect.y + (rect.h / 2);
            const midX = rect.x + (rect.w / 2);
            const halfW = (rect.w - 20) / 2;

            // Map -1 to +1 range onto screen dimensions
            const targetX = midX + (store.smoothCorr * halfW);

            // Draw Reference Grid Line (-1, 0, +1 markers)
            ctx.strokeStyle = palette.get("phase.center");
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(midX, rect.y + 5);
            ctx.lineTo(midX, rect.y + rect.h - 5);
            ctx.stroke();

            // Draw Active Correlation Indicator Bar
            if (store.smoothCorr >= 0) {
                ctx.fillStyle = palette.get("phase.in");
                ctx.fillRect(midX, centerY - 6, targetX - midX, 12);
            } else {
                ctx.fillStyle = palette.get("phase.out");
                ctx.fillRect(targetX, centerY - 6, midX - targetX, 12);
            }

            // Text scale decorations
            ctx.fillStyle = palette.get("text.dim");
            ctx.font = "10px sans-serif";
            ctx.fillText("-1", rect.x + 5, centerY + 4);
            ctx.fillText("+1", rect.x + rect.w - 18, centerY + 4);
            ctx.fillText(store.smoothCorr.toFixed(3), midX - 12, rect.y + rect.h - 4);
        });
    },

    hit(pt, rect) { return null; },
    dispose(gfx) { gfx.store.lastNow = undefined; }
};