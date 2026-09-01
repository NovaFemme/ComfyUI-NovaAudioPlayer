# Test suite

Headless Playwright checks that run against `dev/devserver.py`. They exercise
the real modules in a real browser — no mocks — so a pass means the thing works
where it actually runs.

## Running

    npm install -g playwright && npx playwright install chromium
    python3 dev/devserver.py --port 8731 &
    node dev/tests/apgtest.mjs

Every suite gets Playwright through `dev/tests/_pw.mjs`, which resolves it from a
local install, then `$PLAYWRIGHT_PATH`, then the global npm root. Nothing here
hard-codes a path any more — they used to, and the suite only loaded on the one
machine that path existed on.

**Reset the config before `paneltest` and `scopetest`.** Both assert that a
colour *changes* to a particular value, so a leftover theme from an earlier run
that already holds that colour makes them fail for no reason:

    rm -f config/*.json
    curl -s -X POST http://127.0.0.1:8731/nova_player/config/reload

## What each one covers

| Script | Checks |
|---|---|
| `allcontrols.mjs` | Every chrome control: hit-testing, hover, click, drag, seek |
| `paneltest.mjs` | Settings panel — scoping, autosave, accordion, resize, name dialog |
| `scopetest.mjs` | Per-node vs per-theme colour overrides, promote, theme switching |
| `scrolltest.mjs` | Scrolling renderers are frame-rate independent |
| `cliptest.mjs` | The clip indicator never overlaps the renderer rect, at any size |
| `apgtest.mjs` | APG meter — metric maths, frame-rate independence, reference take |
| `designfix.mjs` | `freq_percentages` shares are of total energy, no bin dropped |
| `enginetest.mjs` | `AudioEngine`'s float-FFT path, with stub analysers |
| `e2e.mjs` | The float FFT flows engine → host → renderer for real |
| `calibrate.mjs` | Not a test — measures the APG bar ranges through a real `AnalyserNode` |
| `benchtest.mjs` | Bench strip — geometry, clamping, toggle, no overlap with the transport |
| `test_bench.py` | `compute_bench()` DSP: levels, both RMS conventions, correlation, contiguous bands, degenerate input |
| `realtake.mjs` | Not a test — measures a whole audio file with the renderer's formulas |
| `flatprobe.mjs` | Not a test — chooses the flat-top detector's epsilon and run length |
| `bartest.mjs` | The shared bar helper: rounding, derived relief, alpha, robustness |
| `scaletest.mjs` | Text scale (font interception, clamps, persistence) and bench resize |
| `zoomtest.mjs` | Pointer mapping under graph zoom |
| `colorlive.mjs` | A colour edit reaches the very next frame, with no cache in the way |
| `perfprobe.mjs` | Not a test — measures where the spectrum renderer's frame time goes |
| `tooltiptest.mjs` | Control hints: wording, the rest delay, and that they never escape the node |
| `test_panel_info.py` | The `panel_info` output mirrors the bench strip, in all three formats |

## calibrate.mjs

Not a pass/fail suite. It plays synthetic material (pure tone, produced-track
mix, the same mix with transients removed, white noise) through a real
`AnalyserNode` and prints what the APG metrics read. The bar ranges and the
`suggest()` thresholds in `projected_guidance.js` come from its output. Re-run it
if you change any of those formulas, and update the constants to match rather
than guessing at them.

## test_bench.py

The only Python suite. Dependency-free — it fakes the small slice of the torch
tensor API that `audio_io` uses, so the DSP is testable without torch or ComfyUI:

    python3 dev/tests/test_bench.py

It also pins the relationship between the two RMS conventions — `rms_db` across
both channels versus `rms_mono_db` on the downmix — which differ by exactly
`10·log10((1+r)/2)` dB. See `docs/TECHNICAL.md § Two RMS conventions`.

## Reading zoomtest's output

`zoomtest.mjs` prints **two** blocks. The first deliberately restores the old,
broken pointer mapping to demonstrate the bug — its FAILs at zoom ≠ 1 are the
expected result and are what the fix is measured against. The second block is
the current code and must be all PASS.
