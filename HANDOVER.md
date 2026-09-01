# Session handover — Nova Audio Player

Written so a fresh session with folder access can pick the work up cold.
Everything the repo already documents is **not** repeated here. This covers the
state of play, the open questions, and the context that otherwise only exists in
conversation.

**Repo:** https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer
**Status:** pushed and live. 299 automated checks passing at time of writing.
**Author:** NovaFemme.

---

## Read these first

The repo documents itself. Read, in order:

1. **`README.md`** — what the node is, from a user's point of view.
2. **`docs/TECHNICAL.md`** — architecture, the renderer contract, colour roles,
   endpoints, and a **Known traps** section listing nine things that have
   actually gone wrong in this codebase.
3. **`docs/design/`** — ten numbered design notes, in the order the work
   happened. `docs/design/README.md` indexes them and pulls out the recurring
   themes.
4. **`dev/tests/README.md`** — what each suite covers and how to run it.

Do not re-derive any of that from the source. It is current.

---

## What this is, in one paragraph

An audio player node for ComfyUI. It began as a 3,418-line single-file widget
using deprecated LiteGraph prototype hijacking, and was rebuilt into ~9,400
lines across 37 source modules on a DOM canvas via `addDOMWidget`. It has 12 live
visualisers behind a registry, a whole-file measurement strip computed in
Python, a themeable colour system with per-node overrides, and a settings drawer
generated from schemas. It is used to evaluate ACE-Step 1.5 XL SFT music
generations — the APG meter exists specifically to make generation settings
tunable by number rather than by ear alone.

---

## Current state

**Shipped and working** (confirmed running in ComfyUI):

- 12 renderers, all registered and drawing
- Bench strip (whole-file stats), toggled and resizable
- APG artifact meter with a freeze-reference workflow
- Theme system: 101 colour roles in the base theme, per-node vs per-theme scope
- Text-size and bar-relief sliders (app-level display preferences)
- Rounded bars with colour-derived 3D relief across every bar in the node
- `panel_info` STRING output (json / text / csv_row) for logging a take
- Control hints on the transport, toggleable in the settings drawer

**Test suite:** `dev/tests/` — 15 JS suites plus two Python suites, 299 checks.
Playwright is resolved by `dev/tests/_pw.mjs`; it used to be imported by an
absolute path that existed on exactly one machine, so the browser suites would
not even load from a fresh clone.

```bash
python3 dev/devserver.py --port 8731 &
node dev/tests/apgtest.mjs          # etc.
python3 dev/tests/test_bench.py
```

Two gotchas that have caused false failures more than once:

- **Delete `config/*.json` before `paneltest` and `scopetest`.** Both assert a
  colour *changes* to a value; a leftover theme already holding that value makes
  them fail for no reason.
- **`zoomtest.mjs` prints two blocks.** The first deliberately restores the old
  broken pointer mapping to demonstrate the bug — its failures are expected.

Run `node dev/lint-templates.mjs` after touching any inline stylesheet.

---

## Open items

Nothing is broken. These are the things that were left deliberately.

### 1. The APG hint thresholds are unvalidated guesses

`suggest()` in `web/renderers/projected_guidance.js` emits directional
hypotheses ("flat + bright → over-guided; lower cfg_scale"). The thresholds sit
outside the range real music occupied when measured, so they fire rarely and
conservatively — but **none of it is validated against ACE-Step**.

Analysis cycles are in progress. When readings exist from several takes at known
settings, those numbers should replace the guesses. This is the single
highest-value follow-up.

The calibration data currently in the code came from one real render
(`docs/design/08-apg-calibration.md` has the full table).

### 2. Registry publishing — set up, not yet published

`pyproject.toml` and `.github/workflows/publish.yml` are in place. Publishing
still needs, on the human side:

1. A publisher account at https://registry.comfy.org — the `PublisherId` in
   `pyproject.toml` is currently `novafemme` and **must match** the ID that
   account is issued.
2. An API key from that account, stored as the repo secret
   `REGISTRY_ACCESS_TOKEN`.

The workflow fires on any push to `main` that touches `pyproject.toml`, so bump
`version` there to cut a release. Until the secret exists it skips cleanly and
logs why, rather than failing red — the first push touching `pyproject.toml`
necessarily happens before a publisher account can exist. `version` reads `2.2.0`: the 2.1.x numbers were local snapshot folders, never
published releases. A registry version can never be reused, so bump before
pushing, never after.

### 3. Repo housekeeping

