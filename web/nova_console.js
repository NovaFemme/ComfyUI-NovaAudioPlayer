/**
 * nova_console.js — renders Nova Console's text on the node face.
 *
 * The Python side is an OUTPUT_NODE returning {"ui": {"text": [...]}}. ComfyUI
 * delivers that to the node's onExecuted, and this drops it into a read-only
 * textarea DOM widget. A plain textarea is used rather than ComfyWidgets.STRING
 * so this file depends on nothing but /scripts/app.js.
 *
 * The text also survives a page reload: it is stashed on the node and restored
 * from the serialised widget value in onConfigure.
 */

import { app } from "/scripts/app.js";

const NODE_CLASS = "NovaConsole";
const WIDGET_NAME = "nova_console_text";
const VALUE_INPUT = "value";
const MIN_SIZE = [420, 260];


function valueInputIndex(node) {
  return (node?.inputs ?? []).findIndex((slot) => slot?.name === VALUE_INPUT);
}

/**
 * Force every auto-connected link onto `value`, never onto the
 * label / print_to_server_log / max_lines widget-inputs.
 *
 * INTERNAL / POTENTIALLY UNSTABLE COMFYUI API.
 *
 * THE BUG. In the new frontend every widget is also a connectable input, so
 * Nova Console offers four: the wildcard `value` plus `label` (STRING),
 * `print_to_server_log` (BOOLEAN) and `max_lines` (INT). Auto-connect picks by
 * type, and a STRING source is an *exact* match for `label` while the wildcard
 * is not — so the link lands on `label`, and the graph then fails to execute.
 *
 * FOUR DIFFERENT INTERNALS resolve that slot, depending on how the node was
 * created and on the frontend version. Verified against the frontend 1.45.15
 * sources (shipped as sourcemaps in comfyui_frontend_package):
 *
 *   LinkConnector.connectToNode()        → node.findInputByType(type)?.slot
 *     Releasing a link on empty canvas and picking Nova Console from the
 *     search box / context menu. THIS is the path that was still broken:
 *     NodeSearchBoxPopover.addNode() ends in
 *     `canvasStore.getCanvas().linkConnector.connectToNode(node, event)`,
 *     which never touches any of the three below.
 *
 *   LGraphNode.connectByType()           → findConnectByTypeSlot(true, …)
 *     Called on the SOURCE node, which then calls findSlotByType on the target.
 *
 *   findSlotByType(input, type, …)       → older builds
 *   findInputSlotByType(type, …)         → some builds call this directly
 *
 * All four are overridden FOR THIS NODE TYPE ONLY — never on the shared
 * prototype, so no other node's behaviour changes (§6, §9).
 *
 * Redirecting is safe rather than merely different: LiteGraph.isValidConnection
 * rewrites "*" to 0 and returns true when either side is falsy, so a link of any
 * type is accepted by `value`. The connection succeeds; it just lands on the
 * slot that can actually receive it.
 *
 * Manual drops onto a named slot go through getInputOnPos()/_dropOnInput() and
 * are untouched — you can still wire something into `label` by hand.
 */
