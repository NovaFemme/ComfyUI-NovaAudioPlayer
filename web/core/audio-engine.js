/**
 * audio-engine.js — audio element, Web Audio graph, and the per-frame signal bag.
 *
 * Three things moved in here out of the old widget closure, and each fixed
 * something on the way:
 *
 * 1. ONE SHARED AudioContext for the page, not one per node.
 *    Browsers cap the number of AudioContexts (commonly around six); a
 *    workflow with a dozen player nodes would start failing to create them and
 *    the meters would silently go dead.  Every node now hangs its own subgraph
 *    off one context.
 *
 * 2. THE GRAPH IS REGISTERED PER FILE, not per widget.
 *    createMediaElementSource() may only ever be called once for a given media
 *    element.  The old code adopted the existing <audio> element on tab-switch
 *    restore and then called createMediaElementSource() on it again; that
 *    throws InvalidStateError, which the surrounding try/catch swallowed as
 *    "Analyser unavailable" — so after switching tabs and back, the meters,
 *    spectrum, spectrogram and goniometer were all dead until you re-ran the
 *    node.  Caching the whole graph alongside the element fixes it.
 *
 * 3. ONE ANALYSER READ PER TICK, shared by every renderer.
 *    Previously each view branch pulled its own copy, so `combined` performed
 *    the same FFT read two or three times per frame.  update() fills a single
 *    `sig` object at the configured rate and hands the same object to whoever
 *    is drawing.
 *
 * Frozen-frame behaviour falls out of this for free: when playback stops we
 * simply stop overwriting the buffers, so the last captured frame stays in
 * them and renderers can draw it dimmed. No per-renderer snapshot copies.
 */

export const CLIP_THRESHOLD = 0.999969482421875;   // 32767/32768, the true 16-bit ceiling

// ---------------------------------------------------------------------------
// Page-level shared resources
// ---------------------------------------------------------------------------

let _sharedCtx = null;

function sharedContext() {
    if (_sharedCtx && _sharedCtx.state !== "closed") return _sharedCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _sharedCtx = new Ctor();
    return _sharedCtx;
}

/**
 * filename -> { el, source, analyserL, analyserR, gain, splitter, refs }
 *
 * Survives widget teardown, because the module is never unloaded.  `refs`
 * counts live engines so the graph is only torn down when the last one goes.
 */
import { fillDemoSignal } from "./idle-demo.js";

const _graphRegistry = new Map();

// Registry key for the bundled voiceover, one per engine.
//
// Deliberately NOT shared between idle nodes the way a take is. Sharing keys on
// a filename works because those engines share the <audio> element too; an idle
// engine already owns its own element, and pointing two of them at one registry
// entry would have the second adopt analysers fed by the first one's element —
// meters moving to audio coming from somewhere else. Two idle nodes both
// playing a four-second voiceover is a fine thing to allow.
const INTRO_KEY = "__nova_intro__";
let _introSeq = 0;

