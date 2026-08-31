# APG meter — calibration against a real ACE-Step render

Companion to [07-apg-artifact-meter.md](07-apg-artifact-meter.md).

## The reference measurement

`dev/tests/realtake.mjs` measures a whole audio file with the renderer's own
formulas. `AnalyserNode` can only be polled in real time, so the script
reproduces what it does — Blackman window, 4096-point FFT, `smoothingTimeConstant`
EMA on the magnitude spectrum — and walks the file at the analyser's frame rate.

Run over a 4:20 K-pop-metal ACE-Step render, 7745 analysed frames:

| | value | p05 | median | p95 |
|---|---|---|---|---|
| peak | 0.00 dBFS | | | |
| RMS | −14.15 dBFS | | | |
| crest (integrated) | 14.15 dB | | | |
| CENTROID | mean 3554 Hz | 1977 | 3581 | 4608 |
| FLATNESS | mean −10.9 dB | −13.0 | −10.9 | −9.6 |
| FLUX | mean 0.102 | 0.076 | 0.097 | 0.142 |
| CLIP | 0.0003% | | | |
| SAT | 0.0000% | | | |

The live meter read CENTROID 2876 Hz and FLATNESS −11.1 dB on the same material
— good agreement, the difference being partial-playback integration versus
whole-file.

## Two presentation faults this exposed

**CLIP printed a flat `0.00 %` on a file with 87 clipped samples.** 87 in 25
million is 0.0003% — real, but invisible at two decimal places. The row is now
log-scaled from 0.0001% to 10% at 4 decimal places.

**FLUX pinned at its ceiling.** 0.12 came from synthetic material; real music
reads 0.169. Max is now 0.40. The general lesson: synthetic loops are far more
self-similar frame to frame than real music, and the synthetic columns bracket
the scale without saying where the needle will sit.

## Why SAT exists

A Bench Metrics node reported `Peak: 1.32 dBFS <<< CLIPPING (11 samples)` while
the APG meter read `CLIP 0.00 %`. **11 samples at an identical peak value is a
flat-top count, and flat-topping is what a limiter leaves behind.**

A take squashed into a limiter and then normalised *back below* full scale has a
clean peak reading and a clean CLIP figure and is still saturated:

| material | peak | CLIP | SAT |
|---|---|---|---|
| clean | −1.16 dBFS | 0.000% | 0.000% |
| limited at −1.32 dBFS | −1.32 dBFS | **0.000%** | **21.9%** |
| clipped at full scale | 0.00 dBFS | 13.5% | 13.5% |
| loud 50 Hz sine | −0.45 dBFS | 0.000% | 0.000% |

**Detector constants, and why they are what they are.** A run is consecutive
samples where `|Δ| ≤ SAT_EPS` and `|x| ≥ SAT_LEVEL`, counted when it reaches
`SAT_RUN` samples.

- `SAT_EPS = 1e-6` — must stay far below one 16-bit LSB (3.05e-5). At `1e-4` a
  loud 50 Hz sine reads **1.0% saturated** purely because consecutive samples
  barely differ near its apex. That false positive on ordinary bass is the whole
  reason the epsilon is tight.
- `SAT_RUN = 4` — shorter runs occur naturally at any waveform apex.
- `SAT_LEVEL = 0.35` (about −9 dBFS) — a limiter ceiling is never below this.

Runs that straddle two analyser windows are counted as two shorter runs and may
fall under `SAT_RUN`, so the metric slightly **under**-reports. Better that way
round than stitching windows that are not contiguous.

**SAT needs lossless audio.** It measured 0.0000% on a 320k MP3 — ffmpeg's own
`astats` agrees, reporting `Flat factor: 0.000000`. Point the player at FLAC
output if this row is to mean anything.

## A correction worth recording

An earlier reading of a low-resolution screenshot took the peak as **−1.32 dBFS**
and concluded the take was not clipping. It is **+1.32 dBFS** — above full scale.
Never read a sign off a scaled screenshot.
