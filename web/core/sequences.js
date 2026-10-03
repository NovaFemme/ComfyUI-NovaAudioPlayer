/**
 * sequences.js — record a renderer's settings as you play with them, and play
 * the recording back.
 *
 * A standard feature for DECORATIVE renderers: any renderer module that sets
 * `sequences: true` gets it, with no code of its own (see _template.js). The
 * settings drawer shows a "Sequences" section for it; host.js owns one
 * recorder and one player per node.
 *
 * RECORDING is a macro: Start snapshots the renderer's current settings, then
 * every change the user makes through the drawer is logged with the time since
 * the previous one. Stop writes the file. A slider drag is many small changes;
 * they are all kept (that is what makes playback glide rather than jump),
 * except that changes to the same setting closer than MERGE_MS are merged.
 *
 * TIME is the host's sequences clock, which only advances while the song is
 * playing (host._seqNow): pause the music to think, and the thinking is not
 * recorded as a wait; a playing sequence pauses with the music.
 *
 * PLAYBACK applies the start snapshot, then each change after its wait, as a
 * temporary layer over the node's own settings. Nothing is written to the
 * node: when playback ends or is stopped, the node is exactly as it was.
 *
 * FILES CAN COME FROM ANYWHERE — users may copy them into the folder by hand,
 * including ones made for another renderer or an older version. So every
 * setting is checked against the renderer's schema when it is applied: an
 * unknown setting, a value of the wrong type, or one outside the setting's
 * min..max is skipped, and playback carries on to the end.
 */

const BASE = "/nova_player/sequences";

