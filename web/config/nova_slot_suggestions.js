/**
 * nova_slot_suggestions.js — put the ▶️ Nova Audio nodes at the top of the
 * link-release suggestion menu.
 *
 * How the suggestion menu is built (frontend 1.45.x)
 * --------------------------------------------------
 * The core extension `Comfy.SlotDefaults` walks every node def and appends the
 * node's name to its own `slot_types_default_out[TYPE]` array, seeded with
 * ["Reroute"]. `setDefaults(n)` then copies each array into litegraph's
 * `LiteGraph.slot_types_default_out[TYPE]`, sliced to the
 * `Comfy.NodeSuggestions.number` setting (default 5). Litegraph's connection
 * menu renders exactly those entries, in array order.
 *
 * Three things core does that this file works around:
 *
 *   1. Node defs are registered in load order, so a custom pack lands at the
 *      end of each array and gets sliced away.
 *   2. Core only scans `input.required`, so a Nova node whose input is optional
 *      never makes the list at all.
 *   3. Core skips inputs whose type is drawn as a widget (STRING, INT, FLOAT,
 *      BOOLEAN, COMBO) unless they are forceInput. That is why dragging from a
 *      `console` STRING output offered nothing but Reroute and Search — and why
 *      the arrays here are created when core never made one.
 *
 * Nova Console is handled separately from the rest: its input is the wildcard
 * type `*`, which matches every link but belongs to no type's list, so it is
 * appended to the suggestions for every type a Nova node can output.
 *
 * The SOURCE array is reordered, not litegraph's copy, so the ordering survives
 * every later `setDefaults()` call — e.g. when the suggestions-number slider
 * moves. Nothing is removed: other packs' nodes still follow, after Reroute.
 */

import { app } from "/scripts/app.js";

const NOVA_CATEGORY = "▶️ Nova Audio";
const WILDCARD = "*";

/**
 * Types litegraph draws as a widget. Core ignores inputs of these types when
 * building suggestions — a text box is not really a link target — and so does
 * this file, unless the input is explicitly forceInput. Without this, Nova
 * SQLite Reader and Nova Batch Load Audio would be promoted for their
 * database_path / folder_path text fields and would sit ahead of Nova Console
 * on every STRING drag.
 */
const WIDGET_TYPES = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"]);

/** Always promoted for, even if no Nova node currently outputs it. */
const ALWAYS_TYPES = ["AUDIO"];

/** slot type -> Nova node class names that accept it, in registration order */
const novaByInputType = new Map();
/** Nova nodes with a wildcard input — they accept anything (Nova Console) */
const novaWildcard = [];
/** every slot type a Nova node produces */
const novaOutputTypes = new Set(ALWAYS_TYPES);

function isNova(nodeData) {
  const category = String(nodeData?.category ?? "");
  return category === NOVA_CATEGORY || category.startsWith(`${NOVA_CATEGORY}/`);
}

function collectNovaNode(nodeData) {
  if (!isNova(nodeData)) return;
  const name = nodeData?.name;
  if (!name) return;

  const specs = [
    ...Object.values(nodeData.input?.required ?? {}),
    ...Object.values(nodeData.input?.optional ?? {}),
  ];
  for (const spec of specs) {
    const type = Array.isArray(spec) ? spec[0] : spec;
    // A combo input carries its option array here, not a type string.
    if (typeof type !== "string") continue;
    if (type === WILDCARD) {
      if (!novaWildcard.includes(name)) novaWildcard.push(name);
      continue;
    }
    const options = Array.isArray(spec) ? spec[1] : undefined;
    if (WIDGET_TYPES.has(type) && !options?.forceInput) continue;
    const list = novaByInputType.get(type) ?? [];
    if (!list.includes(name)) list.push(name);
    novaByInputType.set(type, list);
  }

  for (const type of nodeData.output ?? []) {
    if (typeof type === "string" && type && type !== WILDCARD) novaOutputTypes.add(type);
  }
}

/** Types worth reordering: anything a Nova node emits, plus ALWAYS_TYPES. */
function targetTypes() {
  const types = new Set(novaOutputTypes);
  for (const type of novaByInputType.keys()) types.add(type);
  return [...types];
}

