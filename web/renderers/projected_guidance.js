/**
 * projected_guidance.js — APG artifact meter
 *
 * An instrument for tuning generation settings (cfg_scale, steps, shift,
 * temperature, and the sampler's own eta/norm/momentum) by ear AND by number.
 *
 * WHAT CHANGED, AND WHY
 *
 * Version 1 integrated an error term into a free-running position that railed
 * at 0 and sat there. Version 2 fixed the railing by plotting the measured
 * spectrum against a target curve. Both had a deeper problem for this purpose:
 * distance from a synthetic pink-ish curve is mostly a property of the curve I
 * chose, not of the render. Two takes at different cfg_scale could score the
 * same, so the number could not guide a decision.
 *
 * This version measures properties that the generation settings demonstrably
 * change, each bounded, each computed the same way every time so two takes are
 * comparable:
 *
 *   CREST     peak-to-RMS in dB. Transient definition. Over-guidance and
 *             over-cooking flatten it; it is the single most reliable tell.
 *   CENTROID  spectral centre of mass in Hz. Brightness. High guidance pushes
 *             energy up and makes it harsh; too few steps leaves it dull.
 *   FLUX      how much the spectrum changes between analysis frames. Low means
 *             smeared and static; very high means noisy.
 *   FLATNESS  geometric/arithmetic mean ratio, in dB. 0 dB is white noise;
 *             a pure tone measures about -28 dB. Temperature moves this most.
 *   CLIP      percentage of SAMPLES at the ceiling, using the same threshold
 *             as the clip LED so the two can never disagree.
 *   SAT       percentage of samples inside flat-top runs, at ANY level. This
 *             is the one that catches over-guidance on normalised output: a
 *             take squashed into a limiter and then pulled back below full
 *             scale has a clean peak reading and a clean CLIP figure, and is
 *             still saturated. Measured: material limited at -1.32 dBFS reads
 *             CLIP 0.00% and SAT 21.9%. Needs lossless audio — a lossy encode
 *             smooths the flat tops away.
 *
 * All three spectral figures are computed from TRUE per-bin magnitude, taken
 * from getFloatFrequencyData. The byte spectrum every other renderer draws from
 * is a linear map of decibels that clamps at -100 dBFS; on a produced track most
 * bins above the low mids fall under that floor, and a weighted average over
 * them answers a question about the floor rather than about the music. Measured
 * side by side, the byte path loses roughly half the centroid's response to a
 * brightness change. Hence needs.freqDb.
 *
 * Everything is shown two ways: a live value that moves while you listen, and
 * a figure integrated over everything played since the last reset — the second
 * is the one that is actually comparable between takes.
 *
 * FREEZE A REFERENCE (click the panel): captures the integrated set from a take
 * you like. Every row then shows the delta against it, so you can hear a change
 * and see which way it moved. That is the "tuning the radio" part.
 *
 * THE DIRECTIONAL HINTS ARE HYPOTHESES, NOT MEASUREMENTS. They are my
 * reasoning about what these artifacts usually mean, not anything validated
 * against ACE-Step. Treat them as a starting guess to confirm or discard; the
 * numbers above them are the real output.
 */

import {
    byteToNorm, clipped, drawPlaceholder, rr, smoothingAlpha, textScale, fmtTime,
} from "../core/gfx.js";
// Same ceiling the engine uses for the clip LED, so the meter and the LED can
// never disagree about what counts as clipped.
import { CLIP_THRESHOLD as CLIP_LEVEL } from "../core/audio-engine.js";

// Below this frame RMS the material is treated as silence and left out of the
// integrated figures.
const SILENCE_RMS = 0.002;

// Flat-top ("saturation") detection. A run of consecutive samples that barely
// move, at a level too high to be a quiet passage, is the fingerprint of a
// limiter or of clipping that a later normalise pulled back below full scale.
//
// EPS must stay far below one 16-bit LSB (3.05e-5). At 1e-4 a loud 50 Hz sine
// reads 1.0% saturated purely because consecutive samples barely differ near
// its apex — a false positive on ordinary bass. At 1e-6 the same sine reads
// 0.000% while a take limited at -1.32 dBFS reads 21.9%.
const SAT_EPS = 1e-6;
const SAT_RUN = 4;       // shorter runs happen naturally at any waveform apex
const SAT_LEVEL = 0.35;  // about -9 dBFS: a limiter ceiling is never below this

// Floor for the per-bin dBFS values. Digital silence reads -Infinity, which
// would take the geometric mean with it. Measured spectra on real material
// bottom out around -135 dBFS, so this floor almost never binds.
const FLOOR_DB = -140;

