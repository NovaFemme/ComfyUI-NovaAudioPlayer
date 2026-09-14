import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "NovaSQLDump.StatusDisplay",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "NovaSQLDump" && nodeData.name !== "MySQLUniversalDump") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const statusEl = document.createElement("div");
            statusEl.style.cssText = [
                "width: 100%",
                "min-height: 20px",
                "padding: 4px 6px",
                "box-sizing: border-box",
                "background: rgba(0,0,0,0.3)",
                "border-radius: 4px",
                "font-size: 11px",
                "color: #ccc",
                "white-space: pre-wrap",
                "word-break: break-word",
                "pointer-events: none", // purely informational, don't intercept clicks/drag
            ].join(";");
            statusEl.textContent = "Storage: Idle (logs on execution)";

            this.addDOMWidget("db_status", "status", statusEl, {
                getValue: () => statusEl.textContent,
                setValue: (v) => { statusEl.textContent = v; },
                serialize: false, // purely visual - don't save into the workflow JSON or send to backend
            });

            // Simple setter other extensions (mysql_tracker.js) can call directly.
            this.setDbStatus = (text) => {
                statusEl.textContent = text;
                app.graph.setDirtyCanvas(true, true);
            };

            // Reflect the enable_storage toggle immediately, without waiting on a queue click.
            const enableWidget = this.widgets.find(w => w.name === "enable_storage");
            if (enableWidget) {
                const origCallback = enableWidget.callback;
                enableWidget.callback = (...args) => {
                    const res = origCallback ? origCallback.apply(enableWidget, args) : undefined;
                    this.setDbStatus(enableWidget.value
                        ? "Storage: Idle (logs on execution)"
                        : "Storage: OFF");
                    return res;
                };
            }

            this.setSize(this.computeSize());
        };
    }
});
