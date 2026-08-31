# Bench strip — whole-file statistics in the player

Replaces a set of separate ComfyUI nodes that each measured the same take with
their own band edges, their own peak convention and their own idea of what
counts as clipping — and disagreed with each other and with the player.

## One calculation, one source of truth

`nova_player/audio_io.compute_bench(waveform, sample_rate)` runs once in the
node, on the **same waveform tensor** that produces the WAV, the waveform
display and the loudness badge. Its output rides along in the `ui` payload as
`bench`, and the strip only renders it.

**Whole-file, never live.** Every figure covers the entire take and does not
move during playback. Peak, RMS and band shares are properties of the render; a
rolling version answers a different question. The APG meter is the live
instrument, this is the bench sheet.

## The peak conventions that were in conflict

**`save_wav` clamps, so the player and a bench node see different audio.**

```python
samples = np.clip(waveform[:n_ch].cpu().float().numpy(), -1.0, 1.0)
```

A bench node measures the tensor (+1.32 dBFS). The player loads the WAV, where
that overshoot has become genuine flat-topped digital clipping at exactly 1.0.
This is why a whole-file pass over an exported MP3 found 87 samples pinned at
the ceiling while nothing "clipped" in the generation's own terms.

`compute_bench` runs **before** the clamp and reports both:

- `peak_db` / `peak_linear` — the true generated peak, unclamped
- `over_fs` — samples that exceed full scale, i.e. what the WAV write destroys
- `clipped_samples` / `clipped_pct` — what ends up flattened in the file

The node also prints a console warning when `over_fs` is non-zero. The audio
pipeline is deliberately **unchanged** — no normalising on save. The panel
reports; the user decides whether to lower cfg or add headroom upstream.

## Contiguous bands, again

Disjoint bands of 60–250 / 500–2000 / 4–6 kHz sum to **59.37%**.
`BAND_EDGES_HZ = (0, 250, 2000, 6000, inf)` matches `freq_percentages.js`, so
every bin lands in exactly one band and the four figures always total 100%.

Band energy uses a Welch-style average (8192-point Hann windows, 50% overlap)
rather than one transform of the whole file: flat memory on a long take and a
far steadier estimate.

Validated against a real render — **L/R correlation 0.591, matching the separate
bench node exactly**, with bands summing to 100.00%.

## Layout: the strip takes height, it does not add it

The strip is anchored to the bottom edge and takes its height out of the
visualisation, so opening it does not reflow the graph.

**The bug that design created, and the fix.** On a short node the visualiser
falls back to its minimum height, the transport row goes where it always goes,
and the strip — anchored to the bottom — was drawn straight over the play
button. At 460×280 the transport sat at y=176 inside a strip starting at y=128.

Two guards now:

- `computeLayout` clamps `benchH` to `h − badgeHeight − controlsHeight −
  minVis`, so a node forced small degrades by clipping the strip, never by
  burying the transport. At 460×280 the strip gets 71 px instead of 152.
- `minimumNodeSize` accounts for `benchOpen`, so opening the strip raises the
  node's minimum height (209 → 361 px).

`host._syncPanelBottom()` was extracted because the settings drawer is
positioned from `wfBottom`, which the strip moves.

## Presentation

Two columns: measurements left, file and audio right. Rows are declared in a
`STAT_ROWS` table, so adding a measurement is one entry rather than another
block of layout arithmetic.

`warn` returns a *reason string* or null, and only returned reasons are
coloured — nothing is styled as a warning merely for being a number.

Six theme roles (`bench.bg`, `bench.rule`, `bench.heading`, `bench.label`,
`bench.value`, `bench.warn`). Long filenames are binary-searched to an ellipsis.

The strip is resizable by dragging its top edge, with the height saved per node
and clamped between 64 px and whatever room is genuinely spare.