// Bar endpoints, not judgements about what is good — just the range over which
// the needle has somewhere useful to travel. Every one of these was MEASURED
// through a real AnalyserNode (dev/tests/calibrate.mjs) rather than guessed:
//
//                     pure tone   white noise   REAL ACE-STEP TAKE
//                                                (whole file, p05 - p95)
//   CENTROID            456 Hz       11989 Hz    1977 - 4608 Hz  (mean 3554)
//   FLATNESS          -27.9 dB        -0.2 dB    -13.0 - -9.6 dB (mean -10.9)
//   FLUX               0.0001          0.0996     0.076 - 0.142  (mean 0.102)
//
// The right-hand column is dev/tests/realtake.mjs run over a 4:20 ACE-Step
// render — 7745 analysed frames of actual output. The synthetic columns bracket
// the scale; the real one says where the needle will usually sit. They were NOT
// interchangeable: synthetic material put FLUX at 0.03-0.10 and the resulting
// 0.12 ceiling pinned on real music.
const METRICS = [
    { key: "crest",    label: "CREST",    unit: "dB", min: 3,    max: 24,     dp: 1 },
    { key: "centroid", label: "CENTROID", unit: "Hz", min: 200,  max: 12000,  dp: 0, log: true },
    // 0.12 came from the synthetic material below and was too low: a real
    // ACE-Step track measured 0.169 in ComfyUI and pinned the needle. Synthetic
    // loops are far more self-similar frame to frame than real music, so treat
    // the FLUX row below as a floor on the range, not a description of it.
    { key: "flux",     label: "FLUX",     unit: "",   min: 0,    max: 0.40,   dp: 3 },
    { key: "flatness", label: "FLATNESS", unit: "dB", min: -30,  max: 0,      dp: 1 },
    // Clipping spans an enormous range and the interesting end is the small
    // one: NovaFemme's take has 87 clipped samples in 25 million, which is 0.0003%
    // — real, but invisible at 2 decimal places, where it printed a flat
    // "0.00 %" and looked like none at all. Log scale and 4 places, so a
    // handful of clipped samples is distinguishable from genuinely zero.
    { key: "clip",     label: "CLIP",     unit: "%",  min: 0.0001, max: 10,   dp: 4, log: true },
    // Flat-topping survives in lossless audio but NOT through a lossy encode:
    // measured 0.0000% on the 320k MP3 of a take whose peak sits exactly at
    // full scale. Point the player at the FLAC if this row is to mean anything.
    { key: "sat",      label: "SAT",      unit: "%",  min: 0,      max: 10,   dp: 3 },
];

