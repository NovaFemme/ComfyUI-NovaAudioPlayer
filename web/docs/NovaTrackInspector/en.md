# Nova Track Inspector

Analyses the **whole track over time** and tells you where to listen. Baseline
`v0.2.0`.

It is deliberately not part of mastering. It does not normalise, EQ, compress,
limit or alter a single sample — `audio` is an unchanged pass-through. Think of
it as a visual listening assistant: *here are the regions worth hearing again.*

## Put it after the save

    Master -> Save PCM24 -> reloaded audio -> Track Inspector

Inspecting the reloaded delivery means inspecting what actually ships, rather
than the internal pre-save tensor.

## Inputs

`analysis_resolution` — `Normal` is the baseline. `Fine` buys more time
resolution for more processing. `Fast` is coarser.

`marker_sensitivity` and `coherence_sensitivity` change how readily markers are
raised. **Leave them at the baseline while you are calibrating a release set**,
or you are comparing tracks against a moving ruler.

## Outputs

| Output | Is |
|---|---|
| `audio` | unchanged pass-through |
| `inspection_json` | the full report — feed the Track Inspector Report viewer |
| `markers_json` | timestamped markers |
| `timeline_json` | whole-track measurements and the waveform envelope |
| `score` | Track Integrity, 0–100 |
| `verdict` | EXCELLENT / GOOD / REVIEW / POOR / REJECT |

`REJECT` is reserved for strong evidence — sustained noise-like content,
repeated hard failures, clipping, dropout, artefacts, or genuinely low
integrity. It is not handed out for being different.

## A marker is not a defect

`STRUCTURAL_TRANSITION` usually means a verse changed into a chorus. The
baseline was tuned so that normal, stable musical change is recorded as an
**observation** rather than punished as a fault, and scoring ignores non-fault
observations and normalises penalties by track duration.

So **marker count is not the score**. A track with many observations can score
well and be right to.

High global coherence means the track is broadly stable by that measurement. It
does not mean the song is good. Local Integrity is where genuine coherence
faults are penalised.

## What it can currently see

RMS, peak and crest over time; stereo correlation; tonal-band timelines;
spectral flatness, entropy, flux, centroid and rolloff; broadband-noise risk;
loudness and dynamics discontinuities; stereo phase anomalies; channel dropout;
clipping; silence and near-silence; HF, bass and presence surges or collapses;
coherence breaks; impulse anomalies; extended repetition or stuck generation;
and structural section boundaries.

## The limitation, stated plainly

**A high score does not mean it sounds good, and v0.2.0 has a known blind spot.**

Audio can be spectrally consistent, highly coherent, unclipped and technically
stable while sounding washed out, hollow, noise-dominated, over-masked or
unnaturally uniform. Consistency measurements currently give that kind of
stable-bad audio too much credit. An A or A+ here does not replace listening,
and should not be allowed to override it.

Work identified for future calibration — spectral health, texture and masking
health, macro-dynamic shape, envelope-pattern detection, 1/3-octave RTA temporal
motion, spectral-motion coherence, jitter, band independence, spectral travel,
dynamic stability over time, vocal intelligibility masking risk — **is not
implemented in v0.2.0.** It is listed here so nobody reads the score as covering
it.
