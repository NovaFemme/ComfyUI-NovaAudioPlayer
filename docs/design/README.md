# Design notes

Ten documents written as the node was built, in order. Each covers what was
decided, what broke, and why the fix is the shape it is.

They are kept because the reasoning is harder to reconstruct than the code, and
because several of them record mistakes worth not repeating.

| # | Document | What is in it |
|---|---|---|
| 01 | [Refactor plan](01-refactor-plan.md) | Audit of the original 3,418-line node, target architecture, the renderer contract, migration order |
| 02 | [Implementation notes](02-implementation-notes.md) | What shipped, the graph-zoom pointer bug, five latent bugs the port fixed |
| 03 | [Settings panel rework](03-settings-panel-rework.md) | The echo loop that closed the panel mid-edit, scoped editing, two CSS traps |
| 04 | [Spectrogram timing](04-spectrogram-timing.md) | Frame-counted scroll → a real time axis |
| 05 | [Renderer review](05-renderer-review.md) | Seven community renderers reviewed: byte-vs-dB, 22 missing roles, frame-rate smoothing |
| 06 | [Band and guidance rework](06-band-and-guidance-rework.md) | Contiguous band edges; the integrator that railed at zero |
| 07 | [APG artifact meter](07-apg-artifact-meter.md) | The metrics, why the byte spectrum could not support them, the float FFT path |
| 08 | [APG calibration](08-apg-calibration.md) | Calibration against a real ACE-Step render; why SAT exists |
| 09 | [Bench panel](09-bench-panel.md) | One calculation feeding the strip; the clamp that hid clipping; the layout overlap |
| 10 | [Bar styling](10-bar-styling.md) | Derived relief, radius rules, three test-authoring traps |

## Recurring themes

A few things come up again and again across these documents, and are worth
reading as a set:

- **Quiet failure is the enemy.** Byte-vs-dB, the railed integrator, the clamped
  spectrum and the frame-counted scroll all produced displays that looked alive
  while showing nothing useful.
- **Derive, don't duplicate.** The registry, the colour roles, the bar relief and
  the text scale all exist so that adding something new inherits the system
  rather than restating it.
- **Test the axis, not just the code.** Several false alarms here were tests
  sampling the wrong pixels, the wrong channel, or leaking state between phases.
- **Synthetic material lies about real audio.** Twice a constant calibrated on
  synthetic signals had to be corrected against a real render.