export default {
    id: "projected_guidance",
    label: "APG METER",

    needs: { freq: true, freqDb: true, time: true, peaks: false },

    params: {
        smoothing:  { type: "range", min: 0.05, max: 0.95, step: 0.05, default: 0.7, label: "Live smoothing" },
        showSpectrum: { type: "toggle", default: true, label: "Spectrum backdrop" },
        showHints:  { type: "toggle", default: true, label: "Directional hints" },
        autoReset:  { type: "toggle", default: true, label: "Reset stats on seek" },
    },

    roles: [
        "text", "text.dim", "grid.line", "guidance.path", "guidance.hud.bg",
        "guidance.over", "guidance.under", "guidance.ref", "guidance.target",
    ],
    ramps: [],

    minSize: { w: 200, h: 132 },

    resize(gfx) {
        gfx.store.spectrum = null;
        gfx.store.lastNow = undefined;
    },

    /** Start the integrated statistics over. */
    /**
     * Start a fresh integration.
     *
     * @param {boolean} auto  true when this was an automatic restart (a
     *   backward seek) rather than a new take. Automatic restarts are COUNTED,
     *   because previously they were invisible: the panel silently began
     *   describing a short recent window while still labelling its rows as the
     *   take's figures, and nothing on screen said the ground had moved.
     */
    reset(store, auto = false) {
        store.acc = {
            peak: 0, sumSq: 0, samples: 0, clipped: 0, flat: 0,
            centroidSum: 0, fluxSum: 0, flatSum: 0, specFrames: 0,
            // The integration WINDOW, in seconds. Every integrated figure is
            // conditional on it, so it is tracked as a value rather than left
            // implicit — see the coverage note where it is rendered.
            windowStart: null, windowEnd: null,
        };
        store.live = null;
        store.liveRaw = null;
        store.fluxPrimed = false;
        if (auto) store.autoResets = (store.autoResets || 0) + 1;
    },

    /**
     * What fraction of the take the integrated figures actually cover.
     *
     * Returns null until there is something to report. This is the number that
     * decides whether an integrated reading means anything: a CLIP of 0.0000%
     * over 45% of a take is not evidence that the take does not clip, and a
     * delta between a reference frozen at 45% and a take read at 85% compares
     * unequal fractions of two different things.
     */
    coverage(store, duration) {
        const a = store.acc;
        if (!a || a.windowStart === null || !duration) return null;
        const span = Math.max(0, (a.windowEnd ?? a.windowStart) - a.windowStart);
        return Math.max(0, Math.min(1, span / duration));
    },

    frame(gfx, rect, sig) {
        const { ctx, palette, params, store } = gfx;

        if (!sig.ready || !sig.hasData || !sig.freq || !sig.freqDb || !sig.timeL || !sig.timeR) {
            drawPlaceholder(ctx, rect, ["APG ARTIFACT METER — PLAY TO MEASURE", "PLAY AUDIO ▶"],
                            palette.get("text.dim"));
            return;
        }

        if (!store.acc) this.reset(store);

        // A different render is always a fresh measurement — never optional,
        // or the figures would silently describe two takes at once. The frozen
        // reference deliberately survives: comparing the new take against the
        // old one is the entire point.
        const src = store.sourceId || 0;
        if (store.seenSource !== undefined && store.seenSource !== src) {
            this.reset(store);
            store.autoResets = 0;      // a new take starts the count over
        }
        store.seenSource = src;

        // Seeking backwards makes the integrated figures meaningless too, but
        // that one is a judgement call, so it stays a setting.
        if (params.autoReset !== false && store.lastProgress !== undefined &&
            sig.progress < store.lastProgress - 0.02) {
            this.reset(store, true);
        }
        store.lastProgress = sig.progress;

        const dtRaw = store.lastNow === undefined ? 1 / 60 : (gfx.now - store.lastNow) / 1000;
        store.lastNow = gfx.now;
        const dt = dtRaw > 0 && dtRaw < 0.5 ? dtRaw : 1 / 60;

        const acc = store.acc;
        const bins = sig.binCount;

        // ---- measurement ---------------------------------------------------
        // ALL of it is gated on sig.frame, so every figure is computed once per
        // ANALYSER tick rather than once per repaint. Without the gate flux
        // reads zero on every frame that reuses the same buffer, and every
        // average ends up weighted by the display refresh rate — which would
        // make two takes watched on different machines incomparable, defeating
        // the whole point of the meter.
        if (sig.frame !== store.lastAnalyserFrame) {
            store.lastAnalyserFrame = sig.frame;

            // Time domain: peak, RMS and hard-clipped sample count.
            let peak = 0, sumSq = 0, clipped2 = 0, flat = 0;
            const L = sig.timeL, R = sig.timeR, n = L.length;
            // Run lengths for the flat-top test, tracked per channel. Runs that
            // straddle two analyser windows are counted as two shorter runs and
            // may fall under SAT_RUN, so this slightly UNDER-reports. Better
            // that way round than stitching windows that are not contiguous.
            let runL = 1, runR = 1;
            for (let i = 0; i < n; i++) {
                const l = L[i], r = R[i];
                const a = l < 0 ? -l : l, b = r < 0 ? -r : r;
                if (a > peak) peak = a;
                if (b > peak) peak = b;
                if (a >= CLIP_LEVEL) clipped2++;
                if (b >= CLIP_LEVEL) clipped2++;
                sumSq += l * l + r * r;

                if (i > 0) {
                    const dl = l - L[i - 1], dr = r - R[i - 1];
                    if ((dl < 0 ? -dl : dl) <= SAT_EPS && a >= SAT_LEVEL) runL++;
                    else { if (runL >= SAT_RUN) flat += runL; runL = 1; }
                    if ((dr < 0 ? -dr : dr) <= SAT_EPS && b >= SAT_LEVEL) runR++;
                    else { if (runR >= SAT_RUN) flat += runR; runR = 1; }
                }
            }
            if (runL >= SAT_RUN) flat += runL;
            if (runR >= SAT_RUN) flat += runR;
            const frameRms = Math.sqrt(sumSq / (n * 2));
            const frameCrest = frameRms > 1e-6 ? 20 * Math.log10(peak / frameRms) : 0;

            // Frequency domain.
            if (!store.prevSpec || store.prevSpec.length !== bins) {
                store.prevSpec = new Float32Array(bins);
                store.fluxPrimed = false;
            }

            const hzPerBin = (sig.sampleRate / 2) / bins;
            const db = sig.freqDb;

            // Magnitude, not the byte value. The bytes are decibels on a linear
            // 0-255 scale, so weighting an average by them weights by dB — a
            // bin 60 dB down still carries over half the weight of the loudest
            // one, which swamps the very differences this meter exists to see.
            // Measured on real material, magnitude weighting responds to a 12 dB
            // shelf about four times as strongly as byte weighting does.
            if (!store.mags || store.mags.length !== bins) {
                store.mags = new Float64Array(bins);
            }
            const mags = store.mags;
            let total = 0, weighted = 0, flatLog = 0;

            for (let i = 0; i < bins; i++) {
                const m = Math.pow(10, Math.max(db[i], FLOOR_DB) / 20);
                mags[i] = m;
                total += m;
                weighted += m * i * hzPerBin;
                flatLog += Math.log(m);
            }

            const frameCentroid = total > 1e-12 ? weighted / total : 0;

            // Flatness in dB. As a raw ratio real music lands between 0.01 and
            // 0.05 — all the resolution crammed against zero. 10·log10 spreads
            // the same information evenly, and 0 dB is exactly white noise.
            const geoMean = Math.exp(flatLog / bins);
            const arithMean = total / bins;
            const ratio = arithMean > 0 ? Math.min(1, geoMean / arithMean) : 0;
            const frameFlat = ratio > 0 ? 10 * Math.log10(ratio) : FLOOR_DB;

            // Flux on the SHARE of total magnitude each bin holds, so it
            // measures how the spectrum is changing shape and not merely how
            // loud the passage is. Rising bins only: falls are release, not new
            // content, and counting them doubles every transient.
            let flux = 0;
            if (total > 1e-12) {
                for (let i = 0; i < bins; i++) {
                    const share = mags[i] / total;
                    const d = share - store.prevSpec[i];
                    if (d > 0) flux += d;
                    store.prevSpec[i] = share;
                }
                // The first frame has nothing to compare against: prevSpec is
                // still all zeros, so every bin counts as a rise and flux reads
                // its theoretical maximum of 1.0. Integrating that one spurious
                // frame biases the average upward and makes a freshly reset
                // meter read high for a moment. Prime, then measure.
                if (!store.fluxPrimed) { flux = 0; store.fluxPrimed = true; }
            }
            const frameFlux = flux;

            store.liveRaw = {
                crest: frameCrest, centroid: frameCentroid,
                flux: frameFlux, flatness: frameFlat,
                clip: (clipped2 / (n * 2)) * 100,
                sat: (flat / (n * 2)) * 100,
            };

            // Only accumulate while there is signal — silence between phrases
            // would otherwise drag every integrated figure toward zero and make
            // a sparse arrangement look duller than a dense one at the same
            // settings.
            if (frameRms > SILENCE_RMS) {
                // The window is stamped from the SAME gate the sums use, so
                // coverage describes what was actually integrated rather than
                // how long the transport has been running.
                const t = sig.currentTime ?? (sig.progress || 0) * (sig.duration || 0);
                if (acc.windowStart === null) acc.windowStart = t;
                acc.windowEnd = t;
                if (peak > acc.peak) acc.peak = peak;
                acc.sumSq += sumSq;
                acc.samples += n * 2;
                acc.clipped += clipped2;
                acc.flat += flat;
                acc.centroidSum += frameCentroid;
                acc.fluxSum += frameFlux;
                acc.flatSum += frameFlat;
                acc.specFrames++;
            }
        }

        // ---- live (smoothed) and integrated values ------------------------
        const raw = store.liveRaw ||
            { crest: 0, centroid: 0, flux: 0, flatness: 0, clip: 0, sat: 0 };
        const alpha = smoothingAlpha(params.smoothing ?? 0.7, dt);

        if (!store.live) store.live = { ...raw };
        for (const k of Object.keys(raw)) {
            store.live[k] += (raw[k] - store.live[k]) * alpha;
        }

        // Integrated crest uses the whole-take peak over the whole-take RMS, so
        // it describes the programme rather than averaging per-frame crests
        // (which would flatter a track with a few loud transients).
        const intRms = acc.samples > 0 ? Math.sqrt(acc.sumSq / acc.samples) : 0;
        const integrated = {
            crest: intRms > 1e-6 && acc.peak > 0 ? 20 * Math.log10(acc.peak / intRms) : 0,
            centroid: acc.specFrames ? acc.centroidSum / acc.specFrames : 0,
            flux: acc.specFrames ? acc.fluxSum / acc.specFrames : 0,
            flatness: acc.specFrames ? acc.flatSum / acc.specFrames : 0,
            clip: acc.samples ? (acc.clipped / acc.samples) * 100 : 0,
            sat: acc.samples ? (acc.flat / acc.samples) * 100 : 0,
        };
        store.integrated = integrated;

        // ---- draw ---------------------------------------------------------
        const ref = store.reference;
        // The HUD is sized in text: at a larger text scale a fixed-width box
        // just clips its own hint line off the right edge.
        const S = textScale();
        const pad = 10 * S;
        // The coverage header is not optional chrome: every row beneath it is
        // conditional on the window it names, so the two are sized together.
        const headH = 13 * S;
        const rowH = Math.max(11 * S, Math.min(20 * S,
            (rect.h - pad * 2 - 34 * S - headH) / METRICS.length));
        const panelW = Math.min(rect.w - pad * 2, 366 * S);

        // Coverage and the hint are needed to SIZE the panel, so they are
        // resolved before it is drawn rather than inside the paint pass.
        const cov = this.coverage(store, sig.duration);
        store.refCoverage = cov;          // what a freeze right now would capture

        const hintLineH = 11 * S;
        let hint = null, hintLines = [];
        if (params.showHints !== false) {
            hint = suggest(integrated, ref, gfx.bench, cov);
            ctx.save();
            ctx.font = "9px ui-monospace, monospace";
            hintLines = wrapText(ctx, "HYP: " + hint.text, panelW - 16 * S, 3);
            ctx.restore();
        }

        const panelH = pad + headH + METRICS.length * rowH +
                       (hint ? 14 * S + hintLines.length * hintLineH : 12 * S);

        store.panelRect = { x: rect.x + pad, y: rect.y + pad, w: panelW, h: panelH };

        clipped(ctx, rect, () => {
            if (params.showSpectrum !== false) drawSpectrumBackdrop(gfx, rect, sig, store);
            // Scrim under the panel. The node may be showing album art, and the
            // HUD's own translucency is not enough on a bright frame.
            ctx.save();
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            rr(ctx, store.panelRect.x, store.panelRect.y, panelW, panelH, 6);
            ctx.fill();
            ctx.restore();

            // Panel
            ctx.fillStyle = palette.get("guidance.hud.bg");
            rr(ctx, store.panelRect.x, store.panelRect.y, panelW, panelH, 6);
            ctx.fill();
            ctx.strokeStyle = palette.get("grid.line");
            ctx.lineWidth = 1;
            ctx.stroke();

            const labelX = store.panelRect.x + 8 * S;
            const barX = labelX + 62 * S;
            // The two right-hand columns are right-aligned text, so the track
            // has to stop short of them by their full width — "16605 Hz" plus
            // a delta is wider than it looks, and at the old width the value
            // was printed on top of the end of the bar.
            const VAL_W = 62 * S, DELTA_W = 60 * S;
            const barW = Math.max(40, panelW - 62 * S - VAL_W - DELTA_W - 16 * S);
            const valX = store.panelRect.x + panelW - 8 * S;

            ctx.font = "10px ui-monospace, monospace";
            ctx.textBaseline = "middle";

            // ---- coverage header -------------------------------------
            // "INTEGRATED 0:00-1:40 - 45% of take". Without this the rows look
            // like whole-take figures and disagree with the bench strip, which
            // genuinely is whole-take. They are not wrong; they are answering a
            // narrower question, and the panel never said so.
            const restarts = store.autoResets || 0;
            // A delta between unequal windows is not a measurement. Greyed and
            // labelled rather than hidden: the numbers are still real, they
            // just are not comparable yet, and saying so is more use than
            // removing them.
            const covMismatch = ref && ref.coverage != null && cov != null &&
                                Math.abs(cov - ref.coverage) > 0.05;
            ctx.font = "9px ui-monospace, monospace";
            ctx.textAlign = "left";
            ctx.fillStyle = palette.get(
                cov !== null && cov < 0.8 ? "bench.warn" : "text.dim");
            const headY = store.panelRect.y + 4 * S + headH / 2;
            if (cov === null) {
                ctx.fillText("INTEGRATED — nothing measured yet", labelX, headY);
            } else {
                const a = store.acc;
                const mark = restarts > 0 ? "\u21ba " : "";
                ctx.fillText(
                    `${mark}INTEGRATED ${fmtTime(a.windowStart)}\u2013${fmtTime(a.windowEnd)}` +
                    ` \u00b7 ${Math.round(cov * 100)}% of take`,
                    labelX, headY);
            }
            ctx.font = "10px ui-monospace, monospace";

            METRICS.forEach((m, i) => {
                const y = store.panelRect.y + 6 * S + headH + i * rowH + rowH / 2;
                const live = store.live[m.key];
                const integ = integrated[m.key];

                ctx.fillStyle = palette.get("text.dim");
                ctx.textAlign = "left";
                ctx.fillText(m.label, labelX, y);

                // Track
                ctx.fillStyle = palette.get("grid.line");
                ctx.fillRect(barX, y - 3, barW, 6);

                const place = v => {
                    const t = m.log
                        ? (Math.log2(Math.max(m.min, Math.min(m.max, v || m.min)) / m.min) /
                           Math.log2(m.max / m.min))
                        : (v - m.min) / (m.max - m.min);
                    return barX + Math.max(0, Math.min(1, t)) * barW;
                };

                // Integrated value: the comparable one, drawn solid.
                ctx.fillStyle = palette.get("guidance.path");
                ctx.fillRect(place(integ) - 1.5, y - 5, 3, 10);

                // Live value: a lighter tick that moves while you listen.
                ctx.fillStyle = palette.get("guidance.target");
                ctx.fillRect(place(live) - 1, y - 3, 2, 6);

                // Frozen reference
                if (ref) {
                    ctx.fillStyle = palette.get("guidance.ref");
                    ctx.fillRect(place(ref[m.key]) - 1, y - 7, 2, 14);
                }

                ctx.textAlign = "right";
                const shown = integ.toFixed(m.dp) + (m.unit ? " " + m.unit : "");
                // The reading itself gets the bright role. It is the one thing
                // on this panel worth looking at, and the panel is drawn over
                // whatever artwork the track carries.
                ctx.fillStyle = palette.get("text");
                ctx.fillText(shown, valX - DELTA_W, y);

                if (ref) {
                    const d = integ - ref[m.key];
                    const moved = !covMismatch && Math.abs(d) > (m.max - m.min) * 0.01;

                    // Direction is carried by an arrow, not by hue. Colouring
                    // "up" red and "down" green asserts that up is worse, which
                    // is wrong for four of these five rows — a FALLING crest is
                    // the bad direction, and centroid and flatness have no
                    // inherently good direction at all. The meter refuses to
                    // make that judgement everywhere else; the delta column
                    // should not sneak it back in through colour.
                    //
                    // CLIP is the one exception: more clipping is unambiguously
                    // worse, so a rise there does get the warning role.
                    const worse = m.key === "clip" && d > 0 && moved;
                    ctx.fillStyle = covMismatch ? palette.get("text.dim")
                                  : worse ? palette.alpha("guidance.over", 1)
                                  : moved ? palette.get("text")
                                          : palette.get("text.dim");
                    const arrow = !moved ? " " : d > 0 ? "▲" : "▼";
                    ctx.fillText(arrow + signed(d, m.dp), valX, y);
                } else {
                    ctx.fillStyle = palette.get("text.dim");
                    ctx.fillText("—", valX, y);
                }
            });

            // Footer: reference state and the hypothesis line.
            const footY = store.panelRect.y + 6 * S + headH + METRICS.length * rowH + 8 * S;
            ctx.textAlign = "left";
            ctx.font = "9px ui-monospace, monospace";
            ctx.fillStyle = covMismatch ? palette.get("bench.warn") : palette.get("text.dim");
            ctx.fillText(
                covMismatch
                    ? `REF ${Math.round(ref.coverage * 100)}% \u00b7 now ${Math.round(cov * 100)}% — deltas not comparable`
                    : ref ? "REF FROZEN — click panel to clear"
                          : "click panel to freeze this take as reference",
                labelX, footY,
            );

            if (hint) {
                // Full alpha: guidance.over is a translucent fill role, and at
                // its native alpha this line is barely legible on the HUD.
                ctx.fillStyle = hint.strong
                    ? palette.alpha("guidance.over", 1)
                    : palette.get("text.dim");
                hintLines.forEach((ln, i) => {
                    ctx.fillText(ln, labelX, footY + 12 * S + i * hintLineH);
                });
            }
        });
    },

    /** Click the panel to freeze or clear the reference take. */
    hit(pt, rect, gfx) {
        const r = gfx && gfx.store && gfx.store.panelRect;
        if (!r) return null;
        if (pt.x < r.x || pt.x > r.x + r.w || pt.y < r.y || pt.y > r.y + r.h) return null;

        const store = gfx.store;
        // The coverage travels WITH the frozen figures. A reference taken over
        // 45% of one take and compared against 85% of another is comparing
        // unequal fractions of two different things, and the delta column — the
        // entire point of this panel — was reporting that as a finding.
        store.reference = store.reference
            ? null
            : { ...store.integrated, coverage: store.refCoverage ?? null };
        return { action: "consumed" };
    },

    dispose(gfx) {
        gfx.store.acc = null;
        gfx.store.prevSpec = null;
        gfx.store.mags = null;
        gfx.store.spectrum = null;
        gfx.store.lastNow = undefined;
    },
};

