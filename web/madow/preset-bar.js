/**
 * preset-bar.js — the preset control strip on the Madow Inputs node.
 *
 * LOADING A PRESET IS A FRONTEND OPERATION, and that is the whole design.
 * Selecting a preset writes every value into the node's real widgets. The
 * backend never substitutes values from a preset name at execution time — if
 * it did, the saved workflow would record `preset="x"` without recording what
 * actually ran, ComfyUI's cache would not see the change, and every logged row
 * would be a lie. Preset load = N widget writes; everything downstream is then
 * honest, including the workflow JSON and the cache.
 *
 * Built as a DOM widget through `addDOMWidget`, the same API the player uses,
 * rather than a COMBO. COMBO options are evaluated in INPUT_TYPES() when the
 * server builds /object_info, so a newly saved preset would not appear until
 * the frontend re-fetched the node definition. Driven from the HTTP routes
 * instead, a save appears immediately.
 */

const API = "/madow/presets";

async function api(path, options) {
    const resp = await fetch(path, options);
    if (!resp.ok) throw new Error((await resp.text()) || resp.statusText);
    return resp.status === 204 ? null : resp.json();
}

/**
 * The parameter table, fetched once from the backend.
 *
 * NOT reconstructed here. The widget name is the namespaced key with dots
 * replaced by underscores, which cannot be reversed by rule:
 * `apg_norm_threshold` reverses equally well to `apg.norm.threshold`, and a
 * wrong key writes a preset nothing can load and a hash nothing can match.
 * One definition, served.
 */
let TABLE = null;

async function table() {
    if (!TABLE) TABLE = await api("/madow/params");
    return TABLE;
}

/** The widget carrying a namespaced parameter, or undefined. */
function widgetFor(node, key) {
    const row = (TABLE || []).find(r => r.key === key);
    return row ? node.widgets?.find(w => w.name === row.arg) : undefined;
}

/** Every namespaced parameter currently on the node, keyed properly. */
export function readParams(node) {
    const out = {};
    for (const row of TABLE || []) {
        const w = node.widgets?.find(x => x.name === row.arg);
        if (w) out[row.key] = w.value;
    }
    return out;
}

