/**
 * Combined — a composite view. It owns a layout, not any drawing.
 *
 *   +----------------------------+----------+
 *   |  waveform                  | spectro- |
 *   +--------------+-------------+ gram     |
 *   |  spectrum    | goniometer  |          |
 *   +--------------+-------------+----------+
 *
 * This is the renderer that most justifies the refactor. The original combined
 * branch was ~340 lines that re-implemented the waveform bar loop, the
 * goniometer and the spectrogram rolling buffer inline, with their own caches,
 * their own auto-gain state and their own frozen-frame snapshots. A fix to the
 * spectrum had to be made twice; the two spectrogram implementations had
 * already drifted (one showed six frequency ticks, the other five).
 *
 * Here it computes four rects and calls the same modules the full-size views
 * use. Each child gets its own store slot via gfx.child(), so a combined-view
 * spectrogram and a full-size one keep independent rolling buffers without
 * either knowing the other exists.
 */

import waveform, { drawPlayhead } from "./waveform.js";
import spectrum from "./spectrum.js";
import spectrogram from "./spectrogram.js";
import { drawGoniometer } from "./analyzer.js";

export default {
    id: "combined",
    label: "COMBINED",

    // The union of what its children need.
    needs: { freq: true, time: true, peaks: true },

    params: {
        waveformSplit:    { type: "range", min: 0.3, max: 0.8,  step: 0.05, default: 0.55, label: "Waveform height" },
        spectrogramWidth: { type: "range", min: 0.1, max: 0.5,  step: 0.02, default: 0.28, label: "Spectrogram width" },
        spectrumWidth:    { type: "range", min: 0.2, max: 0.8,  step: 0.02, default: 0.52, label: "Spectrum width" },
        showDividers:     { type: "toggle", default: true, label: "Panel dividers" },
    },

    roles: ["divider"],
    minSize: { w: 260, h: 90 },

    /** Divide `rect` into the four panels. Pure — also used by hit(). */
    panels(rect, params) {
        const gap = 6;
        const splitY = rect.y + Math.round(rect.h * (params.waveformSplit ?? 0.55));
        const specW = Math.round(rect.w * (params.spectrogramWidth ?? 0.28));
        const mainW = rect.w - specW - gap;
        const botH = rect.y + rect.h - splitY - 2;
        const eqW = Math.round(mainW * (params.spectrumWidth ?? 0.52));
        const gonW = mainW - eqW - gap;

        return {
            gap,
            waveform:    { x: rect.x, y: rect.y, w: mainW, h: splitY - rect.y },
            spectrum:    { x: rect.x, y: splitY + 2, w: eqW, h: botH },
            goniometer:  { x: rect.x + eqW + gap, y: splitY + 2, w: gonW, h: botH },
            spectrogram: { x: rect.x + mainW + gap, y: rect.y, w: specW, h: rect.h },
            splitY, mainW, eqW, gonW, specW, botH,
        };
    },

    resize(gfx) {
        // Propagate to the children so their caches invalidate too, otherwise
        // a resize leaves the combined waveform blitting a stale buffer.
        for (const [id, child] of Object.entries(childGfxMap(gfx))) {
            const mod = CHILDREN[id];
            if (mod && mod.resize) mod.resize(child);
        }
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params } = gfx;
        const p = this.panels(rect, params);

        // -- waveform (top) ------------------------------------------------
        if (p.waveform.w > 8 && p.waveform.h > 8) {
            const child = gfx.child("waveform", gfx.childParams("waveform"));
            // Delegate the bars, then place the playhead over this panel only.
            // The original derived the playhead's span from a magic
            // `L.totalW * 0.72 - 6`, which silently disagreed with the actual
            // panel width whenever the combined layout was retuned.
            const geom = waveform.geometry(child, p.waveform);
            const key = `C|${p.waveform.w}|${p.waveform.h}|${Math.round(sig.progress * geom.nBars)}|${sig.playing ? 1 : 0}|${gfx.phase.toFixed(1)}|${palette.name}`;

            let cache = child.store.cache;
            if (!cache || cache.key !== key) {
                const os = ensureOffscreen(child.store, Math.ceil(p.waveform.x + p.waveform.w) + 2,
                                           Math.ceil(p.waveform.y + p.waveform.h) + 2);
                os.ctx.clearRect(0, 0, os.canvas.width, os.canvas.height);
                waveform.paintBars(os.ctx, child, palette, geom, sig.progress, sig.playing);
                cache = { canvas: os.canvas, key };
                child.store.cache = cache;
            }

            ctx.save();
            ctx.beginPath();
            ctx.rect(p.waveform.x, p.waveform.y, p.waveform.w, p.waveform.h);
            ctx.clip();
            ctx.drawImage(cache.canvas, 0, 0);
            ctx.restore();

            if (sig.progress > 0) drawPlayhead(ctx, palette, p.waveform, sig.progress, 5);
        }

        // -- spectrum (bottom left) ---------------------------------------
        if (p.spectrum.w > 8 && p.spectrum.h > 8) {
            spectrum.frame(gfx.child("eq", { ...gfx.childParams("eq"), showLabels: false }),
                           p.spectrum, sig);
        }

        // -- goniometer (bottom right) ------------------------------------
        if (p.goniometer.w > 12 && p.goniometer.h > 12) {
            const size = Math.min(p.goniometer.w, p.goniometer.h);
            drawGoniometer(
                gfx.child("analyzer", gfx.childParams("analyzer")),
                sig,
                p.goniometer.x + p.goniometer.w / 2,
                p.goniometer.y + p.goniometer.h / 2,
                size / 2 - 3,
                { showAxisLabels: false },
            );
        }

        // -- spectrogram (right column) ------------------------------------
        if (p.spectrogram.w > 8 && p.spectrogram.h > 8) {
            spectrogram.frame(gfx.child("spectrogram", gfx.childParams("spectrogram")),
                              p.spectrogram, sig);
        }

        // -- dividers ------------------------------------------------------
        if (params.showDividers !== false) {
            ctx.save();
            ctx.strokeStyle = palette.get("divider");
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.waveform.x, p.splitY);
            ctx.lineTo(p.waveform.x + p.mainW, p.splitY);
            ctx.moveTo(p.spectrum.x + p.eqW + 3, p.splitY + 4);
            ctx.lineTo(p.spectrum.x + p.eqW + 3, rect.y + rect.h - 4);
            ctx.moveTo(p.spectrogram.x - 3, rect.y + 4);
            ctx.lineTo(p.spectrogram.x - 3, rect.y + rect.h - 4);
            ctx.stroke();
            ctx.restore();
        }
    },

    hit(pt, rect, gfx) {
        const p = this.panels(rect, gfx ? gfx.params : {});
        const wf = p.waveform;
        // Only the waveform panel is a time axis, so only it seeks.
        if (pt.x >= wf.x && pt.x <= wf.x + wf.w && pt.y >= wf.y && pt.y <= wf.y + wf.h) {
            return { action: "seek", fraction: (pt.x - wf.x) / wf.w };
        }
        return null;
    },

    dispose(gfx) {
        for (const [id, child] of Object.entries(childGfxMap(gfx))) {
            const mod = CHILDREN[id];
            if (mod && mod.dispose) mod.dispose(child);
        }
    },
};

const CHILDREN = { waveform, eq: spectrum, spectrogram, analyzer: null };

function ensureOffscreen(store, w, h) {
    if (!store.os || store.os.canvas.width !== w || store.os.canvas.height !== h) {
        const canvas = (store.os && store.os.canvas) || document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        store.os = { canvas, ctx: canvas.getContext("2d") };
    }
    return store.os;
}

/** Reconstruct child gfx objects for lifecycle calls (resize/dispose). */
function childGfxMap(gfx) {
    const out = {};
    for (const id of Object.keys(CHILDREN)) {
        out[id] = gfx.child(id, gfx.childParams ? gfx.childParams(id) : gfx.params);
    }
    return out;
}
