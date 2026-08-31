/**
 * Analyzer — goniometer + phase-correlation gauge + condensed spectrum.
 *
 * Layout: circular M/S scope on the left (~38% width), gauge and spectrum on
 * the right.
 *
 * drawGoniometer() is exported because `combined` needs the same scope at a
 * smaller size. In the original that scope was written twice — once here and
 * once inline in the combined branch, each with its own auto-gain state and
 * its own frozen-frame buffers that had drifted apart. One implementation now,
 * parameterised by radius.
 */

import { clipped, drawPlaceholder } from "../core/gfx.js";
import { drawSpectrum } from "./spectrum.js";

export default {
    id: "analyzer",
    label: "ANALYZER",

    needs: { freq: true, time: true, peaks: false },

    params: {
        gonioTarget:   { type: "range", min: 0.3, max: 1,   step: 0.05, default: 0.7, label: "Scope target level" },
        gonioGainMax:  { type: "range", min: 1,   max: 8,   step: 0.5,  default: 3,   label: "Scope max boost" },
        traceAlpha:    { type: "range", min: 0.2, max: 1,   step: 0.05, default: 0.75, label: "Trace opacity" },
        needleSensitivity: {
                         type: "range", min: 0.05, max: 0.6, step: 0.05, default: 0.25, label: "Needle response" },
        corrSmoothing: { type: "range", min: 0.05, max: 0.6, step: 0.05, default: 0.2, label: "Correlation damping" },
        showGauge:     { type: "toggle", default: true, label: "Correlation gauge" },
    },

    roles: [
        "gonio.bg", "gonio.ring", "gonio.ring.outer", "gonio.border", "gonio.grid",
        "gonio.trace", "gonio.trace.glow", "gonio.trace.frozen",
        "gauge.box.bg", "gauge.box.border", "gauge.needle", "gauge.needle.tip",
        "gauge.pivot", "gauge.title", "gauge.readout.pos", "gauge.readout.neg",
        "gauge.seg.green", "gauge.seg.lime", "gauge.seg.yellow",
        "gauge.seg.orange", "gauge.seg.red", "text.dim",
    ],
    minSize: { w: 160, h: 60 },

    resize(gfx) { gfx.store.grad = null; },

    frame(gfx, rect, sig) {
        const { palette, params } = gfx;

        const gonSize = Math.min(rect.h, Math.floor(rect.w * 0.38));
        const gonR = gonSize / 2 - 4;
        const gonCX = rect.x + gonSize / 2;
        const gonCY = rect.y + rect.h / 2;

        const PAD = 14;
        const panelX = rect.x + gonSize + PAD;
        const panelW = rect.x + rect.w - panelX;

        drawGoniometer(gfx, sig, gonCX, gonCY, gonR, {
            showAxisLabels: true,
            axisTop: rect.y + (rect.h - gonSize) / 2 + 10,
            axisLeft: rect.x + 8,
            axisRight: rect.x + gonSize - 9,
        });

        if (panelW > 30 && params.showGauge !== false) {
            drawCorrelationGauge(gfx, sig, {
                x: panelX, y: rect.y, w: panelW, h: rect.h,
            });
        } else if (panelW > 30) {
            drawSpectrum(gfx, { x: panelX, y: rect.y, w: panelW, h: rect.h }, sig, false);
        }
    },

    dispose(gfx) { gfx.store.grad = null; },
};

// ---------------------------------------------------------------------------
// Goniometer
// ---------------------------------------------------------------------------

/**
 * Lissajous M/S scope.
 *
 *   X = (L - R) * scale   the Side component (stereo spread)
 *   Y = -(L + R) * scale  the Mid component  (up = in phase)
 *
 * Auto-gain tracks peak amplitude with a slow attack and a fast release so
 * quiet material still fills the scope without the trace jumping around.
 * The gain state lives in gfx.store, which means a full-size scope and a
 * combined-view scope keep independent gain — the original shared one variable
 * between them and the two fought.
 */
