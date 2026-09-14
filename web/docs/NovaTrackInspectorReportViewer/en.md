# Nova Track Inspector Report

Renders `inspection_json` from **Nova Track Inspector**. Read-only.

## Views

**Inspector** — the whole-track overview: score, grade and verdict, summary
metrics, waveform, issue markers, integrity subscores and priority markers.

**Timeline** — the time-series graphs: window RMS, crest, stereo correlation,
bass, mid, presence, HF, noise likelihood and coherence, as far as the report
carries them.

**Markers** — marker-focused.

**Technical** — the underlying inspection data.

## The waveform

Mouse-wheel to zoom, drag to pan, a visible-range control, double-click to
reset. The priority-marker area scrolls and expands, so the report stays compact
without hiding anything.

## What the marker overlay is not

Worth reading once, because the overlay invites two wrong conclusions.

**Marker boundaries are analysis window and hop boundaries, not sample-accurate
event boundaries.** A marker says "something in this window"; it does not say
the event began on the pixel where the block starts.

**Colour is severity, not amplitude.** A dark band is not a loud passage.

Use the markers as somewhere to put the playhead, then listen.

## Changing the view does not re-run anything

`view_mode`, `theme` and `font_scale` redraw from the cached report. **Apply
View** is an explicit local refresh. The inspection flow is not queued by any of
them.
