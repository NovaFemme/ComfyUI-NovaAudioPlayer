/**
 * peak_rms.js — Peak and RMS Level Visualizer
 * Built using the application framework template.
 */

import { clipped, drawBar, drawPlaceholder } from "../core/gfx.js";

export default {
    id: "peak_rms",
    label: "PEAK & RMS",

    // levelL/levelR are derived from the TIME domain, so that is what to ask
    // for. `peaks` means the pre-computed waveform peak file, which this view
    // never touches.
    needs: { freq: false, time: true, peaks: false },

    params: {
        peakHoldTime: { type: "range", min: 0.5, max: 5, step: 0.5, default: 2, label: "Peak Hold (s)" },
        showLabels: { type: "toggle", default: true, label: "Show dB Values" },
    },

    roles: ["text.dim", "level.rms", "level.peak", "level.bg"],
    ramps: [],

    minSize: { w: 100, h: 60 },

    resize(gfx) {
        gfx.store.peakHoldL = 0;
        gfx.store.peakHoldR = 0;
        gfx.store.timerL = 0;
        gfx.store.timerR = 0;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "PEAK & RMS"], palette.get("text.dim"));
            return;
        }

        clipped(ctx, rect, () => {
            const padding = 10;
            const barHeight = (rect.h - (padding * 3)) / 2;
            
            // Calculate coordinates for Left and Right channels
            const yL = rect.y + padding;
            const yR = yL + barHeight + padding;
            const wMax = rect.w - (padding * 2);

            // Compute current linear levels from signals
            const curL = sig.levelL ?? 0;
            const curR = sig.levelR ?? 0;

            // sig.peakHold is a single NUMBER (the loudest of both channels),
            // not { L, R } — so `sig.peakHold?.L` was always undefined and the
            // hold marker simply tracked the live level. Hold per channel here.
            //
            // The clock is gfx.now (wall time), not sig.currentTime (playback
            // position): using the latter froze the hold while paused and made
            // it jump when you scrubbed.
            const nowSec = gfx.now / 1000;
            const holdFor = params.peakHoldTime ?? 2;

            const hold = (cur, held, timer) => {
                if (cur >= held) return { held: cur, timer: nowSec };
                if (nowSec - timer > holdFor) {
                    // Fall towards the current level rather than snapping, so
                    // the marker reads as a decaying peak and not a flicker.
                    return { held: Math.max(cur, held - (nowSec - timer - holdFor) * 0.6), timer };
                }
                return { held, timer };
            };

            const L = hold(curL, store.peakHoldL ?? 0, store.timerL ?? nowSec);
            store.peakHoldL = L.held; store.timerL = L.timer;
            const R = hold(curR, store.peakHoldR ?? 0, store.timerR ?? nowSec);
            store.peakHoldR = R.held; store.timerR = R.timer;

            // Draw Backgrounds. Tracks get the same rounding as the fills, so
            // a fill sits in a matching well rather than in a square hole.
            const trackColor = palette.get("level.bg");
            drawBar(ctx, rect.x + padding, yL, wMax, barHeight, trackColor, { vertical: false });
            drawBar(ctx, rect.x + padding, yR, wMax, barHeight, trackColor, { vertical: false });

            // Draw RMS Levels
            const rmsColor = palette.get("level.rms");
            drawBar(ctx, rect.x + padding, yL, curL * wMax, barHeight, rmsColor, { vertical: false });
            drawBar(ctx, rect.x + padding, yR, curR * wMax, barHeight, rmsColor, { vertical: false });

            // Draw Peak Hold Marks
            ctx.fillStyle = palette.get("level.peak");
            const xHoldL = rect.x + padding + ((store.peakHoldL ?? 0) * wMax);
            const xHoldR = rect.x + padding + ((store.peakHoldR ?? 0) * wMax);
            const maxX = rect.x + padding + wMax - 2;
            ctx.fillRect(Math.min(xHoldL, maxX), yL, 2, barHeight);
            ctx.fillRect(Math.min(xHoldR, maxX), yR, 2, barHeight);

            // Text overlay displaying decibel calculations
            if (params.showLabels) {
                ctx.fillStyle = palette.get("text.dim");
                ctx.font = "10px sans-serif";
                
                const dbL = 20 * Math.log10(Math.max(curL, 0.0001));
                const dbR = 20 * Math.log10(Math.max(curR, 0.0001));
                
                ctx.fillText(`L: ${dbL.toFixed(2)} dBFS`, rect.x + padding + 5, yL + (barHeight / 2) + 4);
                ctx.fillText(`R: ${dbR.toFixed(2)} dBFS`, rect.x + padding + 5, yR + (barHeight / 2) + 4);
            }
        });
    },

    hit(pt, rect) { return null; },
    dispose(gfx) {}
};