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

app.registerExtension({
    name: "Comfy.MadowInputs",

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        const bar = buildPresetBar(node);

        // serialize:false — the bar holds no state of its own. What preset is
        // loaded lives in the `preset_name` widget, which ComfyUI already
        // serialises, so the workflow records it exactly once.
        node.addDOMWidget(BAR_WIDGET, "madow_presets", bar.element, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 54,
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

        const minW = 420;
        if (node.size[0] < minW) node.setSize([minW, node.size[1]]);
    },
});
