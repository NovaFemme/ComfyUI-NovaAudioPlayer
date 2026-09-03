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

import { clipped, drawBar, drawPlaceholder } from "../core/gfx.js";

// Contiguous, full coverage: the first edge is DC and the last is Nyquist, so
// every bin above the floor lands in exactly one band and the shares are true
// fractions of total energy. Edit an edge and the neighbouring band follows.
// MUST match nova_player/audio_io.BAND_EDGES_HZ — dev/tests/test_bench.py
// asserts the two are identical. 20 Hz rather than 0: bin 0 is DC and a
// window smears an offset into the bins beside it, which lands in the one
// band hardest to check by ear.
const BAND_EDGES_HZ = [20, 250, 2000, 6000, Infinity];
const BANDS = [
    { label: "BASS", role: "band.bass",     hint: "20 – 250 Hz" },
    { label: "MID",  role: "band.mid",      hint: "250 Hz – 2 kHz" },
    { label: "PRES", role: "band.presence", hint: "2 kHz – 6 kHz" },
    { label: "HF",   role: "band.hf",       hint: "6 kHz and above" },
];

/**
 * Band shares from one frame of true-dBFS bins.
 *
 * Exported so a test can drive it with a REAL AnalyserNode's output and check
 * the numbers, rather than reading pixels or trusting a second copy of the
 * arithmetic. `dev/tests/freqtest.mjs` does exactly that.
 *
 * @returns {{pct: (number|null)[], hfOutliers: number, total: number}}
 */
export function bandShares(freqDb, binCount, sampleRate, floorDb = -85,
                           outlierDb = -60) {
    const hzPerBin = sampleRate / (binCount * 2);
    const sums = new Float64Array(BAND_EDGES_HZ.length - 1);
    let total = 0, hfOutliers = 0;

    // From bin 1. Bin 0 is DC, and this take carries a DC offset of 0.0017
    // that would otherwise be counted as musical bass in the one band already
    // under suspicion. compute_bench drops it too; the two paths have to agree
    // about what they are measuring, not merely about the arithmetic.
    for (let i = 1; i < binCount; i++) {
        const hz = i * hzPerBin;
        // Below the first edge is DC and infrasonics: outside every band, so
        // it must be outside the total as well or the shares stop adding to
        // 100.
        if (hz < BAND_EDGES_HZ[0]) continue;

        const db = freqDb[i];          // TRUE dBFS, unclamped
        if (!(db > floorDb)) continue; // also rejects -Infinity and NaN

        // Power. 10^(dB/10), not 20 — a share of energy is a ratio of powers,
        // and compute_bench sums |FFT|^2 for the same reason.
        const energy = Math.pow(10, db / 10);
        total += energy;

        for (let b = 0; b < sums.length; b++) {
            if (hz >= BAND_EDGES_HZ[b] && hz < BAND_EDGES_HZ[b + 1]) {
                sums[b] += energy;
                if (b === sums.length - 1 && hz > 16000 && db > outlierDb) hfOutliers++;
                break;
            }
        }
    }

    // Nothing above the floor yet. `null` says that; 0.0% would claim the band
    // was measured and found empty.
    // Array.from on both branches: `sums.map()` returns another Float64Array,
    // which cannot hold null — it would silently give four zeros, which is the
    // exact claim this is trying not to make.
    const pct = total > 0
        ? Array.from(sums, v => (v / total) * 100)
        : Array.from(sums, () => null);
    return { pct, hfOutliers, total };
}

export default {
    id: "freq_percentages",
    label: "FREQ %",

    // freqDb, NOT freq. THE BUG THIS FIXES: the byte array from
    // getByteFrequencyData is a LEVEL — minDecibels..maxDecibels mapped onto
    // 0-255 — so `(byte/255)^2` squares a decibel scale and calls the result
    // energy. It is not energy in any domain.
    //
    // What that did to the numbers, on one of NovaFemme's takes: this panel
    // read BASS 5.0 / MID 28.3 / PRES 34.3 / HF 32.4 while the bench strip,
    // measuring the same file in true power, read 43.9 / 39.8 / 13.5 / 2.8.
    // Both totalled 100 and both were internally consistent, which is what
    // made it survive: the error is monotonic in frequency, and nothing on
    // screen contradicted itself.
    //
    // The mechanism is bin count. At 4096/48k there are 22 bins below 250 Hz
    // and 1536 above 6 kHz. A bin sitting at the noise floor still returns a
    // byte around 20-40 rather than 0, and 1536 of those outweigh 22 loud bass
    // bins on population alone. In true power a floor bin contributes ~1e-9 of
    // a loud one and cannot.
    needs: { freq: true, freqDb: true, time: false, peaks: false },

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
            const freqDb = sig.freqDb;
            const binCount = sig.binCount ?? (freqDb ? freqDb.length : 0);
            const sampleRate = sig.sampleRate ?? 44100;

            if (!freqDb || !binCount) {
                drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "FREQ BANDS %"],
                                palette.get("text.dim"));
                return;
            }

            const outlierDb = params.outlierDb ?? -60;
            const { pct: shares, hfOutliers } = bandShares(
                freqDb, binCount, sampleRate, params.floorDb ?? -85, outlierDb);

            const rowH = rect.h / (BANDS.length + 1);
            const labelW = 46;
            const pctW = 44;
            const barW = Math.max(10, rect.w - labelW - pctW - 10);

            ctx.font = "10px sans-serif";
            ctx.textBaseline = "alphabetic";

            BANDS.forEach((band, idx) => {
                const pct = shares[idx];
                const curY = rect.y + idx * rowH;
                const textY = curY + rowH / 2 + 3;

                ctx.fillStyle = palette.get("text.dim");
                ctx.textAlign = "left";
                ctx.fillText(band.label, rect.x + 5, textY);

                // Track, so an empty band still reads as a band.
                drawBar(ctx, rect.x + labelW, curY + 4, barW, rowH - 8,
                        palette.get("grid.line"), { vertical: false });
                if (pct !== null) {
                    drawBar(ctx, rect.x + labelW, curY + 4, (pct / 100) * barW, rowH - 8,
                            palette.get(band.role), { vertical: false });
                }

                ctx.fillStyle = palette.get("text.dim");
                ctx.textAlign = "right";
                ctx.fillText(pct === null ? "—" : `${pct.toFixed(1)}%`,
                             rect.x + rect.w - 6, textY);

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
                `% OF TOTAL ENERGY · THIS FRAME, NOT THE TAKE   ·   ` +
                `HF OUTLIERS >${outlierDb}dB: ${hfOutliers}`,
                rect.x + 5, finalY + rowH / 2 + 3,
            );
        });
    },

    hit(pt, rect) { return null; },
    dispose(gfx) {}
};
