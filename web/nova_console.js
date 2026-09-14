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
 * Dragging a link into empty canvas and picking Nova Console from the menu runs
 * source.connectByType() → target.<slot lookup>(). The lookup's first, strict
 * pass compares slot types exactly and rewrites a "*" slot to "0", so the
 * wildcard `value` matches nothing while a same-typed widget-input (e.g. `label`
 * for a STRING link) matches — the link lands there and the mismatched connect
 * then throws.
 *
 * WHICH internal resolves the slot varies by ComfyUI/litegraph version:
 *   • current builds:  findConnectByTypeSlot(input, node, slotType, opts)
 *   • older builds:    findInputSlotByType(type, …) / findSlotByType(input, …)
 * The earlier fix only patched findSlotByType, which current builds never call
 * on this path — so it silently did nothing. We now override all three FOR THIS
 * NODE TYPE ONLY (not the shared prototype) and point every INPUT-side lookup at
 * `value`. Output-side lookups and manual drops onto a specific slot use other
 * code paths and are untouched — you can still wire something into `label` by
 * hand.
 */
function preferValueSlot(nodeType) {
  const proto = nodeType.prototype;

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
