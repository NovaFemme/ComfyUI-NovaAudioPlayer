/**
 * Spectrum — Mel-scale frequency curve with a gradient fill and a neon rim.
 *
 * Exported as both a standalone view ("SPECTRUM") and a drawable other
 * renderers can call: `analyzer` uses it for its right-hand panel and
 * `combined` for its bottom-left quadrant. In the original this curve existed
 * as a closure inside draw() that all three branches reached into — same idea,
 * but now it is a module with an interface, so it can be tuned in one place.
 */

import { clipped, drawPlaceholder } from "../core/gfx.js";

export default {
    id: "eq",
    label: "SPECTRUM",

    needs: { freq: true, time: false, peaks: false },

    params: {
        gain:       { type: "range", min: 0.2, max: 4,  step: 0.05, default: 1.0, label: "Intensity" },
        noiseFloor: { type: "range", min: 0,   max: 30, step: 1,    default: 2,   label: "Noise floor" },
        usableBinFraction: {
                      type: "range", min: 0.3, max: 1,  step: 0.05, default: 0.75, label: "Bandwidth" },
        rimWidth:   { type: "range", min: 0,   max: 5,  step: 0.5,  default: 2,   label: "Rim width" },
        glow:       { type: "range", min: 0,   max: 16, step: 1,    default: 4,   label: "Rim glow" },
        showLabels: { type: "toggle", default: true, label: "Frequency labels" },
    },

    roles: [
        "spectrum.fill.low", "spectrum.fill.high", "spectrum.rim", "spectrum.rim.glow",
        "spectrum.label.bg", "spectrum.label.rule", "spectrum.label.text", "text.dim",
    ],
    minSize: { w: 60, h: 30 },

    resize(gfx) { gfx.store.grad = null; },

    frame(gfx, rect, sig) {
        drawSpectrum(gfx, rect, sig, gfx.params.showLabels !== false);
    },

    dispose(gfx) { gfx.store.grad = null; },
};

/**
 * Paint the spectrum curve into `rect`.
 *
 * @param {boolean} showLabels  frequency strip along the bottom edge
 */
export function drawSpectrum(gfx, rect, sig, showLabels) {
    const { ctx, palette, params } = gfx;
    const { x, y, w, h } = rect;
    if (w < 4 || h < 4) return;

    const bottom = y + h;

    if (!sig.ready || !sig.hasData) {
        drawPlaceholder(ctx, rect,
            ["SPECTRUM ACTIVE DURING PLAYBACK", "ACTIVE DURING PLAYBACK",
             "PLAY TO ACTIVATE", "PLAY ▶"],
            palette.get("text.dim"));
        return;
    }

    ctx.save();

    // -- Mel-scale mapping --------------------------------------------------
    // Mel spacing gives low frequencies — where hearing has the most
    // resolution — proportionally more horizontal room than a linear axis.
    const binCount = Math.max(2, Math.floor(sig.binCount * (params.usableBinFraction ?? 0.75)));
    const hzPerBin = (sig.sampleRate / 2) / sig.binCount;
    const melOf = hz => 2595 * Math.log10(1 + hz / 700);
    const melMin = melOf(20);
    const melRange = melOf(binCount * hzPerBin) - melMin;
    const fracToBin = frac => (700 * (Math.pow(10, (melMin + frac * melRange) / 2595) - 1)) / hzPerBin;

    const freq = sig.freq;
    const floor = params.noiseFloor ?? 2;
    const gain = params.gain ?? 1;
    const plotPoints = Math.max(2, Math.ceil(w));

    ctx.beginPath();
    ctx.moveTo(x, bottom);

    for (let p = 0; p < plotPoints; p++) {
        const binStart = fracToBin(p / plotPoints);
        const binEnd = fracToBin((p + 1) / plotPoints);
        const widthInBins = binEnd - binStart;
        let val;

        if (widthInBins <= 1.2) {
            // Narrow: interpolate between the flanking bins for a smooth curve.
            const idx = Math.floor(binStart);
            const weight = binStart - idx;
            val = idx >= binCount - 1
                ? freq[binCount - 1]
                : freq[idx] * (1 - weight) + freq[idx + 1] * weight;
        } else {
            // Wide: average the covered bins so band energy is represented
            // honestly rather than aliasing to whichever bin we happened to hit.
            let sum = 0, count = 0;
            for (let b = Math.floor(binStart); b <= Math.ceil(binEnd); b++) {
                if (b < binCount) { sum += freq[b]; count++; }
            }
            val = count > 0 ? sum / count : 0;
        }

        val = Math.max(0, (val - floor) * gain);
        const px = x + (p / Math.max(1, plotPoints - 1)) * w;
        const py = bottom - Math.min(1, val / 255) * h;
        ctx.lineTo(px, py);
    }

    ctx.lineTo(x + w, bottom);
    ctx.closePath();

    // -- fill ---------------------------------------------------------------
    // Cached per (top, bottom, theme): a gradient object is tied to its
    // coordinates, so it only needs rebuilding when the rect or palette moves.
    const gradKey = `${y}|${bottom}|${palette.name}`;
    let grad = gfx.store.grad;
    if (!grad || grad.key !== gradKey) {
        const g = ctx.createLinearGradient(0, bottom, 0, y);
        g.addColorStop(0, palette.get("spectrum.fill.low"));
        g.addColorStop(1, palette.get("spectrum.fill.high"));
        grad = { key: gradKey, grad: g };
        gfx.store.grad = grad;
    }
    ctx.fillStyle = grad.grad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // -- neon rim -----------------------------------------------------------
    const rim = params.rimWidth ?? 2;
    if (rim > 0) {
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowBlur = params.glow ?? 4;
        ctx.shadowColor = palette.get("spectrum.rim.glow");
        ctx.strokeStyle = palette.get("spectrum.rim");
        ctx.lineWidth = rim;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // -- frequency reference strip -----------------------------------------
    if (showLabels && h > 40) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.get("spectrum.label.bg");
        ctx.fillRect(x, bottom - 18, w, 18);
        ctx.strokeStyle = palette.get("spectrum.label.rule");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, bottom - 18);
        ctx.lineTo(x + w, bottom - 18);
        ctx.stroke();

        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = palette.get("spectrum.label.text");

        // Positions are derived from the Mel mapping rather than the hand-tuned
        // fractions the original used, so they stay correct if the bandwidth
        // parameter changes the axis.
        for (const hz of [60, 1000, 5000, 15000]) {
            const maxHz = binCount * hzPerBin;
            if (hz > maxHz) continue;
            const frac = (melOf(hz) - melMin) / melRange;
            if (frac < 0 || frac > 1) continue;
            const label = hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`;
            ctx.fillText(label, x + Math.max(16, Math.min(w - 16, frac * w)), bottom - 9);
        }
        ctx.restore();
    }

    ctx.restore();
}
