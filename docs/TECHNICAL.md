# Nova Audio Player — technical reference

Architecture, contracts and the traps worth knowing before you change anything.
For the user-facing tour see [the README](../README.md); for the reasoning
behind individual decisions see [the design notes](design/).

---

## Contents

- [What lives where](#what-lives-where)
- [Adding a view mode](#adding-a-view-mode)
- [Reading the analyser data](#reading-the-analyser-data) ← **read this before writing a renderer**
- [The renderer contract](#the-renderer-contract)
- [Colours](#colours)
- [Bars](#bars)
- [Text scale](#text-scale)
- [The settings drawer](#the-settings-drawer)
- [Whole-file measurement](#whole-file-measurement)
  - [Two RMS conventions](#two-rms-conventions)
  - [The panel_info output](#the-panel_info-output)
- [Where settings are stored](#where-settings-are-stored)
- [HTTP endpoints](#http-endpoints)
- [Local development and tests](#local-development-and-tests)
- [Known traps](#known-traps)

---

## What lives where

```
__init__.py              node mappings; WEB_DIRECTORY = "./web"  (declared once)
config/
  color_config.json      named themes -> colour role tokens
  system_config.json     engine defaults, UI defaults, renderer parameters
nova_player/
  node.py                the node: render audio, compute peaks/LUFS/bench, emit a payload
  audio_io.py            save_wav, compute_lufs, build_peaks, compute_bench  (pure DSP)
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
    _template.js         copy this to add a view mode (not imported)
    waveform.js  spectrum.js  analyzer.js  spectrogram.js  combined.js
    peak_rms.js  lr_correlation.js  freq_percentages.js  combined_suite.js
    fft_analyzer.js  rta_analyzer.js  projected_guidance.js
  ui/
    chrome.js            transport, meter, scrub, pills, hover glow, hit testing
    bench-panel.js       the whole-file statistics strip
    settings-panel.js    the HTML settings drawer, generated from schemas
    download-menu.js     the format picker
dev/
  devserver.py           run the whole UI without ComfyUI
  harness.html           synthetic-signal test page
  harness-zoom.html      the same page inside a CSS transform
  lint-templates.mjs     catches backticks inside template-literal CSS
  tests/                 the test suite — see its own README
docs/
  TECHNICAL.md           this file
  design/                ten design notes
```

The architectural rule: **`registry.js` is the only place that knows renderers
exist.** Mode cycle order, pill label, pill width, minimum node size, hit zones
and settings-panel sections are all derived from it.

---

## Adding a view mode

1. Copy `web/renderers/_template.js` to `web/renderers/my_view.js`.
2. Add two lines to `web/renderers/registry.js` — the import and the array entry.
3. Add a `mode.my_view` colour role to `nova_player/defaults.py` for the pill.

That is the whole procedure. The pill label, its measured width, the cycle
position, the minimum node size and its own settings-panel section all appear
with no further edit.

Any colour role your renderer declares must exist in `defaults.py`, or
`palette.get()` returns **magenta** and warns — by design, so a missing role is
loud rather than silent.

---

## Reading the analyser data

**This is the single most common way to write a renderer that looks alive while
showing nothing.** Four of the seven community-added renderers hit it.

`sig.freq` is `AnalyserNode.getByteFrequencyData()` — a `Uint8Array` of values
**0–255**. It is not decibels and not a linear magnitude. The analyser has
already mapped `[minDecibels, maxDecibels]` (−100 … −30 by default) onto that
byte range.

Treating a byte as decibels fails *quietly*: `20 * Math.log10(byte)` yields
0…48, above every sensible ceiling, so the display pins to full scale and looks
busy instead of looking broken.

Use the helpers in `gfx.js`:

```js
import { byteToDb, byteToNorm, dbToNorm } from "../core/gfx.js";

byteToDb(v)                 // byte -> dB, matching the analyser's own mapping
byteToNorm(v)               // byte -> 0..1, when you want a magnitude
dbToNorm(db, floor, ceil)   // dB -> 0..1 across an explicit window, clamped
```

For band energy, sum `v * v`, not `v`. Amplitude sums do not add up to
meaningful shares.

### When bytes are not enough

The byte path **clamps**: every bin below −100 dBFS reads exactly 0. On a
produced track at around −18 LUFS, a 4096-point FFT spreads energy so thinly
that most bins above the low mids fall under that floor — measured, only 192 of
2048 bins survived.

If your renderer computes a weighted average over the spectrum (a centroid, a
flatness, a flux), that clamping will dominate your answer. Declare
`needs: { freqDb: true }` and read `sig.freqDb`, a `Float32Array` of true
per-bin dBFS with no clamp. The engine only fills it when a renderer asks, since
it is a second full FFT read per tick.

Measured difference on a ±6 dB shelf at 4 kHz: byte weighting responded with 18%
of centre, magnitude-from-float with 71%.

### Animation must be time-based

Any renderer that moves must derive motion from `gfx.now` (the frame's wall-clock
timestamp), never from "one step per frame". Otherwise it runs at a different
speed on a 144 Hz monitor than a 60 Hz one.

For exponential smoothing use `smoothingAlpha(factor, dt)`, which makes the same
setting behave identically at any frame rate.

---

## The renderer contract

```js
export default {
    id: "my_view",
    label: "MY VIEW",

    // The engine wires up only what you ask for.
    needs: { freq: true, freqDb: false, time: false, peaks: false },

    // This schema generates the settings panel. No panel code required.
    params: {
        gain: { type: "range", min: 0.5, max: 4, step: 0.1, default: 1, label: "Gain" },
        show: { type: "toggle", default: true, label: "Show labels" },
    },

    // Every colour you use, by role name. Must exist in defaults.py.
    roles: ["text.dim", "grid.line"],
    ramps: [],

    minSize: { w: 120, h: 60 },

    resize(gfx) { /* invalidate cached buffers */ },
    frame(gfx, rect, sig) { /* draw */ },
    hit(pt, rect, gfx) { return null; },   // or { action: "seek", fraction }
    dispose(gfx) { /* release buffers */ },
};
```

`gfx` carries exactly what a renderer is allowed to touch: `ctx`, `palette`,
`params`, a private `store` for buffers, `peaks`, `stereo`, `layout`, `phase`,
`dpr` and `now`. Anything not on that object is, by design, not a renderer's
business.

`store` persists across frames and is per-instance — which is why two player
nodes on one page no longer fight over shared state.

---

## Colours

**Colours are roles, not literals.** A renderer never contains a hex string; it
asks the resolved token table for a role name. That indirection is what makes the
settings panel possible.

```js
palette.get("wave.left")            // resolved colour string
palette.alpha("guidance.over", 1)   // same role, alpha replaced
palette.fade("grid.line", 0.5)      // same role, alpha scaled
palette.steps("a", "b", 101)        // gradient steps
palette.ramp("spectrogram.heat")    // a named ramp
```

Resolution order: **built-in defaults → `config/*.json` → active theme → per-node
overrides.**

All of `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` are
supported end to end, alpha included. Eight-digit hex works everywhere — that was
the first bug the refactor fixed.

`appearance.color_mixing` selects `"srgb"` (default) or `"linear"` for ramp
interpolation. sRGB is the default deliberately: the spectrogram's heat ramp was
hand-tuned against byte interpolation, and "correcting" the maths changes an
authored design. An individual ramp can pin its own space.

---

## Bars

Every bar goes through one helper so a renderer added later inherits the
treatment for free:

```js
import { drawBar } from "../core/gfx.js";

drawBar(ctx, x, y, w, h, palette.get("band.bass"), { vertical: true });
```

The relief — a highlight and a shade making the bar read as a lit cylinder — is
**derived from the bar's own colour**, so it works with any theme and any colour
a user picks. Alpha is preserved. The gradient runs across the bar's short axis,
so pass `vertical` when the automatic guess (based on aspect) would be wrong.

Radius is proportional and capped, and disabled below 3 px. Gradients are cached
per colour and span. `appearance.bar_relief` (0–1) scales the effect; at 0 the
helper returns the plain colour and builds no gradient at all.

[Full notes →](design/10-bar-styling.md)

---

## Text scale

`appearance.text_scale` multiplies every font size the node draws. It is applied
by intercepting assignment to `ctx.font` on the host's canvas, so **a renderer
you write later is scaled without knowing the feature exists**.

Scaling glyphs alone makes them collide with the rows above and below, so if your
renderer lays out rows, derive their heights from `textScale()` or `scaled(px)`:

```js
import { scaled, textScale } from "../core/gfx.js";

const S = textScale();
const rowH = Math.round(12 * S);
```

---

## The settings drawer

Generated from theme roles and renderer param schemas. Three methods with a
distinction worth keeping straight:

| call | does | safe while editing? |
| --- | --- | --- |
| `build()` | recreates the DOM | no — closes the open section |
| `refresh()` | rebuilds only if the active renderer changed, else syncs | only outside an edit |
| `sync()` | writes values into existing controls, skipping `document.activeElement` | yes |

Edits call `sync()`, coalesced to one animation frame. Calling `build()` during
an edit is what made the panel close its own section mid-colour-pick.

The drawer stops above the transport row so the gear that opened it stays
clickable and playback stays operable while adjusting colours.

**Scope.** `state.colorScope` is `"node"` or `"theme"`. Every edit lands on
`state.overrides` first — that is what makes the display respond mid-drag — and
the scope decides whether it is then written to disk. Node overrides survive a
theme switch; "Reset node" is the explicit way to clear them.

---

## Whole-file measurement

`compute_bench(waveform, sample_rate)` in `audio_io.py` runs once per execution,
on the same tensor that produces the WAV. It returns peak, RMS (in two
conventions — see below), crest, DC offset,
L/R correlation, contiguous band shares, HF outliers, and two clipping counts:

- `over_fs` — samples exceeding full scale, i.e. what `save_wav`'s clamp destroys
- `clipped_samples` — what ends up flattened in the written file

It runs **before** the clamp deliberately, so a generation that overshoots full
scale reports the peak it actually produced.

Band energy uses a Welch-style average (8192-point Hann, 50% overlap) rather than
one transform of the whole file: flat memory on a long take, steadier estimate.

### Two RMS conventions

A standalone bench node will usually disagree with this one about RMS, and the
disagreement is arithmetic, not a bug. There are two defensible ways to reduce a
stereo file to one level:

| Key | Formula | What it answers |
|---|---|---|
| `rms_db` | `sqrt((ΣL² + ΣR²) / 2n)` | how much energy is in the stereo file |
| `rms_mono_db` | `sqrt(Σ((L+R)/2)² / n)` | what a mono-summing meter reads |

For channels of equal power the two differ by exactly

```
Δ dB = 10 · log10((1 + r) / 2)
```

where `r` is the L/R correlation `compute_bench` already reports. So:

| `r` | mono downmix reads |
|---|---|
| 1.000 | the same |
| 0.900 | −0.22 dB |
| 0.591 | −0.99 dB |
| 0.000 | −3.01 dB |

This is the whole explanation for the −14.15 vs −15.14 dBFS split seen against
the separate Bench Metrics node on a take with `lr_corr` 0.591 — that node
downmixes to mono first (`y_mono = (L + R) / 2`) and this one does not. Both
figures are correct answers to different questions; the downmix loses whatever
the two channels do not have in common, which is exactly the point of a mono
compatibility check and exactly the wrong thing for a level reading.

The strip displays `rms_db`. `rms_mono_db` is returned but not displayed, so a
logged take can be compared against a mono-summing meter after the fact without
re-measuring the audio.

**Note that neither of these is the LUFS badge.** `compute_lufs` K-weights a mono
downmix per BS.1770 and applies the −0.691 offset; it will not match either RMS
figure and is not meant to.

### The panel_info output

The node returns a single `STRING` named `panel_info`: the same figures the
bench strip draws, rendered for another node to consume. `nova_player/
panel_info.py` builds it from the identical payload the front end receives, so
the two cannot drift.

The `panel_format` widget selects the shape:

| Value | Shape | For |
|---|---|---|
| `json` | nested object: `file`, `levels`, `clipping`, `bands_pct`, `warnings` | a database, or anything that parses |
| `text` | the strip as it reads on screen, aligned | a display node |
| `csv_row` | one row, `CSV_COLUMNS` order, properly quoted | appending to a log |

Every value appears on the panel, formatted by the same rules — `fmtDb`, the
`—` for a missing figure, `none` for no clipping, `mono` for a mono take. The
one addition is `generated_at`, which a logged row needs and the panel does not.

**If the panel and this output ever disagree, `panel_info.py` is wrong.** It
carries a Python port of `fmtBytes`, deliberately including JS's
round-half-up behaviour, because `round()` in Python rounds halves to even.
`dev/tests/test_panel_info.py` pins the formatting rules.

`CSV_COLUMNS` is append-only. Inserting a column silently shifts every column
after it in a log the user has already been writing to.

[Full notes →](design/09-bench-panel.md)

---

## Where settings are stored

**On disk** (`config/`), shared by every node:

- `color_config.json` — named themes, each a full set of role tokens
- `system_config.json` — engine defaults, UI defaults, renderer params,
  `appearance` (text scale, bar relief, colour mixing)

**In the workflow** (the node's serialised widget value), per node:

```js
{ viewMode, volume, muted, looping, theme, panelOpen, panelWidth,
  benchOpen, benchHeight, openSection, colorScope,
  overrides: { roles: {}, renderers: {} } }
```

Deltas only, enforced in `state.js`. Legacy shapes — a bare string, the old
`{viewMode, volume, muted}` object, a removed mode name, `null` — all migrate.

Writes are atomic (temp file + `os.replace` + fsync) behind a lock, because the
node's `run()` is on a different thread from the aiohttp handlers.

---

## HTTP endpoints

All under `/nova_player/`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/peaks/{filename}` | waveform peak data |
| GET | `/audio/{filename}?fmt=` | the audio, optionally transcoded |
| GET | `/config` | `{themes, activeTheme, renderers, system, version}` |
| GET | `/config/version` | integer, bumped on write — the front end polls this, not the blob |
| POST | `/config/theme` | create or update a named theme, validating every colour |
| POST | `/config/active-theme` | switch theme |
| POST | `/config/appearance` | text scale, bar relief, colour mixing |
| POST | `/config/renderer/{id}` | persist one renderer's params |
| POST | `/config/reload` | re-read from disk |
| DELETE | `/config/theme/{name}` | delete a theme |

Every filename is basenamed and its realpath verified to stay inside the temp
directory — the original passed URL input straight to `os.path.join`.

---

## Local development and tests

Run the entire UI without ComfyUI:

```bash
python3 dev/devserver.py --port 8731
# -> http://127.0.0.1:8731/dev/harness.html
```

The harness feeds every renderer a synthetic signal, and the dev server answers
the real config endpoints from the real `NovaConfigManager`, so panel writes are
exercised against the actual code.

The test suite lives in `dev/tests/` and has [its own README](../dev/tests/README.md)
covering what each suite checks and how to run them. Two things to know:

- **Reset the config before `paneltest` and `scopetest`.** Both assert that a
  colour *changes* to a particular value; a leftover theme that already holds
  that colour makes them fail for no reason.
- **`zoomtest.mjs` prints two blocks.** The first deliberately restores the old
  broken pointer mapping to demonstrate the bug — its failures are the expected
  result.

Run `node dev/lint-templates.mjs` after touching any inline stylesheet.

---

## Known traps

Every one of these has actually happened here.

**Never mix `getBoundingClientRect()` with `ResizeObserver.contentRect`.**
ComfyUI positions DOM widgets under a CSS transform for zoom, so two pixel
spaces coexist: the observer reports untransformed layout pixels (what
`layout.js` works in), the bounding rect reports post-transform pixels (what
pointer events arrive in). Mixing them broke every control at any zoom ≠ 1.0.

**A backtick inside a CSS comment in a template literal** terminates the string
and makes the module a load-time syntax error. `dev/lint-templates.mjs` exists
because this was done twice.

**`display` beats `[hidden]`.** An element with an explicit display value
outranks the UA `[hidden] { display: none }` rule. The panel needs
`.nova-panel [hidden] { display: none !important; }`.

**`createMediaElementSource()` may only be called once per media element.**
Calling it again throws `InvalidStateError`, which is easy to swallow into a
generic "analyser unavailable" and leaves every meter dead until re-run. The
engine caches the whole graph per filename.

**Module-level mutable state is shared between nodes.** A `smoothedCorr` at
module scope meant two players fought over one needle. Use `gfx.store`.

**A shallow merge into the defaults dict lets user data become the default.**
`deep_merge` must deep-copy, or the first saved theme mutates `defaults.py` in
memory and the fallback path serves user data.

**Synthetic test material is not real audio.** A FLUX ceiling derived from a
synthetic loop pinned immediately on a real render — looped synthetic material is
far more self-similar frame to frame than music. Bracket your scale with
synthetic extremes if you like, but calibrate against a real file.

**A horizontal slice through a horizontally-drawn bar is uniform by
construction.** More generally: when a pixel test says a visual effect is
missing, check the axis you are sampling before you check the code.

**`palette.name` is not a cache key.** It is the *theme's* name, and a per-node
colour override does not change it — `setRole()` writes to
`state.overrides.roles` and leaves the active theme alone. Three renderers keyed
cached pixels on it (waveform's offscreen bar buffer, combined's, and spectrum's
fill gradient), so an edited colour kept blitting the stale bitmap. It looked
like the colour picker was broken *except* when the user also moved a renderer
slider, because `setParam()` explicitly nulls the waveform cache. Key on
**`palette.revision`**, which `resolvePalette()` bumps for every distinct
palette it builds. `dev/tests/colorlive.mjs` pins this.

**A flex child will not shrink below its content without `min-height: 0`.**
`.nova-panel__theme` was `flex: 0 0 auto`, so it grew with every row added to it
and, on a short node, pushed the section accordion down behind the footer until
no section could be clicked. It is now `0 1 auto` with a `max-height` and its own
scrollbar, and `.nova-panel__body` carries `min-height: 0`. Adding a row to the
theme block is safe again; it was not.

**`ctx.shadowBlur` costs what the path costs, not what the radius costs.**
Canvas shadows take a slow rasteriser path. On a 1760x600 canvas, blurring the
spectrum's ~1760-segment curve cost ~9.4 ms per frame, and blur radius 12
measured the same as radius 4 — so there is no "turn the glow down" fix, only a
"stop using shadows on complex paths" one. Two wide translucent strokes of the
same path give a comparable bloom for a fraction of the cost. Measure with
`dev/tests/perfprobe.mjs` before and after touching anything in a frame loop.
