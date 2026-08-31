# Nova Player — implementation notes (all 7 steps shipped)

Companion to [01-refactor-plan.md](01-refactor-plan.md).

## What shipped

31 source files, ~5,800 lines, replacing a 3,418-line JS file whose
`makeAudioPlayerWidget()` was 2,840 lines with a 1,995-line `draw()`.

## Post-delivery fixes

**1. `dev/devserver.py` had sandbox absolute paths baked in.** It pointed at
`/home/claude/...`, so `import nova_player` failed. Now self-locating via
`Path(__file__).resolve().parent.parent`, takes `--port`, prints its own URL.

**2. Graph zoom broke ALL pointer input.** The real one. ComfyUI positions DOM
widgets under a CSS transform for zoom, which makes two pixel spaces coexist:

- `ResizeObserver.contentRect` reports the **untransformed layout** size — the
  space `layout.js` and every renderer work in.
- `getBoundingClientRect()` reports the size **after** the transform — the space
  pointer events arrive in.

`_pointerPos()` used `clientX - rect.left` with no correction, so at any zoom
other than exactly 1.0 every coordinate was wrong by the zoom factor. At
zoom > 1 clicks landed short of the target, missing every transport control and
falling through to the visualisation zone — which seeks. Symptom reported:
"I cannot click any control, when I click anywhere it moves the waveform to
another progress, and no music is playing." Nothing was wrong with playback;
the play button was simply never being hit.

Fix in `web/core/host.js`: divide out the measured ratio.

```js
const sx = r.width ? (this._cssW || r.width) / r.width : 1;
return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
```

Also added `_zoom()` and `_syncRenderScale()`: the backing store is allocated at
`devicePixelRatio * zoom` (clamped 0.5–2.5) so a zoomed-in node is sharp rather
than an upscaled bitmap. ResizeObserver never fires on zoom (layout size is
unchanged), so the render loop polls for it at 250 ms.

**Lesson for any future canvas-in-DOM-widget work:** never mix
`getBoundingClientRect()` with `ResizeObserver.contentRect` without converting
between them. This is the single most likely class of bug in this architecture,
and a headless harness will not catch it unless the harness itself applies a
transform — which `dev/harness-zoom.html` now does.

## Deviations from the plan, and why

**Colour mixing space is a setting, defaulting to sRGB — not linear.**
The plan sold linear-light mixing as a straight improvement. Building it showed
that it visibly brightens the spectrogram: the heat ramp's stop positions were
hand-tuned against byte interpolation, so "correcting" the maths changes an
authored design. `appearance.color_mixing` selects `"srgb"` (default) or
`"linear"`; an individual ramp can pin its own.

**The settings drawer stops above the transport row.** First build covered the
full height, which hid the gear that opened it — the panel could not be toggled
closed. `host._syncPanelBottom()` sets the drawer's bottom offset from
`layout.wfBottom`. Side benefit: playback stays operable while adjusting colours.

## Bugs found in the original that the port fixes

1. **Meters died after a tab switch.** `createMediaElementSource()` may only be
   called once per media element. The old `onConfigure` restore adopted the
   existing `<audio>` and called it again; the resulting InvalidStateError was
   swallowed as "Analyser unavailable", so every analyser-driven view went dead
   until the node was re-run. `audio-engine.js` caches the whole graph per
   filename, not just the element.
2. **`smoothedCorr` was module-level.** Two player nodes on one page shared a
   single correlation needle and fought over it. Now per-instance in `gfx.store`.
3. **Path traversal on every route.** `filename` came straight from the URL into
   `os.path.join`. `routes.py` now basenames it and verifies the realpath stays
   inside the temp directory.
4. **Combined-view playhead used a magic constant.** `L.totalW * 0.72 - 6`,
   which silently disagreed with the real panel width.
5. **`deep_merge` (mine, caught in testing).** A shallow top-level copy leaked
   references into `defaults.py`, so the first saved theme mutated the built-in
   defaults and the "fall back to defaults" path served user data.

## Verification performed

- Parity: spectrogram LUT **0 of 768 channels differ** from the original;
  pulse ramp **0 of 101 steps differ**; `computeLayout` **0 mismatches**
  against the original `getLayout` across five node sizes.
- `#00000033` parses to `{0,0,0,a:0.2}` and survives interpolation and output.
- Every control and hover target correct at zoom 0.6, 1.0, 1.75.
- Legacy state: bare string, old object, a removed mode name, and `null` all
  migrate correctly.
- **The premise test**: added a sixth renderer as one new file plus two lines in
  `registry.js` plus one theme role. Pill label, measured width, pill colour,
  cycle position and its own settings-panel section all appeared with no other
  edit. Reverted before packaging; `web/renderers/_template.js` ships as the
  documented starting point.
