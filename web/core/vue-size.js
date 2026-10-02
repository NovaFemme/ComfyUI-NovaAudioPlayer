/**
 * vue-size.js — minimum sizes for Nova's DOM-widget nodes under Nodes 2.0.
 *
 * WHY THE CLASSIC MINIMUMS DO NOTHING THERE
 * -----------------------------------------
 * On the classic (canvas) renderer a node's minimum size comes from
 * `computeSize()` and each DOM widget's `getMinHeight()`, and the panel inside
 * the widget is resized from `node.size` on every `onDrawForeground`. Nodes 2.0
 * (the Vue renderer) uses none of that. Read from the frontend's resize code,
 * v1.53.6 (`useNodeResize.ts`):
 *
 *   minimum HEIGHT  the node card's rendered height with `--node-height` set
 *                   to 0px — the natural height of whatever is in normal flow
 *   minimum WIDTH   the card's INLINE `min-width` style, or 225 px
 *
 * Every Nova DOM widget is a pass-through host with the visible panel
 * positioned absolutely inside it. An absolutely positioned element adds
 * nothing to its parent's natural height, so the node measured as nearly empty
 * and could be dragged down to 225 px wide and a few rows tall, with the panel
 * hanging out of it. And with no `onDrawForeground` pass the panel never
 * followed the node at all: it kept the pixel size it was created with.
 *
 * WHAT THIS DOES
 * --------------
 * `vueSize(host, panel, { minWidth, minHeight })` marks the two elements. From
 * then on, and only inside a Nodes 2.0 card (`[data-node-id]`):
 *
 *   - the host has a CSS `min-height`, which IS in flow, so the frontend's
 *     own measurement now includes it;
 *   - the panel fills the host (`inset: 0`) instead of keeping its remembered
 *     pixel size, so it follows the node when the node is resized;
 *   - the card gets an inline `min-width` for the length of a resize. It is
 *     written on `pointerdown`, in the capture phase, which runs before the
 *     frontend's own handler reads it, and removed on `pointerup`. Vue
 *     replaces and reuses card elements, and a value written at that moment
 *     cannot be stale.
 *
 * On the classic renderer a DOM widget is not inside a `[data-node-id]`
 * element, so none of the rules match and nothing changes there.
 *
 * It does not depend on Nova Theme Studio. The studio's Nodes 2.0 adapter
 * stretches panels too, for any pack's nodes; its rules and these agree.
 */

const STYLE_ID = "nova-vue-size";
const HOST = "nova-dom-host";
const PANEL = "nova-dom-panel";

/** The frontend's own floor (MIN_NODE_WIDTH). Nothing below it needs writing. */
const FRONTEND_MIN_WIDTH = 225;

function widthFor(card) {
    let width = 0;
    for (const host of card.querySelectorAll(`.${HOST}[data-nova-min-w]`)) {
        width = Math.max(width, Number(host.dataset.novaMinW) || 0);
    }
    return width;
}

/** The card this module last wrote a min-width on, so it can be taken off again. */
let marked = null;

function onPointerDown(event) {
    const card = event.target?.closest?.("[data-node-id]");
    if (!card) return;
    const width = widthFor(card);
    if (width > FRONTEND_MIN_WIDTH) {
        card.style.minWidth = `${width}px`;
        marked = card;
    }
}

// TAKEN OFF AGAIN WHEN THE POINTER IS RELEASED. Vue reuses a card element for
// another node, and a min-width left behind made the next node on that element
// 430 px wide whatever it was: measured, a Nova Console created after a Theme
// Studio node. The frontend only reads the value while a resize is in progress,
// so it has no reason to outlive one.
function onPointerUp() {
    if (!marked) return;
    marked.style.removeProperty("min-width");
    marked = null;
}

function install() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // `!important` on both, for one reason each. The host's min-height has to
    // survive the studio adapter's own `min-height: 0` on the same element. The
    // panel's box is set by INLINE styles the node's own code writes, and no
    // ordinary rule outranks an inline one.
    style.textContent = `
[data-node-id] .${HOST} { min-height: var(--nova-min-h, 0px) !important; }
[data-node-id] .${HOST} > .${PANEL} {
    position: absolute !important; inset: 0 !important;
    width: auto !important; height: auto !important;
}`;
    document.head.appendChild(style);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
}

/**
 * @param host   the element handed to `addDOMWidget`
 * @param panel  the absolutely positioned panel inside it
 * @param min    `{ minWidth, minHeight }` in CSS pixels at zoom 1. `minHeight`
 *               is the panel's own; the rows above it are measured by the
 *               frontend. `minWidth` is the whole node's.
 */
export function vueSize(host, panel, { minWidth = 0, minHeight = 0 } = {}) {
    install();
    host.classList.add(HOST);
    panel.classList.add(PANEL);
    if (minHeight > 0) host.style.setProperty("--nova-min-h", `${Math.round(minHeight)}px`);
    if (minWidth > 0) host.dataset.novaMinW = String(Math.round(minWidth));
    return host;
}

/**
 * Keep a node from being narrower than its minimum when it is created and
 * when it is restored from a workflow — one saved before the minimum existed,
 * for instance. The resize handle is covered by the rules above; this covers
 * the two moments a size arrives without a resize. Safe on both renderers, and
 * it does nothing when the node is already wide enough.
 */
export function keepMinimumWidth(node, minWidth) {
    if (!node || !(minWidth > 0)) return;
    const widen = () => {
        const width = node.size?.[0] ?? 0;
        if (width > 0 && width < minWidth) node.setSize([minWidth, node.size[1]]);
    };
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = onConfigure?.apply(this, args);
        requestAnimationFrame(widen);
        return result;
    };
    requestAnimationFrame(widen);
}

/**
 * Make a node exactly as tall as its panel needs, under Nodes 2.0.
 *
 * The classic renderer does this inside `onDrawForeground`, from the widget's
 * `y`. Neither exists under Nodes 2.0, so the difference is measured on the
 * page instead: how tall the host is now against how tall the panel wants to
 * be. `offsetHeight` is in CSS pixels before the canvas zoom, which is the
 * unit `node.size` is in.
 *
 * Returns false on the classic renderer, where the host is not inside a node
 * card, so the caller can fall back to its own path.
 */
export function fitHeightInVue(node, host, wantHeight) {
    const card = host?.closest?.("[data-node-id]");
    if (!card || !node?.size) return false;
    const delta = Math.round(wantHeight - host.offsetHeight);
    if (Math.abs(delta) > 2) {
        node.setSize([node.size[0], Math.max(1, node.size[1] + delta)]);
        node.setDirtyCanvas?.(true, true);
    }
    return true;
}