/** Nova nodes that should lead this type's menu: typed inputs, then wildcards. */
function novaFor(type) {
  const typed = novaByInputType.get(type) ?? [];
  return [...typed, ...novaWildcard.filter((n) => !typed.includes(n))];
}

function slotDefaults() {
  return app.extensions?.find((e) => e.name === "Comfy.SlotDefaults");
}

/** Nova nodes first, then whatever core already had (Reroute, other packs). */
function promoteSource(ext) {
  for (const type of targetTypes()) {
    const nova = novaFor(type);
    if (!nova.length) continue;
    // Create the array when core never registered this type (STRING, INT, …).
    const source = ext.slot_types_default_out?.[type] ?? ["Reroute"];
    ext.slot_types_default_out[type] = [
      ...nova,
      ...source.filter((n) => !nova.includes(n)),
    ];
  }
}

/**
 * Widen litegraph's slice by the size of the Nova block, so promoting these
 * nodes does not push the same number of other-pack nodes off the bottom.
 */
function ensureVisible(ext) {
  const LG = globalThis.LiteGraph;
  if (!LG?.slot_types_default_out) return;
  const configured = Number(ext.suggestionsNumber?.value) || 0;
  for (const type of targetTypes()) {
    const source = ext.slot_types_default_out?.[type];
    const nova = novaFor(type);
    if (!Array.isArray(source) || !nova.length) continue;
    const promoted = nova.filter((n) => source.includes(n)).length;
    const budget = configured > 0
      ? configured
      : LG.slot_types_default_out[type]?.length ?? source.length;
    LG.slot_types_default_out[type] = source.slice(0, promoted + budget);
  }
}

function install() {
  const ext = slotDefaults();
  if (!ext?.slot_types_default_out) {
    console.warn("[Nova] Comfy.SlotDefaults not found — suggestions left untouched");
    return;
  }

  promoteSource(ext);

  // Re-apply the widened slice after any later setDefaults() (slider changes).
  if (!ext.__novaSetDefaultsWrapped) {
    ext.__novaSetDefaultsWrapped = true;
    const original = ext.setDefaults;
    ext.setDefaults = function (count) {
      const result = original?.call(this, count);
      try {
        ensureVisible(this);
      } catch (err) {
        console.error("[Nova] could not widen suggestion slice", err);
      }
      return result;
    };
  }

  ext.setDefaults(ext.suggestionsNumber?.value);

  for (const type of targetTypes()) {
    const nova = novaFor(type);
    if (nova.length) console.log(`[Nova] ${type} suggestions: ${nova.join(", ")}`);
  }
}

const LINK_RELEASE_SETTING = "Comfy.LinkRelease.Action";
const CONTEXT_MENU = "context menu";
const FLIP_FLAG = "Nova.LinkRelease.contextMenuApplied";

/**
 * Installs from frontend 1.24.1 onward default a plain link release to the
 * fuzzy search box, which puts the curated menu behind Shift. Switch it once,
 * then never again — if the user changes it back, that choice stands.
 */
function preferContextMenuOnce() {
  try {
    if (localStorage.getItem(FLIP_FLAG)) return;
    const settings = app.ui?.settings;
    if (!settings?.setSettingValue) return;
    if (settings.getSettingValue?.(LINK_RELEASE_SETTING) !== CONTEXT_MENU) {
      settings.setSettingValue(LINK_RELEASE_SETTING, CONTEXT_MENU);
      console.log(
        "[Nova] link release set to 'context menu' — change it under " +
          "Settings > LiteGraph > LinkRelease > Action on link release"
      );
    }
    localStorage.setItem(FLIP_FLAG, "1");
  } catch (err) {
    console.warn("[Nova] could not set the link-release action", err);
  }
}

app.registerExtension({
  name: "Nova.AudioSlotSuggestions",
  async beforeRegisterNodeDef(_nodeType, nodeData) {
    try {
      collectNovaNode(nodeData);
    } catch (err) {
      console.error("[Nova] slot scan failed", err);
    }
  },
  async setup() {
    try {
      install();
      preferContextMenuOnce();
    } catch (err) {
      console.error("[Nova] suggestion setup failed", err);
    }
  },
});
