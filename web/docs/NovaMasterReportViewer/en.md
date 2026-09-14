# Nova Master Report Viewer

Renders `report_json` from **Nova Audio Master** as a visual report, in the node.
It reads; it changes nothing.

## Changing the view does not re-run your workflow

This is the part that matters in a big graph. Changing `view_mode`, `theme` or
`font_scale` **redraws from the cached report locally** — it does not queue
generation, mastering or anything else. **Apply View**, which sits above
`view_mode`, is an explicit local refresh, not a re-run.

If a view change ever does queue the flow, you are on an older build.

## Views

| View | For |
|---|---|
| **Dashboard** | the fast read — release grade, confidence, headline measurements |
| **Compare** | source against master. The one to open when you want to know what Nova actually changed |
| **Mastering Guide** | the process in phases: source assessment, tonal, stereo, dynamics/crest, loudness/limiting, final validation, export |
| **Detailed** | the full report |
| **Compact** | a smaller summary |
| **Technical** | report-oriented data |

`show_source`, `show_processing`, `show_validation` and `show_release` toggle
sections within whichever view is open.

## Reading a grade honestly

A mastering grade describes **mastering and release measurements**. It says the
processing was safe and the delivery is sound. It says nothing about whether the
music is any good — for that, use the Track Inspector for where to listen, and
then listen.

A `CONDITIONAL_PASS` here is not a defect. See the Nova Audio Master page.

## After reloading a workflow

The viewer restores the widget values currently saved in the workflow rather
than replaying stale values from the previous backend execution. If a reopened
workflow shows the wrong view, you are on an older build.
