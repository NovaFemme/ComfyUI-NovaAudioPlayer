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
 * Both traps from _template.js apply and are handled: the spectrum is read
 * from the unclamped float path (`sig.freqDb`), falling back to the byte
 * spectrum through byteToNorm, and every motion is driven by gfx.now.
 */

import { byteToNorm, clipped, drawPlaceholder, smoothingAlpha } from "../core/gfx.js";
import { mix, toCss } from "../core/color.js";

const BUBBLE_ROLES = ["halo.bubble.a", "halo.bubble.b", "halo.bubble.c", "halo.bubble.d"];
// Spike colours are ROLES, not a ramp, so the settings drawer gives each a
// colour picker. Quiet spikes use `low`, loud ones `high`, with `mid` between;
// "Gradient" blends each spike toward `tip` along its length.
const SPIKE_ROLES = ["halo.spike.low", "halo.spike.mid", "halo.spike.high", "halo.spike.tip"];
const MAX_BUBBLES = 260;
const F_LO = 40;          // Hz — lowest slice
const F_HI = 16000;       // Hz — highest slice (clamped to Nyquist)
const COLOR_STEPS = 32;   // ramp quantisation for batching
const ALPHA_STEPS = 10;
const SEGS = 3;           // each spike is drawn as three segments, inner to tip
// Bucket = (colour step, segment, alpha step). The segment is part of the key
// because each segment blends toward the tip colour by a different amount.
const BUCKETS = COLOR_STEPS * SEGS * (ALPHA_STEPS + 1);
const TIP_MIX = [0, 0.12, 0.65]; // how far each segment leans toward halo.spike.tip, x Gradient
// Float-spectrum window for the absolute reading. Deliberately close to the
// byte path's -100..-30 so "Even out = 0" looks like it did before; only the
// relative reading benefits from seeing below -100.
const DB_FLOOR = -105;
const DB_CEIL = -30;
const REL_FLOOR = -140;   // the relative reading sees everything above this
// Motion: "spin" = the spikes travel round the ring; "rotate" = the ring turns
// in 3D about its short axis; "both"; "off". Each has its own speed.
const SPIN_MODES = ["spin", "rotate", "both", "off"];
// Values saved by the build that had one Spin select and one speed.
const LEGACY_SPIN = { circle: "spin", sideways: "rotate" };
const DEG = Math.PI / 180;

const fract = x => x - Math.floor(x);

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
            t,                                // 0 = bass, 1 = highs
            b0, b1,
            len: 0.65 + rnd() * 0.7,          // some streaks are always longer
            hue: (rnd() - 0.5) * 0.22,        // colour scatter around the ramp
            flickW: 5 + rnd() * 11,           // rad/s
            flickP: rnd() * Math.PI * 2,
            base: 0.3 + rnd() * rnd() * 1.4,       // resting length, so the ring is fringed even in silence
            tilt: (rnd() - 0.5) * 0.35,       // radians off the normal — spiky, not combed
            off: (rnd() - 0.5) * 0.06,        // radial offset, so streaks do not all start on one line
            // Out-of-plane angle, −1..1 (× the max elevation), for Sideways 3D.
            // A hash of k, NOT another rnd() call: drawing one more number
            // would shift every value after it and change the default look.
            el: fract(Math.sin(k * 78.233 + 1.3) * 43758.5453) * 2 - 1,
        };
    }

    store.streakKey = key;
    store.streaks = streaks;
    store.energy = new Float32Array(count);
    store.hi = new Float32Array(count).fill(0.3);
    store.lo = new Float32Array(count);
    return streaks;
}

/**
 * CSS strings for every (colour step, segment): the low→mid→high spike ramp,
 * each step then blended toward the tip colour by that segment's share of
 * "Gradient". Keyed on palette.revision (a colour edit bumps it — never key on
 * palette.name, see TECHNICAL.md) and on the gradient amount.
 */
function spikeCss(store, palette, grad) {
    const key = `${palette.revision}|${grad}`;
    if (store.spikeKey === key && store.spikeCss) return store.spikeCss;
    const space = palette.mixSpace;
    const [low, mid, high, tip] = SPIKE_ROLES.map(r => palette.get(r));
    const out = new Array(COLOR_STEPS * SEGS);
    for (let c = 0; c < COLOR_STEPS; c++) {
        const t = c / (COLOR_STEPS - 1);
        const body = t < 0.5 ? mix(low, mid, t * 2, space) : mix(mid, high, (t - 0.5) * 2, space);
        for (let g = 0; g < SEGS; g++) {
            out[c * SEGS + g] = toCss(mix(body, tip, TIP_MIX[g] * grad, space));
        }
    }
    store.spikeKey = key;
    store.spikeCss = out;
    return out;
}

