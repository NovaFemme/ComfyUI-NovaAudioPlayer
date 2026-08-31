# Nova Player — settings panel rework

Follows [02-implementation-notes.md](02-implementation-notes.md).

## The bug behind "the colour section won't stay open"

Two faults compounding:

1. **Echo loop.** `_save()` assigns `widget.value`; the frontend calls `setValue`
   straight back with it; `restore()` ran and called `panel.rebuild()`. Rebuild
   recreates the accordion, which closes whatever was open and reopens the
   default. Fixed with a `_saving` re-entry guard, and `restore()` now calls
   `refresh()` instead of `rebuild()`.
2. **`setRole` called `panel.refresh()` synchronously**, fighting the colour
   picker the user was still holding.

The "colour didn't apply until I changed something else" symptom was the same
loop: the rebuild reset the controls before the frame that would have shown it.

The shape of the fix is a three-way distinction worth keeping straight:

| call | does | safe while editing? |
| --- | --- | --- |
| `build()` | recreates the DOM | no — closes the open section |
| `refresh()` | builds only if the active renderer changed, else syncs | only outside an edit |
| `sync()` | writes values into existing controls, skipping `document.activeElement` | yes |

Edits call `sync()`, coalesced to one animation frame by `host._syncPanelSoon()`.

## Changes made

| Ask | Implementation |
| --- | --- |
| No `window.prompt` for theme names | Inline dialog — text field + Create/Cancel, Enter/Escape bound, `keydown` stopPropagation so ComfyUI shortcuts don't fire |
| Panel scoped to the selected function | `build()` reads `ctl.activeRenderer()` and emits only that renderer's settings + colours, plus shared chrome |
| Sections auto-collapse | `toggle` listener closes siblings; last-open section persisted in `state.openSection` |
| Settings + colours autosave, no save buttons | `_scheduleSave()` debounces 600 ms then POSTs |
| Panel resizable | Left-edge grip with pointer capture; width persisted, clamped 200–640 |
| Add-new-theme button | `createTheme()` / `saveThemeAs()` write a **full** role snapshot so a new theme stands alone rather than silently tracking its parent |

Also: readable role labels via a `ROLE_LABELS` map, and sticky section headings.

## Scoped editing

`state.colorScope` = `"node"` (default) | `"theme"`, surfaced as an **Edits**
switch beside the theme picker. Both colours and renderer params follow it.

Every edit lands on `state.overrides` first — that is what makes the display
respond mid-drag. The scope decides whether it is then written through:

* **node** — stays in the workflow. Because roles are namespaced per renderer
  (`gonio.*`, `spectrum.*`, `wave.*`), this is inherently per-node *and*
  per-section; no extra mechanism was needed.
* **theme** — written to disk, then the override is cleared so the workflow
  stays deltas-only.

**Behaviour change:** node overrides now SURVIVE a theme switch. Previewing a
theme must not silently discard work; "Reset node" is the explicit way to clear.

## Two CSS traps hit while building this

1. **`display` beats `[hidden]`.** Every panel element sets an explicit display
   value, which outranks the UA `[hidden] { display: none }` rule — so hiding
   the name dialog did nothing. Needs `.nova-panel [hidden] { display: none !important; }`.
2. **A backtick inside a CSS comment in a template literal** terminates the
   string and makes the whole module a load-time syntax error. Made this mistake
   **twice**. `dev/lint-templates.mjs` now catches it; run it after touching any
   inline stylesheet.

**Testing note:** two paneltest checks failed spuriously after the scope work
because they assumed the old always-write-to-theme default. They were stale
expectations, not regressions.
