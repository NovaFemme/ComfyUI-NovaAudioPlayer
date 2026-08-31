# Nova Player — time-based spectrogram scroll

## The defect

The rolling buffer advanced a fixed number of pixels **per painted frame**,
inherited from the original node. That makes the X axis "one column per refresh"
rather than a time axis:

| refresh rate | pixels of scroll for 2 s of audio (old) |
| --- | --- |
| 30 fps | 60 |
| 60 fps | 120 |
| 144 fps | 288 |
| 240 fps | 480 |

So the same file scrolled ~2.4x faster on a 144 Hz monitor than on a 60 Hz one,
sped up or slowed down whenever the frame rate dipped, and there was no answer
to "how much audio is on screen".

## The fix

`scrollSpeed` is now **pixels per second** (default 60, was 1). `frame()`
accumulates `dt * pxPerSecond` into `store.debt` and shifts by
`Math.floor(debt)` columns, carrying the fraction.

Supporting changes:

* `gfx.now` — the frame's wall-clock timestamp, set by `host` from the RAF
  callback. Propagated to children automatically, so `combined`'s spectrogram
  gets it too. Injectable, which is what makes this testable at all.
* Guards: `dt` of NaN, negative, or > 0.5 s (tab switch, long stall) is treated
  as zero rather than scrolling the whole gap in one frame.
* Pausing clears `store.lastNow`, so resuming restarts the clock instead of
  scrolling the entire pause duration at once.
* `spectrogram.timeSpan(rect, params)` — seconds visible. Only a meaningful
  question now that the axis is time.

## Verification

2 s at 60 px/s, expected ~120 px:

```
 30 fps -> 119 px
 60 fps -> 119 px
144 fps -> 120 px
240 fps -> 120 px
spread across 30-240 fps: 1 px
```

## Note for future renderers

**Any renderer that animates must derive motion from `gfx.now`, never from
"one step per frame".** The waveform's `phase` is still frame-counted, but it
only drives a subtle pulse glow whose speed nobody would notice.
