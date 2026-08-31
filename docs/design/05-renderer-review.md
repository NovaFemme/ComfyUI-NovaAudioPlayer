# Review of seven user-added renderers

Seven new view modes written against `_template.js`. All seven loaded,
registered and drew without throwing — the framework side of the contract worked
exactly as intended. The maths and the theme integration did not.

## One root cause behind most of it: byte vs dB

`sig.freq` is `getByteFrequencyData()` — `Uint8Array`, 0-255. Four renderers
treated those bytes as decibels or as linear amplitudes.

| renderer | expression | consequence (measured) |
| --- | --- | --- |
| fft_analyzer | `20*log10(byte)` vs a 0 dB ceiling | 93% of bins clamp to the ceiling — trace is a flat line at the top |
| rta_analyzer | `20*log10(rms of bytes)`, `(db+90)/90` | 100% of bands clamp to full height |
| freq_percentages | `10^(byte/20)` | 5.6e12 for a full-scale bin; one bin swamps every band |
| freq_percentages | `if (db > -24)` on a byte | always true — "HF outliers" was a constant 682 |
| combined_suite | same `10^(byte/20)` | same |

This fails *quietly*: the views look alive while showing nothing, which is why
it survived testing.

Fix: `byteToDb()`, `byteToNorm()`, `dbToNorm()` in `gfx.js`, plus band energy
(`v*v`) rather than amplitude sums.

## Missing colour roles — 22 of them

Every new renderer declared roles that no theme defined (`level.*`, `phase.*`,
`band.*`, `grid.line`, `spectrum.fill`, and a `mode.<id>` pill for each). By
design `palette.get()` returns magenta and warns for an unknown role, so the
RTA rendered as a solid magenta block.

Note the idiom `palette.get("x") ?? "#fallback"` is a **no-op** — `get()` always
returns a string.

## Other real defects

* **peak_rms** read `sig.peakHold?.L` — `peakHold` is a single NUMBER, so the
  hold marker just tracked the live level. Also used `sig.currentTime` as the
  hold clock, which froze while paused and jumped on seek.
* **Frame-rate dependent smoothing** in four renderers — same class of bug as
  the spectrogram. Added `smoothingAlpha(factor, dt)`.
* **projected_guidance** allocated a 2048-entry `Float32Array` every frame
  (~0.5 MB/s of garbage); drew 2048 path points across ~600 px; hardcoded two
  colours; printed `STABILITY: OPTIMAL` unconditionally; HUD at a fixed 190x85
  overflowed small nodes.
* **fft_analyzer** default tilt 3 dB/oct pushed the upper half into the ceiling.
  Peak decay was 0.2 dB per *frame*; now 12 dB/s.

## Two things I got wrong while reviewing

Recorded so the same false alarms are not raised again:

1. Predicted `new Float32Array(rect.w)` would throw on a fractional width. V8
   truncates, and `layout.totalW` is always integral anyway.
2. A verification assertion expected BASS > PRES for a bass-heavy test signal.
   The mid band spans ~8x more bins, so it legitimately holds more energy — my
   assertion was wrong, not the renderer.
