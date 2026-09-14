# Nova Reports Images

Renders one selected report view as a fixed portrait image and saves it.

Pillow-based: no browser, no headless renderer, no subprocess. It is independent
of the interactive viewers, so an exported image does not depend on a viewer
being open or on what view it happens to be showing.

## One node per view

Each instance renders **one** view to **one** file. Two views means two nodes.
That is the design, not a limitation to work around.

## Inputs

`report_json` — the JSON belonging to the view you picked. Mastering views want
Nova Audio Master's `report_json`; inspector views want Nova Track Inspector's
`inspection_json`.

`view_type` — Mastering Report, Source → Master Comparison, Nova Lyric Report,
Nova Lyric Score, Track Inspector Overview, Track Inspector Graphs.

`theme` — Nova Dark, Studio Slate, High Contrast.

`canvas_preset` — Portrait 1200×1600, Portrait HD 1440×1920, Tall Portrait
1440×2160.

`image_format` — PNG or JPG. `output_subfolder` defaults to
`NovaAudioMasters/ReportImages`.

## `text_reference`, and the overwrite trap

A short run, song or generation reference that goes into the filename:

    High_Water_Track06_Run0042_Mastering_Report.png
    High_Water_Track06_Run0042_Track_Inspector_Overview.png

The filename is the sanitised reference plus the view name, and nothing else.
**So a batch of generations sharing one `text_reference` overwrites itself,
quietly, leaving the last one.** Give each run a unique reference — the run
number is the obvious thing to put in it.

## Outputs

`report_image` is a normal ComfyUI IMAGE, so it can go to Preview Image or into
any image branch. `saved_path` is the full path of the file written.
