/**
 * host.js — the player instance: DOM element, render loop, input, state.
 *
 * This is the module that replaces `widget.draw(ctx, node, widget_width, y)`
 * and the six prototype patches around it. What that buys:
 *
 *   - It survives Nodes 2.0. A canvas element we own keeps working however the
 *     node chrome around it is rendered.
 *   - devicePixelRatio. The old code drew at CSS pixels, so on a HiDPI display
 *     the spectrogram and every text label were soft. The backing store is now
 *     scaled and the context pre-transformed, so renderers still work in CSS
 *     pixels and get sharp output for free.
 *   - Real pointer capture. setPointerCapture means a volume or scrub drag
 *     keeps receiving events after the pointer leaves the widget, and always
 *     receives the matching pointerup. The old code persisted the volume value
 *     on every single pointermove specifically to work around losing that
 *     event, and still had a `buttons === 0` guard to catch the case where it
 *     lost it anyway.
 *   - ResizeObserver instead of an onResize patch, with the minimum size
 *     defined once in layout.js rather than in two places that could drift.
 *   - No onConfigure rebuild. The DOM widget instance persists across tab
 *     switches, so there is nothing to reconstruct and no peaks re-fetch.
 */

import { config } from "./config.js";
import { slogan } from "./idle-demo.js";
import { AudioEngine } from "./audio-engine.js";
import { computeLayout, minimumNodeSize } from "./layout.js";
import {
    barRelief, makeGfx, patchFontScaling, setBarRelief, setTextScale, textScale,
} from "./gfx.js";
import { normalise, prune, DEFAULT_STATE } from "./state.js";
import {
    getRenderer, nextRendererId, RENDERER_IDS, defaultParams,
} from "../renderers/registry.js";
import * as chrome from "../ui/chrome.js";
import { drawBenchButton, drawBenchPanel } from "../ui/bench-panel.js";
import { createSettingsPanel } from "../ui/settings-panel.js";
import { showDownloadMenu, closeDownloadMenu, isDownloadMenuOpen } from "../ui/download-menu.js";
import { drawTooltip, tipFor, TOOLTIP_DELAY_MS } from "../ui/tooltips.js";

export class PlayerHost {
    constructor(node, data) {
        this.node = node;
        this.data = data;
        this.peaks = data.peaks || { ch0: [0] };
        this.stereo = !!(data.stereo && this.peaks.ch1);

        this.state = normalise(DEFAULT_STATE, RENDERER_IDS);
        this._stores = new Map();       // rendererId -> persistent store
        this._ripple = { x: 0, y: 0, alpha: 0, color: "#fff" };
        this._hovered = null;
        this._drag = null;              // { kind: "volume" | "scrub", pointerId }
        this._phase = 0;
        this._dirty = true;
        this._raf = null;
        this._destroyed = false;
        this._cssW = 0;
        this._cssH = 0;

        this._buildDom();

        this.engine = new AudioEngine(data.filename, {
            duration: data.duration,
            stereo: data.stereo,
            fftSize: config.audio("fft_size", 4096),
            smoothing: config.audio("smoothing_time_constant", 0.6),
            fps: config.audio("analyser_fps", 30),
            peakHoldMs: config.ui("peak_hold_ms", 300),
        });
        this.engine.setVolume(this.state.volume);
        this.engine.setMuted(this.state.muted);
        this.engine.setLooping(this.state.looping);
        this.engine.demo = config.ui("idle_demo", true) !== false;

        this._textScale = textScale();
        this._unsubscribe = config.subscribe(() => {
            this._palette = null;        // force a re-resolve
            this.engine.demo = config.ui("idle_demo", true) !== false;

            // Text scale changes every glyph metric, so anything that cached a
            // measurement or sized a buffer from one is now wrong.
            if (textScale() !== this._textScale) {
                this._textScale = textScale();
                for (const id of RENDERER_IDS) {
                    const r = getRenderer(id);
                    if (r.resize) { try { r.resize(this._gfxFor(id)); } catch {} }
                }
            }

            this.panel.refresh();
            this.markDirty();
        });

        this._bindEvents();
        this._startLoop();
    }

    // -- DOM ---------------------------------------------------------------

