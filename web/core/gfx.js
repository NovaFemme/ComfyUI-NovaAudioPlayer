/**
 * gfx.js — shared drawing primitives and the per-frame context object.
 *
 * The `gfx` object is what a renderer receives instead of the widget closure it
 * used to read from directly.  It carries exactly what a renderer is allowed to
 * touch: a 2D context, a resolved palette, its own merged params, and a private
 * `store` for offscreen buffers.  Anything not on this object is, by design,
 * not a renderer's business.
 *
 * `store` is the mechanism that keeps the offscreen caches alive across frames
 * without leaking them into module scope. Each renderer instance gets its own,
 * and a composite renderer gets a nested one per child (see child()).
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Rounded rectangle path. Does not fill or stroke. */
export function rr(ctx, x, y, w, h, r) {
    if (h <= 0 || w <= 0) return;
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

/** Speaker glyph, with a red cross when muted. */
export function drawSpeaker(ctx, cx, cy, sz, muted, color, mutedColor) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - sz * 0.5, cy - sz * 0.28);
    ctx.lineTo(cx - sz * 0.1, cy - sz * 0.28);
    ctx.lineTo(cx + sz * 0.3, cy - sz * 0.65);
    ctx.lineTo(cx + sz * 0.3, cy + sz * 0.65);
    ctx.lineTo(cx - sz * 0.1, cy + sz * 0.28);
    ctx.lineTo(cx - sz * 0.5, cy + sz * 0.28);
    ctx.closePath();
    ctx.fill();

    if (!muted) {
        ctx.beginPath();
        ctx.arc(cx + sz * 0.3, cy, sz * 0.42, -Math.PI * 0.42, Math.PI * 0.42);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + sz * 0.3, cy, sz * 0.7, -Math.PI * 0.38, Math.PI * 0.38);
        ctx.stroke();
    } else {
        ctx.strokeStyle = mutedColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx + sz * 0.4, cy - sz * 0.4);
        ctx.lineTo(cx + sz * 0.9, cy + sz * 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + sz * 0.9, cy - sz * 0.4);
        ctx.lineTo(cx + sz * 0.4, cy + sz * 0.4);
        ctx.stroke();
    }
    ctx.restore();
}