export function buildPresetBar(node) {
    const root = document.createElement("div");
    root.className = "madow-presets";
    root.innerHTML = `
        <style>
        .madow-presets {
            display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
            padding: 6px 8px; box-sizing: border-box; width: 100%;
            font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
            color: #c8c8e8;
        }
        .madow-presets select {
            flex: 1 1 120px; min-width: 90px; background: #1b1e2b;
            color: inherit; border: 1px solid #ffffff24; border-radius: 4px;
            padding: 3px 5px; font: inherit;
        }
        .madow-presets button {
            flex: 0 0 auto; background: #232840; color: inherit; cursor: pointer;
            border: 1px solid #ffffff24; border-radius: 4px; padding: 3px 8px;
            font: inherit;
        }
        .madow-presets button:hover { background: #2e3554; }
        .madow-presets button.danger:hover { background: #5a2530; }
        .madow-presets__msg {
            flex: 1 1 100%; min-height: 13px; color: #8a93b8;
        }
        .madow-presets__msg.err { color: #ff8a5c; }
        .madow-presets__dirty { color: #d4c94a; }
        .madow-presets__form {
            flex: 1 1 100%; display: flex; gap: 6px; align-items: center;
            flex-wrap: wrap;
        }
        .madow-presets__form input {
            background: #1b1e2b; color: inherit; border: 1px solid #ffffff24;
            border-radius: 4px; padding: 3px 5px; font: inherit; min-width: 0;
        }
        .madow-presets__form input[name="preset"] { flex: 2 1 120px; }
        .madow-presets__form input[name="note"]   { flex: 3 1 140px; }
        </style>
        <select title="Load a preset into the widgets below"></select>
        <button data-act="save" title="Save the current values as a preset">Save as</button>
        <button data-act="new" title="Clear the loaded preset name">New</button>
        <button data-act="del" class="danger" title="Delete the selected preset">Delete</button>
        <div class="madow-presets__form" hidden>
            <input name="preset" type="text" placeholder="Preset name" maxlength="64">
            <input name="note" type="text" placeholder="Note (optional)" maxlength="200">
            <button data-act="confirm">Save</button>
            <button data-act="cancel">Cancel</button>
        </div>
        <div class="madow-presets__msg"></div>
    `;

    const select = root.querySelector("select");
    const msg = root.querySelector(".madow-presets__msg");
    const say = (text, isErr = false) => {
        msg.textContent = text || "";
        msg.classList.toggle("err", !!isErr);
    };

    const nameWidget = () => node.widgets?.find(w => w.name === "preset_name");

    async function refresh(selected) {
        try {
            await table();          // must be loaded before any read or write
        } catch (e) {
            say(`Could not load the parameter table: ${e.message}`, true);
            return;
        }
        let list = [];
        try {
            list = await api(API);
        } catch (e) {
            say(`Could not list presets: ${e.message}`, true);
        }
        const want = selected ?? nameWidget()?.value ?? "";
        select.innerHTML = `<option value="">— no preset —</option>` +
            list.map(p => `<option value="${p.name}"${p.name === want ? " selected" : ""}>` +
                          `${p.name}</option>`).join("");
        if (want && !list.some(p => p.name === want)) {
            // The workflow references a preset that is no longer on disk. Say
            // so rather than silently showing "no preset": the run will still
            // record the name, and the mismatch is worth knowing about.
            select.innerHTML += `<option value="${want}" selected>${want} (missing)</option>`;
            say(`Preset "${want}" is not on disk`, true);
        }
    }

    /** Write a preset's values into the real widgets. */
    async function load(name) {
        if (!name) {
            if (nameWidget()) nameWidget().value = "";
            say("");
            return;
        }
        let preset;
        try {
            await table();
            preset = await api(`${API}/${encodeURIComponent(name)}`);
        } catch (e) {
            say(`Could not load: ${e.message}`, true);
            return;
        }
        const excludes = new Set(preset.excludes || []);
        let written = 0, missing = [];
        for (const [key, value] of Object.entries(preset.params || {})) {
            // `excludes` is why loading a preset does not clobber a seed the
            // user is deliberately holding.
            if (excludes.has(key)) continue;
            const w = widgetFor(node, key);
            if (!w) { missing.push(key); continue; }
            w.value = value;
            // Some widgets do work on change (combo validation, linked state).
            w.callback?.(value);
            written++;
        }
        if (nameWidget()) nameWidget().value = name;
        node.setDirtyCanvas(true, true);

        // A preset from a newer pack version may name parameters this build
        // does not have. Loading what matched and naming what did not is more
        // use than refusing the whole preset.
        say(missing.length
            ? `Loaded ${written}, skipped unknown: ${missing.join(", ")}`
            : `Loaded "${name}" (${written} values` +
              `${excludes.size ? `, ${[...excludes].join(", ")} kept` : ""})`,
            missing.length > 0);
    }

    select.addEventListener("change", () => load(select.value));

    root.querySelector('[data-act="new"]').addEventListener("click", () => {
        if (nameWidget()) nameWidget().value = "";
        select.value = "";
        say("Preset cleared — values unchanged");
    });

    // SAVING IS ONE INTERACTION, NOT TWO MODALS.
    //
    // This was `window.prompt` for the name and then a second `window.prompt`
    // for the note. Two identical-looking OS dialogs in a row read as "the
    // first one failed, it is asking again" — NovaFemme hit Enter through the
    // second one twice, believing the save had not taken. A note is optional;
    // it is not worth a dialog of its own, and neither field is worth blocking
    // the whole browser for.
    const form = root.querySelector(".madow-presets__form");
    const nameField = form.querySelector('input[name="preset"]');
    const noteField = form.querySelector('input[name="note"]');

    const closeForm = () => {
        form.hidden = true;
        nameField.value = "";
        noteField.value = "";
    };

    const openForm = () => {
        nameField.value = nameWidget()?.value || "";
        noteField.value = "";
        form.hidden = false;
        // Prefetch while the user is typing, so Save is one request.
        table().catch(() => { /* readParams yields {} and the save is refused */ });
        requestAnimationFrame(() => { nameField.focus(); nameField.select(); });
    };

    async function commit() {
        const name = nameField.value.trim();
        if (!name) { say("A preset needs a name", true); nameField.focus(); return; }

        // Saving onto an existing name overwrites the file. That is the right
        // behaviour — updating a preset is the common case — but it is not
        // something to discover by losing one, so it asks. Same rule as
        // Delete: one dialog, for the one action that destroys something.
        const exists = [...select.options].some(o => o.value === name);
        if (exists && !window.confirm(`Overwrite the preset "${name}"?`)) {
            nameField.focus();
            return;
        }

        const note = noteField.value.trim();
        try {
            const res = await api(API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, note, params: readParams(node) }),
            });
            if (nameWidget()) nameWidget().value = name;
            closeForm();
            await refresh(name);
            say(res.message || `Saved "${name}"`);
        } catch (e) {
            say(`Could not save: ${e.message}`, true);
        }
    }

    // The canvas listens for single keys — "n" adds a node, Delete removes the
    // selected one. Without this a preset called "Nine" deletes the node it is
    // being saved from.
    for (const field of [nameField, noteField]) {
        field.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); closeForm(); say(""); }
        });
    }

    root.querySelector('[data-act="save"]').addEventListener("click", () => {
        if (form.hidden) openForm(); else closeForm();
    });
    root.querySelector('[data-act="confirm"]').addEventListener("click", commit);
    root.querySelector('[data-act="cancel"]').addEventListener("click", () => {
        closeForm();
        say("");
    });

    root.querySelector('[data-act="del"]').addEventListener("click", async () => {
        const name = select.value;
        if (!name) { say("Nothing selected", true); return; }
        if (!window.confirm(`Delete preset "${name}"?`)) return;
        try {
            await api(`${API}/${encodeURIComponent(name)}`, { method: "DELETE" });
            if (nameWidget()?.value === name) nameWidget().value = "";
            await refresh("");
            say(`Deleted "${name}"`);
        } catch (e) {
            say(`Could not delete: ${e.message}`, true);
        }
    });

    return { element: root, refresh, load };
}
