/**
 * halo.js — a burst ring: radial streaks around an ellipse, with bubbles
 * drifting up through the middle.
 *
 * PURELY DECORATIVE. Nothing here is a measurement and nothing should be read
 * as one. It uses the spectrum and the level only to decide how things move.
 *
 * How the audio drives it
 * -----------------------
 * - Each streak owns a log-spaced slice of the spectrum. Bass sits at the left
 *   and right of the ring, highs at the top and bottom, mirrored, so the shape
 *   stays balanced whatever the music does.
 * - Streak length follows its slice (fast attack, slower release); streak
 *   colour follows it too, through the "halo" ramp, so loud slices run hot.
 * - The whole ring breathes with the overall level.
 * - Bubbles spawn faster when the music is louder and fade in and out.
 *
 * Both traps from _template.js apply and are handled: `sig.freq` is converted
 * with byteToNorm, and every motion is driven by gfx.now, never per frame.
 */

import { byteToNorm, clipped, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";

const BUBBLE_ROLES = ["halo.bubble.a", "halo.bubble.b", "halo.bubble.c", "halo.bubble.d"];
const MAX_BUBBLES = 260;
const F_LO = 40;          // Hz — lowest slice
const F_HI = 16000;       // Hz — highest slice (clamped to Nyquist)
const COLOR_STEPS = 32;   // ramp quantisation for batching
const ALPHA_STEPS = 6;
const BUCKETS = COLOR_STEPS * ALPHA_STEPS * 2;

/** Deterministic PRNG so a streak's personality survives a resize. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Per-streak constants and spectrum slices. Rebuilt only when the streak
 * count or the analyser's bin layout changes.
 */
function buildStreaks(store, count, binCount, sampleRate) {
    const key = `${count}|${binCount}|${sampleRate}`;
    if (store.streakKey === key) return store.streaks;

    const rnd = mulberry32(0x4a10 + count);
    const nyq = sampleRate / 2;
    const hzPerBin = nyq / binCount;
    const fHi = Math.min(F_HI, nyq * 0.95);
    const streaks = new Array(count);

    for (let k = 0; k < count; k++) {
        const angle = (k / count) * Math.PI * 2;
        // 0 at the sides (bass), 1 at top and bottom (highs), with a little
        // jitter so neighbouring streaks do not move in lockstep.
        let t = Math.abs(Math.sin(angle)) + (rnd() - 0.5) * 0.12;
        t = t < 0 ? 0 : t > 1 ? 1 : t;

        const half = 0.035;
        const fA = F_LO * Math.pow(fHi / F_LO, Math.max(0, t - half));
        const fB = F_LO * Math.pow(fHi / F_LO, Math.min(1, t + half));
        const b0 = Math.max(1, Math.floor(fA / hzPerBin));
        const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil(fB / hzPerBin)));

        streaks[k] = {
            angle,
            // Music has far less energy up top than down low; without this
            // the high-frequency streaks barely move and the ring looks lopsided.
            weight: 1 + 0.8 * t,
            b0, b1,
            len: 0.65 + rnd() * 0.7,          // some streaks are always longer
            hue: (rnd() - 0.5) * 0.22,        // colour scatter around the ramp
            flickW: 5 + rnd() * 11,           // rad/s
            flickP: rnd() * Math.PI * 2,
            wide: 0.7 + rnd() * 0.8,          // stroke weight scatter
            base: 0.3 + rnd() * rnd() * 1.4,       // resting length, so the ring is fringed even in silence
            tilt: (rnd() - 0.5) * 0.35,       // radians off the normal — spiky, not combed
            off: (rnd() - 0.5) * 0.06,        // radial offset, so streaks do not all start on one line
        };
    }

    store.streakKey = key;
    store.streaks = streaks;
    store.energy = new Float32Array(count);
    store.hi = new Float32Array(count).fill(0.3);
    store.lo = new Float32Array(count);
    return streaks;
}

/** 256 CSS strings from the ramp LUT, rebuilt when the theme changes. */
function rampCss(store, palette) {
    if (store.rampRev === palette.revision && store.rampCss) return store.rampCss;
    const lut = palette.ramp("halo");
    const out = new Array(256);
    for (let i = 0; i < 256; i++) {
        out[i] = `rgb(${lut[i * 3]},${lut[i * 3 + 1]},${lut[i * 3 + 2]})`;
    }
    store.rampRev = palette.revision;
    store.rampCss = out;
    return out;
}

