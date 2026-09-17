# Nova Track Inspector Report

Renders `inspection_json` from **Nova Track Inspector**. Read-only.

## Exporting every view as an image

**Right-click this node → Export views → images.** The count in the menu is the
number of files you will get.

It renders each view in turn — every one except **Technical**, which is a raw
data dump and pointless as a picture — and saves them to
`output/NovaAudioMasters/ReportImages/`. Files are named after the audio the
report came from, so `Irony_of_Heart_Dashboard_20260915-120530.png` rather than
anything you have to decode later.

The pictures are the viewer itself. They are rasterised from this node's own
rendered output with its own stylesheet, so what lands on disk is what you see
here — not a second drawing of the same numbers that drifts away from it over
time. Width is fixed so the image does not change with the size of the node on
your canvas, and height follows the content, so nothing is cropped and there is
no empty space under a short report.

The viewer flicks through each view while it works and returns to the one you
started on, including if something goes wrong.

Three settings, under **Settings → Nova Audio → Report Capture**:

| Setting | Default | Effect |
|---|---|---|
| Report export scale | 1.5 | Pixel multiplier. 1.5 is crisp at a sensible file size. |
| Report export width (px) | 1200 | Layout width. Height follows content, so this sets the shape. |
| Add a date-time stamp | on | On, every export is kept. Off, re-exporting replaces the previous set. |

The node's title bar carries a reminder of how many views it will export, and it
turns blue once there is a report to capture.

**If the exported images come out empty.** The export refuses with a message
rather than writing them, and the server refuses them again if they somehow get
that far, because the cause is never the report itself. A privacy or
anti-fingerprinting browser extension has replaced the function the export uses
to turn the picture into a file, and it returns an image of the right size with
nothing in it. Paste this into the browser console to identify it:

```js
HTMLCanvasElement.prototype.toDataURL.toString()
```

Anything other than `[native code]` means an extension has replaced it, and
disabling that extension for this site fixes it.

More often the cause is the browser's **GPU-accelerated 2D canvas**. Browsers
keep small canvases in software and hand large ones to the GPU, and on some
Linux graphics drivers the large ones read back empty — which is why the report
looks perfect on screen and the file comes out blank. In Firefox, open
`about:config` and set `gfx.canvas.accelerated` to **false**; in Chromium or
Opera, open `chrome://flags` and set **Accelerated 2D canvas** to *Disabled*.
Restart the browser afterwards. The report on screen is never affected either
way.

**If your browser cannot export large images.** Some graphics drivers hand large
canvases to the GPU and then fail to read them back, which would make every
exported file empty. The export detects this, measures the largest size your
browser can actually read, and falls back to capturing the report in horizontal
bands that are joined back together when they are saved. You will see a note
saying the export is being tiled; the images are identical either way and
nothing needs to be configured. If you would rather fix it at the source, set
`gfx.canvas.accelerated` to **false** in Firefox's `about:config`, or disable
**Accelerated 2D canvas** in `chrome://flags` for Chromium and Opera, then
restart the browser.

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
