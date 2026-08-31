/**
 * layout.js — all widget geometry, as one pure function.
 *
 * Extracted verbatim from the old getLayout() closure, with two changes:
 *
 *   1. It is pure.  It takes numbers and returns numbers, so it can be tested
 *      without a canvas, a node, or an audio file, and two callers (the
 *      renderer and the hit-tester) provably see identical geometry.
 *   2. The minimum sizes live here, once.  The old code declared them in
 *      computeSize() AND again in the onResize prototype patch, where the two
 *      sets could — and did — drift apart.
 *
 * Coordinate space is the widget's own canvas: (0, 0) is the widget's top-left
 * corner, not the node's.  The DOM canvas host means there is no longer a `y`
 * offset to thread through everything.
 */

export const LAYOUT_DEFAULTS = Object.freeze({
    barGap: 2,
    padX: 14,
    meterGap: 6,
    timeOffset: 24,
    timeToScrubGap: 8,
    controlsHeight: 95,
    badgeHeight: 28,
    channelGap: 6,
    minChannelHeight: 40,
    minNodeWidth: 460,
    minNodeHeight: 280,
    minWidgetHeight: 203,
    settingsButton: true,
    benchOpen: false,
    benchHeight: 152,
});

const _cache = new Map();
const CACHE_LIMIT = 32;

/**
 * Compute the full geometry for a widget of `w` x `h` pixels.
 *
 * @param {number} w          widget width in CSS pixels
 * @param {number} h          widget height in CSS pixels
 * @param {boolean} stereo    whether a second channel exists
 * @param {number} peakCount  how many peak samples the file has
 * @param {object} opts       overrides for LAYOUT_DEFAULTS
 * @returns {object} frozen layout
 */
