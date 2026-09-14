/**
 * nova_namepath_manager.js — "Load profile into widgets" button.
 *
 * SCOPE. This file is a convenience only. Every profile operation the node
 * performs — apply, save, save as — happens server-side inside the execute
 * function through normal ComfyUI data flow. If this extension fails to load,
 * is blocked, or the graph runs in API mode with no frontend at all, the node
 * behaves exactly the same. Nothing here is required for correctness.
 *
 * What it adds: picking a profile and pressing Load fills the node's widgets
 * with the stored values, so you can see and edit them before running rather
 * than running blind and reading settings_json afterwards.
 *
 * INTERNAL / POTENTIALLY UNSTABLE COMFYUI API
 * -------------------------------------------
 * Two internal touchpoints, both isolated in this file:
 *   - node.widgets lookup by name, to write values back into widgets;
 *   - nodeType.prototype.onNodeCreated chaining, the usual extension hook.
 * Neither is a documented stable interface. Both are wrapped in try/catch so a
 * ComfyUI change costs the button, never the node.
 *
 * The two endpoints it calls are read-only (see utilities/routes.py).
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "NovaNamePathManager";
const PROFILE_WIDGET = "profile";
const NONE_LABEL = "— none —";

/** Widgets a profile round-trips — must match PROFILE_KEYS in the Python node. */
const PROFILE_KEYS = [
  "database_path",
  "table_name",
  "existing_database",
  "folder_string",
  "file_filter",
  "input_filename",
  "report_path",
  "audio_path",
  "concatenate_filename",
];

async function fetchProfileNames() {
  const response = await api.fetchApi("/nova_namepath/profiles");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data?.profiles) ? data.profiles : [];
}

async function fetchProfileValues(name) {
  const response = await api.fetchApi(`/nova_namepath/profile/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = await response.json();
  return data?.values ?? null;
}

function widgetsByName(node) {
  const map = new Map();
  for (const widget of node.widgets ?? []) map.set(widget.name, widget);
  return map;
}

function applyValues(node, values) {
  const widgets = widgetsByName(node);
  let applied = 0;
  for (const key of PROFILE_KEYS) {
    if (!(key in values)) continue;
    const widget = widgets.get(key);
    if (!widget) continue;
    const value = values[key];
    widget.value = typeof widget.value === "boolean" ? Boolean(value) : value ?? "";
    widget.callback?.(widget.value);
    applied += 1;
  }
  node.graph?.setDirtyCanvas(true, true);
  return applied;
}

/** Refresh the profile combo's options without disturbing the current value. */
async function refreshChoices(node, statusWidget) {
  const widgets = widgetsByName(node);
  const combo = widgets.get(PROFILE_WIDGET);
  if (!combo?.options) return;
  try {
    const names = await fetchProfileNames();
    combo.options.values = [NONE_LABEL, ...names];
    if (!combo.options.values.includes(combo.value)) combo.value = NONE_LABEL;
    if (statusWidget) statusWidget.value = `${names.length} profile(s) on disk`;
    node.graph?.setDirtyCanvas(true, true);
  } catch (err) {
    console.warn("[Nova NamePath] could not list profiles", err);
    if (statusWidget) statusWidget.value = "profile list unavailable";
  }
}

function setupNode(node) {
  const widgets = widgetsByName(node);
  const combo = widgets.get(PROFILE_WIDGET);
  if (!combo) return;

  const status = node.addWidget("text", "profile_status", "", () => {}, {
    serialize: false,
  });
  status.disabled = true;

  const load = node.addWidget(
    "button",
    "load_profile_into_widgets",
    "",
    async () => {
      const name = combo.value;
      if (!name || name === NONE_LABEL) {
        status.value = "pick a profile first";
        node.graph?.setDirtyCanvas(true, true);
        return;
      }
      try {
        const values = await fetchProfileValues(name);
        if (!values) {
          status.value = `'${name}' could not be read`;
          return;
        }
        const applied = applyValues(node, values);
        status.value = `loaded '${name}' (${applied} field(s))`;
      } catch (err) {
        console.error("[Nova NamePath] load failed", err);
        status.value = "load failed — see the browser console";
      }
      node.graph?.setDirtyCanvas(true, true);
    },
    { serialize: false }
  );
  load.label = "Load profile into widgets";

  const refresh = node.addWidget(
    "button",
    "refresh_profile_list",
    "",
    () => refreshChoices(node, status),
    { serialize: false }
  );
  refresh.label = "Refresh profile list";

  // Pick up profiles written by a run in this session without a page reload.
  refreshChoices(node, status);

  // The node reports on every execution; a run that saved also refreshes the
  // dropdown, so a newly written profile is selectable immediately.
  node.novaOnExecuted = (message) => {
    const text = Array.isArray(message?.status) ? message.status.join(" ") : message?.status;
    if (text) status.value = text;
    const saved = Array.isArray(message?.saved) ? message.saved[0] : message?.saved;
    if (saved) refreshChoices(node, status).then(() => { if (text) status.value = text; });
    node.graph?.setDirtyCanvas(true, true);
  };
}

app.registerExtension({
  name: "Nova.NamePathManager",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        setupNode(this);
      } catch (err) {
        console.error("[Nova NamePath] could not build the profile controls", err);
      }
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      try {
        this.novaOnExecuted?.(message);
      } catch (err) {
        console.error("[Nova NamePath] could not show the run status", err);
      }
    };
  },
});