/** Gear glyph for the settings button. */
export function drawGear(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    const teeth = 8;
    const inner = r * 0.52;
    const outer = r * 0.92;
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
        const a = (i / (teeth * 2)) * Math.PI * 2;
        const rad = i % 2 === 0 ? outer : inner;
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    // Hub, punched out so the glyph reads as a gear at 20 px.
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/** "1:23" or, while scrubbing, "1:23.4". */
export function fmtTime(seconds, showMs = false) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (showMs) {
        const ms = Math.floor((seconds % 1) * 10);
        return `${mins}:${String(secs).padStart(2, "0")}.${ms}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Draw the widest message from `options` that fits in `maxW`.
 * Replaces four hand-written copies of the same "pick a label that fits"
 * logic that had drifted to different message lists.
 */
export function fitText(ctx, options, maxW) {
    for (const msg of options) {
        if (ctx.measureText(msg).width <= maxW - 8) return msg;
    }
    return options[options.length - 1];
}

/** Centred placeholder for a renderer with no data yet. */
export function drawPlaceholder(ctx, rect, options, color, fontSize = 10) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.font = `italic ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(fitText(ctx, options, rect.w), rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();
}

/** Run `fn` with the context clipped to `rect`, always restoring. */
export function clipped(ctx, rect, fn) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    try { fn(); } finally { ctx.restore(); }
}

// ---------------------------------------------------------------------------
// Frequency-data units
// ---------------------------------------------------------------------------
//
// sig.freq comes from AnalyserNode.getByteFrequencyData(): unsigned BYTES,
// 0-255, NOT decibels and NOT a linear magnitude. The analyser has already
// mapped [minDecibels, maxDecibels] onto that byte range for you.
//
// Treating a byte as if it were dB is the single easiest mistake to make here,
// and it fails quietly rather than loudly: `20 * Math.log10(byte)` yields 0..48,
// which is above every sensible ceiling, so the display pins to full scale and
// looks "active" instead of looking broken. Use these helpers instead.

/** AnalyserNode defaults. Change only if you also change the analyser. */
export const DB_MIN = -100;
export const DB_MAX = -30;

/** Byte (0-255) -> decibels, matching the analyser's own mapping. */
export function byteToDb(v) {
    return DB_MIN + (v / 255) * (DB_MAX - DB_MIN);
}

/** Byte (0-255) -> 0..1. Use this when you want a magnitude, not a level. */
export function byteToNorm(v) {
    return v / 255;
}

/** Decibels -> 0..1 across an explicit window, clamped. */
export function dbToNorm(db, floorDb = -90, ceilDb = 0) {
    const t = (db - floorDb) / (ceilDb - floorDb);
    return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Frame-rate independent smoothing coefficient.
 *
 * `factor` is the fraction of the old value retained per 60th of a second, so
 * the same setting behaves identically at 30, 60 or 144 fps. Without this an
 * exponential smoother is really "per frame", and a meter's ballistics change
 * with the monitor.
 */
export function smoothingAlpha(factor, dtSeconds) {
    const f = Math.max(0, Math.min(0.999, factor));
    if (!(dtSeconds > 0)) return 1 - f;
    return 1 - Math.pow(f, dtSeconds * 60);
}

// ---------------------------------------------------------------------------
// The gfx object
// ---------------------------------------------------------------------------

/**
 * Build the per-frame context handed to renderers.
 *
 * @param {object} o { ctx, palette, params, store, peaks, stereo, layout, phase, dpr, now }
 */
export function makeGfx(o) {
    return {
        ctx: o.ctx,
        palette: o.palette,
        params: o.params || {},
        store: o.store,
        peaks: o.peaks,
        stereo: o.stereo,
        layout: o.layout,
        phase: o.phase || 0,
        dpr: o.dpr || 1,
        // Wall-clock timestamp for this frame, in ms. Renderers that animate
        // must derive motion from this rather than from "one step per frame",
        // or they run at whatever rate the monitor happens to be. Injectable
        // so a test can drive a renderer at a simulated frame rate.
        now: o.now ?? 0,
        registry: o.registry || null,

        /**
         * Merged params for ANOTHER renderer, by id.
         * A composite needs its children's settings, not its own, and it must
         * not have to know how the config store is layered to get them.
         */
        childParams(id) {
            return o.paramsFor ? o.paramsFor(id) : {};
        },

        /**
         * A child gfx for a delegated renderer.  Used by `combined`: each child
         * gets its own params and its own nested store slot, so a composite can
         * host the same renderer the full-size view uses without the two
         * fighting over one offscreen buffer.
         */
        child(id, params) {
            if (!this.store.__children) this.store.__children = {};
            if (!this.store.__children[id]) this.store.__children[id] = {};
            return makeGfx({
                ...o,
                params: params || this.params,
                store: this.store.__children[id],
                phase: this.phase,
                registry: this.registry,
            });
        },
    };
}

/** Create a same-size offscreen canvas, reusing one from `store` if present. */
export function offscreen(store, key, w, h, opts = {}) {
    const slot = store[key];
    if (slot && slot.canvas.width === w && slot.canvas.height === h) return slot;

    const canvas = (slot && slot.canvas) || document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", opts);
    const created = { canvas, ctx, w, h };
    store[key] = created;
    return created;
}


// ---------------------------------------------------------------------------
// Text scale
// ---------------------------------------------------------------------------
//
// Every font size in this codebase is a literal in a `ctx.font = "9px ..."`
// string, chosen when the node was designed against a 1080p screen. On a 1440p
// or 4K display those literals are physically tiny.
//
// Rather than route two dozen call sites through a helper — which would still
// miss any renderer added later — the host intercepts assignment to
// `ctx.font` and rescales the px figure on the way through. One place, and a
// renderer someone writes tomorrow is scaled without knowing this exists.

let _textScale = 1;

/** Current global text scale. */
export function textScale() { return _textScale; }

/** Set the global text scale. Clamped to a range that stays legible. */
export function setTextScale(v) {
    const n = Number(v);
    _textScale = Number.isFinite(n) ? Math.max(0.6, Math.min(2.5, n)) : 1;
    return _textScale;
}

/** Scale a size that has to track the text, e.g. a row height or a padding. */
export function scaled(px) { return px * _textScale; }

// Matches the px size in a CSS font shorthand: optional style/weight words,
// then a number with optional decimals, then "px".
const FONT_PX = /(\d*\.?\d+)px/;

/** Rescale the px size inside a CSS font shorthand. */
export function scaleFontString(font) {
    if (_textScale === 1 || typeof font !== "string") return font;
    return font.replace(FONT_PX, (m, size) => `${(parseFloat(size) * _textScale).toFixed(2)}px`);
}

/**
 * Make `ctx.font = "9px sans-serif"` apply the global text scale.
 *
 * The getter returns what the canvas actually holds (the scaled value), which
 * is what any code measuring text needs. Idempotent: calling it twice on the
 * same context does not double-scale, because the second call finds its own
 * marker and returns.
 */
export function patchFontScaling(ctx) {
    if (!ctx || ctx.__novaFontPatched) return ctx;

    // The descriptor lives on the prototype, not the instance.
    let proto = Object.getPrototypeOf(ctx);
    let desc = null;
    while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, "font");
        proto = Object.getPrototypeOf(proto);
    }
    if (!desc || !desc.set) return ctx;   // exotic context: leave it alone

    Object.defineProperty(ctx, "font", {
        configurable: true,
        enumerable: false,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, scaleFontString(v)); },
    });
    Object.defineProperty(ctx, "__novaFontPatched", {
        value: true, enumerable: false, configurable: true,
    });
    return ctx;
}


// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------
//
// One helper every bar in the player goes through, so a level meter, a band
// share and a spectrum column all get the same treatment and a renderer added
// later inherits it for free.
//
// THE SHADING IS DERIVED, NOT AUTHORED. A bar is lit as a cylinder: a light
// edge, the pure theme colour a third of the way across, and a shaded far
// edge, with the gradient running across the bar's SHORT axis so a horizontal
// bar is lit top-to-bottom and a vertical one left-to-right. The light and
// shade are computed from the bar's own colour, so every theme and every
// user-picked colour gets a coherent result with nothing to configure.
//
// Alpha is preserved throughout: `#6c63ffaa` stays 67% transparent, it just
// gains relief. Mixing toward opaque white would quietly make translucent
// bars solid.

const _barCache = new Map();
const BAR_CACHE_LIMIT = 96;

/** Relief strength, 0 = flat fill, 1 = maximum. Set from the appearance config. */
let _barRelief = 0.55;

export function barRelief() { return _barRelief; }
export function setBarRelief(v) {
    const n = Number(v);
    _barRelief = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.55;
    _barCache.clear();       // every cached gradient was built for the old value
    return _barRelief;
}

/**
 * Corner radius for a bar, in px.
 *
 * Proportional to the short side and capped, so a 3 px spectrum column is not
 * rounded into a lozenge and a 40 px meter does not look like a pill. Below
 * 3 px there is no radius at all: rounding something that thin just eats it.
 */
export function barRadius(w, h, max = 4) {
    const short = Math.min(Math.abs(w), Math.abs(h));
    if (short < 3) return 0;
    return Math.min(max, short * 0.28, Math.abs(w) / 2, Math.abs(h) / 2);
}

/**
 * Fill style giving `color` a cylindrical relief across the short axis.
 *
 * Cached on colour + span + orientation: a 64-band spectrum at 60 fps would
 * otherwise build 3840 gradient objects a second, which is exactly the kind of
 * per-frame allocation the rest of this codebase avoids.
 */
