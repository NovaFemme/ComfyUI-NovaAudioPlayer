/**
 * Madow Inputs — frontend registration.
 *
 * Two jobs only: attach the preset bar, and keep `preset_name` out of the way.
 * The 23 parameter widgets are ComfyUI's own, built from INPUT_TYPES, and are
 * deliberately left alone — grouping them into collapsible sections means
 * hiding auto-generated widgets through frontend internals that have moved
 * between versions, and a node that fails to render is worse than a tall one.
 */

import { app } from "/scripts/app.js";
import { buildPresetBar } from "./preset-bar.js";

const NODE_TYPE = "MadowInputs";
const BAR_WIDGET = "madow_preset_bar";

// Narrower than this and the four controls wrap onto three rows, which is a
// worse node than a wide one.
const MIN_W = 420;
// One row of controls plus its padding: the floor, and the starting guess for
// the first frame, before the bar has been laid out and can be measured.
const MIN_BAR_H = 34;
// What ComfyUI leaves between the last widget and the bottom edge. Without it
// the bar sits flush against the border and the last row reads as clipped even
// when it is not.
const BOTTOM_PAD = 6;

const barHeight = (node) => Math.max(MIN_BAR_H, node._madowBarH || MIN_BAR_H);

/**
 * The shortest this node can be with every control visible.
 *
 * Two candidates, and the taller wins.
 *
 * `computeSize()` is the frontend's own answer and is the one that matters,
 * because it is what the resize handle clamps against — it walks the widget
 * stack and asks each widget for its height, which for a DOM widget means
 * `getMinHeight`. Feeding that a real measurement is most of this fix.
 *
 * `widget.y` is the bar's actual top edge from the last layout pass, so
 * `y + height` is where the bar really ends. It is the more direct number when
 * it is available, but it is only set once the node has been drawn and can be a
 * frame stale after a widget appears or disappears — hence both, not either.
 */
function neededHeight(node) {
    let needed = 0;

    try {
        const computed = node.computeSize?.();
        if (computed && Number.isFinite(computed[1])) needed = computed[1];
    } catch {
        // A frontend that computes sizes differently is not a reason to fail;
        // widget.y below still gives an answer.
    }

    const w = node.widgets?.find(x => x.name === BAR_WIDGET);
    const y = w?.y ?? w?.last_y;
    if (typeof y === "number" && y > 0) {
        needed = Math.max(needed, y + barHeight(node) + BOTTOM_PAD);
    }

    return Math.ceil(needed);
}

/**
 * Re-measure the bar and make the node tall enough to hold it.
 *
 * GROWS FREELY, SHRINKS ONLY WHAT IT GREW. If the node is exactly the height
 * this function last set, nobody has touched it since and closing the save form
 * may take that space back. At any other height the user sized it by hand, and
 * quietly undoing that on the next message is the kind of thing that makes a
 * node feel possessed.
 */
function fit(node, bar) {
    const measured = bar.measure();
    if (measured > 0) node._madowBarH = Math.max(MIN_BAR_H, Math.ceil(measured));

    const needed = neededHeight(node);
    if (!needed) return;

    const width = Math.max(node.size[0], MIN_W);
    // "Ours" means the node is still at exactly the height this function last
    // put it at, so nothing has resized it since and the space is ours to give
    // back. Any other height was chosen by hand.
    const ours = Math.abs(node.size[1] - (node._madowFitH ?? -1)) <= 2;
    const height = ours ? needed : Math.max(node.size[1], needed);

    const grew = Math.abs(height - node.size[1]) > 1;
    if (grew || width !== node.size[0]) {
        node.setSize([width, height]);
        node.setDirtyCanvas(true, true);
    }

    // Claim the height ONLY when this call actually set it. Recording the
    // user's own height here instead would make the next call believe it put it
    // there, and the following one would take it away — a node that springs
    // back to its minimum the first time a message appears.
    if (grew) node._madowFitH = height;
    else if (!ours) node._madowFitH = null;
}