export function audioUrl(filename) {
    // This pack's own route rather than ComfyUI's /view, because playback needs
    // RANGE requests. A browser playing a long file buffers ahead and asks for
    // later byte ranges as it goes; a server that answers 200-with-everything
    // instead of 206-with-the-slice forces it to start again from the top, and
    // that is heard as a short break mid-track. /nova_player/audio serves
    // through web.FileResponse, which handles Range and streams from disk.
    return `/nova_player/audio/${encodeURIComponent(filename)}?fmt=wav`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class AudioEngine {
    /**
     * @param {string} filename
     * @param {object} opts { stereo, duration, fftSize, smoothing, fps }
     */
    constructor(filename, opts = {}) {
        this.filename = filename;
        this.duration = opts.duration || 0;
        this.stereo = !!opts.stereo;
        this.fftSize = opts.fftSize || 4096;
        this.smoothing = opts.smoothing ?? 0.6;
        this.interval = 1000 / (opts.fps || 30);

        this._volume = 1;
        this._muted = false;
        this._lastUpdate = 0;
        this._clipHold = 0;
        this._peakHold = 0;
        this._peakHoldTime = 0;
        this.peakHoldMs = opts.peakHoldMs ?? 300;

        // The bundled voiceover, played only when someone presses play on an
        // idle node. Resolved from this module's own URL so it works wherever
        // ComfyUI mounts the pack's web directory.
        this.introUrl = new URL("../assets/intro.mp3", import.meta.url).href;

        // IDLE: a node that has never run has no file, and it still draws.
        // Without this the player did not exist at all until the first
        // execution — a freshly placed node was three widgets and a title, so
        // anyone browsing the node library saw a plain box where the point of
        // the pack is what it looks like running.
        //
        // A src-less <audio> is deliberate rather than a null element: 25 call
        // sites touch `this.el`, and an element that exists and does nothing is
        // safer than twenty-five null guards. play() refuses early, so nothing
        // reaches it that would throw.
        this.idle = !filename;
        this.demo = true;            // host turns this off if the user does
        this._demoStart = 0;
        if (this.idle) {
            this.el = new Audio();
            this.el.preload = "none";
        } else {
        // Adopt an existing element for this file if there is one — otherwise a
        // second <audio> starts playing the same file and you hear it twice.
        const existing = _graphRegistry.get(filename);
        if (existing) {
            this.el = existing.el;
            existing.refs++;
        } else {
            this.el = new Audio(audioUrl(filename));
            this.el.preload = "auto";
            this.el.addEventListener("error", () => {
                console.error("[NovaPlayer] audio error:", this.el.error);
            });
            _graphRegistry.set(filename, { el: this.el, refs: 1 });
        }
        }

        // The shared signal bag.  One object, reused every tick; renderers hold
        // a reference to it rather than receiving a fresh allocation per frame.
        this.sig = {
            ready: false,        // the Web Audio graph exists
            hasData: false,      // at least one frame has ever been captured
            playing: false,
            frame: 0,

            freq: null,          // Uint8Array, left-channel byte frequency data
            freqDb: null,        // Float32Array, TRUE dBFS per bin — see below
            timeL: null,         // Float32Array, exact -1..+1 samples
            timeR: null,

            levelL: 0,           // 0..1, RMS mapped through a -60..0 dB window
            levelR: 0,
            peakHold: 0,
            clip: false,

            corrRaw: 0,          // Pearson L/R correlation, unsmoothed

            sampleRate: 44100,
            binCount: 0,
            fftSize: this.fftSize,

            currentTime: 0,
            progress: 0,
            duration: this.duration,
        };

        this._onPlay = () => { this.ensureGraph(); };
        this.el.addEventListener("play", this._onPlay);
    }

    // -- graph ------------------------------------------------------------

    /**
     * Build (or adopt) the Web Audio graph for this file.
     * Idempotent, and safe to call on every play event.
     */
    /** Buffers for the idle demo, shaped exactly like the real analyser's. */
    _ensureDemoBuffers() {
        const bins = this.fftSize / 2;
        const sig = this.sig;
        if (sig.freq && sig.freq.length === bins) return;
        sig.freq = new Uint8Array(bins);
        sig.freqDb = new Float32Array(bins);
        sig.timeL = new Float32Array(this.fftSize);
        sig.timeR = new Float32Array(this.fftSize);
        sig.binCount = bins;
        sig.sampleRate = 48000;
        sig.fftSize = this.fftSize;
        sig.ready = true;
    }

    ensureGraph() {
        // An idle engine has no graph until the intro is loaded; after that it
        // is an ordinary source and the normal path applies.
        if (this.idle && !this.el.src) return false;
        const entry = _graphRegistry.get(this.filename);
        if (entry && entry.analyserL) {
            this._adopt(entry);
            return true;
        }

        const ctx = sharedContext();
        if (!ctx) {
            console.warn("[NovaPlayer] Web Audio is unavailable in this browser");
            return false;
        }

        try {
            // Autoplay policy: a context created before a user gesture starts
            // suspended and every analyser reads zeroes until it is resumed.
            if (ctx.state === "suspended") ctx.resume().catch(() => {});

            const source = ctx.createMediaElementSource(this.el);

            const analyserL = ctx.createAnalyser();
            analyserL.fftSize = this.fftSize;
            analyserL.smoothingTimeConstant = this.smoothing;

            const analyserR = ctx.createAnalyser();
            analyserR.fftSize = this.fftSize;
            analyserR.smoothingTimeConstant = this.smoothing;

            const gain = ctx.createGain();
            gain.gain.value = this._muted ? 0 : this._volume;

            let splitter = null;
            if (this.stereo) {
                // Analysers tap BEFORE the gain node so the meters always show
                // the true signal regardless of the volume slider.
                splitter = ctx.createChannelSplitter(2);
                source.connect(splitter);
                splitter.connect(analyserL, 0);
                splitter.connect(analyserR, 1);
                // Audible path stays un-split so stereo passes through intact.
                source.connect(gain);
            } else {
                source.connect(analyserL);
                source.connect(analyserR);
                source.connect(gain);
            }
            gain.connect(ctx.destination);

            const graph = { el: this.el, source, analyserL, analyserR, gain, splitter,
                            refs: entry ? entry.refs : 1 };
            _graphRegistry.set(this.filename, graph);
            this._adopt(graph);
            return true;
        } catch (e) {
            // The common cause is a second createMediaElementSource() on one
            // element, which the registry above is designed to prevent — if it
            // still happens, say so clearly instead of "analyser unavailable".
            console.warn("[NovaPlayer] could not build the audio graph:", e.message);
            return false;
        }
    }

    _adopt(graph) {
        this.analyserL = graph.analyserL;
        this.analyserR = graph.analyserR;
        this.gain = graph.gain;

        const bins = this.analyserL.frequencyBinCount;
        if (!this.sig.freq || this.sig.freq.length !== bins) {
            this.sig.freq = new Uint8Array(bins);
        }
        if (this.wantFloatFreq && (!this.sig.freqDb || this.sig.freqDb.length !== bins)) {
            this.sig.freqDb = new Float32Array(bins);
        }
        const n = this.analyserL.fftSize;
        if (!this.sig.timeL || this.sig.timeL.length !== n) {
            // Float32, not Uint8: byte time-domain data quantises to ~0.4% of
            // full scale, which trips the clip detector on signals that never
            // actually reached the ceiling.
            this.sig.timeL = new Float32Array(n);
            this.sig.timeR = new Float32Array(n);
        }

        this.sig.ready = true;
        this.sig.binCount = bins;
        this.sig.fftSize = n;
        this.sig.sampleRate = this.analyserL.context.sampleRate;

        this.gain.gain.value = this._muted ? 0 : this._volume;
    }

    // -- transport --------------------------------------------------------

    get playing() { return !this.el.paused && !this.el.ended; }
    get currentTime() { return this.el.currentTime; }

    play() {
        // An idle node plays the pack's own voiceover — a real file through
        // the real analyser, so the visualisers are showing an actual signal
        // rather than the synthetic one they animate with. It loads on the
        // FIRST PRESS and never before: a node dropped into a graph must not
        // fetch anything, and autoplay policy would refuse it anyway. The
        // press is the gesture that makes it legal, which is also why this
        // cannot happen without the user asking for it.
        if (this.idle && !this.el.src) {
            this.el.src = this.introUrl;
            this.el.preload = "auto";
            this.filename = `${INTRO_KEY}:${++_introSeq}`;
        }
        this.ensureGraph();
        const ctx = sharedContext();
        if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
        return this.el.play().catch(e => {
            console.error("[NovaPlayer] play() failed:", e.message);
        });
    }

    pause() { this.el.pause(); }

    toggle() { return this.el.paused ? this.play() : this.pause(); }

    seekTo(seconds) {
        const d = this.duration || this.el.duration || 0;
        this.el.currentTime = Math.max(0, Math.min(d, seconds));
    }

    seekFraction(frac) {
        this.seekTo(Math.max(0, Math.min(1, frac)) * (this.duration || 0));
    }

    skip(delta) { this.seekTo(this.el.currentTime + delta); }

    setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        // The element stays at full volume; the gain node does the work, so
        // the analysers keep seeing the true signal.
        this.el.volume = 1;
        if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume;
    }

    setMuted(m) {
        this._muted = !!m;
        this.el.muted = false;             // mute via gain, not the element
        if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume;
    }

    setLooping(l) { this.el.loop = !!l; }

    // -- per-frame update -------------------------------------------------

    /**
     * Refresh `sig`.  Cheap to call every animation frame: the analyser reads
     * are rate-limited internally to the configured fps, and everything else
     * is a handful of assignments.
     *
     * @returns {object} the shared signal bag
     */
    update(now = performance.now()) {
        const sig = this.sig;
        sig.playing = this.playing;
        sig.currentTime = this.el.currentTime;
        sig.duration = this.duration || this.el.duration || 0;
        sig.progress = sig.duration > 0 ? Math.min(sig.currentTime / sig.duration, 1) : 0;

        // The clip LED's hold timer must expire on wall-clock time, not on the
        // analyser tick, or a 1 s hold outlives its welcome at low frame rates.
        sig.clip = (now - this._clipHold) < 1000;

        // An idle node draws synthetic material so the visualisers move — see
        // idle-demo.js. Throttled harder than the real path (15 fps against 30)
        // because a graph can hold a dozen idle players and not one of them is
        // showing anything anybody is measuring.
        // Playing the intro is real audio through the real analyser: fall
        // through to the measurement path. The synthetic demo is only for a
        // node that is sitting there doing nothing.
        if (this.idle && !(this.playing && sig.ready)) {
            if (!this.demo) return sig;
            if (now - this._lastUpdate < 66) return sig;
            this._lastUpdate = now;
            if (!this._demoStart) this._demoStart = now;
            this._ensureDemoBuffers();
            fillDemoSignal(sig, (now - this._demoStart) / 1000);
            return sig;
        }

        if (!sig.ready) return sig;

        // Paused: leave every buffer holding its last captured frame so
        // renderers can draw a frozen view. Peak hold still decays.
        if (!sig.playing) {
            this._decayPeak(now, false);
            sig.peakHold = this._peakHold;
            return sig;
        }

        if (now - this._lastUpdate < this.interval) {
            this._decayPeak(now, true);
            sig.peakHold = this._peakHold;
            return sig;
        }
        this._lastUpdate = now;

        this.analyserL.getByteFrequencyData(sig.freq);

        // Byte frequency data is a linear map of DECIBELS over
        // minDecibels..maxDecibels (-100..-30 by default), and it CLAMPS: every
        // bin quieter than -100 dBFS reads 0 and becomes indistinguishable.
        // On a produced track at around -18 LUFS a 4096-point FFT spreads the
        // energy so thinly that most bins above the low mids sit below that
        // floor, so anything computing a weighted average over the spectrum
        // gets a badly distorted answer. The float call returns the true dBFS
        // per bin with no clamp — measurably worth it, so renderers that do
        // spectral arithmetic ask for it. Only filled when one is active,
        // because it is a second full read of the FFT every analyser tick.
        if (this.wantFloatFreq) {
            if (!sig.freqDb || sig.freqDb.length !== sig.freq.length) {
                sig.freqDb = new Float32Array(sig.freq.length);
            }
            this.analyserL.getFloatFrequencyData(sig.freqDb);
        }

        this.analyserL.getFloatTimeDomainData(sig.timeL);
        this.analyserR.getFloatTimeDomainData(sig.timeR);
        sig.hasData = true;
        sig.frame++;

        const L = sig.timeL, R = sig.timeR, n = L.length;

        // One pass for clip, RMS and correlation — the old code walked these
        // buffers separately in three different places.
        let clipping = false;
        let sumL2 = 0, sumR2 = 0, sumLR = 0;
        const step = Math.max(1, Math.floor(n / 512));

        for (let i = 0; i < n; i++) {
            const lv = L[i];
            if (lv >= CLIP_THRESHOLD || lv <= -CLIP_THRESHOLD) { clipping = true; break; }
        }
        if (!clipping) {
            for (let i = 0; i < n; i++) {
                const rv = R[i];
                if (rv >= CLIP_THRESHOLD || rv <= -CLIP_THRESHOLD) { clipping = true; break; }
            }
        }
        if (clipping) this._clipHold = now;
        sig.clip = (now - this._clipHold) < 1000;

        // Full-resolution RMS (accurate), strided correlation (cheap, and the
        // needle is smoothed downstream anyway).
        let rmsL = 0, rmsR = 0;
        for (let i = 0; i < n; i++) { rmsL += L[i] * L[i]; rmsR += R[i] * R[i]; }
        rmsL = Math.sqrt(rmsL / n);
        rmsR = Math.sqrt(rmsR / n);

        for (let i = 0; i < n; i += step) {
            const lv = L[i], rv = R[i];
            sumLR += lv * rv;
            sumL2 += lv * lv;
            sumR2 += rv * rv;
        }
        const denom = Math.sqrt(sumL2 * sumR2);
        sig.corrRaw = denom > 0.0001 ? Math.max(-1, Math.min(1, sumLR / denom)) : 0;

        sig.levelL = rmsToLevel(rmsL);
        sig.levelR = rmsToLevel(rmsR);

        const peak = Math.max(sig.levelL, sig.levelR);
        if (peak > this._peakHold) {
            this._peakHold = peak;
            this._peakHoldTime = now;
        } else {
            this._decayPeak(now, true);
        }
        sig.peakHold = this._peakHold;

        return sig;
    }

    _decayPeak(now, isPlaying) {
        if (this._peakHold <= 0) return;
        if (now - this._peakHoldTime < this.peakHoldMs) return;
        this._peakHold *= isPlaying ? 0.99 : 0.92;
        if (this._peakHold < 0.001) this._peakHold = 0;
    }

    // -- teardown ---------------------------------------------------------

    /**
     * Release this engine.  The shared AudioContext is never closed — other
     * nodes are using it — and the per-file graph is only torn down when the
     * last engine referencing it goes away.
     */
    dispose() {
        this.el.removeEventListener("play", this._onPlay);

        const entry = _graphRegistry.get(this.filename);
        if (!entry) return;

        entry.refs--;
        if (entry.refs > 0) return;

        try { this.el.pause(); } catch {}
        try { this.el.src = ""; } catch {}

        for (const node of [entry.source, entry.analyserL, entry.analyserR,
                            entry.gain, entry.splitter]) {
            try { node && node.disconnect(); } catch {}
        }
        _graphRegistry.delete(this.filename);

        this.analyserL = this.analyserR = this.gain = null;
        this.sig.ready = false;
        this.sig.freq = this.sig.timeL = this.sig.timeR = null;
    }
}

/**
 * RMS amplitude -> 0..1 meter position over a -60..0 dB window.
 * Anything quieter than -60 dBFS reads as off; 0 dBFS reads as full scale.
 */
export function rmsToLevel(rms) {
    if (rms < 0.0001) return 0;
    const db = 20 * Math.log10(rms);
    return Math.max(0, Math.min(1, (db + 60) / 60));
}