// ---------------------------------------------------------------------------
// Directional hints — HYPOTHESES, not measurements
// ---------------------------------------------------------------------------
//
// The reasoning, so you can argue with it rather than trust it:
//
//   Low crest          transients flattened. Over-guidance (high cfg_scale) and
//                      over-long sampling both do this. Lower cfg first.
//   High centroid      energy pushed up the spectrum; the usual audible face of
//                      guidance oversaturation. Lower cfg, or raise the
//                      sampler's APG norm threshold, which exists for this.
//   Low centroid+flux  dull and static: under-resolved. More steps, or adjust
//                      shift so more of the schedule lands where detail forms.
//   High flatness      drifting toward noise. Lower temperature.
//   Low flatness+flux  over-tonal and static: too deterministic. Raise
//                      temperature or eta.
//   Any clipping       reduce cfg_scale before anything else; it is the
//                      clearest oversaturation signal there is.
//
// None of this is validated against ACE-Step. Log takes, compare against a
// frozen reference, and replace these rules with what you actually observe.

/**
 * Signed delta. Rounds first, so a difference that vanishes at this many
 * decimals prints "0" rather than the "-0" a naive sign test produces.
 */
function signed(d, dp) {
    const r = +d.toFixed(dp);
    return (r > 0 ? "+" : "") + r.toFixed(dp);
}

