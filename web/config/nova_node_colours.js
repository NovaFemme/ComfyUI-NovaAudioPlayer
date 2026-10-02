/**
 * nova_node_colours.js — colours this pack's nodes by the role they play in a
 * flow, so a graph reads left to right at a glance.
 *
 * The grouping is deliberately NOT the menu sub-category. Several flows draw
 * every node from a single sub-category — the Tag Writer template is all
 * Delivery & Metadata — and colouring by menu would make those flows one flat
 * colour. Role is what distinguishes load from process from save, which is the
 * thing the eye is actually looking for.
 *
 * Colours are the nine LiteGraph offers under right-click > Colors, taken from
 * LGraphCanvas.node_colors, so a node coloured here is indistinguishable from
 * one a user coloured by hand and the palette stays consistent with core nodes.
 *
 * Only the 28 node types listed below are touched. Nothing else on the canvas
 * is read or modified.
 *
 * The colour is set as a STATIC on the node class, not on its prototype and not
 * on the instance. LGraphNode declares `color` and `bgcolor` as class fields, so
 * every instance owns an `undefined` for both and a prototype value is shadowed
 * and never read. The renderer resolves colour as
 *
 *     this.color || this.constructor.color || LiteGraph.NODE_DEFAULT_COLOR
 *
 * so a static on the class is the supported default, and the instance is still
 * consulted first: recolour a node by hand and your choice wins. Because the
 * instance field stays undefined, serialisation (`this.color && ...`) writes
 * nothing, so a saved workflow stays free of colour and picks the scheme up
 * live — including any later change to it.
 *
 * Turn the whole thing off in Settings > Nova Audio > "Colour nodes by role".
 * The setting applies to nodes added after it changes; reload to restyle a
 * graph that is already open.
 */

import { app } from "/scripts/app.js";

const SETTING_ID = "NovaAudio.ColourNodesByRole";

// LGraphCanvas.node_colors — title bar and body for each palette entry.
const PALETTE = {
    red:       { color: "#322",    bgcolor: "#533" },
    brown:     { color: "#332922", bgcolor: "#593930" },
    green:     { color: "#232",    bgcolor: "#353" },
    blue:      { color: "#223",    bgcolor: "#335" },
    pale_blue: { color: "#2a363b", bgcolor: "#3f5159" },
    cyan:      { color: "#233",    bgcolor: "#355" },
    purple:    { color: "#323",    bgcolor: "#535" },
    yellow:    { color: "#432",    bgcolor: "#653" },
    black:     { color: "#222",    bgcolor: "#000" },
};

const ROLES = {
    green: {
        label: "Input & Load",
        nodes: ["NovaLoadAudio", "NovaBatchLoadAudio", "NovaACEDatasetBuilder"],
    },
    brown: {
        label: "Data & Catalogue",
        nodes: ["NovaSQLiteReader", "NovaTagReader", "NovaSQLDump"],
    },
    purple: {
        label: "Generation",
        nodes: ["MadowInputs", "MadowUnpack", "NovaACELoRATrainer"],
    },
    blue: {
        label: "Process",
        nodes: ["NovaAudioMaster", "NovaACEPreprocess"],
    },
    yellow: {
        label: "Identity & Provenance",
        nodes: ["NovaMasterIdentity"],
    },
    cyan: {
        label: "Analysis & Validation",
        nodes: [
            "NovaFinalMasterValidator", "NovaTrackInspector",
            "NovaACEDatasetReview", "NovaACESetupCheck",
            "NovaMemoryProbe",
        ],
    },
    red: {
        // Writes to disk and cannot be undone. Nova Tag Writer reads like a
        // database node but edits your audio files in place, which is the same
        // class of act as a save, so it is warned about the same way.
        label: "Writes to disk",
        nodes: ["NovaAudioSaveWAV", "NovaAudioSaveFLAC24", "NovaTagWriter"],
    },
    pale_blue: {
        label: "View & Report",
        nodes: [
            "NovaMasterReportViewer",
            "NovaTrackInspectorReportViewer", "NovaPlayerNode", "NovaConsole",
        ],
    },
    black: {
        label: "Plumbing",
        nodes: ["NovaNamePathManager"],
    },
};

// Flattened once: node type name -> {color, bgcolor}.
const COLOUR_BY_NODE = {};
for (const [name, role] of Object.entries(ROLES)) {
    const swatch = PALETTE[name];
    if (!swatch) continue;
    for (const node of role.nodes) COLOUR_BY_NODE[node] = swatch;
}

function enabled() {
    try {
        const value = app.ui?.settings?.getSettingValue(SETTING_ID);
        return value === undefined || value === null ? true : !!value;
    } catch {
        return true;                       // a settings API change must not un-register nodes
    }
}

app.registerExtension({
    name: "NovaAudio.NodeColours",

    init() {
        try {
            app.ui?.settings?.addSetting({
                id: SETTING_ID,
                category: ["Nova Audio", "Appearance", "Colour nodes by role"],
                name: "Colour nodes by role",
                tooltip:
                    "Colour this pack's nodes by what they do — load, process, " +
                    "identity, validate, save, view. Your own colour choices are " +
                    "always kept. Applies to nodes added after the change.",
                type: "boolean",
                defaultValue: true,
            });
        } catch (error) {
            console.warn("[Nova Node Colours] could not register the setting:", error);
        }
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        const swatch = COLOUR_BY_NODE[nodeData?.name];
        if (!swatch) return;               // not ours: leave it entirely alone

        // Statics on the class: `renderingColor` falls back to
        // `this.constructor.color` when the instance has none, which is every
        // node until a user picks a colour by hand.
        try {
            if (enabled()) {
                nodeType.color = swatch.color;
                nodeType.bgcolor = swatch.bgcolor;
            }
        } catch (error) {
            console.warn(`[Nova Node Colours] ${nodeData?.name}:`, error);
        }
    },
});
