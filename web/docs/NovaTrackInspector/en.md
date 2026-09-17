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

---

## The provisional layer (new in 2.6.0)

Everything above this line is a measured fact about the file. What follows is
**not validated**, and the node says so rather than hiding it.

### Why it exists

The score used to answer one question: *is this track the same as itself
throughout?* Around 72% of the weight sat on measures that start at 100 and only
fall when something **changes** — coherence, spectral consistency, level
continuity, structural integrity.

A track that is uniformly wrong is perfectly consistent. That is why a washed-out
generation could score an A: nothing in it changed, so nothing was penalised.

The provisional layer asks a different question — *does the end of this track
belong with the beginning?* — which a uniformly wrong track fails.

### What it measures

**Start-vs-end timbre.** A 24-band energy profile over 200–6000 Hz, normalised so
it describes character rather than loudness, compared between the first and last
third. Six approved masters measured 0.018–0.058.

**Sustained excursion.** How long the track sits away from its own baseline, after
the repeat allowance. No approved master exceeded one 10-second block.

**Timbre step.** The largest single jump, with its timestamp. Treat this as a
place to listen, not a fault — approved masters legitimately reached 8.5.

**Dynamic spread.** Crest variation across the track. Weak by default: wide
dynamics are a stylistic choice.

### The controls

| Control | Default | Direction |
|---|---|---|
| `consistency_threshold` | 0.075 | Lower flags more |
| `consistency_weight` | 0.35 | Higher penalises tracks that end different |
| `excursion_seconds` | 10.0 | Lower is more sensitive |
| `excursion_weight` | 0.35 | Higher penalises sections that don't belong |
| `repeat_allowance` | 0.70 | Higher forgives deliberate repetition |
| `step_z_threshold` | 9.0 | Lower flags more |
| `step_weight` | 0.20 | Deliberately low — step size alone misclassifies |
| `loudness_weight` | 0.25 | Higher argues with explosive tracks |
| `provisional_authority` | 0.30 | How far unvalidated measures may push the verdict |

`provisional_authority` is the one that matters. At **0.00** these measures only
comment. At **0.30**, the default, they can colour a report REVIEW and no worse.
At **0.70** they may reach POOR, and at **1.00** REJECT. Raise it as your own
listening validates them — not before.

Nothing here can fail a track on its own at the default. That is deliberate: an
unproven measure with veto power is what produced the original bug, in both
directions.

### Live tuning

Every control is on the node, so you can move one and re-run to see the verdict
move, rather than staring at a fixed report. The values used are written into the
report JSON with the result, so a saved report records the dial positions that
produced it.

### Profiles

`weight_profile` lists the same names as Madow's profile dropdown. Selecting one
loads its saved controls; `— none —` uses the values on the node. A profile may
override one control or all nine — anything it does not mention keeps the node's
value.

The weights are stored in `profiles/track_inspector/<name>.json`, **not** inside
the Madow preset. Madow rebuilds a preset file from six fixed keys when it saves,
so anything extra stored there is silently dropped the next time you press Save
in Madow. Sharing the names without sharing the file avoids that.

`save_weights_to_profile` writes the node's current values into the selected
profile on the next run. Off by default — a run should not change your saved
settings unless you ask.

**Why profiles are necessary, not a convenience.** No single threshold works
across material. A deliberately explosive track measured 0.213 on start-vs-end
timbre — higher than takes that were rejected as broken. A threshold that clears
it would miss most genuine faults. Different material needs different numbers.

### Honest limits

- **Start-vs-end timbre cannot separate dramatic tracks from broken ones.** It
  flags a legitimately explosive master. Per-profile thresholds are the fix.
- **`loudness_weight` measures crest spread**, which is not the same as a peak
  crest reading from a meter with direction and rate of change. It does not yet
  capture what such a meter sees.
- **Thresholds come from six mastered tracks**, not from generated takes. They
  are a starting point, not a calibration.
