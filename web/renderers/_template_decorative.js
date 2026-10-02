/**
 * _template_decorative.js — copy this to add a DECORATIVE view mode.
 *
 * A decorative renderer is one made to be watched, not read: Halo is the
 * first. It follows exactly the same contract as _template.js (read that for
 * the two traps around analyser data and frame timing) plus one thing:
 *
 *     sequences: true
 *
 * which gives it RECORDED SEQUENCES for free. The settings drawer grows a
 * "Sequences" section where the user presses Record, plays with this
 * renderer's settings, presses Stop & save, and can then replay it — once,
 * N times or in a loop — while the music plays. You write no code for it:
 * host.js records every change made through the drawer, core/sequences.js
 * plays it back, and the files live in
 *
 *     ComfyUI/user/nova_player/sequences/<your id>/<name>.json
 *
 * WHAT THIS MEANS FOR YOUR RENDERER
 *
 * 1. Your `params` ARE the sequence format. A sequence is a list of
 *    (setting, value, time) for the keys you declare here. Rename a key and
 *    old recordings stop driving it — they are not broken, that one setting
 *    is simply skipped. So choose keys you are willing to keep.
 * 2. Every value is validated against your schema at play time: unknown keys,
 *    wrong types and values outside min..max are skipped, not applied. Keep
 *    `min`/`max` honest; widening a range later is safe, narrowing is not
 *    (older recordings with values outside the new range lose those steps).
 *    If you rename a select option, list the old value in `aliases`.
 * 3. Settings change DURING a frame sequence, many times a second while a
 *    recorded slider drag replays. Treat params as live: read them every
 *    frame, and make `resize()` cheap — it is called after each change so you
 *    can drop caches that depend on a setting.
 * 4. Motion must be time-based (gfx.now), never per frame. It already had to
 *    be; with playback it also has to survive a speed that changes mid-motion.
 *    Accumulate a phase (`store.phase += dt * speed`) rather than computing
 *    `now * speed`, or changing the speed makes the picture jump.
 * 5. Measurement views must NOT set `sequences: true`. A meter whose settings
 *    change by themselves is a meter you cannot trust.
 *
 * To add it: copy this file, fill it in, import it in registry.js, add it to
 * RENDERERS, and add a "mode.<id>" colour role (plus any roles you read) to
 * nova_player/defaults.py.
 *
 * This file is NOT imported by registry.js — it is a reference, not a mode.
 */

import { byteToNorm, clipped, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";

export default {
    id: "mydecor",
    label: "MY DECOR",

    // The whole feature, from the renderer's side.
    sequences: true,

    needs: { freq: true, time: false, peaks: false },

    // Each of these becomes a drawer control AND a recordable setting.
    //   range:  min, max, step, default     (values outside min..max are skipped on playback)
    //   toggle: default                     (booleans only)
    //   select: options [{ value, label }], default, optional aliases { old: current }
    params: {
        gain:  { type: "range", min: 0.2, max: 3, step: 0.05, default: 1, label: "Intensity" },
        speed: { type: "range", min: -1, max: 1, step: 0.01, default: 0.1, label: "Speed (rev/s)" },
        glow:  { type: "toggle", default: true, label: "Glow" },
        shape: { type: "select", default: "ring", label: "Shape",
                 options: [{ value: "ring", label: "Ring" }, { value: "dots", label: "Dots" }] },
    },

    roles: ["text.dim", "spectrum.rim"],
    ramps: [],
    minSize: { w: 80, h: 50 },

    resize(gfx) {
        // Called on resize AND after every setting change (including replayed
        // ones). Drop anything cached from a setting here; keep it cheap.
        gfx.store.cache = null;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params: p, store } = gfx;
        if (!sig.ready || !sig.hasData || !sig.freq) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "PLAY ▶"], palette.get("text.dim"));
            return;
        }

        // Time-based, and accumulated: see point 4 above.
        const now = gfx.now || 0;
        let dt = store.lastNow === undefined ? 0 : (now - store.lastNow) / 1000;
        store.lastNow = now;
        if (!(dt > 0) || dt > 0.5) dt = 0;
        store.phase = ((store.phase || 0) + dt * (p.speed ?? 0.1) * Math.PI * 2) % (Math.PI * 2);

        // Smooth the level, frame-rate independently.
        let peak = 0;
        for (let i = 0; i < sig.freq.length; i++) if (sig.freq[i] > peak) peak = sig.freq[i];
        const lvl = byteToNorm(peak) * (p.gain ?? 1);
        store.level = (store.level ?? 0) + (lvl - (store.level ?? 0)) * smoothingAlpha(0.8, dt || 1 / 60);

        clipped(ctx, rect, () => {
            const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
            const r = Math.min(rect.w, rect.h) * (0.2 + 0.2 * store.level);
            ctx.strokeStyle = palette.get("spectrum.rim");
            ctx.lineWidth = p.glow ? 3 : 1;
            if (p.shape === "dots") {
                for (let k = 0; k < 12; k++) {
                    const a = store.phase + (k / 12) * Math.PI * 2;
                    ctx.beginPath();
                    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3, 0, Math.PI * 2);
                    ctx.stroke();
                }
            } else {
                ctx.beginPath();
                ctx.arc(cx, cy, r, store.phase, store.phase + Math.PI * 1.8);
                ctx.stroke();
            }
        });
    },

    hit() { return null; },

    dispose(gfx) {
        gfx.store.cache = null;
        gfx.store.lastNow = undefined;
    },
};
