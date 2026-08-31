# APG meter — rework into an artifact meter

Replaces the earlier `projected_guidance` renderer (v1 integrator, v2
spectrum-vs-target). Purpose: give a measurable read on how a generation's
settings changed the audio, so `cfg_scale`, `steps`, `shift`, `temperature` and
the sampler's `eta / norm / momentum` can be tuned against numbers rather than
impressions.

## Why the previous versions could not do this

v1 integrated an error term into a free-running position that clamped at 0 and
stayed there. v2 fixed the clamping by plotting the measured spectrum against a
synthetic target curve.

The deeper problem in both: **distance from an arbitrary reference curve is
mostly a property of the curve, not of the render.** Two takes at different
`cfg_scale` could score identically, so the number could not inform a decision.

Also worth stating plainly, because the naming invites the confusion: the
renderer's own panel knobs (`smoothing`, `showSpectrum`, `showHints`,
`autoReset`) only affect how the meter smooths and draws. They do not touch the
audio and share nothing but a name with the sampler's Adaptive Projected
Guidance parameters.

## The byte-spectrum trap — the most important thing in this file

The first build read `sig.freq`, the `Uint8Array` from `getByteFrequencyData`.
In ComfyUI it reported **CENTROID 499 Hz** on a dense electronic track. That is
not a plausible brightness figure, and chasing it found two compounding faults:

**1. Bytes are decibels, not magnitude.** `getByteFrequencyData` maps
`minDecibels..maxDecibels` (−100..−30 by Web Audio default) linearly onto 0..255.
Weighting an average by the byte value therefore weights by dB — a bin 60 dB down
still carries over half the weight of the loudest one. Measured through a real
`AnalyserNode` against a ±6 dB shelf at 4 kHz, byte weighting responded with 18%
of centre; magnitude weighting with 71%.

**2. The byte path clamps, and the clamp is most of the spectrum.** Every bin
below −100 dBFS reads exactly 0. A 4096-point FFT spreads a −18 LUFS track's
energy so thinly that on a produced track most bins above the low mids fall
under that floor. Measured: on a source with a low noise floor, only **192 of
2048 bins** were non-zero, and a ±6 dB shelf above 4 kHz moved the byte centroid
by **zero Hz**.

Converting bytes → magnitude fixes (1) but not (2): the ~2000 clamped bins each
contribute a phantom −100 dB, faking a broadband HF bed. On the clamping source
that halved the response again (31% vs the float path's 61%).

**The fix is `getFloatFrequencyData`**, which returns true per-bin dBFS with no
clamp. `minDecibels`/`maxDecibels` only scale the byte conversion, so the float
call needs no global setting change and affects no other renderer.

- `AudioEngine` gained `sig.freqDb` (`Float32Array`), filled only when
  `engine.wantFloatFreq` is set — a second full FFT read per analyser tick.
- Renderers opt in with `needs: { freqDb: true }`.
- `host._draw()` derives the flag from the active renderer **every tick**, not at
  the point of switching: the view also changes on state restore and from the
  settings panel, and a flag set in only one of those paths is wrong some of the
  time.

## What it measures

| Metric | Meaning |
|---|---|
| CREST | peak-to-RMS, dB. Transient definition. Over-guidance flattens it. |
| CENTROID | magnitude-weighted spectral centre of mass, Hz. Brightness. |
| FLUX | rising-only change in each bin's *share* of total magnitude. Level-invariant. |
| FLATNESS | geometric/arithmetic mean ratio, **in dB**. 0 dB is white noise; a pure tone ≈ −28 dB. |
| CLIP | % of samples at the digital ceiling. |
| SAT | % of samples inside flat-top runs, at ANY level. |

`SAT` is the one that catches over-guidance on normalised output: a take
squashed into a limiter and then pulled back below full scale has a clean peak
reading and a clean CLIP figure, and is still saturated. Measured: material
limited at −1.32 dBFS reads CLIP 0.00% and SAT 21.9%. Needs lossless audio — a
lossy encode smooths the flat tops away.

Each metric shows a **live** smoothed value and one **integrated** since the
last reset. The integrated one is the comparable one.

## Design decisions worth remembering

**Everything is gated on `sig.frame`.** All measurement happens once per analyser
tick, never per repaint. Without the gate, flux reads zero on every frame that
reuses the same buffer and every average ends up weighted by display refresh
rate. Verified identical at 60 Hz and 120 Hz repaint to 0.0%.

**Flux must be primed before it is measured.** On the first frame `prevSpec` is
all zeros, so every bin counts as a rise and flux reads its theoretical maximum
of 1.0. `store.fluxPrimed` skips it — and `reset()` clears the flag, or a
mid-track reset reintroduces the same spike.

**Integrated crest is whole-take peak over whole-take RMS**, not a mean of
per-frame crests, which would flatter a track with a few loud transients.

**Silence (frame RMS < 0.002) is excluded.** Otherwise a sparse arrangement looks
duller than a dense one at identical settings.

**Flatness is reported in dB.** As a raw ratio real music lands between 0.01 and
0.05 — all the resolution crammed against zero.

**Clip uses the engine's own `CLIP_THRESHOLD`**, imported rather than duplicated,
so the meter and the clip LED can never disagree.

**Comparability requires the same `fftSize` between takes.**

## Reference take

Clicking the panel freezes the current integrated set; every row then shows a
delta. Freeze on a take you like, change one setting, generate again, read the
deltas.

A new render **always** restarts the integration, regardless of `autoReset`, and
**keeps** the frozen reference. `setData()` bumps `host._sourceId` on a filename
change and stamps `store.sourceId` on every renderer store. Progress alone could
not distinguish "the user scrubbed" from "this is a different render".

**Delta direction is carried by an arrow, not by hue.** The first build coloured
"up" red and "down" green, which asserts that up is worse — wrong for four of the
six rows. A *falling* crest is the bad direction, and centroid and flatness have
no inherently good direction at all. CLIP is the one exception.

## The directional hints are hypotheses

`suggest()` emits one line prefixed `HYP:`, preferring reference-relative
readings when a reference is frozen (an absolute threshold has to guess where
"too bright" starts for music in general; a delta only has to notice that *this*
take moved). Each candidate carries the size of move it needs before it is worth
mentioning, and the one furthest past its own threshold wins.

**None of it is validated against ACE-Step.** Log takes, compare against a frozen
reference, and replace these rules with what is actually observed.

## Test-authoring traps hit

- Uniform-distributed noise has a crest of 4.77 dB (11–13 dB is *Gaussian* noise).
- Material phase must advance with the analyser tick, not the repaint.
- `dev/harness.html` stubs `engine.update()` wholesale, so anything testing
  engine internals must exercise `AudioEngine` directly or it silently tests
  nothing.
- `frame()` recomputes `integrated` and overwrites injected values, so
  `suggest()` is exported and tested directly rather than through a draw call.