export function suggest(m, ref, bench = null, coverage = null) {
    // THREE TIERS WITH HARD PRECEDENCE, and a coverage gate on the last one.
    //
    // A tier SUPPRESSES the tiers below it rather than outranking them. The
    // cost is asymmetric: a confident wrong hypothesis gets acted on. Clipping
    // reduces crest, so a take with a gain fault reads as "low crest", and the
    // old flat list answered "lower cfg_scale" — five minutes of re-render
    // chasing a fault that lives in the output stage and would survive every
    // value of cfg_scale tried.
    //
    //   1 LEVEL   whole-file, pre-clamp, from compute_bench
    //   2 MASTER  flat-topping in what was decoded
    //   3 GEN     crest / centroid / flatness / flux — SUPPRESSED below 80%
    //             coverage, because a partial window cannot support a claim
    //             about the take
    //
    // No tier names a parameter to change. The meter measures output; it cannot
    // attribute a measurement to one setting, and a line that says "lower
    // cfg_scale" claims exactly that. Every line names the metric and threshold
    // that fired it, so a reading can be audited rather than believed.

    const level = levelFault(bench);
    if (level) return level;

    // -- tier 2: the master ----------------------------------------------
    if (m.sat > 1.0) {
        return { tier: 2, strong: true,
                 text: `SAT ${m.sat.toFixed(2)}% (>1.00) — flat-top saturation. Lossless source only; an MP3 reads 0 regardless.` };
    }
    if (m.clip > 0.02) {
        return { tier: 2, strong: true,
                 text: `CLIP ${m.clip.toFixed(4)}% (>0.0200) — clipping in the decoded audio. Check the output stage before the rows above.` };
    }

    // -- tier 3: generation stage, only over enough of the take -----------
    if (coverage !== null && coverage < 0.8) {
        return { tier: 3, strong: false, partial: true,
                 text: `${Math.round(coverage * 100)}% of take measured — play further before reading the rows as the take's figures.` };
    }

    const over = coverage === null ? "" : ` over ${Math.round(coverage * 100)}% of take`;

    if (ref) {
        const rel = relative(m, ref);
        if (rel) return rel;
    }

    // Absolute fallbacks. Thresholds sit outside the range real music occupied
    // when measured (centroid 1800-7100 Hz, flatness -15..-3 dB, flux
    // 0.03-0.10), so a line fires only when something is off the scale.
    if (m.crest < 6) {
        return { tier: 3, strong: true,
                 text: `CREST ${m.crest.toFixed(1)} dB${over} (<6.0) — below the 7.7 dB p05 of the reference render. Compare against a frozen take before attributing it to a setting.` };
    }
    if (m.centroid > 8500) {
        return { tier: 3, strong: true,
                 text: `CENTROID ${m.centroid.toFixed(0)} Hz${over} (>8500) — brighter than any measured material. Compare against a frozen take.` };
    }
    if (m.flatness > -1.5) {
        return { tier: 3, strong: true,
                 text: `FLATNESS ${m.flatness.toFixed(1)} dB${over} (>-1.5) — approaching white noise. Compare against a frozen take.` };
    }
    if (m.centroid < 1200 && m.flux < 0.04) {
        return { tier: 3, strong: true,
                 text: `CENTROID ${m.centroid.toFixed(0)} Hz (<1200) with FLUX ${m.flux.toFixed(3)} (<0.040)${over} — dull and static. Compare against a frozen take.` };
    }
    if (m.flatness < -20) {
        return { tier: 3, strong: false,
                 text: `FLATNESS ${m.flatness.toFixed(1)} dB${over} (<-20) — more tonal than any measured material.` };
    }

    if (ref) return { tier: 3, strong: false, text: "tracking REF — no meaningful drift yet" };
    return { tier: 3, strong: false, text: "no strong artifact signature" };
}

