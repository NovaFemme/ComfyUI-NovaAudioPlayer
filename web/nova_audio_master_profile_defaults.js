import { app } from "../../scripts/app.js";

const PROFILE_DEFAULTS = {
    "Metal": {
        strength: 70.0,
        target_lufs: -11.5,
        target_true_peak_dbtp: -1.0,
        target_crest_db: 9.5,
        high_pass_hz: 30.0,
        bass_db: 0.0,
        low_mid_db: 0.0,
        mid_db: 0.0,
        presence_db: 0.0,
        air_db: 0.0,
        stereo_width_percent: 100.0,
        mono_below_hz: 120.0,
    },
    "EDM-Trance": {
        strength: 70.0,
        target_lufs: -11.0,
        target_true_peak_dbtp: -1.0,
        target_crest_db: 10.5,
        high_pass_hz: 28.0,
        bass_db: 0.0,
        low_mid_db: 0.0,
        mid_db: 0.0,
        presence_db: 0.0,
        air_db: 0.0,
        stereo_width_percent: 100.0,
        mono_below_hz: 120.0,
    },
    "K-Pop": {
        strength: 70.0,
        target_lufs: -10.5,
        target_true_peak_dbtp: -1.0,
        target_crest_db: 9.5,
        high_pass_hz: 28.0,
        bass_db: 0.0,
        low_mid_db: 0.0,
        mid_db: 0.0,
        presence_db: 0.0,
        air_db: 0.0,
        stereo_width_percent: 100.0,
        mono_below_hz: 100.0,
    },
    "Balanced": {
        strength: 60.0,
        target_lufs: -12.0,
        target_true_peak_dbtp: -1.0,
        target_crest_db: 11.0,
        high_pass_hz: 25.0,
        bass_db: 0.0,
        low_mid_db: 0.0,
        mid_db: 0.0,
        presence_db: 0.0,
        air_db: 0.0,
        stereo_width_percent: 100.0,
        mono_below_hz: 100.0,
    },
};

function widgetByName(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function applyProfileDefaults(node, profileName) {
    const preset = PROFILE_DEFAULTS[profileName];
    if (!preset) return;

    for (const [name, value] of Object.entries(preset)) {
        const widget = widgetByName(node, name);
        if (!widget) continue;
        widget.value = value;
        // Do not invoke each widget's callback: we only need to update the
        // serialized input values and redraw the node.
    }

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "NovaAudioMaster.ProfileDefaults",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "NovaAudioMaster") return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);

            const profileWidget = widgetByName(this, "profile");
            if (!profileWidget || profileWidget.__novaProfileDefaultsHooked) {
                return result;
            }

            profileWidget.__novaProfileDefaultsHooked = true;
            const originalCallback = profileWidget.callback;

            profileWidget.callback = (value, ...args) => {
                const r = originalCallback?.call(profileWidget, value, ...args);

                // Profile defaults are applied only when the user changes the
                // profile widget. Workflow loading does not overwrite stored values.
                applyProfileDefaults(this, value);
                return r;
            };

            return result;
        };
    },
});