function preferValueSlot(nodeType) {
  const proto = nodeType.prototype;

  // THE ONE THAT MATTERS for the link-release context menu.
  // LinkConnector.connectToNode does:  node.findInputByType(type)?.slot
  // so this must return litegraph's {index, slot} shape, not a bare index.
  const origFindInputByType = proto.findInputByType;
  proto.findInputByType = function (type, ...rest) {
    try {
      const idx = valueInputIndex(this);
      if (idx !== -1) return { index: idx, slot: this.inputs[idx] };
    } catch (err) {
      console.error("[Nova Console] findInputByType preference failed", err);
    }
    return origFindInputByType
      ? origFindInputByType.apply(this, [type, ...rest])
      : undefined;
  };

  // Current litegraph: connectByType → target.findConnectByTypeSlot(...).
  // `this` is the target (Nova Console); returns a slot index (number) | null.
  const origConnectBy = proto.findConnectByTypeSlot;
  proto.findConnectByTypeSlot = function (input, ...rest) {
    try {
      if (input === true) {
        const idx = valueInputIndex(this);
        if (idx !== -1) return idx;
      }
    } catch (err) {
      console.error("[Nova Console] findConnectByTypeSlot preference failed", err);
    }
    return origConnectBy ? origConnectBy.apply(this, [input, ...rest]) : null;
  };

  // Older litegraph: findSlotByType(input, type, returnObj, …) → index | slot.
  const origByType = proto.findSlotByType;
  proto.findSlotByType = function (input, type, returnObj, ...rest) {
    try {
      if (input === true) {
        const idx = valueInputIndex(this);
        if (idx !== -1) return returnObj ? this.inputs[idx] : idx;
      }
    } catch (err) {
      console.error("[Nova Console] findSlotByType preference failed", err);
    }
    return origByType ? origByType.apply(this, [input, type, returnObj, ...rest]) : undefined;
  };

  // findInputSlotByType(type, returnObj, …) → index | slot. Some versions call
  // this directly instead of delegating to findSlotByType.
  const origInputByType = proto.findInputSlotByType;
  proto.findInputSlotByType = function (type, returnObj, ...rest) {
    try {
      const idx = valueInputIndex(this);
      if (idx !== -1) return returnObj ? this.inputs[idx] : idx;
    } catch (err) {
      console.error("[Nova Console] findInputSlotByType preference failed", err);
    }
    return origInputByType ? origInputByType.apply(this, [type, returnObj, ...rest]) : undefined;
  };
}

function buildTextarea() {
  const el = document.createElement("textarea");
  el.readOnly = true;
  el.spellcheck = false;
  el.placeholder = "Run the graph to see output here.";
  Object.assign(el.style, {
    width: "100%",
    height: "100%",
    minHeight: "120px",
    boxSizing: "border-box",
    padding: "6px 8px",
    border: "1px solid var(--border-color, #4e4e4e)",
                borderRadius: "6px",
                background: "var(--comfy-input-bg, #1a1a1a)",
                color: "var(--input-text, #ddd)",
                fontFamily:
                "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
                fontSize: "11px",
                lineHeight: "1.45",
                whiteSpace: "pre",
                overflow: "auto",
                resize: "none",
  });
  return el;
}

function consoleWidget(node) {
  let widget = node.widgets?.find((w) => w.name === WIDGET_NAME);
  if (widget) return widget;

  const el = buildTextarea();
  widget = node.addDOMWidget(WIDGET_NAME, "novaconsole", el, { serialize: false });
  widget.serialize = false;
  if (widget.options) widget.options.serialize = false;

  // Keep the stored text reachable for onConfigure / resize.
  widget.novaSetText = (text) => {
    el.value = text ?? "";
    node.__novaConsoleText = el.value;
    el.scrollTop = 0;
  };
  return widget;
}

function setText(node, text) {
  const widget = consoleWidget(node);
  widget.novaSetText?.(text);

  const [w, h] = node.size ?? MIN_SIZE;
  node.setSize?.([Math.max(w, MIN_SIZE[0]), Math.max(h, MIN_SIZE[1])]);
  node.graph?.setDirtyCanvas(true, false);
}

app.registerExtension({
  name: "Nova.Console",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;

    preferValueSlot(nodeType);

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        consoleWidget(this);
        this.setSize?.([
          Math.max(this.size?.[0] ?? 0, MIN_SIZE[0]),
                       Math.max(this.size?.[1] ?? 0, MIN_SIZE[1]),
        ]);
      } catch (err) {
        console.error("[Nova Console] could not build the display widget", err);
      }
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      try {
        const payload = message?.text;
        const text = Array.isArray(payload) ? payload.join("\n") : payload ?? "";
        setText(this, text);
      } catch (err) {
        console.error("[Nova Console] could not display the message", err);
      }
    };

    // Restore the last text when a saved workflow is loaded.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      onConfigure?.apply(this, arguments);
      try {
        if (this.__novaConsoleText) setText(this, this.__novaConsoleText);
      } catch (err) {
        console.error("[Nova Console] restore failed", err);
      }
    };
  },
});