export function barFill(ctx, x, y, w, h, color, vertical = null) {
    if (_barRelief <= 0.001) return color;

    const isVertical = vertical === null ? Math.abs(h) >= Math.abs(w) : vertical;
    const span = Math.round(isVertical ? Math.abs(w) : Math.abs(h));
    if (span < 2) return color;

    const key = `${color}|${span}|${isVertical ? 1 : 0}|${_barRelief.toFixed(3)}`;
    let stops = _barCache.get(key);

    if (!stops) {
        const base = parseColor(color);
        if (!base) return color;

        // Light and shade are the SAME colour pushed toward white and black,
        // keeping its alpha. Mixing in RGB rather than the theme's configured
        // space on purpose: this is a lighting effect on one colour, not a
        // blend between two, and sRGB is what reads as "shiny" to the eye.
        const lift = 0.42 * _barRelief;
        const drop = 0.34 * _barRelief;
        const lightC = mixKeepAlpha(base, { r: 255, g: 255, b: 255 }, lift);
        const darkC = mixKeepAlpha(base, { r: 0, g: 0, b: 0 }, drop);
        const edgeC = mixKeepAlpha(base, { r: 0, g: 0, b: 0 }, drop * 1.35);

        stops = [
            [0, edgeC],
            [0.10, lightC],
            [0.38, colorToCss(base)],
            [0.88, darkC],
            [1, edgeC],
        ];
        if (_barCache.size >= BAR_CACHE_LIMIT) {
            _barCache.delete(_barCache.keys().next().value);
        }
        _barCache.set(key, stops);
    }

    const g = isVertical
        ? ctx.createLinearGradient(x, y, x + w, y)
        : ctx.createLinearGradient(x, y, x, y + h);
    for (const [at, css] of stops) g.addColorStop(at, css);
    return g;
}

/**
 * Draw one bar: rounded, with derived relief.
 *
 * Negative width or height is normalised, so a caller that grew a bar upward
 * from a baseline does not have to think about it.
 */
export function drawBar(ctx, x, y, w, h, color, opts = {}) {
    let bx = x, by = y, bw = w, bh = h;
    if (bw < 0) { bx += bw; bw = -bw; }
    if (bh < 0) { by += bh; bh = -bh; }
    if (bw <= 0 || bh <= 0) return;

    const r = opts.radius !== undefined
        ? Math.min(opts.radius, bw / 2, bh / 2)
        : barRadius(bw, bh, opts.maxRadius);

    ctx.save();
    ctx.fillStyle = barFill(ctx, bx, by, bw, bh, color, opts.vertical);
    if (r > 0) {
        rr(ctx, bx, by, bw, bh, r);
        ctx.fill();
    } else {
        ctx.fillRect(bx, by, bw, bh);
    }
    ctx.restore();
}

// -- small colour helpers, kept local so gfx.js stays dependency-free --------

function parseColor(css) {
    if (typeof css !== "string") return null;
    const s = css.trim();

    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split("").map(c => c + c).join("");
        }
        if (hex.length !== 6 && hex.length !== 8) return null;
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
    }

    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean);
        if (parts.length < 3) return null;
        const num = (v, scale) => {
            const t = v.trim();
            return t.endsWith("%") ? (parseFloat(t) / 100) * scale : parseFloat(t);
        };
        return {
            r: num(parts[0], 255), g: num(parts[1], 255), b: num(parts[2], 255),
            a: parts.length > 3 ? num(parts[3], 1) : 1,
        };
    }
    return null;
}

function colorToCss(c) {
    const to = v => Math.max(0, Math.min(255, Math.round(v)));
    return c.a >= 1
        ? `rgb(${to(c.r)}, ${to(c.g)}, ${to(c.b)})`
        : `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${Math.max(0, Math.min(1, c.a)).toFixed(4)})`;
}

/** Blend toward a target, keeping the source's alpha — see the note above. */
function mixKeepAlpha(c, target, t) {
    return colorToCss({
        r: c.r + (target.r - c.r) * t,
        g: c.g + (target.g - c.g) * t,
        b: c.b + (target.b - c.b) * t,
        a: c.a,
    });
}
