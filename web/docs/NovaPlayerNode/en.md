# ComfyUI-NovaAudioPlayer

An audio player node with twelve live visualisers, a whole-file measurement
strip computed in Python, and a theme system you can drive from inside the node.

The views: waveform, spectrum/EQ, analyzer (goniometer + phase correlation),
spectrogram, combined, peak/RMS, L/R correlation, frequency bands, combined
suite, FFT analyzer, RTA analyzer, and the APG artifact meter.

## Output

**`panel_info`** (STRING) — the bench strip's contents, for a display node or a
database. `panel_format` selects `json`, `text` or `csv_row`.

## A node with no audio yet

A freshly placed node is not blank. It draws the real player and animates a
synthetic signal so the visualisers show what they do, and the badge row reads
`no audio connected · press play for a demo`. Pressing play runs a four-second
clip bundled with the pack through the real analyser, so what you see is an
actual measurement rather than a mock-up.

Nothing loads or plays until you press it. Wire an `AUDIO` in and the demo
stops for good. `ui.idle_demo: false` in the system config turns the animation
off.

## Downloads

WAV, FLAC and OGG, written by `soundfile`. No mp3 — that needed ffmpeg as an
external binary, which the Comfy registry's scanner flagged; the WAV is one
ffmpeg command away from anything you want.

## Controls

Rest the pointer on any transport control for a hint. Turn them off with
**Control hints** in the settings drawer, next to Text size.

## What lives where

```
__init__.py              node mappings; WEB_DIRECTORY = "./web"  (declared once)
config/
  color_config.json      named themes -> colour role tokens
  system_config.json     engine defaults, UI defaults, renderer parameters
nova_player/
  node.py                the node: render audio, compute peaks/LUFS, emit a payload
  audio_io.py            save_wav, compute_lufs, build_peaks, compute_bench
  peaks_cache.py         in-memory cache + .peaks.json sidecar
  config_manager.py      loads/validates/persists the JSON above
  routes.py              every HTTP endpoint
  defaults.py            built-in defaults; the bottom of the resolution stack
web/
  index.js               extension registration — hooks only
  core/
    color.js             parse / mix / resolve. The whole colour surface.
    config.js            one shared config client for every node on the page
    state.js             the serialised widget value (deltas only)
    layout.js            all geometry, as one pure function
    audio-engine.js      audio element, Web Audio graph, per-frame signal bag
    gfx.js               drawing primitives + the gfx object renderers receive
    host.js              DOM canvas, RAF loop, pointer input, per-node state
  renderers/
    registry.js          the single list everything else is derived from
    waveform.js  spectrum.js  analyzer.js  spectrogram.js
    peak_rms.js  lr_correlation.js  freq_percentages.js
    fft_analyzer.js  rta_analyzer.js  projected_guidance.js
    combined.js  combined_suite.js   composites: lay out rects, delegate
    _template.js         copy this to add a view mode (not imported)
  ui/
    chrome.js            transport, meter, scrub, pills, hover glow, hit testing
    settings-panel.js    the HTML settings drawer, generated from schemas
    bench-panel.js       the whole-file measurement strip
    download-menu.js     the format picker
dev/                     local harness; NOT served by ComfyUI
```

## Adding a view mode

Three steps, and nothing else needs touching:

1. `cp web/renderers/_template.js web/renderers/myview.js` and fill it in.
2. Import it in `web/renderers/registry.js`.
3. Add it to the `RENDERERS` array.

The view button's label, width and cycle position; the settings-panel section
for its parameters; which analyser data the engine computes; and the minimum
size clamp are all derived from the module. Add a `mode.myview` colour role to
your theme for the pill's colour.

## Colours

Every colour is a **role**, never a literal in a draw call. Roles live in
`config/color_config.json`; a theme states only what differs from the base
theme (`nova-dark`) and inherits the rest.

Supported values: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`.
Alpha is carried through parsing, interpolation and output.

`appearance.color_mixing` in `system_config.json` selects the blend space:

* `"srgb"` (default) reproduces the look the node shipped with, and is what the
  spectrogram's heat-ramp stops were authored against.
* `"linear"` blends in linear light — physically correct, no chalky midpoints.
  It will visibly brighten the spectrogram.

An individual ramp can pin its own space with
`{"space": "linear", "stops": [[0, "#000"], ...]}`.

## The settings drawer

Opened with the gear. It is scoped to the view you are currently looking at:
switch the view with the pill and the drawer follows. Three sections, one open
at a time — the active renderer's settings, its colours, and the shared player
chrome colours. Drag the drawer's left edge to widen it.

Nothing in it has a save button. Every edit applies to the display immediately.
Where it is *kept* is the **Edits** switch, next to the theme picker:

* **This node** (default) — the change belongs to this player alone and travels
  with the workflow. Two players on the same theme can look different. Because
  colour roles are namespaced per renderer (`gonio.*`, `spectrum.*`, `wave.*`),
  this is per-node *and* per-section: recolouring the analyzer's trace on one
  node leaves its spectrum, and every other node, untouched.
* **Theme** — the change is written to `config/color_config.json` (or, for
  parameters, to that renderer's defaults in `system_config.json`) about half a
  second later, and every player using that theme picks it up.

Rows this node is overriding are marked with an accent bar, so local and
inherited values are distinguishable at a glance. In node scope a button offers
to **apply your node's changes to the theme** when you decide they should be
shared. Node overrides survive switching themes — previewing a different theme
never silently discards them; **Reset node** clears them when you want that.

**New** and **Save as** name a theme; that is the only decision that needs
confirming, and it uses an inline field rather than a browser prompt.

## Where settings are stored

```
built-in defaults  ->  config/*.json  ->  active theme  ->  per-node overrides
```

A node stores only the theme's *name* plus whatever it changed, so a workflow
never carries a full palette. "Save theme" in the panel promotes the node's
overrides into a named theme on disk and clears them from the node.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/nova_player/peaks/{filename}` | waveform peak data |
| GET | `/nova_player/audio/{filename}?fmt=…` | original or transcoded audio |
| GET | `/nova_player/config` | full snapshot |
| GET | `/nova_player/config/version` | cheap change poll |
| POST | `/nova_player/config/theme` | create/update a theme |
| POST | `/nova_player/config/active-theme` | switch theme |
| POST | `/nova_player/config/renderer/{id}` | persist renderer params |
| POST | `/nova_player/config/reload` | re-read both files from disk |
| DELETE | `/nova_player/config/theme/{name}` | delete a theme |

A missing or malformed config file never stops the node: values fall back to
`nova_player/defaults.py` and the parse error is logged with its line number.

## Local development

```
cd ComfyUI-NovaAudioPlayer
python3 dev/devserver.py                    # then open the URL it prints
python3 dev/devserver.py --port 9000        # if 8731 is taken
```

The script locates the package from its own path, so it also works when called
by absolute path from anywhere. It serves the package directory and answers the
config endpoints from the real `NovaConfigManager`; `folder_paths` is stubbed in
`dev/stubs/` because that module only exists inside a ComfyUI process.

Open `http://127.0.0.1:8731/dev/harness.html`, or
`dev/harness-zoom.html` to exercise the same player inside a CSS transform at
several graph-zoom levels (`window.__setZoom(1.75)` in the console). The harness feeds every renderer
a synthetic signal, so every view and the settings drawer can be exercised
without ComfyUI or an audio file.

Nothing under `dev/` is served by ComfyUI — only `web/` is (`WEB_DIRECTORY`).