- **GitHub topics** — this 20-tag list was chosen but may not be applied:
  `comfyui`, `comfyui-nodes`, `comfyui-custom-nodes`, `audio`, `audio-player`,
  `audio-visualizer`, `audio-visualization`, `waveform`, `spectrogram`,
  `spectrum-analyzer`, `audio-analysis`, `audio-metering`, `dsp`, `lufs`,
  `web-audio-api`, `realtime-audio`, `ace-step`, `music-generation`, `ai-music`,
  `text-to-music`.
- **`docs/images/`** holds six screenshots taken from the dev harness, i.e.
  synthetic signal rather than real audio. Worth replacing with captures from a
  real workflow.

### 4. Longer-standing backlog, never chased

- Behaviour when the node is **collapsed** in ComfyUI was never tested.
- Whether `addDOMWidget`'s `getValue`/`setValue` fire on the exact frontend
  version in use was assumed, not confirmed.

---

## Resolved, for the record

**The RMS convention disagreement (−14.15 vs −15.14 dBFS) is arithmetic, not a
bug.** `compute_bench` measures both channels; the separate Bench Metrics node
downmixes to mono first. For channels of equal power the two differ by exactly
`10·log10((1+r)/2)` dB, where `r` is the L/R correlation. At the observed
`lr_corr` of 0.591 that is −0.99 dB, which is the split, to the hundredth.
`compute_bench` now also returns `rms_mono_db` (not displayed) so a logged take
can be compared against a mono-summing meter without re-measuring. Full
explanation in `docs/TECHNICAL.md § Two RMS conventions`; pinned by four checks
in `dev/tests/test_bench.py`.

---

## Things that will bite a new session

All of these are in `docs/TECHNICAL.md § Known traps` with more detail. The three
most likely to come up:

**`sig.freq` is bytes, not decibels.** `getByteFrequencyData` returns 0–255 with
the analyser's dB mapping already applied. Treating a byte as dB fails *quietly*
— the display pins to full scale and looks busy. Four of the seven hand-written
renderers hit this. Use `byteToDb` / `byteToNorm` / `dbToNorm` from `gfx.js`. If
a renderer computes a weighted average over the spectrum, it needs
`needs: { freqDb: true }` and the unclamped float path instead.

**Never mix `getBoundingClientRect()` with `ResizeObserver.contentRect`.**
ComfyUI transforms DOM widgets for zoom, so two pixel spaces coexist. Mixing
them broke every control at any zoom ≠ 1.0 and presented as "clicking anywhere
seeks the audio".

**A backtick inside a CSS comment in a template literal** silently makes the
whole module a load-time syntax error. This happened twice.
`dev/lint-templates.mjs` catches it.

---

## How the work goes, and what matters to the author

Useful for calibrating tone and approach in a new session:

- Every delivery is tested in real ComfyUI and reported back with screenshots.
  **Several of those screenshots caught real bugs the harness could not** — a
  499 Hz centroid that exposed the byte-spectrum clamp, a pinned FLUX bar, an
  unreadable HUD over album art. Treat the screenshots as data, not as status
  reports.
- He writes his own renderers against `_template.js`. The registry-driven design
  exists so he can, and it works. Keep that property intact.
- He values being told plainly when something cannot do what he hoped —
  specifically that the APG panel's knobs cannot reveal anything about
  `cfg_scale`, and that the directional hints are unvalidated hypotheses.
  **Do not oversell the meter.**
- Mistakes from previous sessions worth not repeating: a minus sign misread off
  a low-resolution screenshot led to calling his clipping warning wrong when it
  was right; a constant calibrated on synthetic audio pinned immediately on real
  audio; several tests sampled the wrong pixels and looked like feature
  failures. **When a pixel test says a visual effect is missing, check the
  sampling axis before the code.**

---

## Workflow context

ACE-Step 1.5 XL SFT, in ComfyUI. Settings observed in use:

- APG sampler node: eta 0.45, norm_threshold 4.00, momentum 0.20
- ModelSamplingAuraFlow: shift 3.00
- KSampler: steps 80, cfg 2.80, `er_sde`, `linear_quadratic`, denoise 1.00
- TextEncodeAceStepAudio1.5: cfg_scale 2.00, temperature 0.72, top_p 0.90
- Saves both MP3 320k and FLAC; a MySQL dump node logs runs

Relevant because: **point the player at the FLAC** if the SAT metric is to mean
anything (lossy encoding smooths away the flat tops it detects), and the MySQL
logging is the natural home for the take-comparison data that would validate the
APG thresholds.