    _buildDom() {
        this.element = document.createElement("div");
        this.element.className = "nova-player";
        Object.assign(this.element.style, {
            position: "relative",
            width: "100%",
            height: "100%",
            minHeight: "160px",
            overflow: "hidden",
            borderRadius: "10px",
            contain: "strict",
        });

        this.canvas = document.createElement("canvas");
        Object.assign(this.canvas.style, {
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",     // we handle drags ourselves
        });
        this.ctx = this.canvas.getContext("2d");
        // Every `ctx.font = "9px ..."` in the codebase — and in any renderer
        // added later — goes through the global text scale from here on.
        patchFontScaling(this.ctx);
        this.element.appendChild(this.canvas);

        this.panel = createSettingsPanel(this._panelController());
        this.element.appendChild(this.panel.element);

        this._resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const box = entry.contentBoxSize?.[0];
                const w = box ? box.inlineSize : entry.contentRect.width;
                const h = box ? box.blockSize : entry.contentRect.height;
                this._resize(w, h);
            }
        });
        this._resizeObserver.observe(this.element);
    }

    /**
     * Graph zoom, as a multiplier on our layout pixels.
     *
     * ComfyUI positions DOM widgets with a CSS transform for zoom. That makes
     * two different "pixels" exist at once:
     *
     *   - ResizeObserver.contentRect reports the UNTRANSFORMED layout size.
     *     That is the space layout.js and every renderer work in.
     *   - getBoundingClientRect() reports the size AFTER the transform, which
     *     is the space pointer events arrive in.
     *
     * At any zoom other than 1 those disagree, and the ratio between them is
     * what has to be divided out of every incoming coordinate.
     */
    _zoom() {
        const r = this.canvas.getBoundingClientRect();
        if (!r.width || !this._cssW) return 1;
        return r.width / this._cssW;
    }

    _resize(cssW, cssH) {
        if (cssW < 2 || cssH < 2) return;

        // Render at device pixels times graph zoom, so a zoomed-in node is
        // sharp rather than an upscaled bitmap. Clamped: past ~2.5x the memory
        // cost stops buying visible detail.
        const dpr = window.devicePixelRatio || 1;
        const zoom = Math.max(0.5, Math.min(2.5, this._zoom() || 1));
        const scale = dpr * zoom;

        const bw = Math.round(cssW * scale);
        const bh = Math.round(cssH * scale);

        if (this.canvas.width !== bw || this.canvas.height !== bh) {
            this.canvas.width = bw;
            this.canvas.height = bh;
        }
        // Renderers keep working in CSS pixels; the transform does the scaling.
        this.ctx.setTransform(scale, 0, 0, scale, 0, 0);

        const changed = cssW !== this._cssW || cssH !== this._cssH;
        this._cssW = cssW;
        this._cssH = cssH;
        this._dpr = scale;
        this._renderScale = scale;

        // The drawer covers the visualisation area only, never the transport
        // row. Two reasons: the gear that opened it stays clickable so it can
        // toggle closed, and playback stays operable while you are adjusting
        // colours — which is exactly when you want to hear it.
        this._syncPanelBottom();

        if (changed) {
            // Tell every renderer its buffers are stale, once, here — instead
            // of each of them comparing remembered dimensions inside draw().
            for (const id of RENDERER_IDS) {
                const r = getRenderer(id);
                if (r.resize) {
                    try { r.resize(this._gfxFor(id)); } catch (e) { console.warn(e); }
                }
            }
        }
        this.markDirty();
    }

    /**
     * Re-scale the backing store when the graph zoom has moved.
     * Only acts on a meaningful change, so a slow zoom gesture does not
     * reallocate the canvas on every frame.
     */
    _syncRenderScale() {
        if (!this._cssW || !this._cssH) return;
        const dpr = window.devicePixelRatio || 1;
        const zoom = Math.max(0.5, Math.min(2.5, this._zoom() || 1));
        const wanted = dpr * zoom;
        const current = this._renderScale || dpr;
        if (Math.abs(wanted - current) / current < 0.1) return;
        this._resize(this._cssW, this._cssH);
    }

    // -- palette / params --------------------------------------------------

    get palette() {
        if (!this._palette) {
            this._palette = config.palette(this.state.overrides, this.state.theme);
        }
        return this._palette;
    }

    /** Palette without this node's overrides — the baseline prune() compares to. */
    get basePalette() {
        return config.palette(null, this.state.theme);
    }

    paramsFor(id) {
        return {
            ...defaultParams(id),
            ...config.rendererParams(id, this.state.overrides),
        };
    }

    _storeFor(id) {
        if (!this._stores.has(id)) this._stores.set(id, {});
        return this._stores.get(id);
    }

    _gfxFor(id, layout = null) {
        return makeGfx({
            ctx: this.ctx,
            palette: this.palette,
            params: this.paramsFor(id),
            paramsFor: rid => this.paramsFor(rid),
            store: this._storeFor(id),
            peaks: this.peaks,
            stereo: this.stereo,
            layout: layout || this._layout(),
            phase: this._phase,
            dpr: this._dpr || 1,
            now: this._frameNow || performance.now(),
            bench: (this.data && this.data.bench) || null,
        });
    }

    /**
     * Keep the settings drawer's bottom edge on the visualisation's bottom
     * edge. Called on resize AND whenever the bench strip toggles, because the
     * strip takes its height out of the visualisation and moves wfBottom.
     */
    _syncPanelBottom() {
        if (!this.panel || !this._cssH) return;
        const L = this._layout();
        this.panel.element.style.bottom =
            `${Math.max(0, Math.round(this._cssH - L.wfBottom))}px`;
    }

    _layout() {
        return computeLayout(
            this._cssW || 460,
            this._cssH || 260,
            this.stereo,
            this.peaks.ch0.length,
            {
                barGap: config.ui("bar_gap", 2),
                padX: config.ui("pad_x", 14),
                settingsButton: config.ui("settings_button", true),
                benchOpen: !!this.state.benchOpen,
                benchHeight: this.state.benchHeight || config.ui("bench_height", 152),
            },
        );
    }

    // -- render loop -------------------------------------------------------

    markDirty() { this._dirty = true; }

    _startLoop() {
        const tick = () => {
            if (this._destroyed) return;
            this._raf = requestAnimationFrame(tick);

            // Skip work when the tab is hidden or nothing has changed and
            // nothing is animating. An idle node costs one comparison a frame.
            if (document.hidden) return;

            // Zooming the graph changes our on-screen size without changing
            // our layout size, so ResizeObserver never fires for it. Poll for
            // it instead — throttled, because it forces a layout read.
            const now = performance.now();
            if (now - (this._lastZoomCheck || 0) > 250) {
                this._lastZoomCheck = now;
                this._syncRenderScale();
            }

            // An idle node animates too, or the demo would be a still frame.
            // `engine.playing` is false there: nothing is playing, and claiming
            // otherwise would put a running transport on a node with no audio.
            const demoing = this.engine.idle && this.engine.demo;
            const animating = this.engine.playing || demoing
                              || this._ripple.alpha > 0;
            if (!animating && !this._dirty) return;

            this._dirty = false;
            if (this.engine.playing || demoing) this._phase += 0.07;
            this._frameNow = now;
            this._draw();
        };
        this._raf = requestAnimationFrame(tick);
    }

    _draw() {
        const ctx = this.ctx;
        const L = this._layout();
        const palette = this.palette;

        // Derived from the active renderer every tick rather than set at the
        // point of switching: the view also changes on state restore and from
        // the settings panel, and a flag set in only one of those paths is a
        // flag that is wrong some of the time.
        this.engine.wantFloatFreq = !!getRenderer(this.state.viewMode).needs?.freqDb;

        const sig = this.engine.update();

        ctx.save();
        ctx.clearRect(0, 0, this._cssW, this._cssH);

        chrome.drawBackground(ctx, L, palette);
        // The badge row carries the file's format when there is a file. With
        // no file it is empty space on the one screen a stranger judges the
        // pack by, so the demo signs itself there instead.
        if (this.engine.idle && this.engine.demo) {
            chrome.drawIdleBadge(ctx, L, palette,
                                 slogan((this._frameNow || 0) / 1000));
        } else {
            chrome.drawBadge(ctx, L, palette, this.data);
        }

        // -- the visualiser --------------------------------------------
        const renderer = getRenderer(this.state.viewMode);
        const rect = { x: L.wfX, y: L.wfTop, w: L.totalW, h: L.wfH };
        if (rect.w > renderer.minSize.w && rect.h > renderer.minSize.h) {
            const gfx = this._gfxFor(renderer.id, L);
            try {
                renderer.frame(gfx, rect, sig);
            } catch (e) {
                console.error(`[NovaPlayer] renderer "${renderer.id}" threw:`, e);
                // One bad renderer must not take the transport controls with
                // it — fall through and keep drawing the chrome below.
            }
        }

        if (sig.clip) chrome.drawClipLed(ctx, L, palette);

        // -- chrome ----------------------------------------------------
        chrome.drawMeter(ctx, L, palette, sig);
        chrome.drawTimeLabels(ctx, L, palette, sig.currentTime, sig.duration,
                              this._drag?.kind === "scrub");
        chrome.drawScrub(ctx, L, palette, sig.progress);
        chrome.drawVolume(ctx, L, palette, this.state.volume, this.state.muted);
        chrome.drawTransport(ctx, L, palette, {
            playing: this.engine.playing,
            looping: this.state.looping,
        });
        const pillW = chrome.drawViewPill(ctx, L, palette, this.state.viewMode);
        drawBenchButton(ctx, L, palette, this._hovered === "bench", !!this.state.benchOpen);

        // Last, so it sits over anything the visualiser drew into its band.
        drawBenchPanel(ctx, L, palette, this.data,
                       this._hovered === "benchGrip" || this._drag?.kind === "benchGrip");

        if (chrome.drawRipple(ctx, this._ripple)) this.markDirty();

        chrome.drawHoverGlow(ctx, L, palette, this._hovered, {
            volume: this.state.volume,
            muted: this.state.muted,
            progress: sig.progress,
            viewPillW: pillW,
        });

        // Absolutely last: a hint that the bench strip or the hover ring could
        // paint over would be worse than no hint. Suppressed mid-drag, when the
        // pointer is busy and the box would chase it across the node.
        if (this._tipShown && this._hovered && !this._drag &&
            config.appearance("show_tooltips", true) !== false) {
            drawTooltip(ctx, L, palette, tipFor(this._hovered, {
                playing: this.engine.playing,
                looping: this.state.looping,
                muted: this.state.muted,
                volume: this.state.volume,
                viewLabel: getRenderer(this.state.viewMode).label,
                benchOpen: !!this.state.benchOpen,
            }), this._ptr);
        }

        ctx.restore();
    }

    // -- input -------------------------------------------------------------

    /**
     * Client coordinates -> layout coordinates.
     *
     * The rect is post-transform (screen space); the layout is pre-transform.
     * Dividing by the measured ratio makes this correct at any graph zoom, and
     * also survives whatever else the frontend puts a transform on. Getting
     * this wrong is not subtle: at zoom > 1 every click lands short of where
     * the user aimed, so the transport buttons become unreachable and every
     * click falls through to the visualisation and seeks instead.
     */
    _pointerPos(e) {
        const r = this.canvas.getBoundingClientRect();
        const sx = r.width ? (this._cssW || r.width) / r.width : 1;
        const sy = r.height ? (this._cssH || r.height) / r.height : 1;
        return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
    }

    _bindEvents() {
        const c = this.canvas;

        c.addEventListener("pointerdown", e => this._onPointerDown(e));
        c.addEventListener("pointermove", e => this._onPointerMove(e));
        c.addEventListener("pointerup", e => this._onPointerUp(e));
        c.addEventListener("pointercancel", e => this._onPointerUp(e));
        c.addEventListener("pointerleave", () => {
            this._clearTooltip();
            if (this._hovered) { this._hovered = null; c.style.cursor = ""; this.markDirty(); }
        });
        c.addEventListener("dblclick", e => e.stopPropagation());

        // Media element state changes must repaint even when the RAF loop is
        // idle (paused): otherwise the play button keeps showing the old icon.
        for (const evt of ["play", "pause", "ended", "seeked", "loadedmetadata"]) {
            this.engine.el.addEventListener(evt, () => this.markDirty());
        }
        this.engine.el.addEventListener("ended", () => {
            if (!this.state.looping) this.markDirty();
        });

        this._onVisibility = () => this.markDirty();
        document.addEventListener("visibilitychange", this._onVisibility);
    }

    _onPointerDown(e) {
        const { x, y } = this._pointerPos(e);
        const L = this._layout();
        const hit = chrome.hitTest(x, y, L);

        // Stop LiteGraph from starting a node drag underneath us.
        e.stopPropagation();
        if (hit) e.preventDefault();

        // Acting on a control answers the question the hint was there to
        // answer, and a box left hanging over a drag is just in the way.
        this._clearTooltip();

        switch (hit) {
            case "play":
                this.engine.toggle();
                break;

            case "skipBack":
                this.engine.skip(-10);
                break;

            case "skipFwd":
                this.engine.skip(10);
                break;

            case "loop":
                this.state.looping = !this.state.looping;
                this.engine.setLooping(this.state.looping);
                this._save();
                break;

            case "view":
                this.state.viewMode = nextRendererId(this.state.viewMode);
                this._ripple = {
                    x: L.viewBtnX, y: L.btnCY, alpha: 1,
                    color: this.palette.get("hover.glow"),
                };
                // A view that needs the analyser must be able to build it even
                // if the user switches modes before ever pressing play.
                if (getRenderer(this.state.viewMode).needs?.freq) this.engine.ensureGraph();
                this.panel.refresh();   // rebuilds: the renderer changed
                this._save();
                break;

            case "speaker":
                this.state.muted = !this.state.muted;
                this.engine.setMuted(this.state.muted);
                this._save();
                break;

            case "volume":
                this._beginDrag(e, "volume");
                this._applyVolume(x, L);
                break;

            case "scrub":
                this._beginDrag(e, "scrub");
                this._applyScrub(x, L);
                this._ripple = {
                    x, y: L.scrubTop + L.scrubH / 2, alpha: 1,
                    color: this.palette.get("scrub.fill"),
                };
                break;

            case "download":
                if (isDownloadMenuOpen()) closeDownloadMenu();
                else showDownloadMenu(this.data.filename, this.palette, e.clientX, e.clientY);
                break;

            case "benchGrip":
                // Dragging the top edge resizes the strip. Handled here rather
                // than as a click so the pointer is captured for the gesture.
                this._beginDrag(e, "benchGrip");
                return;

            case "bench":
                this.state.benchOpen = !this.state.benchOpen;
                // The strip eats height from the visualisation, so every
                // renderer's buffers are the wrong size the moment it opens.
                for (const id of RENDERER_IDS) {
                    const r = getRenderer(id);
                    if (r.resize) { try { r.resize(this._gfxFor(id)); } catch {} }
                }
                // The settings drawer is positioned from wfBottom, which just
                // moved.
                this._syncPanelBottom();
                this._save();
                break;

            case "settings":
                this._togglePanel();
                break;

            case "visualisation": {
                const renderer = getRenderer(this.state.viewMode);
                const rect = { x: L.wfX, y: L.wfTop, w: L.totalW, h: L.wfH };
                const result = renderer.hit
                    ? renderer.hit({ x, y }, rect, this._gfxFor(renderer.id, L))
                    : null;
                if (result && result.action === "seek") {
                    this.engine.seekFraction(result.fraction);
                    this._ripple = {
                        x, y, alpha: 1,
                        color: result.fraction < 0.5
                            ? this.palette.get("wave.left")
                            : this.palette.get("wave.right"),
                    };
                }
                break;
            }

            default:
                return;   // let the click fall through to the node
        }

        this.markDirty();
    }

    _beginDrag(e, kind) {
        this._drag = { kind, pointerId: e.pointerId };
        // The reason the old workarounds can go: capture guarantees this
        // element sees every move and the final up, wherever the pointer goes.
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    }

    _onPointerMove(e) {
        const { x, y } = this._pointerPos(e);
        const L = this._layout();

        if (this._drag) {
            e.stopPropagation();
            if (this._drag.kind === "volume") {
                this._applyVolume(x, L);
                this._ripple = {
                    x: L.volX + L.volW * this.state.volume, y: L.volY,
                    alpha: 0.5, color: this.palette.get("vol.knob"),
                };
            } else if (this._drag.kind === "benchGrip") {
                this._applyBenchHeight(y, L);
            } else if (this._drag.kind === "scrub") {
                this._applyScrub(x, L);
                this._ripple = {
                    x, y: L.scrubTop + L.scrubH / 2,
                    alpha: 0.6, color: this.palette.get("scrub.fill"),
                };
            }
            this.markDirty();
            return;
        }

        // Kept for tooltip placement. Updated even when the hovered control is
        // unchanged, so the box tracks the pointer along a slider.
        this._ptr = { x, y };

        const hit = chrome.hitTest(x, y, L);
        if (hit !== this._hovered) {
            this._hovered = hit;
            this.canvas.style.cursor =
                hit === "benchGrip" ? "ns-resize"
                : hit && hit !== "visualisation" ? "pointer"
                : hit === "visualisation" ? "crosshair"
                : "";
            this._armTooltip(hit);
            this.markDirty();
        } else if (this._tipShown) {
            // Following the pointer within one control: repaint so the box moves.
            this.markDirty();
        }
    }

    /**
     * Show a hint once the pointer has rested.
     *
     * A timer rather than a per-frame deadline check, because the RAF loop
     * returns early when nothing is animating and nothing is dirty — a deadline
     * would simply never be reached on a paused node.
     */
    _armTooltip(hit) {
        clearTimeout(this._tipTimer);
        this._tipTimer = null;
        this._tipShown = false;
        if (!hit || !tipFor(hit)) return;
        this._tipTimer = setTimeout(() => {
            this._tipTimer = null;
            // The pointer may have left, or a drag begun, while we waited.
            if (this._destroyed || this._hovered !== hit || this._drag) return;
            this._tipShown = true;
            this.markDirty();
        }, TOOLTIP_DELAY_MS);
    }

    /** Cancel any pending or visible hint. */
    _clearTooltip() {
        clearTimeout(this._tipTimer);
        this._tipTimer = null;
        this._tipShown = false;
    }

    _onPointerUp(e) {
        if (!this._drag) return;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
        // Persist once, at the end of the gesture — not on every move.
        this._save();
        this._drag = null;
        this.markDirty();
    }

    /**
     * Resize the bench strip by dragging its top edge.
     *
     * Clamped between a floor that still shows something useful and the same
     * ceiling computeLayout enforces, so a drag can never push the strip over
     * the transport row — the clamp lives in one place and this respects it
     * rather than restating it.
     */
    _applyBenchHeight(y, L) {
        const wanted = Math.round(this._cssH - y);
        const next = Math.max(L.benchMinH, Math.min(L.benchMaxH, wanted));
        if (next === this.state.benchHeight) return;

        this.state.benchHeight = next;
        // The visualisation just changed size under the strip.
        for (const id of RENDERER_IDS) {
            const r = getRenderer(id);
            if (r.resize) { try { r.resize(this._gfxFor(id)); } catch {} }
        }
        this._syncPanelBottom();
    }

    _applyVolume(x, L) {
        this.state.volume = Math.max(0, Math.min(1, (x - L.volX) / L.volW));
        this.engine.setVolume(this.state.volume);
        this.panel.refresh();
    }

    _applyScrub(x, L) {
        this.engine.seekFraction((x - L.scrubX) / L.scrubW);
    }

    _togglePanel() {
        const open = !this.panel.isOpen;
        this.panel.setOpen(open);
        this.state.panelOpen = open;
        this._save();
        this.markDirty();
    }

    // -- settings panel controller ----------------------------------------

    /**
     * Autosave.
     *
     * Every panel edit applies instantly as a node override — that is what
     * makes the display respond while you drag a slider. What happens next
     * depends on the scope switch:
     *
     *   "node"  — nothing. The override stays on the node and travels with the
     *             workflow, so two players can wear different colours.
     *   "theme" — it is written through to disk here, and the override is then
     *             dropped, because the theme (or the renderer defaults) now
     *             carries the value and a duplicate would only bloat the
     *             workflow JSON.
     *
     * Debounced, because dragging an opacity slider fires on every pixel and
     * each save is a disk write plus a config re-fetch.
     */
    _scheduleSave(kind, id = null) {
        this._pending = this._pending || { roles: false, renderers: new Set() };
        if (kind === "role") this._pending.roles = true;
        else this._pending.renderers.add(id);

        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flushSaves(), 600);
    }

    async _flushSaves() {
        const pending = this._pending;
        if (!pending) return;
        this._pending = null;

        // Colours go into the active theme. A node's colour edits are not a
        // per-node quirk to be hoarded; they are what the theme now looks like.
        if (pending.roles && Object.keys(this.state.overrides.roles).length) {
            const name = this.state.theme || config.activeTheme;
            const roles = { ...this.state.overrides.roles };
            const res = await config.saveTheme(name, { roles }, false);
            if (res.ok) {
                for (const role of Object.keys(roles)) {
                    // Only clear what we actually saved — the user may have
                    // touched another role while the request was in flight.
                    if (this.state.overrides.roles[role] === roles[role]) {
                        delete this.state.overrides.roles[role];
                    }
                }
                this._palette = null;
                this.panel.notify("Saved to " + name, "ok");
            } else {
                this.panel.notify(res.message, "error");
            }
        }

        for (const id of pending.renderers) {
            const params = this.paramsFor(id);
            const res = await config.saveRenderer(id, params);
            if (res.ok) delete this.state.overrides.renderers[id];
            else this.panel.notify(res.message, "error");
        }

        this._save();
        this.panel.sync();
        this.markDirty();
    }

    /**
     * Refresh the panel's decorations at most once per frame.
     *
     * sync() only writes values into existing controls and skips whichever one
     * has focus, so it is safe to call while a colour picker is open or a
     * slider is being dragged — unlike refresh(), which can rebuild. Coalesced
     * to one animation frame because an alpha drag fires on every pixel.
     */
    _syncPanelSoon() {
        if (this._panelSyncPending) return;
        this._panelSyncPending = true;
        requestAnimationFrame(() => {
            this._panelSyncPending = false;
            if (!this._destroyed) this.panel.sync();
        });
    }

    _panelController() {
        const self = this;
        return {
            close: () => self._togglePanel(),
            getPalette: () => self.palette,
            getBasePalette: () => self.basePalette,
            activeRenderer: () => self.state.viewMode,

            getRoleValue: (role) => self.palette.get(role),

            /** True when this node is overriding the theme for `role`. */
            isRoleLocal: (role) =>
                Object.prototype.hasOwnProperty.call(self.state.overrides.roles, role),
            isParamLocal: (id, key) =>
                !!(self.state.overrides.renderers[id] &&
                   Object.prototype.hasOwnProperty.call(self.state.overrides.renderers[id], key)),

            setRole: (role, value) => {
                // Every edit lands on the node first — that is what makes the
                // display respond instantly. Whether it then travels on to the
                // theme is what the scope switch decides.
                self.state.overrides.roles[role] = value;
                self._palette = null;
                self._save();
                self.markDirty();
                if (self.state.colorScope === "theme") self._scheduleSave("role");
                // sync(), never refresh(): refresh() can rebuild, which would
                // close the section the user is working in. sync() only updates
                // the local-override dot and the promote button, and skips the
                // control that currently has focus.
                self._syncPanelSoon();
            },

            getParam: (id, key) => self.paramsFor(id)[key],
            setParam: (id, key, value) => {
                const bucket = self.state.overrides.renderers[id] ||
                               (self.state.overrides.renderers[id] = {});
                bucket[key] = value;
                // Params can change buffer geometry (scroll speed, bandwidth),
                // so let the renderer invalidate what it needs to.
                const r = getRenderer(id);
                if (r.resize) { try { r.resize(self._gfxFor(id)); } catch {} }
                const wf = self._stores.get("waveform");
                if (wf) wf.cache = null;
                self._save();
                self.markDirty();
                if (self.state.colorScope === "theme") self._scheduleSave("renderer", id);
                self._syncPanelSoon();
            },

            /**
             * Where panel edits are written.
             *   "node"  — this node only, saved inside the workflow.
             *   "theme" — the shared theme (and renderer defaults) on disk.
             */
            getScope: () => self.state.colorScope,
            setScope: (scope) => {
                self.state.colorScope = scope === "theme" ? "theme" : "node";
                self._save();
                self.panel.sync();
            },

            /** Count of local overrides, for the panel's promote button. */
            localCount: () =>
                Object.keys(self.state.overrides.roles).length +
                Object.keys(self.state.overrides.renderers).length,

            /** Promote everything this node overrides into the shared theme. */
            promoteToTheme: async () => {
                const name = self.state.theme || config.activeTheme;
                self._pending = {
                    roles: true,
                    renderers: new Set(Object.keys(self.state.overrides.renderers)),
                };
                clearTimeout(self._saveTimer);
                await self._flushSaves();
                self.panel.sync();
                return { ok: true, message: `Applied to ${name}` };
            },

            getThemeName: () => self.state.theme || config.activeTheme,
            setThemeName: (name) => {
                self.state.theme = name;
                // Node overrides deliberately SURVIVE a theme change. They are
                // choices made for this node, not for that theme; wiping them
                // silently would throw away work the moment you previewed a
                // different theme. "Reset node" clears them when you want that.
                self._palette = null;
                self._save();
                self.panel.sync();
                self.markDirty();
            },
            listThemes: () => Object.entries(config.themes)
                .map(([name, t]) => ({ name, label: t.label || name })),
            canDeleteTheme: (name) =>
                name !== config.baseTheme && Object.keys(config.themes).length > 1,

            // The LIVE value, not the persisted one: during a drag the preview
            // has already been applied and the drawer must scale with it rather
            // than lag a save behind.
            getTextScale: () => textScale(),

            // Applied without persisting, so a drag is smooth: the slider fires
            // per pixel and each save is an HTTP write. The panel debounces the
            // save; this is what paints in between.
            previewTextScale: v => {
                setTextScale(v);
                for (const id of RENDERER_IDS) {
                    const r = getRenderer(id);
                    if (r.resize) { try { r.resize(this._gfxFor(id)); } catch {} }
                }
                this._textScale = textScale();
                this.panel.sync();     // the drawer's own type scales too
                this.markDirty();
            },

            setTextScale: async v => {
                const res = await config.saveAppearance({ text_scale: v });
                // A failed save must not leave the screen showing a size that
                // is not stored anywhere.
                if (!res.ok) {
                    setTextScale(config.appearance("text_scale", 1));
                    this.markDirty();
                }
                return res;
            },

            getBarRelief: () => barRelief(),

            previewBarRelief: v => {
                setBarRelief(v);
                // Bars drawn into an offscreen buffer (the waveform) will not
                // repaint until told their buffer is stale.
                for (const id of RENDERER_IDS) {
                    const r = getRenderer(id);
                    if (r.resize) { try { r.resize(this._gfxFor(id)); } catch {} }
                }
                this.markDirty();
            },

            setBarRelief: async v => {
                const res = await config.saveAppearance({ bar_relief: v });
                if (!res.ok) {
                    setBarRelief(config.appearance("bar_relief", 0.55));
                    this.markDirty();
                }
                return res;
            },

            getShowTooltips: () => config.appearance("show_tooltips", true) !== false,

            setShowTooltips: async v => {
                const res = await config.saveAppearance({ show_tooltips: !!v });
                if (!v) this._clearTooltip();
                this.markDirty();
                return res;
            },

            getPanelWidth: () => self.state.panelWidth,
            setPanelWidth: (px) => { self.state.panelWidth = px; self._save(); },

            getOpenSection: () => self.state.openSection,
            setOpenSection: (id) => { self.state.openSection = id; self._save(); },

            resetOverrides: () => {
                self.state.overrides = { roles: {}, renderers: {} };
                self._palette = null;
                self._stores.clear();
                self._save();
                self.markDirty();
            },

            /** Duplicate the current look under a new name and switch to it. */
            createTheme: (name) => self._writeTheme(name, false),
            saveThemeAs: (name) => self._writeTheme(name, true),

            deleteTheme: async (name) => {
                const res = await config.deleteTheme(name);
                if (res.ok) {
                    self.state.theme = config.activeTheme;
                    self._palette = null;
                    self._save();
                    self.markDirty();
                }
                return res;
            },
        };
    }

    /**
     * Write the current look out as a named theme.
     *
     * The new theme is a full snapshot, not a delta: it carries every resolved
     * role, so it stands on its own and does not silently change when the theme
     * it happened to be copied from is edited later.
     */
    async _writeTheme(name, makeActive) {
        const roles = {};
        const palette = this.palette;
        for (const role of Object.keys(palette.roles)) roles[role] = palette.roles[role];

        const res = await config.saveTheme(
            name, { label: name, roles, ramps: palette.rampDefs }, true,
        );
        if (res.ok) {
            this.state.theme = name;
            this.state.overrides.roles = {};
            this._palette = null;
            this._save();
            this.markDirty();
        }
        return res;
    }

    // -- serialisation -----------------------------------------------------

    /** What ComfyUI writes into the workflow. Deltas only. */
    serialise() {
        return prune(this.state, this.basePalette, id => ({
            ...defaultParams(id),
            ...config.rendererParams(id, null),
        }));
    }

    /**
     * Restore from a saved workflow value (any legacy shape included).
     *
     * Guarded against echo: assigning widget.value can make the frontend call
     * setValue straight back with what we just wrote. Without the guard that
     * round trip re-entered here on every edit and rebuilt the panel, which
     * closed whichever section the user was working in and reopened the
     * default one — the exact symptom of "the colour section won't stay open".
     */
    restore(value) {
        if (this._saving) return;

        this.state = normalise(value, RENDERER_IDS);
        this._palette = null;
        this.engine.setVolume(this.state.volume);
        this.engine.setMuted(this.state.muted);
        this.engine.setLooping(this.state.looping);
        this.panel.setOpen(this.state.panelOpen);
        // refresh(), not rebuild(): it rebuilds only when the active renderer
        // has actually changed, and otherwise just writes values into the
        // controls that already exist.
        this.panel.refresh();
        this.markDirty();
    }

    _save() {
        this._saving = true;
        try {
            if (this.widget) this.widget.value = this.serialise();
            if (this.node && this.node.graph) this.node.graph._version++;
        } finally {
            this._saving = false;
        }
    }

    /** New audio from a re-run: swap the file without rebuilding anything. */
    setData(data) {
        const sameFile = data.filename === this.data.filename;
        this.data = data;
        this.peaks = data.peaks || this.peaks;
        this.stereo = !!(data.stereo && this.peaks.ch1);

        if (!sameFile) {
            const wasPlaying = this.engine.playing;
            this.engine.dispose();
            this.engine = new AudioEngine(data.filename, {
                duration: data.duration,
                stereo: data.stereo,
                fftSize: config.audio("fft_size", 4096),
                smoothing: config.audio("smoothing_time_constant", 0.6),
                fps: config.audio("analyser_fps", 30),
                peakHoldMs: config.ui("peak_hold_ms", 300),
            });
            this.engine.setVolume(this.state.volume);
            this.engine.setMuted(this.state.muted);
            this.engine.setLooping(this.state.looping);
            this._bindMediaEvents();
            if (wasPlaying) this.engine.play();
        }

        // Renderers that accumulate across a whole take (the APG meter's
        // integrated statistics, for one) must be able to tell "the user
        // scrubbed" from "this is a different render". Progress alone cannot:
        // a new file usually rewinds to 0, but not always, and a renderer that
        // lets the user switch that heuristic off would otherwise blend two
        // takes into one figure and quietly report a number for neither.
        if (!sameFile) this._sourceId = (this._sourceId || 0) + 1;

        for (const store of this._stores.values()) {
            store.cache = null;
            store.buffer = null;
            store.sourceId = this._sourceId || 0;
        }
        this.markDirty();
    }

    _bindMediaEvents() {
        for (const evt of ["play", "pause", "ended", "seeked", "loadedmetadata"]) {
            this.engine.el.addEventListener(evt, () => this.markDirty());
        }
    }

    minimumSize() {
        // benchOpen raises the floor: the strip needs its own height on top of
        // a usable visualiser, so opening it grows the node rather than
        // squeezing the waveform to nothing.
        return minimumNodeSize(this.stereo, {
            benchOpen: !!this.state.benchOpen,
            benchHeight: this.state.benchHeight || config.ui("bench_height", 152),
            minNodeWidth: config.ui("min_node_width", 460),
            minNodeHeight: config.ui("min_node_height", 280),
            minWidgetHeight: config.ui("min_widget_height", 203),
        });
    }

    // -- teardown ----------------------------------------------------------

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        if (this._raf) cancelAnimationFrame(this._raf);
        this._clearTooltip();
        this._resizeObserver?.disconnect();
        document.removeEventListener("visibilitychange", this._onVisibility);
        this._unsubscribe?.();

        for (const id of RENDERER_IDS) {
            const r = getRenderer(id);
            if (r.dispose) {
                try { r.dispose(this._gfxFor(id)); } catch {}
            }
        }
        this._stores.clear();

        closeDownloadMenu();
        this.panel.destroy();
        this.engine.dispose();
        this.element.remove();
    }
}