app.registerExtension({
    name: "Comfy.MadowInputs",

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        const bar = buildPresetBar(node);
        node._madowBarH = MIN_BAR_H;

        // serialize:false — the bar holds no state of its own. What preset is
        // loaded lives in the `preset_name` widget, which ComfyUI already
        // serialises, so the workflow records it exactly once.
        node.addDOMWidget(BAR_WIDGET, "madow_presets", bar.element, {
            serialize: false,
            hideOnZoom: false,
            // MEASURED, NOT ASSUMED. This was `() => 54`, one row's worth, and
            // it is why the bottom controls fell outside the node: the bar is
            // `flex-wrap`, so its height is whatever the content and the
            // current node width make it. Opening "Save as" adds a full-width
            // row, a long message wraps onto another, and a narrow node pushes
            // the buttons down — none of which 54 knows about. The node was
            // sized for one row and drawn with three.
            getMinHeight: () => barHeight(node),
        });

        // `preset_name` is written by the bar and read by the backend for
        // provenance. Leaving it editable invites someone to type a name that
        // was never loaded, which would put a false preset in the log.
        const nameWidget = node.widgets?.find(w => w.name === "preset_name");
        if (nameWidget) {
            nameWidget.disabled = true;
            nameWidget.tooltip = "Set by the preset bar above. Recorded in " +
                                 "context; never used to supply values.";
        }

        // THE BAR TELLS THE NODE, RATHER THAN THE NODE ASKING EVERY FRAME.
        //
        // Every reason the bar changes height — the save form opening, a
        // message wrapping, the node dragged narrower so the buttons rewrap —
        // ends as a height change on this one element, so one observer covers
        // all of them. Polling from `onDrawForeground` instead would force a
        // layout on every canvas frame for a value that changes a handful of
        // times in a session.
        if (typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(() => fit(node, bar));
            ro.observe(bar.body);
            // An observer holds its target alive; ComfyUI calls this when the
            // node leaves the graph.
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                ro.disconnect();
                return onRemoved?.apply(this, arguments);
            };
        }

        // The resize handle clamps against `computeSize()`, which now reports
        // the real bar height — but a frontend that clamps differently, or a
        // size restored straight out of a workflow, would still be free to cut
        // the controls off. Clamping the size array here is the last word
        // either way, and mutating it in place is how LiteGraph expects an
        // onResize hook to alter a drag.
        const onResize = node.onResize;
        node.onResize = function (size) {
            const r = onResize?.apply(this, arguments);
            if (!size) return r;
            const min = neededHeight(this);
            if (min && size[1] < min) size[1] = min;
            if (size[0] < MIN_W) size[0] = MIN_W;
            return r;
        };

        // A workflow load sets the size after the node is built, so the fit has
        // to run again afterwards or a stored height wins and the controls are
        // clipped every time the graph is opened.
        const onConfigure = node.onConfigure;
        node.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            requestAnimationFrame(() => fit(this, bar));
            return r;
        };

        // Fire and forget: a node that cannot reach the routes still works,
        // it just shows the error in the bar.
        bar.refresh().catch(() => {});

        // NO CUSTOM SLOT LAYOUT HERE, and the reason is worth keeping.
        //
        // 30 outputs make this node tall, so an attempt was made to lay them
        // in two columns by overriding `getConnectionPos` — the LiteGraph hook
        // that historically decided where a slot sits. On ComfyUI frontend
        // 1.45 it changes nothing: measured on a live node, the override was
        // installed and returned two-column coordinates while the node still
        // drew a single column.
        //
        // That frontend replaced the whole mechanism. Nodes now carry
        // `arrange()`, `_measureSlots()`, `drawSlots()` and `_arrangeWidgets()`,
        // and every slot has its own `boundingRect` and `pos`.
        // `getConnectionPos` survives as legacy and drives neither layout nor
        // drawing. An override there is inert at best, and at worst disagrees
        // with the renderer about where a link attaches.
        //
        // The height is also not where it looked. This frontend gives every
        // widget its own inline input slot, so the node reports 29 inputs
        // against 30 outputs: halving the outputs saves ONE row, not fifteen.
        //
        // Anything attempted here must hook the new API and be measured on a
        // real node, not reasoned about from the older LiteGraph.
        //
        // The sizing above and below obeys that: it reasons about no slots at
        // all. It reads the bar's height off the DOM and asks the frontend,
        // through `computeSize()` and `widget.y`, where its own layout put
        // things.

        if (node.size[0] < MIN_W) node.setSize([MIN_W, node.size[1]]);

        // Two frames, on purpose. The element is not in the document when
        // `nodeCreated` runs, so the first frame is where it lands and takes a
        // width, and the second is where it has wrapped to that width and can
        // be measured. The observer above catches everything after that; this
        // is for the newly added node, which has to look right without anyone
        // touching it.
        requestAnimationFrame(() => requestAnimationFrame(() => fit(node, bar)));
    },
});
