/**
 * config.js — one shared client for the server's configuration.
 *
 * Every player node on the page reads from this single store rather than
 * fetching its own copy: the config is global, only the per-node overrides
 * differ.  A change made in one node's settings panel therefore reaches every
 * other node on the next poll without any cross-node wiring.
 *
 * Live reload works by polling GET /nova_player/config/version, which returns
 * a single integer.  Only when that integer moves do we re-fetch the full
 * snapshot.  Polling runs only while something is subscribed, and stops when
 * the last player node goes away.
 */

import { resolvePalette, setDefaultMixSpace } from "./color.js";
import { setBarRelief, setTextScale } from "./gfx.js";

const BASE = "/nova_player";
const POLL_MS = 4000;

const FALLBACK = {
    version: 0,
    baseTheme: "nova-dark",
    activeTheme: "nova-dark",
    themes: {
        "nova-dark": {
            label: "Nova Dark (built-in fallback)",
            // Deliberately minimal.  If we are using this, the server is
            // unreachable, and the point is that the node still draws.
            roles: {
                "surface": "#00000033",
                "text": "#c8c8e8",
                "text.dim": "#cbcbcb",
                "divider": "#ffffff14",
                "wave.idle": "#610042",
                "wave.idle.right": "#4d3221",
                "wave.left": "#6c63ff",
                "wave.left.pulse": "#d9d6ff",
                "wave.right": "#cea12f",
                "wave.right.pulse": "#fff0d6",
                "wave.label": "#232e74",
                "wave.label.bg": "#0000008c",
                "playhead": "#ffffff",
                "btn.bg": "#1a1a7e",
                "btn.active": "#232e74",
                "btn.icon": "#ffffff",
                "scrub.bg": "#bab041",
                "scrub.fill": "#6c63ff",
                "vol.track": "#702525",
                "vol.fill": "#efefef",
                "vol.knob": "#efefef",
                "speaker.muted": "#e05555",
                "hover.glow": "#a89fff",
                "meter.green.lit": "#3ecf5c",
                "meter.green.dim": "#1a2e1e",
                "meter.yellow.lit": "#d4c94a",
                "meter.yellow.dim": "#2a2a1a",
                "meter.red.lit": "#e05555",
                "meter.red.dim": "#2e1a1a",
                "meter.peak": "#ffffff",
                "clip.led": "#ff3b3b",
                "clip.highlight": "#ffb4b4b3",
                "spectrum.fill.low": "#6c63ffaa",
                "spectrum.fill.high": "#cea12f",
                "spectrum.rim": "#ffffff",
                "spectrum.rim.glow": "#ffffff66",
                "spectrum.label.bg": "#00000080",
                "spectrum.label.rule": "#ffffff1a",
                "spectrum.label.text": "#ffffff",
                "gonio.bg": "#00121ceb",
                "gonio.ring": "#00c8ff1f",
                "gonio.ring.outer": "#00c8ff40",
                "gonio.border": "#610042",
                "gonio.grid": "#00c8ff33",
                "gonio.trace": "#00dcffd9",
                "gonio.trace.glow": "#00e6ffb3",
                "gonio.trace.frozen": "#00b4d273",
                "gauge.box.bg": "#00000033",
                "gauge.box.border": "#610042",
                "gauge.needle": "#bbbbbb",
                "gauge.needle.tip": "#ffffff",
                "gauge.pivot": "#ffffff",
                "gauge.title": "#c8c8dc66",
                "gauge.readout.pos": "#aaddaa",
                "gauge.readout.neg": "#ff5555",
                "gauge.seg.green": "#22aa22",
                "gauge.seg.lime": "#88cc00",
                "gauge.seg.yellow": "#cccc00",
                "gauge.seg.orange": "#cc6600",
                "gauge.seg.red": "#cc2222",
                "spectrogram.bg": "#000000",
                "spectrogram.grid": "#ffffff2e",
                "spectrogram.label": "#ffffff80",
                "mode.text": "#ffffff",
                "mode.border": "#ffffff",
                "mode.waveform": "#be5504",
                "mode.eq": "#3a5311",
                "mode.analyzer": "#017da2",
                "mode.spectrogram": "#4b0082",
                "mode.combined": "#1a4a3a",
                "panel.bg": "#12101acc",
                "panel.surface": "#1b1723",
                "panel.border": "#3d3550",
                "panel.text": "#ede9f2",
                "panel.text.dim": "#847b96",
                "panel.accent": "#6c63ff",
            },
            ramps: {
                spectrogram: [
                    [0, "#000000"], [40, "#14003c"], [80, "#500078"],
                    [120, "#b40028"], [160, "#dc2800"], [200, "#ff8c00"],
                    [230, "#ffdc00"], [255, "#ffffff"],
                ],
            },
        },
    },
    renderers: {},
    system: {},
};

class ConfigStore {
    constructor() {
        this.data = FALLBACK;
        this.loaded = false;
        this._listeners = new Set();
        this._pollTimer = null;
        this._inFlight = null;
        this._paletteCache = new Map();   // overrideKey -> { version, palette }
    }

    // -- loading ----------------------------------------------------------

