/**
 * Waveform — pre-computed peak bars with a proximity pulse at the playhead.
 *
 * The offscreen cache from the original is kept intact and is the reason this
 * view is cheap: hundreds of rounded-rect fills are drawn once to a buffer and
 * blitted with a single drawImage, rebuilt only when the cache key changes
 * (size, quantised progress, playing state, animation phase).
 *
 * What changed: the two PULSE colour ramps used to be module-level constants
 * built at import time from the hardcoded palette, so they could never follow a
 * theme change. They are now pulled from the palette, which memoises them per
 * theme — same cost at runtime, live-themeable.
 */

import { clipped, drawBar, offscreen, rr } from "../core/gfx.js";

export default {
    id: "waveform",
    label: "WAVEFORM",

    needs: { freq: false, time: false, peaks: true },

    params: {
        barHeightScale: { type: "range", min: 0.4, max: 1,    step: 0.02, default: 0.88, label: "Bar height" },
        pulseWidth:     { type: "range", min: 0,   max: 0.25, step: 0.01, default: 0.05, label: "Pulse spread" },
        idleAlpha:      { type: "range", min: 0.1, max: 1,    step: 0.05, default: 0.35, label: "Unplayed opacity" },
        showChannelLabels: { type: "toggle", default: true, label: "Channel labels" },
    },

    roles: [
        "wave.left", "wave.left.pulse", "wave.right", "wave.right.pulse",
        "wave.idle", "wave.idle.right", "wave.label", "wave.label.bg", "playhead",
    ],
    minSize: { w: 80, h: 40 },

    resize(gfx) { gfx.store.cache = null; },

    /**
     * Channel descriptors. Shared with `combined`, which draws the same bars at
     * a different height — hence chH being a parameter rather than read from
     * the layout.
     */
    channels(gfx, palette, geom) {
        const { peaks, stereo } = gfx;
        const list = [{
            p: peaks.ch0,
            midY: geom.ch0MidY,
            chH: geom.chH,
            played: palette.get("wave.left"),
            idle: palette.get("wave.idle"),
            pulse: palette.steps("wave.left", "wave.left.pulse", 101),
            label: stereo ? "L" : "M",
        }];
        if (stereo && peaks.ch1) {
            list.push({
                p: peaks.ch1,
                midY: geom.ch1MidY,
                chH: geom.chH,
                played: palette.get("wave.right"),
                idle: palette.get("wave.idle.right"),
                pulse: palette.steps("wave.right", "wave.right.pulse", 101),
                label: "R",
            });
        }
        return list;
    },

    /**
     * Paint the bars into `octx`. Split out of frame() so `combined` can reuse
     * it with its own geometry instead of duplicating the loop, which is what
     * the original did (and why a waveform fix had to be made twice).
     */
    paintBars(octx, gfx, palette, geom, progress, playing) {
        const params = gfx.params;
        const barScale = params.barHeightScale ?? 0.88;
        const pulseW = params.pulseWidth ?? 0.05;
        const idleAlpha = params.idleAlpha ?? 0.35;
        const gap = gfx.layout.barGap;

        for (const ch of this.channels(gfx, palette, geom)) {
            for (let i = 0; i < geom.nBars; i++) {
                const bx = geom.x + i * (geom.barW + gap);
                const frac = i / geom.nBars;
                const done = frac < progress;
                const pi = Math.min(ch.p.length - 1, Math.floor(frac * ch.p.length));
                let barH = Math.max(2, ch.p[pi] * ch.chH * barScale);
                const nearHead = Math.abs(frac - progress);

                let barColor;
                if (playing && done && pulseW > 0 && nearHead < pulseW) {
                    // Bars within `pulseWidth` of the playhead sample the ramp;
                    // index 100 is right at the head, 0 is the far edge.
                    octx.globalAlpha = 1;
                    barH = Math.min(barH * 1.08, ch.chH * 0.95);
                    const idx = Math.round(Math.max(0, 100 - (nearHead / pulseW) * 100));
                    barColor = ch.pulse[Math.min(100, idx)];
                } else {
                    octx.globalAlpha = done ? 1 : idleAlpha;
                    barColor = done ? ch.played : ch.idle;
                }

                // vertical: true — the relief runs across the bar's width, so a
                // column of any height is lit down one side like a cylinder.
                drawBar(octx, bx, ch.midY - barH / 2, geom.barW, barH, barColor, {
                    vertical: true,
                    radius: Math.min(2, geom.barW / 2),
                });
            }

            if (params.showChannelLabels !== false) {
                octx.globalAlpha = 1;
                octx.font = "bold 9px sans-serif";
                const lblW = octx.measureText(ch.label).width;
                octx.fillStyle = palette.get("wave.label.bg");
                rr(octx, geom.x, ch.midY - 7, lblW + 6, 14, 3);
                octx.fill();
                octx.fillStyle = palette.get("wave.label");
                octx.textAlign = "left";
                octx.textBaseline = "middle";
                octx.fillText(ch.label, geom.x + 3, ch.midY);
            }
        }
        octx.globalAlpha = 1;
    },

    /** Bar geometry for an arbitrary rect — used by both this view and combined. */
    geometry(gfx, rect) {
        const gap = gfx.layout.barGap;
        const peakCount = gfx.peaks.ch0.length;
        const nBars = Math.min(peakCount, Math.max(10, Math.floor(rect.w / (2 + gap))));
        const barW = Math.max(2, (rect.w - gap * (nBars - 1)) / nBars);

        const stereo = gfx.stereo && !!gfx.peaks.ch1;
        const chGap = stereo ? 6 : 0;
        const chH = stereo ? Math.floor((rect.h - chGap) / 2) : rect.h;

        return {
            x: rect.x, y: rect.y, w: rect.w, h: rect.h,
            nBars, barW, chH,
            ch0MidY: rect.y + chH / 2,
            ch1MidY: stereo ? rect.y + chH + chGap + chH / 2 : null,
        };
    },

    frame(gfx, rect, sig) {
        const { ctx, palette } = gfx;
        const geom = this.geometry(gfx, rect);
        const progress = sig.progress;

        // Quantising progress to whole bars means the cache survives most
        // frames during playback instead of missing on every one.
        const snap = Math.round(progress * geom.nBars);
        // palette.revision, not palette.name: a per-node colour override leaves
        // the theme name alone, so keying on the name meant an edited colour
        // kept blitting the stale bitmap until something else happened to drop
        // the cache — which is why moving a slider "fixed" it.
        const key = `${rect.w}|${rect.h}|${snap}|${sig.playing ? 1 : 0}|${gfx.phase.toFixed(1)}|${palette.revision}`;

        let cache = gfx.store.cache;
        if (!cache || cache.key !== key) {
            const os = offscreen(gfx.store, "os", Math.ceil(rect.x + rect.w) + 2,
                                 Math.ceil(rect.y + rect.h) + 2);
            os.ctx.clearRect(0, 0, os.canvas.width, os.canvas.height);
            this.paintBars(os.ctx, gfx, palette, geom, progress, sig.playing);
            cache = { canvas: os.canvas, key };
            gfx.store.cache = cache;
        }

        clipped(ctx, rect, () => ctx.drawImage(cache.canvas, 0, 0));

        if (progress > 0) drawPlayhead(ctx, palette, rect, progress);
    },

    hit(pt, rect) {
        if (pt.x < rect.x || pt.x > rect.x + rect.w) return null;
        if (pt.y < rect.y || pt.y > rect.y + rect.h) return null;
        // Clicking anywhere in the waveform seeks to that position.
        return { action: "seek", fraction: (pt.x - rect.x) / rect.w };
    },

    dispose(gfx) {
        gfx.store.cache = null;
        gfx.store.os = null;
    },
};

/**
 * The vertical playhead with its anchor dots.
 * Exported so `combined` can place one over its own waveform panel rather than
 * recomputing the geometry from a magic 0.72 constant, which is what the
 * original did — and which broke whenever the combined layout was retuned.
 */
export function drawPlayhead(ctx, palette, rect, progress, pad = 5) {
    const x = rect.x + progress * rect.w;
    const top = rect.y + pad;
    const bottom = rect.y + rect.h - pad;
    if (bottom <= top) return;

    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = progress < 0.5 ? palette.get("wave.left") : palette.get("wave.right");
    ctx.strokeStyle = palette.get("playhead");
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();

    ctx.fillStyle = palette.get("playhead");
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.arc(x, top, 2, 0, Math.PI * 2);
    ctx.arc(x, bottom, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}