/**
 * Word-wrap `text` to `maxW`, at most `maxLines` lines.
 *
 * The hint lines carry the metric and the threshold that fired them, which is
 * what makes a reading auditable rather than oracular — and which also made
 * them roughly three times longer than the one-clause hints they replaced.
 * They overran the panel and overprinted themselves. Truncating would throw
 * away the threshold, so they wrap instead and the panel grows to fit.
 *
 * Assumes ctx.font is already set: measurement depends on it, and the global
 * font patch means "9px" is already the scaled size.
 */
function wrapText(ctx, text, maxW, maxLines = 3) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
        const next = line ? line + " " + w : w;
        if (ctx.measureText(next).width <= maxW || !line) {
            line = next;
        } else {
            lines.push(line);
            line = w;
            if (lines.length === maxLines) break;
        }
    }
    if (lines.length < maxLines && line) lines.push(line);
    // A dropped tail is worse than a visible ellipsis: the reader needs to know
    // the line was cut rather than assume it ended there.
    if (lines.length === maxLines) {
        const last = lines[maxLines - 1];
        const consumed = lines.join(" ");
        if (consumed.length < text.length) {
            let t = last;
            while (t && ctx.measureText(t + " …").width > maxW) {
                t = t.slice(0, -1);
            }
            lines[maxLines - 1] = t + " …";
        }
    }
    return lines;
}

