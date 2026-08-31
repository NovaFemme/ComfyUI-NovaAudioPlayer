/**
 * combined_suite.js — Comprehensive Master Audio Metering Dashboard
 * Built using the application framework template.
 */

import { byteToDb, byteToNorm, clipped, drawBar, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";

export default {
    id: "combined_suite",
    label: "MASTER SUITE",

    // Demands complete suite calculation pathways from the engine
    needs: { freq: true, time: true, peaks: true },

    params: {
        showDetails: { type: "toggle", default: true, label: "Detailed Text" }
    },

    roles: [
        "text.dim", "level.rms", "level.peak", "level.bg",
        "phase.in", "phase.out", "phase.center",
        "band.bass", "band.mid", "band.presence", "band.hf"
    ],
    ramps: [],

    minSize: { w: 180, h: 120 },

    resize(gfx) {
        gfx.store.smoothCorr = 0;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "MASTER SUITE"], palette.get("text.dim"));
            return;
        }

        clipped(ctx, rect, () => {
            // Split window space cleanly into 3 targeted zones
            const zoneH = rect.h / 3;

            // SECTION 1: PEAK & RMS METERS
            const y1 = rect.y + 4;
            const wMax = rect.w - 20;
            const curL = sig.levelL ?? 0;
            const curR = sig.levelR ?? 0;

            const meterH = (zoneH / 2) - 4;
            const trackC = palette.get("level.bg");
            const rmsC = palette.get("level.rms");
            drawBar(ctx, rect.x + 10, y1, wMax, meterH, trackC, { vertical: false });
            drawBar(ctx, rect.x + 10, y1 + (zoneH / 2), wMax, meterH, trackC, { vertical: false });
            drawBar(ctx, rect.x + 10, y1, curL * wMax, meterH, rmsC, { vertical: false });
            drawBar(ctx, rect.x + 10, y1 + (zoneH / 2), curR * wMax, meterH, rmsC, { vertical: false });

            // SECTION 2: L/R STEREO CORRELATION METER
            const y2 = rect.y + zoneH;
            const midX = rect.x + (rect.w / 2);
            const halfW = (rect.w - 40) / 2;
            const rawCorr = sig.corrRaw ?? 0;
            const dt = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
            store.lastNow = gfx.now;
            const alpha = smoothingAlpha(0.8, dt > 0 && dt < 0.5 ? dt : 1 / 60);
            store.smoothCorr = (store.smoothCorr ?? 0) + (rawCorr - (store.smoothCorr ?? 0)) * alpha;
            const targetX = midX + (store.smoothCorr * halfW);

            ctx.strokeStyle = palette.get("phase.center");
            ctx.beginPath();
            ctx.moveTo(midX, y2 + 2);
            ctx.lineTo(midX, y2 + zoneH - 2);
            ctx.stroke();

            if (store.smoothCorr >= 0) {
                ctx.fillStyle = palette.get("phase.in");
                ctx.fillRect(midX, y2 + (zoneH / 2) - 4, targetX - midX, 8);
            } else {
                ctx.fillStyle = palette.get("phase.out");
                ctx.fillRect(targetX, y2 + (zoneH / 2) - 4, midX - targetX, 8);
            }

            // SECTION 3: FREQUENCY BAND POWER SPLITS
            const y3 = rect.y + (zoneH * 2);
            if (sig.freq) {
                const freqArray = sig.freq;
                const binCount = sig.binCount ?? freqArray.length;
                const sampleRate = sig.sampleRate ?? 44100;
                const hzPerBin = sampleRate / (binCount * 2);

                // Same maths as freq_percentages, and the same contiguous
                // edges, so the stacked bar here and the rows there agree:
                // bytes converted before thresholding, energy accumulated, and
                // bands that tile the spectrum so the stack really is 100%.
                let bSum = 0, mSum = 0, pSum = 0, hSum = 0;
                for (let i = 0; i < binCount; i++) {
                    const hz = i * hzPerBin;
                    if (byteToDb(freqArray[i]) <= -85) continue;
                    const v = byteToNorm(freqArray[i]);
                    const energy = v * v;

                    if (hz < 250) bSum += energy;
                    else if (hz < 2000) mSum += energy;
                    else if (hz < 6000) pSum += energy;
                    else hSum += energy;
                }

                const total = bSum + mSum + pSum + hSum || 1;
                const bPct = bSum / total;
                const mPct = mSum / total;
                const pPct = pSum / total;
                const hPct = hSum / total;

                // Stacked, so only the outer ends are rounded — rounding every
                // segment would leave gaps down the middle of a solid bar.
                const microW = rect.w - 20;
                const segs = [
                    [bPct, "band.bass"], [mPct, "band.mid"],
                    [pPct, "band.presence"], [hPct, "band.hf"],
                ];
                let sx = rect.x + 10;
                for (const [pct, role] of segs) {
                    const segW = pct * microW;
                    if (segW <= 0) continue;
                    drawBar(ctx, sx, y3 + 4, segW, 6, palette.get(role),
                            { vertical: false, radius: 1.5 });
                    sx += segW;
                }
            }

            // Interactive Text Readout HUD
            if (params.showDetails) {
                ctx.fillStyle = palette.get("text.dim");
                ctx.font = "9px monospace";
                const dbL = 20 * Math.log10(Math.max(curL, 0.0001));
                ctx.fillText(`P/R: ${dbL.toFixed(1)}dB | Corr: ${store.smoothCorr.toFixed(2)}`, rect.x + 10, y3 + 18);
            }
        });
    },

    hit(pt, rect) { return null; },
    dispose(gfx) {}
};