export function drawGoniometer(gfx, sig, cx, cy, r, opts = {}) {
    const { ctx, palette, params } = gfx;
    if (r < 6) return;

    ctx.save();

    // Background + rings
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = palette.get("gonio.bg");
    ctx.fill();

    for (let ri = 1; ri <= 3; ri++) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * (ri / 3), 0, Math.PI * 2);
        ctx.strokeStyle = ri === 3 ? palette.get("gonio.ring.outer") : palette.get("gonio.ring");
        ctx.lineWidth = ri === 3 ? 1.2 : 0.75;
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = palette.get("gonio.border");
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Grid, clipped inside the circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = palette.get("gonio.grid");
    ctx.lineWidth = 0.75;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    const dg = r * 0.707;
    ctx.moveTo(cx - dg, cy - dg); ctx.lineTo(cx + dg, cy + dg);
    ctx.moveTo(cx + dg, cy - dg); ctx.lineTo(cx - dg, cy + dg);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Axis labels, outside the clip so they are never masked
    if (opts.showAxisLabels) {
        ctx.save();
        ctx.fillStyle = palette.get("text.dim");
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("M", cx, opts.axisTop);
        ctx.fillText("L", opts.axisLeft, cy);
        ctx.fillText("R", opts.axisRight, cy);
        ctx.fillText("+S", cx - r * 0.65, cy + r * 0.67);
        ctx.fillText("-S", cx + r * 0.65, cy + r * 0.67);
        ctx.restore();
    }

    // Trace
    if (!sig.ready || !sig.hasData) {
        ctx.fillStyle = palette.get("text.dim");
        ctx.font = `italic ${r < 40 ? 7 : 9}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(r < 40 ? "PLAY" : "PLAY TO ACTIVATE", cx, cy);
        ctx.restore();
        return;
    }

    const L = sig.timeL, R = sig.timeR, n = L.length;
    const step = Math.max(1, Math.floor(n / 512));

    if (sig.playing) {
        let peakAmp = 0;
        for (let i = 0; i < n; i += step) {
            const a = Math.abs(L[i]), b = Math.abs(R[i]);
            if (a > peakAmp) peakAmp = a;
            if (b > peakAmp) peakAmp = b;
        }
        if (gfx.store.gonGain === undefined) gfx.store.gonGain = 1;
        const target = peakAmp > 0.001
            ? Math.min(params.gonioGainMax ?? 3, (params.gonioTarget ?? 0.7) / peakAmp)
            : gfx.store.gonGain;
        // Slow attack, fast release.
        gfx.store.gonGain += (target - gfx.store.gonGain) *
                             (target < gfx.store.gonGain ? 0.3 : 0.05);
    }

    const scale = r * 0.88 * (gfx.store.gonGain ?? 1);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
        const gx = cx + (L[i] - R[i]) * scale;
        const gy = cy - (L[i] + R[i]) * scale;
        i === 0 ? ctx.moveTo(gx, gy) : ctx.lineTo(gx, gy);
    }

    if (sig.playing) {
        ctx.shadowColor = palette.get("gonio.trace.glow");
        ctx.shadowBlur = r < 40 ? 4 : 6;
        ctx.strokeStyle = palette.get("gonio.trace");
        ctx.lineWidth = r < 40 ? 1 : 1.5;
        ctx.globalAlpha = params.traceAlpha ?? 0.75;
    } else {
        // Paused: the buffers still hold the last captured frame, so the same
        // path draws — just dimmed. No separate frozen snapshot needed.
        ctx.strokeStyle = palette.get("gonio.trace.frozen");
        ctx.lineWidth = r < 40 ? 1 : 1.5;
        ctx.globalAlpha = 0.5;
    }
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.restore();
}

// ---------------------------------------------------------------------------
// Correlation gauge
// ---------------------------------------------------------------------------

const ARC_SEGMENTS = [
    { from: -1.0, to: -0.6, role: "gauge.seg.green" },
    { from: -0.6, to: -0.2, role: "gauge.seg.lime" },
    { from: -0.2, to:  0.2, role: "gauge.seg.yellow" },
    { from:  0.2, to:  0.6, role: "gauge.seg.orange" },
    { from:  0.6, to:  1.0, role: "gauge.seg.red" },
];

const ARC_LABELS = [
    { v: -1,   txt: "+1",  deg: "0°" },
    { v: -0.5, txt: "+.5", deg: "45°" },
    { v:  0,   txt: "0",   deg: "90°" },
    { v:  0.5, txt: "-.5", deg: "135°" },
    { v:  1,   txt: "-1",  deg: "180°" },
];

/**
 * Semicircular Pearson-correlation gauge.
 *
 *   +1  fully in phase (effectively mono)
 *    0  uncorrelated
 *   -1  anti-phase (cancels when folded to mono)
 *
 * The axis is deliberately reversed so the "good" zone reads left, like a VU
 * meter. Needle smoothing state lives in gfx.store — it was a module-level
 * `let smoothedCorr` in the original, which meant two player nodes on the same
 * page shared one needle and fought over it.
 */
export function drawCorrelationGauge(gfx, sig, rect) {
    const { ctx, palette, params } = gfx;

    if (gfx.store.corr === undefined) gfx.store.corr = 0;
    if (gfx.store.needle === undefined) gfx.store.needle = 0;

    const alpha = params.corrSmoothing ?? 0.2;
    const target = sig.ready && sig.playing ? sig.corrRaw : gfx.store.corr;
    gfx.store.corr += (target - gfx.store.corr) * alpha;
    const corr = gfx.store.corr;

    gfx.store.needle += (corr - gfx.store.needle) * (params.needleSensitivity ?? 0.25);

    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h * 0.75;
    const r = Math.min(rect.w * 0.40, rect.h * 0.60);
    if (r < 12) return;
    const thick = Math.max(6, r * 0.22);

    // -1 -> pi (left), +1 -> 2pi (right), 0 -> 3pi/2 (top)
    const angleOf = v => Math.PI + Math.PI * (1 - (v + 1) / 2);

    ctx.save();

    // Container box, sized from the gauge geometry so it always contains the
    // arc, the outer degree labels and the readout at any node size.
    const outerR = r + thick * 0.5 + 18;
    const boxTop = cy - outerR - 10;
    const boxBottom = cy + 34;
    const boxLeft = Math.max(rect.x + 2, cx - outerR - 10);
    const boxRight = Math.min(rect.x + rect.w - 2, cx + outerR + 10);
    if (boxRight > boxLeft && boxBottom > boxTop) {
        ctx.beginPath();
        ctx.roundRect(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, 10);
        ctx.fillStyle = palette.get("gauge.box.bg");
        ctx.fill();
        ctx.strokeStyle = palette.get("gauge.box.border");
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Colour-zoned track
    ctx.lineWidth = thick;
    ctx.lineCap = "butt";
    for (const seg of ARC_SEGMENTS) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, angleOf(seg.to), angleOf(seg.from));
        ctx.strokeStyle = palette.alpha(seg.role, 0.56);
        ctx.stroke();
    }

    // Needle
    const finalAngle = Math.PI * 3 - angleOf(gfx.store.needle);
    const needleOuter = r + thick * 0.5;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.strokeStyle = palette.get("gauge.needle");
    ctx.lineWidth = 2;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(finalAngle) * needleOuter, cy + Math.sin(finalAngle) * needleOuter);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = palette.get("gauge.needle.tip");
    ctx.lineWidth = 2.5;
    ctx.shadowColor = palette.get("gauge.needle.tip");
    ctx.shadowBlur = 6;
    const tipStart = r - thick * 0.5;
    ctx.moveTo(cx + Math.cos(finalAngle) * tipStart, cy + Math.sin(finalAngle) * tipStart);
    ctx.lineTo(cx + Math.cos(finalAngle) * needleOuter, cy + Math.sin(finalAngle) * needleOuter);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = palette.get("gauge.pivot");
    ctx.fill();
    ctx.restore();

    // Tick labels
    ctx.shadowBlur = 0;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = palette.get("text.dim");
    for (const lbl of ARC_LABELS) {
        const a = angleOf(lbl.v);
        const innerR = r - thick * 0.5 - 6;
        ctx.font = "bold 8px sans-serif";
        ctx.fillText(lbl.txt, cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);

        const outer = r + thick * 0.5 + 8;
        ctx.font = "7px sans-serif";
        ctx.fillText(lbl.deg, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }

    // Title + readout
    ctx.fillStyle = palette.get("gauge.title");
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("Correlation", cx, cy - r * 0.28);

    ctx.fillStyle = corr < 0 ? palette.get("gauge.readout.neg") : palette.get("gauge.readout.pos");
    ctx.font = "bold 12px ui-monospace, monospace";
    ctx.textBaseline = "top";
    ctx.fillText(gfx.store.needle.toFixed(2), cx, cy + 8);

    ctx.restore();
}