/**
 * Tier 1 — level and format faults, from the whole-file Python measurement.
 *
 * These CANNOT come from the meter's own rows. It measures the decoded WAV,
 * which save_wav already clamped, so a take that overshot full scale looks
 * clean to it: the overshoot is gone and the peak reads 0 dBFS. `bench` is
 * measured before the clamp and is the only place the overshoot survives.
 *
 * Returns null without bench data — a fault that cannot be measured must not
 * be guessed at.
 */
function levelFault(bench) {
    if (!bench) return null;

    const peak = bench.peak_db;
    const over = bench.over_fs || 0;

    if (typeof peak === "number" && peak > 0) {
        const clamped = over ? `, ${over} samples over scale` : "";
        return { tier: 1, strong: true,
                 text: `PEAK ${peak > 0 ? "+" : ""}${peak.toFixed(2)} dBFS (>0.00)${clamped} — fix output gain before reading generation metrics.` };
    }
    if (over > 0) {
        return { tier: 1, strong: true,
                 text: `${over} samples over full scale, clamped by the WAV write — fix output gain before reading generation metrics.` };
    }
    // 0.001 was a guess and it was wrong.  Measured across 54 ACE-Step FLACs
    // from NovaFemme's own input folder: min 0.00014, median 0.00201, max
    // 0.00265 -- 44 of 54 above 0.001 and none above 0.005.  A constant
    // ~0.002 is what this decoder leaves behind, so a line at 0.001 fires on
    // four takes in five and, being tier 1, blanks out every hypothesis below
    // it.  An alarm that is always on is not an alarm.
    //
    // 0.01 (1% of full scale, about -40 dBFS) is where DC starts costing
    // audible headroom and where a corpus that tops out at 0.0027 says
    // something has genuinely changed.  At 0.002 the cost is ~0.001 dB of
    // headroom and 0.02% of RMS power: real, measurable, and not worth
    // suppressing the rest of the panel for.  The bench strip's DC row still
    // shows the number on every take, which is the right place for something
    // informational.
    if (typeof bench.dc_offset === "number" && Math.abs(bench.dc_offset) > 0.01) {
        return { tier: 1, strong: true,
                 text: `DC offset ${bench.dc_offset.toFixed(5)} (>0.01000) — check the decode path.` };
    }
    // Null is mono, which is not a fault.
    if (typeof bench.lr_corr === "number" && bench.lr_corr < 0.3) {
        return { tier: 1, strong: true,
                 text: `L/R correlation ${bench.lr_corr.toFixed(2)} (<0.30) — check mono compatibility.` };
    }
    return null;
}

