import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "NovaSQLDump.PasswordMask",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "NovaSQLDump" || nodeData.name === "MySQLUniversalDump") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const index = this.widgets.findIndex(w => w.name === "password");
                if (index === -1) return;

                // Default STRING widgets are drawn on canvas by litegraph -
                // there's no real <input> element behind them, so setting
                // `.element.type = "password"` was a no-op. Replace the widget
                // with a genuine DOM <input type="password"> instead.
                const oldWidget = this.widgets[index];
                const initialValue = oldWidget.value ?? "";

                this.widgets.splice(index, 1);

                const inputEl = document.createElement("input");
                inputEl.type = "password";
                inputEl.value = initialValue;
                inputEl.autocomplete = "new-password";
                inputEl.style.width = "100%";
                inputEl.style.boxSizing = "border-box";

                const domWidget = this.addDOMWidget("password", "password", inputEl, {
                    getValue: () => inputEl.value,
                    setValue: (v) => { inputEl.value = v ?? ""; },
                });

                inputEl.addEventListener("input", () => {
                    domWidget.value = inputEl.value;
                });
                // Stop node drag / other canvas shortcuts from stealing keystrokes
                // while typing in the field.
                inputEl.addEventListener("pointerdown", (e) => e.stopPropagation());
                inputEl.addEventListener("keydown", (e) => e.stopPropagation());

                // Put the new widget back where "password" used to sit in the list
                const newIndex = this.widgets.indexOf(domWidget);
                if (newIndex !== -1 && newIndex !== index) {
                    this.widgets.splice(newIndex, 1);
                    this.widgets.splice(index, 0, domWidget);
                }

                this.setSize(this.computeSize());
                app.graph.setDirtyCanvas(true, true);
            };
        }
    }
});
