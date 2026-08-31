# Bar styling — rounded corners and derived relief

One helper in `web/core/gfx.js` that every bar in the player goes through, so a
level meter, a band share, a waveform column and a spectrum bar all get the same
treatment — and a renderer added later inherits it without knowing it exists.

## The shading is derived, not authored

`drawBar()` lights a bar as a cylinder: a dark rim, a highlight at 10% of the
span, the pure theme colour at 38%, shade at 88%, dark rim again. The gradient
runs across the bar's **short axis**, so a horizontal bar is lit top-to-bottom
and a vertical one left-to-right.

Light and shade are computed **from the bar's own colour** — the same colour
pushed toward white and toward black. That is what makes it work for any theme
and any colour a user picks, with nothing to configure per colour.

**Alpha is preserved throughout.** `#6c63ffaa` stays 67% transparent and merely
gains relief. Mixing toward opaque white would quietly turn every translucent
bar solid.

**Mixing happens in sRGB deliberately**, not in the theme's configured mix
space. This is a lighting effect on one colour, not a blend between two.

## Rules that keep it from looking wrong

**Radius is proportional and capped.** `barRadius()` returns
`min(4, short × 0.28, w/2, h/2)`, and **0 below 3 px**. A 3 px spectrum column
rounded to a lozenge just disappears; a 40 px meter rounded to a pill looks like
a different widget.

**Below 2 px of span there is no gradient at all.**

**Stacked bars round only their outer ends.** Rounding every segment of a
continuous bar leaves visible gaps down its middle.

**Tracks are drawn with the same helper as fills**, so a fill sits in a matching
well rather than in a square hole.

## Performance

Gradients are cached on `colour | span | orientation | relief`. A 64-band
spectrum at 60 fps would otherwise build 3840 gradient objects a second. The
cache is a bounded LRU (96 entries) and is cleared whenever the relief setting
changes.

## The relief slider

`appearance.bar_relief`, 0–1, default 0.55, in the theme block of the settings
panel beside text size. An **app-level display preference, not theme content** —
the shading is derived from whatever colour the theme supplies.

At 0 the helper returns the plain colour string and builds no gradient at all,
so "flat" costs nothing.

## Where it is applied

`waveform`, `peak_rms`, `freq_percentages`, `rta_analyzer`, `combined_suite`,
`chrome.drawMeter`, and the bench strip's band bar and legend swatches.

`spectrum` and `analyzer` are untouched: they draw filled curves and a
goniometer, not bars.

## Three test-authoring traps hit here

1. Sampling one pixel *inside* a rounded corner still lands inside the arc —
   sample the bounding-box corner itself.
2. The highlight peaks at 10% of the span, not at the edge; sampling the very
   edge measures the deliberate dark rim and reads as "no highlight".
3. **A horizontal slice through a horizontally-drawn bar is uniform by
   construction**, because its relief runs top-to-bottom. The first in-app check
   reported "2 shades flat → 2 with relief", which looked like the feature was
   dead when the test was cutting along the wrong axis.
