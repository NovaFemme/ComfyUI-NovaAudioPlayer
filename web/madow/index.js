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
import { applyTwoColumnOutputs, canApply } from "./two-column.js";

// LiteGraph is a global, NOT a named export of app.js. Importing it as one
// would be a load-time failure that takes this whole module — preset bar
// included — down with it, which is a far worse outcome than a tall node.
// Read at call time rather than at module scope: the extension may be
// evaluated before the global is assigned.
const liteGraph = () => globalThis.LiteGraph ?? null;

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

        // -- two-column outputs --------------------------------------
        // 30 outputs against one input means LiteGraph sizes the slot region
        // at 30 rows, 29 of them with an empty left column. Two columns
        // reclaim ~300px.
        //
        // Stored as a node property so the choice travels with the workflow,
        // and defaults on. If a frontend update ever moves getConnectionPos,
        // canApply() returns false and the node renders normally instead of
        // half-patched.
        node.properties = node.properties || {};
        if (node.properties.twoColumnOutputs === undefined) {
            node.properties.twoColumnOutputs = true;
        }

        let restore = null;
        const lg = liteGraph();

        const sync = () => {
            const want = node.properties.twoColumnOutputs !== false;
            if (want && !restore) {
                restore = applyTwoColumnOutputs(node, lg);
                if (!restore) {
                    // Said once, and only when it was actually asked for.
                    console.info("[MadowInputs] two-column outputs unavailable "
                               + "on this frontend — using the default layout");
                    node.properties.twoColumnOutputs = false;
                }
            } else if (!want && restore) {
                restore();
                restore = null;
            }
            node.setSize(node.computeSize());
            node.setDirtyCanvas(true, true);
        };

        node.__madowToggleColumns = () => {
            node.properties.twoColumnOutputs = !node.properties.twoColumnOutputs;
            sync();
        };

        // A user who hits a rendering bug can turn this off without editing
        // files or losing the workflow.
        const origMenu = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origMenu?.apply(this, arguments);
            if (!canApply(this, lg) && this.properties.twoColumnOutputs === false) return;
            options.push({
                content: this.properties.twoColumnOutputs !== false
                    ? "Outputs: single column"
                    : "Outputs: two columns",
                callback: () => this.__madowToggleColumns(),
            });
        };

        sync();

        const minW = 420;
        if (node.size[0] < minW) node.setSize([minW, node.size[1]]);
    },
});
