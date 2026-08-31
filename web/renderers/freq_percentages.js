/**
 * freq_percentages.js — Frequency Energy Band Distribution Analytics
 *
 * Shows how the programme's energy is split across the spectrum.
 *
 * The bands TILE the whole audible range rather than sampling four disjoint
 * windows. The original measured 60-250, 500-2k, 4-6k and >16k, which left
 * 0-60, 250-500, 2-4k and 6-16k — most of the spectrum, and most of the energy
 * — uncounted, then presented the result as percentages. Those percentages were
 * shares of an arbitrary subset, so they moved when the gaps did and never
 * described the mix. Contiguous edges mean the four figures are genuine shares
 * of total energy and always account for 100% of what is playing.
 */

import { byteToDb, byteToNorm, clipped, drawBar, drawPlaceholder } from "../core/gfx.js";

// Contiguous, full coverage: the first edge is DC and the last is Nyquist, so
// every bin above the floor lands in exactly one band and the shares are true
// fractions of total energy. Edit an edge and the neighbouring band follows.
const BAND_EDGES_HZ = [0, 250, 2000, 6000, Infinity];
const BANDS = [
    { label: "BASS", role: "band.bass",     hint: "below 250 Hz" },
    { label: "MID",  role: "band.mid",      hint: "250 Hz – 2 kHz" },
    { label: "PRES", role: "band.presence", hint: "2 kHz – 6 kHz" },
    { label: "HF",   role: "band.hf",       hint: "6 kHz and above" },
];

export default {
    id: "freq_percentages",
    label: "FREQ %",

    // Must read frequency bins from audio engine
    needs: { freq: true, time: false, peaks: false },

    params: {
        floorDb:   { type: "range", min: -100, max: -40, step: 5, default: -85, label: "Floor (dB)" },
        outlierDb: { type: "range", min: -90, max: -35, step: 5, default: -60, label: "HF outlier above (dB)" },
        showHints: { type: "toggle", default: true, label: "Show band ranges" },
    },

    roles: ["text.dim", "band.bass", "band.mid", "band.presence", "band.hf", "grid.line"],
    ramps: [],

    minSize: { w: 120, h: 60 },

    resize(gfx) {},

    frame(gfx, rect, sig) {
        const { ctx, palette, params } = gfx;

        if (!sig.ready || !sig.hasData || !sig.freq) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "FREQ BANDS %"], palette.get("text.dim"));
            return;
        }

        clipped(ctx, rect, () => {
            const freqArray = sig.freq;
            const binCount = sig.binCount ?? freqArray.length;
            const sampleRate = sig.sampleRate ?? 44100;
            const hzPerBin = sampleRate / (binCount * 2);

            const floor = params.floorDb ?? -85;
            const outlierDb = params.outlierDb ?? -60;

            const sums = new Float64Array(BANDS.length);
            let total = 0;
            let hfOutliers = 0;

            for (let i = 0; i < binCount; i++) {
                // freqArray holds BYTES (0-255) from getByteFrequencyData, not
                // decibels — convert before comparing against a dB floor.
                const db = byteToDb(freqArray[i]);
                if (db <= floor) continue;

                // Energy, not amplitude: shares only add up correctly this way.
                const v = byteToNorm(freqArray[i]);
                const energy = v * v;
                total += energy;

                const hz = i * hzPerBin;
                // Contiguous edges: find the band this bin falls in. Every bin
                // above the floor lands in exactly one, so nothing is dropped.
                for (let b = 0; b < BANDS.length; b++) {
                    if (hz >= BAND_EDGES_HZ[b] && hz < BAND_EDGES_HZ[b + 1]) {
                        sums[b] += energy;
                        if (b === BANDS.length - 1 && hz > 16000 && db > outlierDb) hfOutliers++;
                        break;
                    }
                }
            }

            const denom = total || 1;
            const rowH = rect.h / (BANDS.length + 1);
            const labelW = 46;
            const pctW = 44;
            const barW = Math.max(10, rect.w - labelW - pctW - 10);

            ctx.font = "10px sans-serif";
            ctx.textBaseline = "alphabetic";

            BANDS.forEach((band, idx) => {
                const pct = (sums[idx] / denom) * 100;
                const curY = rect.y + idx * rowH;
                const textY = curY + rowH / 2 + 3;

                ctx.fillStyle = palette.get("text.dim");
                ctx.textAlign = "left";
                ctx.fillText(band.label, rect.x + 5, textY);

                // Track, so an empty band still reads as a band.
                drawBar(ctx, rect.x + labelW, curY + 4, barW, rowH - 8,
                        palette.get("grid.line"), { vertical: false });
                drawBar(ctx, rect.x + labelW, curY + 4, (pct / 100) * barW, rowH - 8,
                        palette.get(band.role), { vertical: false });

                ctx.fillStyle = palette.get("text.dim");
                ctx.textAlign = "right";
                ctx.fillText(`${pct.toFixed(1)}%`, rect.x + rect.w - 6, textY);

                // Range hint sits at the far end of the track, where the fill
                // does not reach, rather than on top of the coloured bar.
                if (params.showHints !== false && rowH > 18 && barW > 190) {
                    ctx.textAlign = "right";
                    ctx.fillText(band.hint, rect.x + labelW + barW - 6, textY);
                }
            });

            // Footer: the shares are of total energy, so say so, and report the
            // HF outlier count against the threshold it actually used.
            const finalY = rect.y + BANDS.length * rowH;
            ctx.fillStyle = palette.get("text.dim");
            ctx.textAlign = "left";
            ctx.fillText(
                `% OF TOTAL ENERGY   ·   HF OUTLIERS >${outlierDb}dB: ${hfOutliers}`,
                rect.x + 5, finalY + rowH / 2 + 3,
            );
        });
    },

    hit(pt, rect) { return null; },
    dispose(gfx) {}
};
