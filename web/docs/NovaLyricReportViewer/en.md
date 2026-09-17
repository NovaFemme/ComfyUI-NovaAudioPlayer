# Nova Lyric Report

Renders `lyric_report_json` from the lyric scoring chain as a visual report, in
the node. It reads; it changes nothing.

## Exporting every view as an image

**Right-click this node → Export views → images.** The count in the menu is the
number of files you will get.

It renders each view in turn — all three of this viewer's, since it has no
**Technical** view, the one view the export always skips as a raw data dump
that is pointless as a picture — and saves them to
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

## Changing the view does not re-run your workflow

Changing `view_mode`, `theme` or `font_scale` redraws from the cached report
locally — it does not queue transcription, scoring or anything upstream.
**Apply View** is an explicit local refresh, not a re-run.

## Views

| View | For |
|---|---|
| **Dashboard** | the fast read — score, headline counts, where the lyric and the audio disagree |
| **Transcription** | what was actually heard, line by line |
| **Lyric Report** | the written lyric against the transcription, aligned |

## Inputs

| Field | Required | Notes |
|---|---|---|
| `lyric_report_json` | yes | Wired from the lyric scorer. |
| `view_mode` | — | Dashboard, Transcription or Lyric Report. |
| `theme` | — | Nova Dark, High Contrast or Studio Slate. |
| `font_scale` | — | 0.75–1.5. Affects the node only, not the export. |
| `transcription_json` | optional | Adds the heard text where the report alone does not carry it. |
| `inspection_json` | optional | Lets the report line up lyric events against track markers. |

## Reading it honestly

A low score is as often a transcription failure as a singing failure — a
transcriber mishears a growled or heavily processed vocal far more readily than
a clean one. Before treating a score as a verdict on the take, open
**Transcription** and see whether the words it heard resemble the words that
were sung. If they do not, the score is telling you about the transcriber.

---
