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

        const minW = 400;
        if (node.size[0] < minW) node.setSize([minW, node.size[1]]);
    },
});