function spawnBubble(store) {
    // Loosely columned, clustered toward the centre — the look of the
    // reference rather than an even scatter.
    const g = (Math.random() + Math.random() + Math.random() + Math.random()) / 4;   // ~normal
    const cols = 44;
    const x = Math.round((0.5 + (g - 0.5) * 1.15) * cols) / cols + (Math.random() - 0.5) * 0.003;
    const big = Math.random() < 0.08;
    store.bubbles.push({
        x,
        y: 0.15 + Math.random() * 0.95,
        vy: 0.02 + Math.random() * 0.07,          // rect heights per second
        r: big ? 3.5 + Math.random() * 3 : 1.2 + Math.random() * 2.4,
        age: 0,
        life: 2.5 + Math.random() * 4,
        role: BUBBLE_ROLES[(Math.random() * BUBBLE_ROLES.length) | 0],
        wob: Math.random() * Math.PI * 2,
    });
}

export default {
    id: "halo",
    label: "HALO",

    needs: { freq: true, time: false, peaks: false },

    params: {
        gain:     { type: "range", min: 0.2, max: 3,    step: 0.05, default: 1.2,  label: "Intensity" },
        floor:    { type: "range", min: 0,   max: 0.7,  step: 0.01, default: 0.28, label: "Noise floor" },
        streaks:  { type: "range", min: 60,  max: 360,  step: 10,   default: 300,  label: "Streaks" },
        size:     { type: "range", min: 0.3, max: 0.9,  step: 0.01, default: 0.58, label: "Ring size" },
        aspect:   { type: "range", min: 1,   max: 2.2,  step: 0.05, default: 1.45, label: "Ellipse width" },
        spread:   { type: "range", min: 0.2, max: 2,    step: 0.05, default: 1,    label: "Streak length" },
        pulse:    { type: "range", min: 0,   max: 0.4,  step: 0.01, default: 0.12, label: "Beat pulse" },
        spin:     { type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0.04, label: "Spin (rev/s)" },
        bubbles:  { type: "range", min: 0,   max: 3,    step: 0.1,  default: 1,    label: "Bubbles" },
        balance:  { type: "range", min: 0,   max: 1,    step: 0.05, default: 0.6,  label: "Even out" },
        release:  { type: "range", min: 0.5, max: 0.97, step: 0.01, default: 0.86, label: "Release" },
        glow:     { type: "toggle", default: true, label: "Core glow" },
    },

    roles: ["text.dim", "halo.bg", "halo.core", ...BUBBLE_ROLES],
    ramps: ["halo"],

    minSize: { w: 80, h: 50 },

    resize(gfx) {
        // Bubbles live in normalised coordinates, so they survive a resize.
        // The cached colour strings are keyed on palette.revision; clearing
        // them here also covers a ramp edited in place.
        gfx.store.rampCss = null;
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData || !sig.freq) {
            drawPlaceholder(ctx, rect, ["PLAY TO ACTIVATE", "PLAY ▶"], palette.get("text.dim"));
            return;
        }

        // ---- clock ------------------------------------------------------
        const now = gfx.now || 0;
        let dt = store.lastNow === undefined ? 0 : (now - store.lastNow) / 1000;
        store.lastNow = now;
        if (!(dt > 0) || dt > 0.5) dt = 0;     // tab switch / stall: do not jump

        const p = params;
        const count = Math.round(p.streaks ?? 300);
        const bins = sig.binCount || sig.freq.length;
        const sr = sig.sampleRate || 48000;
        const streaks = buildStreaks(store, count, bins, sr);
        const energy = store.energy;

        // ---- signal -----------------------------------------------------
        const gain = p.gain ?? 1.2;
        const floor = p.floor ?? 0.28;
        const aUp = smoothingAlpha(0.35, dt);                 // fast attack
        const aDn = smoothingAlpha(p.release ?? 0.86, dt);    // slower release
        const freq = sig.freq;
        // "Even out": each streak is also judged against its own recent range
        // (a slow floor and a slow peak), so a region of the spectrum that is
        // always quiet still animates. Automatic gain — display only, and
        // exactly why this view is not a meter.
        const balance = p.balance ?? 0.6;
        const hi = store.hi, lo = store.lo;
        const hiDecay = dt > 0 ? Math.pow(0.5, dt / 3) : 1;        // 3 s half-life
        const loRise = dt > 0 ? 1 - Math.pow(0.5, dt / 4) : 0;     // floor creeps up over ~4 s

        for (let k = 0; k < count; k++) {
            const s = streaks[k];
            let m = 0;
            for (let b = s.b0; b < s.b1; b++) if (freq[b] > m) m = freq[b];
            const raw = byteToNorm(m);
            let abs = (raw - floor) / (1 - floor);
            abs = abs <= 0 ? 0 : Math.min(1, Math.pow(abs * gain * s.weight, 0.75));

            lo[k] = raw < lo[k] ? raw : lo[k] + (raw - lo[k]) * loRise;
            hi[k] = Math.max(raw, hi[k] * hiDecay, lo[k] + 0.08);
            const rel = Math.min(1, ((raw - lo[k]) / (hi[k] - lo[k])) * gain);

            const v = (1 - balance) * abs + balance * rel;
            const e = energy[k];
            energy[k] = e + (v - e) * (v > e ? aUp : aDn);
        }

        const level = Math.max(sig.levelL ?? 0, sig.levelR ?? 0);
        const lvl = store.level ?? 0;
        store.level = lvl + (level - lvl) * (level > lvl ? smoothingAlpha(0.4, dt) : smoothingAlpha(0.9, dt));
        store.rot = ((store.rot ?? 0) + dt * (p.spin ?? 0.04) * Math.PI * 2) % (Math.PI * 2);

        // ---- bubbles ----------------------------------------------------
        if (!store.bubbles) store.bubbles = [];
        const density = p.bubbles ?? 1;
        if (density > 0 && sig.playing !== false) {
            store.spawnDebt = (store.spawnDebt ?? 0) + dt * density * (10 + 70 * store.level);
            while (store.spawnDebt >= 1) {
                store.spawnDebt -= 1;
                if (store.bubbles.length < MAX_BUBBLES) spawnBubble(store);
            }
        } else if (store.bubbles.length === 0 && density > 0) {
            // A paused or idle node still shows a few, so the view reads.
            for (let i = 0; i < 30; i++) spawnBubble(store);
        }
        const bub = store.bubbles;
        const moving = sig.playing !== false;
        let w = 0;
        for (let i = 0; i < bub.length; i++) {
            const b = bub[i];
            if (moving) { b.age += dt; b.y -= b.vy * dt; }
            if (b.age < b.life && b.y > -0.05) bub[w++] = b;
        }
        bub.length = w;

        // ---- geometry ---------------------------------------------------
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const aspect = p.aspect ?? 1.45;
        const base = Math.min(rect.w / 2 / aspect, rect.h / 2) * (p.size ?? 0.58);
        const R = base * (1 + (p.pulse ?? 0.12) * store.level);
        const rx = R * aspect, ry = R;
        const spread = p.spread ?? 1;
        const css = rampCss(store, palette);
        const tSec = now / 1000;

        clipped(ctx, rect, () => {
            ctx.fillStyle = palette.get("halo.bg");
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

            // Bubbles, behind the ring. Batched by (colour, alpha step) the
            // same way as the streaks: sixteen strokes rather than one each.
            ctx.lineWidth = 1.1;
            for (let ri = 0; ri < BUBBLE_ROLES.length; ri++) {
                const role = BUBBLE_ROLES[ri];
                for (let aq = 1; aq <= 4; aq++) {
                    let any = false;
                    for (const b of bub) {
                        if (b.role !== role) continue;
                        const life = b.age / b.life;
                        const a = Math.sin(Math.PI * Math.min(1, Math.max(0, life)));
                        if (Math.ceil(a * 4) !== aq) continue;
                        if (!any) { ctx.beginPath(); any = true; }
                        const x = rect.x + (b.x + Math.sin(b.wob + b.age * 1.7) * 0.004) * rect.w;
                        const y = rect.y + b.y * rect.h;
                        ctx.moveTo(x + b.r, y);
                        ctx.arc(x, y, b.r, 0, Math.PI * 2);
                    }
                    if (!any) continue;
                    ctx.globalAlpha = (aq / 4) * 0.85;
                    ctx.strokeStyle = palette.get(role);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

            // Streaks, additive so overlaps burn toward white.
            //
            // Batched: every streak is geometry plus a (colour, alpha, width)
            // bucket, and each bucket is ONE path and ONE stroke(). Stroking
            // 300 streaks x 2 passes individually was ~600 draw calls a frame;
            // bucketed it is typically under a hundred, for an identical look
            // at these quantisation steps.
            ctx.globalCompositeOperation = "lighter";
            ctx.lineCap = "round";
            const rot = store.rot;
            const wideW = Math.max(1.2, R * 0.018);
            const thinW = Math.max(0.7, R * 0.008);

            if (!store.seg || store.seg.length !== count * 5) {
                store.seg = new Float32Array(count * 5);     // px, py, tx, ty, full
                store.key = new Uint16Array(count);
                store.order = new Uint16Array(count);
                store.bucketStart = new Uint16Array(BUCKETS + 1);
            }
            const seg = store.seg;
            if (!store.cIdx || store.cIdx.length !== count) store.cIdx = new Uint8Array(count);
            const col = store.cIdx;

            for (let k = 0; k < count; k++) {
                const s = streaks[k];
                const e = energy[k];
                const a = s.angle + rot;
                const ca = Math.cos(a), sa = Math.sin(a);
                // Point on the ellipse and its outward normal, tilted a
                // little per streak so the fringe looks spiky.
                let nx = ca / rx, ny = sa / ry;
                const nl = Math.hypot(nx, ny) || 1;
                nx /= nl; ny /= nl;
                const ct = Math.cos(s.tilt), st = Math.sin(s.tilt);
                const o = k * 5;
                seg[o]     = cx + rx * ca + nx * R * s.off;
                seg[o + 1] = cy + ry * sa + ny * R * s.off;
                seg[o + 2] = nx * ct - ny * st;
                seg[o + 3] = nx * st + ny * ct;
                const flick = 0.8 + 0.2 * Math.sin(tSec * s.flickW + s.flickP);
                seg[o + 4] = R * (0.1 * s.base + e * 0.55 * spread * s.len) * flick;

                let idx = 0.2 + 0.62 * e + s.hue + 0.14 * Math.cos(a * 2 - rot * 3);
                idx = idx < 0 ? 0 : idx > 1 ? 1 : idx;
                col[k] = Math.round(idx * (COLOR_STEPS - 1));
            }

            for (let pass = 0; pass < 2; pass++) {
                const wide = pass === 0;
                // The wide pass runs the full length, the bright pass stops
                // short — so every streak tapers to a soft tip.
                const lenK = wide ? 1 : 0.7;

                // Counting sort of streaks into buckets.
                const key = store.key, order = store.order, starts = store.bucketStart;
                starts.fill(0);
                for (let k = 0; k < count; k++) {
                    const e = energy[k];
                    const aq = Math.min(ALPHA_STEPS - 1, (e * ALPHA_STEPS) | 0);
                    const wq = streaks[k].wide > 1.1 ? 1 : 0;
                    const kk = (col[k] * ALPHA_STEPS + aq) * 2 + wq;
                    key[k] = kk;
                    starts[kk + 1]++;
                }
                for (let b = 0; b < BUCKETS; b++) starts[b + 1] += starts[b];
                const fill = store.fillPos || (store.fillPos = new Uint16Array(BUCKETS));
                fill.set(starts.subarray(0, BUCKETS));
                for (let k = 0; k < count; k++) order[fill[key[k]]++] = k;

                for (let b = 0; b < BUCKETS; b++) {
                    const b0 = starts[b], b1 = starts[b + 1];
                    if (b0 === b1) continue;
                    const wq = b & 1;
                    const aq = (b >> 1) % ALPHA_STEPS;
                    const cq = ((b >> 1) / ALPHA_STEPS) | 0;
                    const e = (aq + 0.5) / ALPHA_STEPS;
                    // The haze sits a few steps cooler than its streak, so a
                    // white-hot streak glows pink or gold rather than grey.
                    const hq = wide ? Math.max(0, cq - 6) : cq;
                    ctx.strokeStyle = css[Math.round((hq / (COLOR_STEPS - 1)) * 255)];
                    ctx.globalAlpha = wide ? 0.12 + 0.22 * e : 0.3 + 0.6 * e;
                    ctx.lineWidth = (wide ? wideW : thinW) * (wq ? 1.3 : 0.85);
                    ctx.beginPath();
                    for (let i = b0; i < b1; i++) {
                        const o = order[i] * 5;
                        const out = seg[o + 4] * lenK, inn = out * 0.55;
                        ctx.moveTo(seg[o] - seg[o + 2] * inn, seg[o + 1] - seg[o + 3] * inn);
                        ctx.lineTo(seg[o] + seg[o + 2] * out, seg[o + 1] + seg[o + 3] * out);
                    }
                    ctx.stroke();
                }
            }

            // The hot core of the ring. The glow is two wide faint strokes
            // rather than shadowBlur, which costs a blur of the whole path.
            const coreW = R * (0.012 + 0.03 * store.level);
            ctx.strokeStyle = palette.get("halo.core");
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            if (p.glow !== false) {
                ctx.globalAlpha = 0.05 + 0.08 * store.level;
                ctx.lineWidth = coreW * 2.5 + R * 0.14;
                ctx.stroke();
                ctx.lineWidth = coreW * 2.5 + R * 0.06;
                ctx.stroke();
            }
            ctx.globalAlpha = 0.12 + 0.25 * store.level;
            ctx.lineWidth = coreW * 2.5;
            ctx.stroke();
            ctx.globalAlpha = 0.25 + 0.4 * store.level;
            ctx.lineWidth = Math.max(0.7, coreW * 0.5);
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
        });
    },

    // Display only — clicking the view does nothing.
    hit() {
        return null;
    },

    dispose(gfx) {
        const s = gfx.store;
        s.streaks = s.energy = s.bubbles = s.rampCss = s.seg = s.cIdx = null;
        s.streakKey = undefined;
        s.lastNow = undefined;
    },
};