/**
 * Reading of the largest meaningful move away from the frozen reference.
 *
 * Each candidate carries the size of the move it needs before it is worth
 * mentioning — set from what the metric actually does, not from a single global
 * epsilon, since 1 dB of crest and 500 Hz of centroid are not comparable
 * quantities. The one with the largest move relative to its own threshold wins,
 * so the line always names the thing that changed most, not the first rule in
 * the list.
 */
function relative(m, ref) {
    const pct = (a, b) => (b !== 0 ? (a - b) / Math.abs(b) : 0);

    // Clipping and flat-topping are NOT candidates here: they are tier 2 and
    // are handled before this function is reached, so a level or master fault
    // can never be outscored by a spectral wobble.
    const candidates = [
        { on: m.crest - ref.crest < -1.5, score: Math.abs(m.crest - ref.crest) / 1.5,
          text: () => `CREST ${(m.crest - ref.crest).toFixed(1)} dB vs REF (>1.5) — transients flattening. Lower cfg_scale is the usual cause; verify before assuming.` },
        { on: m.crest - ref.crest > 1.5, score: Math.abs(m.crest - ref.crest) / 1.5,
          text: () => `CREST +${(m.crest - ref.crest).toFixed(1)} dB vs REF (>1.5) — transients sharper. Whatever changed, this direction is working.` },

        { on: pct(m.centroid, ref.centroid) > 0.15, score: pct(m.centroid, ref.centroid) / 0.15,
          text: () => `CENTROID +${(pct(m.centroid, ref.centroid) * 100).toFixed(0)}% vs REF (>15%) — brighter. Listen for harshness before deciding it is an improvement.` },
        { on: pct(m.centroid, ref.centroid) < -0.15, score: -pct(m.centroid, ref.centroid) / 0.15,
          text: () => `CENTROID ${(pct(m.centroid, ref.centroid) * 100).toFixed(0)}% vs REF (>15%) — darker. Worth testing more steps, or shift.` },

        { on: m.flatness - ref.flatness > 2, score: (m.flatness - ref.flatness) / 2,
          text: () => `FLATNESS +${(m.flatness - ref.flatness).toFixed(1)} dB vs REF (>2.0) — noisier. Worth testing a lower temperature.` },
        { on: m.flatness - ref.flatness < -2, score: -(m.flatness - ref.flatness) / 2,
          text: () => `FLATNESS ${(m.flatness - ref.flatness).toFixed(1)} dB vs REF (>2.0) — more tonal. Worth testing a higher temperature or eta.` },

        { on: pct(m.flux, ref.flux) < -0.2, score: -pct(m.flux, ref.flux) / 0.2,
          text: () => `FLUX ${(pct(m.flux, ref.flux) * 100).toFixed(0)}% vs REF (>20%) — more smeared. Worth testing more steps, or a lower cfg.` },
        { on: pct(m.flux, ref.flux) > 0.2, score: pct(m.flux, ref.flux) / 0.2,
          text: () => `FLUX +${(pct(m.flux, ref.flux) * 100).toFixed(0)}% vs REF (>20%) — busier than the reference.` },
    ];

    let best = null;
    for (const c of candidates) {
        if (!c.on || !Number.isFinite(c.score)) continue;
        if (!best || c.score > best.score) best = c;
    }
    if (!best) return null;
    return { tier: 3, strong: true,
             text: typeof best.text === "function" ? best.text() : best.text };
}

// ---------------------------------------------------------------------------

/** Faint live spectrum behind the panel, for context while you listen. */
function drawSpectrumBackdrop(gfx, rect, sig, store) {
    const { ctx, palette } = gfx;
    const bins = sig.binCount;
    const cols = Math.max(2, Math.floor(rect.w));

    if (!store.spectrum || store.spectrum.length !== cols) {
        store.spectrum = new Float32Array(cols);
    }

    ctx.strokeStyle = palette.get("guidance.path");
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let px = 0; px < cols; px++) {
        const i = Math.min(bins - 1, Math.floor((px / cols) * bins));
        const v = byteToNorm(sig.freq[i]);
        store.spectrum[px] += (v - store.spectrum[px]) * 0.25;
        const y = rect.y + rect.h - store.spectrum[px] * rect.h;
        px === 0 ? ctx.moveTo(rect.x + px, y) : ctx.lineTo(rect.x + px, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}