function spawnBubble(store) {
    // Positions are in RING radii, not in rect fractions: u = 1 is the
    // ellipse's right edge, v = 1 its bottom. So the bubbles cluster around
    // the ring whatever shape the view is — in a wide, short strip they used
    // to spread across the whole width and swamp it.
    // Loosely columned, centre-weighted — the look of the reference.
    const g = (Math.random() + Math.random() + Math.random() + Math.random()) / 4;   // ~normal
    const cols = 30;
    const u = Math.round((g - 0.5) * 3.2 * cols) / cols + (Math.random() - 0.5) * 0.01;
    const big = Math.random() < 0.06;
    store.bubbles.push({
        u,
        v: -1.1 + Math.random() * 2.5,
        vv: 0.08 + Math.random() * 0.25,          // ring radii per second, upward
        r: big ? 3 + Math.random() * 2.5 : 1 + Math.random() * 2,
        age: 0,
        life: 2.5 + Math.random() * 4,
        role: BUBBLE_ROLES[(Math.random() * BUBBLE_ROLES.length) | 0],
        wob: Math.random() * Math.PI * 2,
        z: Math.random() * 2 - 1,                 // depth, for Sideways 3D
    });
}

export default {
    id: "halo",
    label: "HALO",

    // Decorative: offers recorded sequences (core/sequences.js) — the user
    // records themselves playing with these settings and replays it.
    sequences: true,

    // freqDb: the unclamped float spectrum. The byte spectrum floors every
    // bin below -100 dBFS at 0, which on real material is most of the top
    // octaves, so "Even out" had nothing to even out and the top and bottom
    // of the ring sat still. The float path costs a second FFT read per
    // tick, only while this view is showing.
    needs: { freq: true, freqDb: true, time: false, peaks: false },

    params: {
        // -- signal
        gain:      { type: "range", min: 0.2, max: 3,    step: 0.05, default: 1.2,  label: "Intensity" },
        floor:     { type: "range", min: 0,   max: 0.7,  step: 0.01, default: 0.28, label: "Noise floor" },
        highBoost: { type: "range", min: 0,   max: 4,    step: 0.1,  default: 1,    label: "High boost" },
        balance:   { type: "range", min: 0,   max: 1,    step: 0.05, default: 0.6,  label: "Even out" },
        release:   { type: "range", min: 0.5, max: 0.97, step: 0.01, default: 0.86, label: "Release" },
        // -- spikes
        streaks:   { type: "range", min: 60,  max: 360,  step: 10,   default: 300,  label: "Streaks" },
        spread:    { type: "range", min: 0.2, max: 2,    step: 0.05, default: 1,    label: "Streak length" },
        width:     { type: "range", min: 0.5, max: 5,    step: 0.1,  default: 1.6,  label: "Spike width" },
        soft:      { type: "range", min: 0,   max: 1,    step: 0.05, default: 0.55, label: "Softness" },
        gradient:  { type: "range", min: 0,   max: 1,    step: 0.05, default: 0.6,  label: "Gradient" },
        // -- ring
        size:      { type: "range", min: 0.3, max: 0.9,  step: 0.01, default: 0.58, label: "Ring size" },
        aspect:    { type: "range", min: 1,   max: 2.2,  step: 0.05, default: 1.45, label: "Ellipse width" },
        fitWidth:  { type: "toggle", default: true, label: "Fit to view width" },
        tilt:      { type: "range", min: -90, max: 90,   step: 1,    default: 0,    label: "Tilt (° to vertical)" },
        // -- motion
        spinMode:  { type: "select", default: "spin", label: "Motion", aliases: LEGACY_SPIN,
                     options: [{ value: "spin", label: "Spin" },
                               { value: "rotate", label: "Rotate (3D)" },
                               { value: "both", label: "Spin + rotate" },
                               { value: "off", label: "Off" }] },
        spin:      { type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0.04, label: "Spin speed (rev/s)" },
        rotate:    { type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0.08, label: "Rotate speed (rev/s)" },
        depth:     { type: "range", min: 0,   max: 1,    step: 0.05, default: 0.8,  label: "3D depth (Rotate)" },
        pulse:     { type: "range", min: 0,   max: 0.6,  step: 0.01, default: 0.12, label: "Beat pulse" },
        pulseGain: { type: "range", min: 0,   max: 3,    step: 0.05, default: 1,    label: "Pulse intensity" },
        glow:      { type: "toggle", default: true, label: "Core glow" },
        // -- bubbles
        bubbles:    { type: "range", min: 0,   max: 3,   step: 0.1,  default: 0.7,  label: "Bubbles" },
        bubbleSize: { type: "range", min: 0.3, max: 4,   step: 0.05, default: 1,    label: "Bubble size" },
        bubbleSoft: { type: "range", min: 0,   max: 1,   step: 0.05, default: 0,    label: "Bubble softness" },
    },

    roles: ["text.dim", "halo.bg", ...SPIKE_ROLES, "halo.core", ...BUBBLE_ROLES],
    ramps: [],

    minSize: { w: 80, h: 50 },

    resize(gfx) {
        // Bubbles live in normalised coordinates, so they survive a resize.
        gfx.store.spikeCss = null;
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
        const fdb = sig.freqDb && sig.freqDb.length === freq.length ? sig.freqDb : null;
        const boost = p.highBoost ?? 1;
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
            // raw: the absolute level (bounded like the byte path);
            // deep: the same slice on a much wider window, for "Even out".
            let raw, deep;
            if (fdb) {
                let m = -Infinity;
                for (let b = s.b0; b < s.b1; b++) if (fdb[b] > m) m = fdb[b];
                if (!(m > REL_FLOOR)) m = REL_FLOOR;            // also catches -Infinity/NaN
                raw = m <= DB_FLOOR ? 0 : (Math.min(m, DB_CEIL) - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
                deep = (Math.min(m, DB_CEIL) - REL_FLOOR) / (DB_CEIL - REL_FLOOR);
            } else {
                let m = 0;
                for (let b = s.b0; b < s.b1; b++) if (freq[b] > m) m = freq[b];
                raw = deep = byteToNorm(m);
            }
            // Music carries far less energy up top than down low; this lifts
            // the upper slices so the whole ring takes part.
            const weight = 1 + boost * s.t;
            let abs = (raw - floor) / (1 - floor);
            abs = abs <= 0 ? 0 : Math.min(1, Math.pow(abs * gain * weight, 0.75));

            lo[k] = deep < lo[k] ? deep : lo[k] + (deep - lo[k]) * loRise;
            hi[k] = Math.max(deep, hi[k] * hiDecay, lo[k] + 0.12);
            const rel = Math.min(1, ((deep - lo[k]) / (hi[k] - lo[k])) * gain * (1 + 0.25 * boost * s.t));

            const v = (1 - balance) * abs + balance * rel;
            const e = energy[k];
            energy[k] = e + (v - e) * (v > e ? aUp : aDn);
        }

        const level = Math.max(sig.levelL ?? 0, sig.levelR ?? 0);
        const lvl = store.level ?? 0;
        store.level = lvl + (level - lvl) * (level > lvl ? smoothingAlpha(0.4, dt) : smoothingAlpha(0.9, dt));
        let spinMode = LEGACY_SPIN[p.spinMode] || p.spinMode;
        if (!SPIN_MODES.includes(spinMode)) spinMode = "spin";
        const spinOn = spinMode === "spin" || spinMode === "both";
        const rotateOn = spinMode === "rotate" || spinMode === "both";
        // Two independent phases, so switching one off leaves the other
        // exactly where it was.
        const TAU = Math.PI * 2;
        if (spinOn) store.rot = ((store.rot ?? 0) + dt * (p.spin ?? 0.04) * TAU) % TAU;
        if (rotateOn) store.turn = ((store.turn ?? 0) + dt * (p.rotate ?? 0.08) * TAU) % TAU;
        // "Pulse intensity" multiplies everything that reacts to loudness:
        // the ring's swell, the core's weight and glow, and spike punch.
        const pulseGain = p.pulseGain ?? 1;
        const lp = Math.min(3, store.level * pulseGain);

        // ---- bubbles ----------------------------------------------------
        if (!store.bubbles) store.bubbles = [];
        const density = p.bubbles ?? 0.7;
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
            if (moving) { b.age += dt; b.v -= b.vv * dt; }
            if (b.age < b.life && b.v > -1.8 && b.u !== undefined) bub[w++] = b;
        }
        bub.length = w;

        // ---- geometry ---------------------------------------------------
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        // "Fit width": a wide, short strip (the usual shape of this node)
        // left a small ring in a lot of empty space. Stretch the ellipse
        // toward the strip's own proportions, never below the set width.
        // "Tilt" turns the ellipse's long axis from horizontal (0°) toward
        // vertical (±90°). Fit-width and the size fit both work on the tilted
        // shape, so a vertical ring in a wide strip is not stretched sideways.
        const th = (p.tilt ?? 0) * DEG;
        const cth = Math.cos(th), sth = Math.sin(th);
        const act = Math.abs(cth), ast = Math.abs(sth);
        let aspect = p.aspect ?? 1.45;
        if (p.fitWidth !== false) {
            const along = act * rect.w + ast * rect.h;     // view extent along the long axis
            const across = ast * rect.w + act * rect.h;    // ...and across it
            aspect = Math.max(aspect, Math.min(3, (along / across) * 0.5));
        }
        // Bounding half-extents of the tilted ellipse per unit of minor radius.
        const bw = Math.hypot(aspect * cth, sth);
        const bh = Math.hypot(aspect * sth, cth);
        const fitMax = Math.min(rect.w / 2 / bw, rect.h / 2 / bh);
        const base = fitMax * (p.size ?? 0.58);
        // Swell with the beat, but never past the view.
        const R0 = Math.min(fitMax * 0.97, base * (1 + (p.pulse ?? 0.12) * lp));
        const rx = R0 * aspect, ry = R0;
        // "Sideways" spin turns the ring like a coin about its short axis.
        // It is a real projection: everything foreshortens together — the
        // ring AND its spikes. (The first version squashed only the ring and
        // kept the spikes full length, so edge-on they pinched into two fangs:
        // a mouth.) With "3D depth" it is a solid object, not a paper disc —
        // see below. depthK = sin(phase) is how far each point has turned
        // toward or away from the viewer.
        const rot = store.rot ?? 0;
        const turn = store.turn ?? 0;
        const sideways = rotateOn;
        const q = sideways ? Math.cos(turn) : 1;
        const depthK = sideways ? Math.sin(turn) : 0;
        const rxs = rx * q;
        // "3D depth" makes Sideways a solid object rather than a paper disc:
        // spikes tilt out of the ring's plane (up to ±55°), and everything is
        // drawn in perspective, the near side larger than the far. Focal
        // length F is kept beyond the deepest point so nothing inverts; at
        // depth 1 the near edge is ~1.8x the far, at 0 there is none.
        const depth = sideways ? Math.max(0, Math.min(1, p.depth ?? 0.8)) : 0;
        const elMax = 55 * DEG * depth;
        const zReach = rx + R0 * 1.2;
        const F = zReach * (2.2 + 8 * (1 - depth)) + 1;
        const persp = z => F / Math.max(F * 0.2, F - z);
        const spikeRot = spinOn ? rot : 0;
        // On-screen half-extents, for placing the bubbles.
        const bwPx = R0 * bw, bhPx = R0 * bh;
        // Streak lengths, stroke widths and bubble sizes scale with the
        // ring's mean radius rather than its short one, so a stretched ring
        // is not fringed with stubs.
        const R = Math.sqrt(rx * ry);
        const bubScale = Math.max(0.5, Math.min(1.4, R / 90)) * (p.bubbleSize ?? 1);
        const bubSoft = p.bubbleSoft ?? 0;
        const spread = p.spread ?? 1;
        const grad = p.gradient ?? 0.6;
        const css = spikeCss(store, palette, grad);
        const tSec = now / 1000;
        const punch = Math.max(0.2, 1 + 0.45 * (pulseGain - 1) * store.level);

        clipped(ctx, rect, () => {
            ctx.fillStyle = palette.get("halo.bg");
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

            // Bubbles, behind the ring. Batched by (colour, alpha step) the
            // same way as the streaks: one path per bucket, sixteen buckets.
            // "Bubble softness" draws each path a few more times — two wide,
            // faint strokes and a faint fill — so the rings blur into soft
            // glows; each path is composited once, so overlaps stay soft.
            const bubW = 1.1 * Math.max(1, Math.sqrt(p.bubbleSize ?? 1));
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
                        let bu = b.u + Math.sin(b.wob + b.age * 1.7) * 0.012, bk = 1;
                        if (sideways && depth > 0) {
                            // Bubbles fill a volume and turn with the ring,
                            // so the near ones sweep across the far ones.
                            const bz = (b.z ?? 0) * depth;
                            const u2 = bu * q + bz * depthK, z2 = -bu * depthK + bz * q;
                            bk = persp(z2 * bwPx);
                            bu = u2 * bk;
                        }
                        const x = cx + bu * bwPx;
                        const y = cy + b.v * bhPx * bk;
                        const br = b.r * bubScale * bk;
                        ctx.moveTo(x + br, y);
                        ctx.arc(x, y, br, 0, Math.PI * 2);
                    }
                    if (!any) continue;
                    const a = (aq / 4) * 0.85;
                    const c = palette.get(role);
                    ctx.strokeStyle = c;
                    if (bubSoft > 0) {
                        ctx.fillStyle = c;
                        ctx.globalAlpha = a * 0.12 * bubSoft;
                        ctx.fill();
                        ctx.lineWidth = bubW * (1 + 8 * bubSoft);
                        ctx.globalAlpha = a * 0.1 * bubSoft;
                        ctx.stroke();
                        ctx.lineWidth = bubW * (1 + 3 * bubSoft);
                        ctx.globalAlpha = a * 0.22 * bubSoft;
                        ctx.stroke();
                    }
                    ctx.lineWidth = bubW;
                    ctx.globalAlpha = a * (1 - 0.55 * bubSoft);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

            // Streaks, additive so overlaps burn toward white.
            //
            // Batched: every spike segment is geometry plus a (colour, alpha)
            // bucket, and each bucket is ONE path and ONE stroke() per pass.
            // 300 spikes x 3 segments x 3 passes stroked individually would be
            // ~2700 draw calls a frame; bucketed it is a few hundred.
            ctx.globalCompositeOperation = "lighter";
            ctx.lineCap = "round";
            const wideW = Math.max(1.2, R * 0.018);
            const thinW = Math.max(0.7, R * 0.008);

            if (!store.seg || store.seg.length !== count * 5) {
                store.seg = new Float32Array(count * 5);     // px, py, tx, ty, full
            }
            const seg = store.seg;
            if (!store.cIdx || store.cIdx.length !== count) store.cIdx = new Uint8Array(count);
            const col = store.cIdx;
            if (!store.dep || store.dep.length !== count) store.dep = new Float32Array(count);
            const dep = store.dep;

            for (let k = 0; k < count; k++) {
                const s = streaks[k];
                const e = energy[k];
                const a = s.angle + spikeRot;
                const ca = Math.cos(a), sa = Math.sin(a);
                // In the ring's own flat frame (before any turn): the point on
                // the ellipse, its outward normal, and the spike's direction —
                // the normal leaned a little so the fringe looks spiky rather
                // than combed.
                let lnx = ca / rx, lny = sa / ry;
                const nl = Math.hypot(lnx, lny) || 1;
                lnx /= nl; lny /= nl;
                const ct = Math.cos(s.tilt), st = Math.sin(s.tilt);
                let dx = lnx * ct - lny * st, dy = lnx * st + lny * ct;
                let ox = rx * ca + lnx * R0 * s.off, oy = ry * sa + lny * R0 * s.off;
                const flick = 0.8 + 0.2 * Math.sin(tSec * s.flickW + s.flickP);
                let full = R * (0.1 * s.base + e * 0.55 * spread * s.len) * flick * punch;
                const o = k * 5;
                if (sideways) {
                    // A real 3D object turned about the ring's short axis (Y),
                    // then projected with perspective. Z points at the viewer.
                    const el = s.el * elMax, cel = Math.cos(el);
                    const Dx = dx * cel, Dy = dy * cel, Dz = Math.sin(el);
                    const Px = ox * q, Pz = -ox * depthK;            // point, turned
                    const Tx = Dx * q + Dz * depthK;                 // direction, turned
                    const Tz = -Dx * depthK + Dz * q;
                    const k0 = persp(Pz);
                    const kt = persp(Pz + Tz * full);
                    const sx = Px * k0, sy = oy * k0;                // projected root
                    let vx = (Px + Tx * full) * kt - sx;             // projected spike
                    let vy = (oy + Dy * full) * kt - sy;
                    const vl = Math.hypot(vx, vy);
                    if (vl > 1e-4) { vx /= vl; vy /= vl; } else { vx = 0; vy = 1; }
                    full = vl;
                    ox = sx; oy = sy; dx = vx; dy = vy;
                    // Nearer is brighter: 1 at the front, 0.45 at the back.
                    dep[k] = 0.725 + 0.275 * Math.max(-1, Math.min(1, Pz / rx));
                } else dep[k] = 1;
                // Then the ring's tilt, a plain screen rotation.
                seg[o]     = cx + ox * cth - oy * sth;
                seg[o + 1] = cy + ox * sth + oy * cth;
                seg[o + 2] = dx * cth - dy * sth;
                seg[o + 3] = dx * sth + dy * cth;
                // Soft knee toward the view's edge: in a short strip a long
                // streak would be cut flat by the clip. Compress it instead,
                // so loud streaks still read as longer, just less so.
                const txx = seg[o + 2], tyy = seg[o + 3];
                const ax = txx > 0 ? rect.x + rect.w - seg[o] : seg[o] - rect.x;
                const ay = tyy > 0 ? rect.y + rect.h - seg[o + 1] : seg[o + 1] - rect.y;
                const room = Math.max(1, Math.min(
                    Math.abs(txx) > 1e-3 ? ax / Math.abs(txx) : Infinity,
                    Math.abs(tyy) > 1e-3 ? ay / Math.abs(tyy) : Infinity) - 2);
                full = room * (1 - Math.exp(-full / room));
                seg[o + 4] = full;

                let idx = 0.28 + 0.7 * e + s.hue + 0.14 * Math.cos(a * 2 - rot * 3);
                idx = idx < 0 ? 0 : idx > 1 ? 1 : idx;
                col[k] = Math.round(idx * (COLOR_STEPS - 1));
            }

            // Passes, widest first. "Softness" adds a broad haze and pulls
            // the bright core back, so neighbouring spikes melt into one
            // another instead of reading as separate lines.
            const soft = p.soft ?? 0.55;
            const wMul = p.width ?? 1.6;
            const passes = [];
            // The haze is one round-capped stroke per spike (segments would
            // bead where their round caps overlap); the other passes are
            // three butt-capped segments so the gradient can run along them.
            // `cool` shifts a pass down the ramp: the faint wide passes sit
            // toward pink and red, as in the reference, because a faint
            // yellow over near-black reads as olive rather than as glow.
            if (soft > 0) passes.push({ haze: true, cool: 0.3, w: wideW * wMul * (1.5 + 3 * soft), a0: 0.02 * soft, a1: 0.09 * soft, len: 0.75 });
            passes.push({ cool: 0.18, w: wideW * wMul, a0: 0.1, a1: 0.22, len: 1 });
            passes.push({ cool: 0, w: thinW * wMul, a0: 0.3 * (1 - 0.6 * soft), a1: 0.6 * (1 - 0.45 * soft), len: 0.7 });

            // Along each spike: three segments from the inner end to the tip.
            // "Gradient" runs the root a little cooler along the spike colours
            // and blends toward the tip colour outward (TIP_MIX); softness
            // fades the tip out.
            const SEG_T = [-1, 0, 0.5, 1];                 // inner end, ring, midpoint, tip
            const SEG_C = [-0.22, 0, 0.06];
            const SEG_A = [0.75, 1, 1 - 0.55 * soft];
            const n = count * SEGS;
            if (!store.key || store.key.length !== n) {
                store.key = new Uint16Array(n);
                store.order = new Uint32Array(n);
            }
            const key = store.key, order = store.order;
            const starts = store.bucketStart || (store.bucketStart = new Uint32Array(BUCKETS + 1));
            const fill = store.fillPos || (store.fillPos = new Uint32Array(BUCKETS));

            for (const pass of passes) {
                starts.fill(0);
                for (let k = 0; k < count; k++) {
                    const e = energy[k];
                    const baseA = (pass.a0 + pass.a1 * e) * dep[k];
                    const c0 = col[k] / (COLOR_STEPS - 1);
                    for (let g = 0; g < SEGS; g++) {
                        if (pass.haze && g !== 1) { key[k * SEGS + g] = 0; starts[1]++; continue; }  // bucket 0 = skipped
                        let c = c0 + SEG_C[g] * grad - pass.cool;
                        c = c < 0 ? 0 : c > 1 ? 1 : c;
                        const cq = Math.round(c * (COLOR_STEPS - 1));
                        let aq = Math.round(baseA * SEG_A[g] * ALPHA_STEPS * 2);   // alpha steps of 0.05
                        aq = aq > ALPHA_STEPS ? ALPHA_STEPS : aq;
                        const kk = (cq * SEGS + g) * (ALPHA_STEPS + 1) + aq;
                        key[k * SEGS + g] = kk;
                        starts[kk + 1]++;
                    }
                }
                for (let b = 0; b < BUCKETS; b++) starts[b + 1] += starts[b];
                fill.set(starts.subarray(0, BUCKETS));
                for (let i = 0; i < n; i++) order[fill[key[i]]++] = i;

                ctx.lineWidth = pass.w;
                ctx.lineCap = pass.haze ? "round" : "butt";
                for (let b = 0; b < BUCKETS; b++) {
                    const b0 = starts[b], b1 = starts[b + 1];
                    if (b0 === b1) continue;
                    const aq = b % (ALPHA_STEPS + 1);
                    if (aq === 0) continue;                  // invisible at this step
                    ctx.strokeStyle = css[(b / (ALPHA_STEPS + 1)) | 0];
                    ctx.globalAlpha = aq / (ALPHA_STEPS * 2);
                    ctx.beginPath();
                    for (let i = b0; i < b1; i++) {
                        const id = order[i], k = (id / SEGS) | 0, g = id - k * SEGS;
                        const o = k * 5;
                        const out = seg[o + 4] * pass.len, inn = out * 0.55;
                        const d0 = pass.haze ? -inn : SEG_T[g] < 0 ? -inn : SEG_T[g] * out;
                        const d1 = pass.haze ? out : SEG_T[g + 1] < 0 ? -inn : SEG_T[g + 1] * out;
                        ctx.moveTo(seg[o] + seg[o + 2] * d0, seg[o + 1] + seg[o + 3] * d0);
                        ctx.lineTo(seg[o] + seg[o + 2] * d1, seg[o + 1] + seg[o + 3] * d1);
                    }
                    ctx.stroke();
                }
            }
            ctx.lineCap = "round";

            // The hot core of the ring. The glow is two wide faint strokes
            // rather than shadowBlur, which costs a blur of the whole path.
            // The core follows the pulse too, but gently: at high "Pulse
            // intensity" a linear core grew into a white band over the spikes.
            const lc = Math.min(1.2, lp);
            const coreW = R * (0.012 + 0.022 * lc);
            ctx.strokeStyle = palette.get("halo.core");
            ctx.beginPath();
            if (sideways) {
                // The ring itself in perspective, as a polyline.
                const N = 120;
                for (let i = 0; i <= N; i++) {
                    const t = (i / N) * Math.PI * 2;
                    const X = rx * Math.cos(t), Y = ry * Math.sin(t);
                    const kk = persp(-X * depthK);
                    const x = X * q * kk, y = Y * kk;
                    const px = cx + x * cth - y * sth, py = cy + x * sth + y * cth;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
            } else {
                ctx.ellipse(cx, cy, Math.max(0.5, Math.abs(rxs)), ry, th, 0, Math.PI * 2);
            }
            if (p.glow !== false) {
                ctx.globalAlpha = Math.min(1, 0.05 + 0.08 * lc);
                ctx.lineWidth = coreW * 2.5 + R * 0.14;
                ctx.stroke();
                ctx.lineWidth = coreW * 2.5 + R * 0.06;
                ctx.stroke();
            }
            ctx.globalAlpha = Math.min(1, 0.12 + 0.25 * lc);
            ctx.lineWidth = coreW * 2.5;
            ctx.stroke();
            ctx.globalAlpha = Math.min(1, 0.25 + 0.4 * lc);
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
        s.streaks = s.energy = s.bubbles = s.spikeCss = s.seg = s.cIdx = s.dep = null;
        s.spikeKey = undefined;
        s.streakKey = undefined;
        s.lastNow = undefined;
    },
};