/** Changes to the same setting closer together than this are merged. */
export const MERGE_MS = 30;
/** A recording stops itself here rather than grow without bound. */
export const MAX_STEPS = 20000;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function call(method, path, body) {
    try {
        const resp = await fetch(`${BASE}${path}`, {
            method,
            cache: "no-store",
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        let data = {};
        try { data = await resp.json(); } catch { /* non-JSON error page */ }
        if (!resp.ok || data.status !== "success") {
            return { ok: false, message: data.message || `HTTP ${resp.status}` };
        }
        return { ok: true, ...data };
    } catch (e) {
        return { ok: false, message: String(e && e.message || e) };
    }
}

const seg = s => encodeURIComponent(s);

/** { ok, folder, items: [{ name, steps, duration_ms, error? }] } */
export const listSequences = id => call("GET", `/${seg(id)}`);
/** { ok, sequence } */
export const loadSequence = (id, name) => call("GET", `/${seg(id)}/${seg(name)}`);
/** { ok, name } — the name actually used; a clash becomes "Name (2)". */
export const saveSequence = (id, name, sequence) =>
    call("POST", `/${seg(id)}`, { name, sequence });
export const deleteSequence = (id, name) => call("DELETE", `/${seg(id)}/${seg(name)}`);

/** The same cleaning the server applies, so the UI can warn before saving. */
export function cleanName(name) {
    return String(name || "")
        .replace(/[^0-9A-Za-z _\-.()'&,]/g, "")
        .replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "")
        .slice(0, 80).trim();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The value to apply for one setting, or undefined to skip it.
 *
 * @param {object} schema  the renderer's `params` (registry paramSchema)
 */
export function checkSetting(schema, key, value) {
    const spec = schema && Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : null;
    if (!spec) return undefined;                                   // no such setting
    if (spec.type === "toggle") return typeof value === "boolean" ? value : undefined;
    if (spec.type === "select") {
        if (typeof value !== "string") return undefined;
        const v = (spec.aliases && spec.aliases[value]) || value;
        const opts = (spec.options || []).map(o => (typeof o === "string" ? o : o.value));
        return opts.includes(v) ? v : undefined;
    }
    // range (the default type)
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const min = spec.min ?? -Infinity, max = spec.max ?? Infinity;
    // A hair of tolerance for values that went through a decimal round trip.
    const eps = Math.abs(spec.step || 0) * 1e-6 + 1e-9;
    if (value < min - eps || value > max + eps) return undefined;
    return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export class SequenceRecorder {
    /**
     * @param {string} id        renderer id
     * @param {string} name      file name chosen before Start
     * @param {object} start     the renderer's settings when Start was pressed
     * @param {number} now       ms (performance.now or gfx-style clock)
     */
    constructor(id, name, start, now) {
        this.id = id;
        this.name = name;
        this.start = { ...start };
        this.steps = [];
        this.t0 = now;
        this.lastT = now;
        this.full = false;
    }

    /** Log one change. Returns false once MAX_STEPS is reached. */
    record(key, value, now) {
        if (this.full) return false;
        const wait = Math.max(0, Math.round(now - this.lastT));
        const last = this.steps[this.steps.length - 1];
        if (last && last.key === key && wait < MERGE_MS) {
            last.value = value;                // merge a fast burst on one slider
            return true;
        }
        this.steps.push({ wait_ms: wait, key, value });
        this.lastT = now;
        if (this.steps.length >= MAX_STEPS) this.full = true;
        return !this.full;
    }

    get elapsedMs() { return this.lastT - this.t0; }

    /** The file body. `now` is when Stop was pressed: the hold after the last change. */
    finish(now) {
        return {
            name: this.name,
            created: new Date().toISOString(),
            start: this.start,
            steps: this.steps,
            end_ms: Math.max(0, Math.round(now - this.lastT)),
        };
    }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export class SequencePlayer {
    /**
     * @param {string} id
     * @param {string} name
     * @param {object} sequence   file body (untrusted)
     * @param {object} schema     the renderer's params schema
     * @param {object} opts       { loop: boolean, times: number }
     */
    constructor(id, name, sequence, schema, opts = {}) {
        this.id = id;
        this.name = name;
        this.schema = schema;
        this.loop = !!opts.loop;
        this.times = Math.max(1, Math.floor(opts.times || 1));
        this.skipped = new Set();

        const seq = sequence && typeof sequence === "object" ? sequence : {};
        // Start snapshot and steps, each setting checked once, up front.
        this.start = {};
        const start = seq.start && typeof seq.start === "object" ? seq.start : {};
        for (const [k, v] of Object.entries(start)) {
            const ok = checkSetting(schema, k, v);
            if (ok === undefined) this.skipped.add(k); else this.start[k] = ok;
        }
        this.steps = [];
        let at = 0;
        for (const s of Array.isArray(seq.steps) ? seq.steps : []) {
            if (!s || typeof s !== "object") continue;
            const w = typeof s.wait_ms === "number" && Number.isFinite(s.wait_ms) && s.wait_ms > 0 ? s.wait_ms : 0;
            at += w;                            // a skipped step still takes its time
            const ok = checkSetting(schema, s.key, s.value);
            if (ok === undefined) { this.skipped.add(String(s.key)); continue; }
            this.steps.push({ at, key: s.key, value: ok });
        }
        const end = typeof seq.end_ms === "number" && Number.isFinite(seq.end_ms) && seq.end_ms > 0 ? seq.end_ms : 0;
        // Never zero: a sequence of instant changes still holds for a moment,
        // or looping it would spin the loop without ever yielding a frame.
        this.duration = Math.max(250, at + end);

        this.params = {};
        this.pass = 0;
        this.idx = 0;
        this.passStart = null;
        this.done = false;
    }

    /** Settings the file had that this renderer cannot use. */
    get skippedKeys() { return [...this.skipped]; }

    get progress() {
        return this.passStart === null ? 0 : Math.min(1, this._elapsed / this.duration);
    }

    _beginPass(now) {
        this.params = { ...this.start };
        this.idx = 0;
        this.passStart = now;
    }

    /**
     * Advance to `now` (ms). Returns true if any setting changed.
     * When finished, `done` is set and `params` is left as the final state.
     */
    tick(now) {
        if (this.done) return false;
        let changed = false;
        if (this.passStart === null) { this._beginPass(now); changed = true; }
        // A long stall (hidden tab) can cover several passes; walk them all.
        for (let guard = 0; guard < 1000; guard++) {
            const elapsed = now - this.passStart;
            this._elapsed = elapsed;
            while (this.idx < this.steps.length && this.steps[this.idx].at <= elapsed) {
                const s = this.steps[this.idx++];
                this.params[s.key] = s.value;
                changed = true;
            }
            if (elapsed < this.duration) break;
            this.pass++;
            if (!this.loop && this.pass >= this.times) { this.done = true; break; }
            this.passStart += this.duration;
            this.params = { ...this.start };
            this.idx = 0;
            changed = true;
        }
        return changed;
    }
}
