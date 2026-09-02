/**
 * index.js — extension registration. Hooks only, no drawing, no state.
 *
 * What this file deliberately does NOT do any more:
 *
 *   nodeType.prototype.onMouseDown   -> canvas pointerdown  (host.js)
 *   nodeType.prototype.onMouseMove   -> canvas pointermove  (host.js)
 *   nodeType.prototype.onMouseUp     -> canvas pointerup    (host.js)
 *   nodeType.prototype.onMouseLeave  -> canvas pointerleave (host.js)
 *   nodeType.prototype.onResize      -> ResizeObserver      (host.js)
 *   nodeType.prototype.onConfigure   -> not needed: the DOM widget instance
 *                                       survives a tab switch, so there is
 *                                       nothing to rebuild and no peaks
 *                                       re-fetch to perform
 *
 * ComfyUI's docs now state that monkey-patching prototypes is deprecated and
 * subject to change; all six of those are gone. `nodeCreated` builds the
 * widget, and the one remaining override is `onExecuted`, which is still the
 * documented way to receive a node's `ui` payload — and it now just hands data
 * to an instance that already exists.
 */

import { app } from "/scripts/app.js";
import { config } from "./core/config.js";
import { PlayerHost } from "./core/host.js";
import { minimumNodeSize } from "./core/layout.js";

// The pack's second node registers its own extension. Imported here because
// ComfyUI loads exactly one entry point per WEB_DIRECTORY, so anything not
// reachable from this file never runs.
import "./madow/index.js";

const NODE_TYPE = "NovaPlayerNode";
const WIDGET_NAME = "nova_player_display";

/** node.id -> PlayerHost */
const hosts = new Map();

async function fetchPeaks(filename) {
    const resp = await fetch(`/nova_player/peaks/${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json();
}

function ensureHost(node, data) {
    let host = hosts.get(node.id);

    if (host) {
        host.setData(data);
        return host;
    }

    host = new PlayerHost(node, data);
    hosts.set(node.id, host);

    const widget = node.addDOMWidget(WIDGET_NAME, "nova_player", host.element, {
        serialize: true,
        hideOnZoom: false,
        getValue: () => host.serialise(),
        setValue: (v) => host.restore(v),
        getMinHeight: () => minimumNodeSize(host.stereo)[1],
    });

    host.widget = widget;

    // Restore anything LiteGraph had already parked on the widget before we
    // attached (the usual path when a saved workflow loads).
    if (node._novaPendingValue !== undefined) {
        host.restore(node._novaPendingValue);
        delete node._novaPendingValue;
    } else if (widget.value !== undefined && widget.value !== null) {
        host.restore(widget.value);
    }

    widget.onRemove = () => {
        host.destroy();
        hosts.delete(node.id);
    };

    const [minW, minH] = host.minimumSize();
    if (node.size[0] < minW || node.size[1] < minH) {
        node.setSize([Math.max(node.size[0], minW), Math.max(node.size[1], minH)]);
    }

    return host;
}

app.registerExtension({
    name: "Comfy.NovaPlayerNode",

    async setup() {
        // Warm the config once at startup so the first paint already has the
        // real theme rather than the built-in fallback.
        config.load();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // The one remaining override. Still the documented route for a node's
        // `ui` payload, and now a three-line handoff rather than a widget rebuild.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);

            const payload = message?.nova_player?.[0];
            if (!payload) return;

            // Kept so a workflow reopened in a fresh session knows which file
            // to ask for, exactly as before.
            this.properties = this.properties || {};
            this.properties.lastAudioData = { ...payload };

            fetchPeaks(payload.filename)
                .then(peaks => ensureHost(this, { ...payload, peaks }))
                .catch(e => console.error("[NovaPlayer] could not load peaks:", e.message));
        };
    },

    /**
     * Rebuild the player when a saved workflow is loaded.
     *
     * This replaces the onConfigure patch. It runs once per node on load,
     * fetches the peaks for the file the node last played (served from the
     * sidecar JSON, so it survives a server restart while the temp WAV is
     * still present), and does nothing at all if the audio is gone.
     */
    async loadedGraphNode(node) {
        if (node.type !== NODE_TYPE) return;

        const saved = node.properties?.lastAudioData;
        if (!saved?.filename) return;

        // Hold the serialised widget value until the host exists to receive it.
        const widget = node.widgets?.find(w => w.name === WIDGET_NAME);
        if (widget && widget.value !== undefined) node._novaPendingValue = widget.value;

        try {
            const peaks = await fetchPeaks(saved.filename);
            ensureHost(node, { ...saved, peaks });
        } catch {
            // Temp file has been cleaned up — the node simply shows nothing
            // until it is re-run. Not worth an error toast.
        }
    },
});
