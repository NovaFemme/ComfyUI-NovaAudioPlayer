# Nova Player — audit + refactor plan

Audited: ComfyUINovaAudioPlayer.zip, 30 Aug 2026.

## Decisions taken

- Render path: own `<canvas>` via `addDOMWidget` (not LiteGraph `widget.draw`).
- Config model: disk themes + per-node overrides (deltas only).
- Settings panel scope: colours + per-renderer intensity.

## Audit findings

1. **`nova_player/npjs/nova_player_widget.js` is a stale copy, not a second node.** Nine
   differing lines vs the root copy, all renames. It is never served (`WEB_DIRECTORY` is
   declared once at package root as `./npjs`) and would break if it were — it fetches
   `/nova_player_nova/peaks/`, a route that does not exist. Delete it.
2. **A `config_manager.py` existed and its source is lost.** Only
   `nova_player/__pycache__/config_manager.cpython-312.pyc` remains: class `NovaConfigManager`,
   methods `_safe_read_json`, `_safe_write_json`, `reload_all`, routes
   `GET /nova_audio_player/config` and `POST /nova_audio_player/config/colors`.
   Both JSON config files are currently referenced by nothing and their values do not match
   what the widget draws.
3. **One closure, one draw call, five visualisers.** `makeAudioPlayerWidget()` spans lines
   366–3206 (2,840 lines); `draw()` inside it is ~1,995 lines. View modes branch at lines
   1198 / 1288 / 1797 / 1804. Adding a mode requires five edits in four unrelated regions
   (branch, `VIEW_MODES`, label ternary at 2728, button widths at 2733 and 2819, hit-test at 2968).
   `combined` re-implements rather than composes.
4. **`lerpColor()` corrupts 8-digit hex.** `nova_player_widget.js:87` slices exactly six digits
   and returns `rgb()`. `#00000033` parses to `[0,0,0]` with alpha dropped. Canvas itself
   handles `#RRGGBBAA` fine — the bug is ours. 69 hex literals in the file, only 15 route
   through the `C` object; 35 `rgba()` calls besides. `PULSE_L`/`PULSE_R` are module-level
   constants, so ramps cannot be rebuilt on a theme change.
5. **Prototype hijacking is deprecated.** Six methods patched onto `nodeType.prototype`
   (`onMouseDown/Move/Leave/Up`, `onResize`, `onConfigure`). ComfyUI docs now say prototype
   monkey-patching is "deprecated and subject to change".
6. **Nodes 2.0 retires canvas-drawn widgets.** Vue/DOM node rendering; opt-in today, legacy
   still ships. `widget.draw(ctx, node, w, y)` is the surface being replaced.
7. **Keep verbatim:** offscreen waveform cache, spectrogram rolling buffer, reusable Float32
   time-domain buffers (Uint8 caused false clip detection), `_audioRegistry` audio-element
   adoption on tab-switch restore.

## Renderer contract

```js
export default {
  id, label,
  needs:  { freq, time, peaks, stereo },      // engine wires only what is asked for
  params: { gain: {type:"range", min, max, step, default, label}, ... },  // schema drives the panel
  roles:  ["surface", "spectrogram.grid"],
  minSize:{ w, h },
  init(gfx), resize(gfx, rect), frame(gfx, rect, sig, t), hit(pt, rect), dispose(gfx)
};
```

`registry.js` is the only place that knows renderers exist. Mode cycle order, button label,
button widths, min node size, hit zones and panel sections are all derived from it.

## Migration order (each step shipped independently)

1. Clean the package — delete stale `npjs/` + orphan pycs, split `audio_io.py` and
   `routes.py` out of the node file.
2. Land `config_manager.py` + schema + endpoints. Nothing consumes it yet.
3. Replace the colour pipeline. Visuals unchanged, alpha legal, ramps rebuildable.
4. Extract `layout.js` and `audio-engine.js`.
5. Port renderers behind the registry; `combined` as a composite last.
6. Move to the DOM canvas host. Test at 25% and 200% zoom, collapsed, two nodes.
7. Build the settings panel, generated from theme roles + renderer param schemas.

## Risks identified

- DOM widget positioning at extreme zoom / after resize (ComfyUI_frontend #7942).
- `AudioContext` exhaustion — one per node; move to a shared context.
- Workflow JSON bloat if a resolved palette is serialised per node — deltas only.
- Config writes must stay inside aiohttp route handlers, behind a lock.

## Sources

- https://docs.comfy.org/custom-nodes/js/javascript_objects_and_hijacking
- https://docs.comfy.org/custom-nodes/js/javascript_hooks
- https://docs.comfy.org/interface/nodes-2
- https://blog.comfy.org/p/comfyui-node-2-0
- https://github.com/Comfy-Org/ComfyUI_frontend/issues/7942