export function computeLayout(w, h, stereo, peakCount, opts = {}) {
    const o = { ...LAYOUT_DEFAULTS, ...opts };
    const key = `${w}|${h}|${stereo ? 1 : 0}|${peakCount}|${o.barGap}|${o.padX}|` +
                `${o.controlsHeight}|${o.settingsButton ? 1 : 0}|` +
                `${o.benchOpen ? 1 : 0}|${o.benchHeight}`;

    const hit = _cache.get(key);
    if (hit) return hit;

    const chGap = stereo ? o.channelGap : 0;

    // Visualisation area: everything between the info badge and the fixed
    // controls block at the bottom.
    // The bench strip is a band across the bottom, below the transport. It
    // takes its height from the visualisation rather than growing the node, so
    // opening it never resizes anything in the graph — the trade is that on a
    // short node the waveform gets cramped, which the minimum below allows for.
    // Clamp the strip to the space that is genuinely spare. Without this, a
    // short node gives the visualiser its minimum height, pushes the transport
    // row down to where it always goes — and the strip, anchored to the bottom
    // edge, is then drawn straight over the transport buttons. The node
    // minimum below grows when the strip is open so this rarely binds, but a
    // node forced smaller must degrade by clipping the strip, never by burying
    // the play button under it.
    const minVis = stereo ? o.minChannelHeight * 2 + o.channelGap : o.minChannelHeight;
    const benchRoom = Math.max(0, h - o.badgeHeight - o.controlsHeight - minVis);
    const benchH = o.benchOpen ? Math.min(o.benchHeight, benchRoom) : 0;
    const benchTop = benchH ? h - benchH : null;

    const wfTop = o.badgeHeight;
    const wfAvail = Math.max(o.minChannelHeight,
                             h - o.controlsHeight - o.badgeHeight - benchH);
    const chH = stereo ? Math.floor((wfAvail - chGap) / 2) : wfAvail;
    const wfH = stereo ? chH * 2 + chGap : chH;
    const wfBottom = wfTop + wfH;

    const ch0MidY = wfTop + chH / 2;
    const ch1MidY = stereo ? wfTop + chH + chGap + chH / 2 : null;

    // Controls are positioned downward from wfBottom so they stay consistent
    // at every node height.
    const timeY = wfBottom + o.meterGap + o.timeOffset;
    const scrubTop = timeY + o.timeToScrubGap;
    const scrubH = 4;
    const btnCY = scrubTop + scrubH + 20;
    const btnCX = w / 2;

    // Bar geometry: fit as many bars as the width allows, never more than the
    // file actually has, never fewer than 10.
    const avail = w - 16;
    const nBars = Math.min(peakCount, Math.max(10, Math.floor(avail / (2 + o.barGap))));
    const barW = Math.max(2, (avail - o.barGap * (nBars - 1)) / nBars);
    const totalW = nBars * (barW + o.barGap) - o.barGap;
    const wfX = 8;

    // Transport row, left to right.
    const spkX = 14, spkY = btnCY;
    const volX = spkX + 16, volW = 70, volY = btnCY, volH = 3, knobR = 4;
    const skipR = 12, skipGap = 10;
    const skipBackCX = btnCX - 16 - skipGap - skipR;
    const skipFwdCX = btnCX + 16 + skipGap + skipR;
    const loopCX = skipFwdCX + skipR + skipGap + skipR;
    const loopCY = btnCY;

    // The settings button sits at the far right; download moves left of it.
    const gearR = 10;
    const gearCX = o.settingsButton ? w - 22 : null;
    const dlBtnR = 10;
    const dlBtnCX = o.settingsButton ? w - 22 - gearR - 12 - dlBtnR : w - 24;
    const dlBtnCY = btnCY;

    // View pill sits midway between the loop button and the download button.
    // Bench toggle sits immediately left of the download button, in the gap
    // the view pill already leaves.
    const benchBtnR = 10;
    const benchBtnCX = dlBtnCX - dlBtnR - 12 - benchBtnR;

    const viewBtnX = Math.round((loopCX + benchBtnCX) / 2);

    const layout = Object.freeze({
        w, h, stereo,
        padX: o.padX,
        barGap: o.barGap,

        // visualisation rect
        wfTop, wfH, wfBottom, wfX, totalW,
        chH, chGap, ch0MidY, ch1MidY,
        midY: ch0MidY,
        nBars, barW,

        // meter + time + scrub
        meterY: wfBottom + o.meterGap,
        timeY, scrubTop, scrubH,
        scrubX: o.padX,
        scrubW: w - o.padX * 2,

        // transport
        btnCX, btnCY, playR: 16,
        spkX, spkY,
        volX, volW, volY, volH, knobR,
        skipR, skipBackCX, skipFwdCX,
        loopCX, loopCY,
        viewBtnX, viewBtnH: 16,
        dlBtnCX, dlBtnCY, dlBtnR,
        gearCX, gearCY: btnCY, gearR,
        hasGear: !!o.settingsButton,

        // bench strip
        benchOpen: !!o.benchOpen, benchH, benchTop,
        // Grab band straddling the top edge, so the cursor does not have to
        // find a 1 px line.
        benchGripTop: benchTop === null ? null : benchTop - 4,
        benchGripH: 8,
        benchMinH: 64,
        benchMaxH: benchRoom,
        benchBtnCX: benchBtnCX, benchBtnCY: btnCY, benchBtnR,
    });

    // Bounded LRU-ish cache: a node being drag-resized generates a new key per
    // pixel, and an unbounded Map would leak for the life of the page.
    if (_cache.size >= CACHE_LIMIT) {
        _cache.delete(_cache.keys().next().value);
    }
    _cache.set(key, layout);
    return layout;
}

/** The visualisation rect, the only geometry a renderer is given. */
export function visualisationRect(L) {
    return { x: L.wfX, y: L.wfTop, w: L.totalW, h: L.wfH };
}

/** Minimum node size, derived from the same constants the layout uses. */
export function minimumNodeSize(stereo, opts = {}) {
    const o = { ...LAYOUT_DEFAULTS, ...opts };
    const wfH = stereo
        ? o.minChannelHeight * 2 + o.channelGap
        : o.minChannelHeight;
    const benchH = o.benchOpen ? o.benchHeight : 0;
    const naturalH = wfH + o.controlsHeight + o.badgeHeight + benchH;
    return [o.minNodeWidth, Math.max(naturalH, o.minWidgetHeight + benchH)];
}

export function clearLayoutCache() {
    _cache.clear();
}