    /** Fetch the full snapshot. Concurrent calls share one request. */
    async load() {
        if (this._inFlight) return this._inFlight;

        this._inFlight = (async () => {
            try {
                const resp = await fetch(`${BASE}/config`, { cache: "no-store" });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                if (!json || typeof json !== "object" || !json.themes) {
                    throw new Error("malformed config payload");
                }
                this.data = json;
                this.loaded = true;
                // Colour mixing space is global, so apply it before any
                // palette is resolved against the new data.
                setDefaultMixSpace((json.system?.appearance || {}).color_mixing || "srgb");
                setTextScale((json.system?.appearance || {}).text_scale ?? 1);
                setBarRelief((json.system?.appearance || {}).bar_relief ?? 0.55);
                this._paletteCache.clear();
                this._emit();
            } catch (e) {
                // Not fatal: FALLBACK keeps the node drawing.  Logged once per
                // failure so a genuinely broken server is visible.
                console.warn("[NovaPlayer] config unavailable, using built-in defaults:", e.message);
            } finally {
                this._inFlight = null;
            }
            return this.data;
        })();

        return this._inFlight;
    }

    /** Poll the cheap version endpoint; re-fetch only when it moves. */
    async _checkVersion() {
        try {
            const resp = await fetch(`${BASE}/config/version`, { cache: "no-store" });
            if (!resp.ok) return;
            const { version } = await resp.json();
            if (version !== this.data.version) await this.load();
        } catch {
            // Silent: a poll failure is not worth a console line every 4s.
        }
    }

    // -- subscription -----------------------------------------------------

    /**
     * Register a callback fired whenever the config changes.
     * Returns an unsubscribe function.  Polling starts with the first
     * subscriber and stops with the last, so a page with no player nodes
     * makes no requests.
     */
    subscribe(fn) {
        this._listeners.add(fn);
        if (!this.loaded && !this._inFlight) this.load();
        if (this._listeners.size === 1 && !this._pollTimer) {
            this._pollTimer = setInterval(() => this._checkVersion(), POLL_MS);
        }
        return () => {
            this._listeners.delete(fn);
            if (this._listeners.size === 0 && this._pollTimer) {
                clearInterval(this._pollTimer);
                this._pollTimer = null;
            }
        };
    }

    _emit() {
        for (const fn of this._listeners) {
            try { fn(this.data); } catch (e) { console.error("[NovaPlayer] config listener:", e); }
        }
    }

    // -- reads ------------------------------------------------------------

    get themes()      { return this.data.themes || {}; }
    get activeTheme() { return this.data.activeTheme || this.data.baseTheme || "nova-dark"; }
    get baseTheme()   { return this.data.baseTheme || "nova-dark"; }
    get system()      { return this.data.system || {}; }

    /** A UI default with a caller-supplied fallback. */
    ui(key, fallback) {
        const v = (this.system.ui_defaults || {})[key];
        return v === undefined ? fallback : v;
    }

    audio(key, fallback) {
        const v = (this.system.audio_engine || {})[key];
        return v === undefined ? fallback : v;
    }

    /** An app-level appearance preference (text scale, colour mixing). */
    appearance(key, fallback) {
        const v = (this.system.appearance || {})[key];
        return v === undefined ? fallback : v;
    }

    /**
     * Resolved palette for a node.
     *
     * Cached on (override identity + config version), so the expensive work —
     * parsing ~76 roles and building the ramps — happens once per theme change
     * rather than once per frame.  This is what the old module-level PULSE
     * constants could never do.
     */
    palette(overrides = null, themeName = null) {
        const name = themeName || this.activeTheme;
        const key = name + "|" + (overrides ? JSON.stringify(overrides) : "");
        const hit = this._paletteCache.get(key);
        if (hit && hit.version === this.data.version) return hit.palette;

        const palette = resolvePalette(
            this.themes, name, this.baseTheme, overrides,
            (this.system.appearance || {}).color_mixing || "srgb",
        );
        this._paletteCache.set(key, { version: this.data.version, palette });
        return palette;
    }

    /** Renderer params: server values, then per-node overrides. */
    rendererParams(id, overrides = null) {
        const server = (this.data.renderers || {})[id] || {};
        const local = (overrides && overrides.renderers && overrides.renderers[id]) || {};
        return { ...server, ...local };
    }

    // -- writes -----------------------------------------------------------

    async _post(path, body) {
        try {
            const resp = await fetch(`${BASE}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok) return { ok: false, message: json.message || `HTTP ${resp.status}` };
            await this.load();
            return { ok: true, message: json.message || "Saved" };
        } catch (e) {
            return { ok: false, message: e.message };
        }
    }

    saveTheme(name, theme, makeActive = false) {
        return this._post("/config/theme", { name, theme, makeActive });
    }

    setActiveTheme(name) {
        return this._post("/config/active-theme", { name });
    }

    saveAppearance(values) {
        return this._post("/config/appearance", values);
    }

    saveRenderer(id, params) {
        return this._post(`/config/renderer/${encodeURIComponent(id)}`, params);
    }

    async deleteTheme(name) {
        try {
            const resp = await fetch(`${BASE}/config/theme/${encodeURIComponent(name)}`,
                                    { method: "DELETE" });
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok) return { ok: false, message: json.message || `HTTP ${resp.status}` };
            await this.load();
            return { ok: true, message: json.message || "Deleted" };
        } catch (e) {
            return { ok: false, message: e.message };
        }
    }
}

export const config = new ConfigStore();
