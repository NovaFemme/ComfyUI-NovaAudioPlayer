# Nova Audio Player

**Twenty-eight nodes for making music with ACE-Step in ComfyUI** — generation
parameters, corrective mastering, measurement you can trust, report viewers,
delivery, and LoRA training.

It started as one player node and grew into the parts around it. The through-line
is measurement: every number this pack shows is computed once, in Python, from
the audio you are actually looking at, and the same number is what gets logged.

![A Nova workflow](docs/images/nodes/workflow-overview.png)

---

## Install

**From the Comfy Registry** — the supported route:

```bash
comfy node install comfyui-novaaudioplayer
```

**Or clone it:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer.git
```

Restart ComfyUI. Everything lands under **▶️ Nova Audio** in the node menu.

### Requirements

Two packages are declared and installed with the pack:

| package | needed by | why it is required |
|---|---|---|
| `mutagen` | Nova Tag Writer, Nova Tag Reader | there is no degraded mode — tag work without it is not possible |
| `pymysql` | Nova SQL Dump | pure Python and small; the node reports a clean error if it is missing |

Everything else the pack imports at load time — `torch`, `numpy`, `PIL`, `av` —
already ships with ComfyUI, so **a normal ComfyUI install loads the whole pack
with nothing extra**.

Three things are optional and imported only when used:

- **`scipy`** — used for K-weighting in the LUFS measurement. Without it the
  player still reports loudness with the correct channel summation, but
  unweighted and ungated, so treat the figure as approximate.
- **`transformers`, `demucs`** — Nova Audio Transcribe only. The node fails when
  you run it, not when the pack loads.
- **A separate ACE-Step install** — the four LoRA training nodes drive
  ACE-Step's own trainer. Nothing is installed at runtime.

---

## The nodes

Seven groups under **▶️ Nova Audio**. Screenshots are linked where one exists;
the rest are being filled in.

### 🛠️ Utility & IO

| Node | What it does |
|---|---|
| **Nova Load Audio 🔄** | Loads one file or an `AUDIO` input and returns audio plus `filename`, `sample_rate`, `duration`, `type`, `metadata` and `bit_depth`. Channel mode, start offset and duration are widgets, so trimming happens on load. |
| **Nova Batch Load Audio 🎼** | Walks a folder — filter, recursive, sort, limit — and returns a `files` table, optional decoded audio, a count, filenames and metadata. The front of every batch workflow in this pack. |
| **Nova Console 🖥️** | Prints whatever you wire into it, in the node. The debugging node you end up using constantly. |
| **Nova Memory Probe (RAM/VRAM) 🧠** | Reports host RAM and device VRAM at that point in the graph, with deltas since the probe's previous run. Read-only — it never unloads or frees anything. |
| **Nova NamePath Manager 🧭** | Holds every path a delivery workflow needs in one node and stores the whole set as a named profile. |
| **Nova SQL Dump 🛢️** | Writes a table to MySQL. Storage is a toggle, so the node can sit in a graph switched off. |

![Nova Load Audio](docs/images/nodes/NovaLoadAudio.png)
![Nova Batch Load Audio](docs/images/nodes/NovaBatchLoadAudio.png)
![Nova Console](docs/images/nodes/NovaConsole.png)
![Nova Console showing a memory report](docs/images/nodes/NovaConsole-memory.png)
![Nova NamePath Manager](docs/images/nodes/NovaNamePathManager.png)
![Nova SQL Dump](docs/images/nodes/NovaSQLDump.png)

### 🤖 Generation & Synthesis

| Node | What it does |
|---|---|
| **Madow Inputs 🎚️** | Every ACE-Step generation parameter in one node, with named presets, cross-field validation and a `context` blob that records exactly what produced a take. |
| **Madow Unpack ⚪** | Takes the `madow` bundle and fans it out into 28 typed outputs — the 27 parameters plus `file_path`. |

![Madow Inputs](docs/images/nodes/MadowInputs.png)

[More on how these two split the work →](#madow-inputs-)

### 🎛️ Mastering Process

| Node | What it does |
|---|---|
| **Nova Audio Master 🧾** | Analyses the source and produces a safer mastered version — tonal, stereo and dynamic correction — with a rollback path and a full `report_json`. |
| **Nova Master Identity 🪪** | Turns a mastering report into release and archive identity: what source, what settings, what came out. |

![Nova Audio Master](docs/images/nodes/NovaAudioMaster.png)
![Nova Master Identity](docs/images/nodes/NovaMasterIdentity.png)

### 📊 Analysis & Validation

| Node | What it does |
|---|---|
| **Nova Player 🔊** | The player: twelve live visualisers, a whole-file measurement panel, a theme system, and a `panel_info` output for logging every take. |
| **Nova Track Inspector 🔬** | Analyses the whole track over time and tells you where to listen, against a baseline. |
| **Nova Final Master Validator** | Answers one question: did the file you saved still reproduce the master you approved? |
| **Nova Audio Transcribe 🎙️** | Speech-to-text over an `AUDIO` input, returning `text` and timestamped `json`. |
| **Nova Lyric Score 📊** | Scores a transcript against reference lyrics and returns `score`, `grade`, `report_json` and `report_text`. |

![Nova Player](docs/images/nodes/NovaPlayerNode-waveform.png)

[The player in detail →](#the-player)

### 🗂️ Data Viewers

Read-only nodes that render a report inside the canvas, so you never leave the
graph to read what just happened.

| Node | Renders |
|---|---|
| **Nova Master Report Viewer 📊** | `report_json` from Nova Audio Master |
| **Nova Track Inspector Report 📈** | `inspection_json` from Nova Track Inspector |
| **Nova Lyric Report 📈** | Nova Audio Transcribe + Nova Lyric Score together |

Each has several view modes on one widget.

**Nova Master Report Viewer** — Dashboard, Compare, Mastering Guide, Technical:

![Master report, dashboard](docs/images/nodes/NovaMasterReportViewer-dashboard.png)
![Master report, source vs master](docs/images/nodes/NovaMasterReportViewer-compare.png)
![Master report, mastering guide](docs/images/nodes/NovaMasterReportViewer-guide.png)
![Master report, technical](docs/images/nodes/NovaMasterReportViewer-technical.png)

**Nova Track Inspector Report** — Inspector, Timeline, Markers, Technical:

![Inspector report, score card](docs/images/nodes/NovaTrackInspectorReportViewer-inspector.png)
![Inspector report, timeline](docs/images/nodes/NovaTrackInspectorReportViewer-timeline.png)
![Inspector report, markers](docs/images/nodes/NovaTrackInspectorReportViewer-markers.png)
![Inspector report, technical](docs/images/nodes/NovaTrackInspectorReportViewer-technical.png)

**Nova Lyric Report** — Dashboard, Transcription, and a word-level diff:

![Lyric report, dashboard](docs/images/nodes/NovaLyricReportViewer-dashboard.png)
![Lyric report, transcription](docs/images/nodes/NovaLyricReportViewer-transcription.png)
![Lyric report, diff](docs/images/nodes/NovaLyricReportViewer-diff.png)

### 📦 Delivery & Metadata

| Node | What it does |
|---|---|
| **Save Audio FLAC 24-bit ⬇️** | Writes an `AUDIO` input to FLAC at 24-bit or 16-bit. |
| **Save Audio WAV PCM16\|PCM24\|FLOAT32 ⬇️** | Writes RIFF/WAVE at 16-bit PCM, 24-bit PCM or 32-bit float. |
| **Nova Tag Writer 🏷️** | Writes a table of metadata onto files, with column mapping, skip rules and a dry-run mode that reports without touching anything. |
| **Nova Tag Reader 🔖** | Reads tags off a file list into a console report and `tags_json`. |
| **Nova SQLite Reader 🗃️** | Reads a table out of a SQLite database — columns, `where`, and the option to create a new database. |
| **Nova Reports Images 🖼️** | Renders one selected report view as a fixed portrait image and saves it. |

![Nova Reports Images](docs/images/nodes/NovaReportsImages.png)

### 🎓 LoRA Training

Four nodes that drive ACE-Step's own training pipeline. They need a separate
ACE-Step install; this pack installs nothing at runtime.

| Node | What it does |
|---|---|
| **Nova ACE Dataset Builder 🧱** | Turns a batch of tagged audio into the dataset JSON ACE-Step's preprocessor expects. |
| **Nova ACE Dataset Review 🔍** | Checks a dataset before you spend GPU hours on it. ACE-Step's own docs make manual review mandatory; this is that pass. |
| **Nova ACE Preprocess 🧮** | Runs ACE-Step's two-pass tensor generation over a Nova dataset. |
| **Nova ACE LoRA Trainer 🎓** | Runs ACE-Step's LoRA training loop over those tensors. |

![Nova ACE LoRA Trainer](docs/images/nodes/NovaACELoRATrainer.png)

---

## The player

Drop **Nova Player 🔊** into a workflow and connect any `AUDIO` output.

### Twelve views, one button

Cycle them with the pill in the transport row. Every view is a separate module
and every one is themeable.

| View | | |
|---|---|---|
| **Waveform** | Stereo peak bars with a pulse at the playhead | ![](docs/images/nodes/NovaPlayerNode-waveform.png) |
| **Spectrum / EQ** | Filled spectrum curve with a neon rim | ![](docs/images/nodes/NovaPlayerNode-spectrum.png) |
| **Analyzer** | Goniometer and phase-correlation needle | ![](docs/images/nodes/NovaPlayerNode-analyzer.png) |
| **Spectrogram** | Scrolling heat map, on a real time axis | ![](docs/images/nodes/NovaPlayerNode-spectrogram.png) |
| **Combined** | Waveform, spectrum and spectrogram together | ![](docs/images/nodes/NovaPlayerNode-combined.png) |
| **Peak / RMS** | Level meters with peak hold and decay | ![](docs/images/nodes/NovaPlayerNode-peak-rms.png) |
| **L/R Correlation** | Phase relationship over time | ![](docs/images/nodes/NovaPlayerNode-correlation.png) |
| **Freq %** | Energy split across four contiguous bands | ![](docs/images/nodes/NovaPlayerNode-freq-bands.png) |
| **Combined Suite** | Meters, correlation and bands in one view | ![](docs/images/nodes/NovaPlayerNode-master-suite.png) |
| **FFT Analyzer** | High-resolution spectrum with peak hold | ![](docs/images/nodes/NovaPlayerNode-fft.png) |
| **RTA Analyzer** | 1/3-octave real-time analyser | ![](docs/images/nodes/NovaPlayerNode-rta.png) |
| **APG Meter** | Artifact metrics for tuning generation settings | ![](docs/images/nodes/NovaPlayerNode-apg.png) |

### Loudness, measured properly

The loudness badge is **ITU-R BS.1770-4 integrated LUFS**: K-weighted, summed
across channels rather than averaged, and gated at −70 LUFS absolute and −10 LU
relative.

That is worth stating plainly because an earlier version got it wrong. It
averaged L and R into mono before measuring — a different quantity, 3 dB low for
correlated stereo — and it took the mean square of the whole file instead of
gating. Together those read **3.84 LU low** on the take they were found with:
−17.3 LUFS where `ffmpeg`'s `ebur128` reports −13.5. A number that wrong is worse
than no number, because it is the one a mastering decision gets made against.

The current implementation tracks `ffmpeg` to within 0.05 LU across the test
suite. If `scipy` is unavailable the channel rule still holds, but the figure is
unweighted and ungated — close, not correct.

### An output you can log

The node returns **`panel_info`** — everything in the bench strip as a string,
ready for a display node or a database. The `panel_format` widget picks the
shape: `json` for a parser, `text` for reading, `csv_row` for appending to a
log. It is built from the same numbers the panel draws, so a logged take and the
screen can never disagree.

### It works before you wire anything

Place the node and it is already a player — chrome, transport, view pill, and a
visualiser animating a synthetic signal so you can see what each view does. The
badge row says `no audio connected · press play for a demo`; pressing play runs
a four-second clip through the real analyser, so the first thing you see is a
genuine measurement rather than a mock-up.

Connect an `AUDIO` output and all of it is gone for good. Nothing is fetched or
played until you ask for it.

### Downloads

The download arrow offers **WAV**, **FLAC** and **OGG** — everything
`soundfile` can write, with no external binary involved.

There is deliberately no MP3, M4A, Opus or WebM, and there will not be.

This node measures. Its own SAT row reads `0.0000%` on a 320k MP3 — the figure
does not fail, it quietly stops meaning anything — so a lossy download from the
measurement node would be a file its own panel cannot honestly read. Delivery
formats also have their own home: **Save Audio FLAC 24-bit** and **Save Audio
WAV PCM16|PCM24|FLOAT32** under Delivery & Metadata. The download arrow is for
auditioning what you are measuring, not for shipping it.

If you want an mp3, the WAV is one ffmpeg command away.

### A bench panel that agrees with itself

Click the bar-chart button next to the download arrow. Everything in the strip
is measured **once**, in Python, from the same audio the waveform and the
loudness badge come from — so nothing on screen can disagree with anything else
on screen.

![Bench strip](docs/images/bench-strip.png)

It reports the peak **before** the WAV write clamps it, so a generation that
overshoots full scale tells you so instead of silently arriving pre-clipped.
Band shares are contiguous and always total 100%.

Drag its top edge to make it taller.

### The APG meter

Six artifact metrics — crest, spectral centroid, flux, flatness, clipping and
flat-top saturation — each shown live and integrated over the whole take.

![APG meter](docs/images/nodes/NovaPlayerNode-apg.png)

Click the panel to freeze a reference take. Every row then shows a delta against
it, so you can change one generation setting, render again, and read which way
the audio moved. There is a directional hint line, and it is clearly marked as a
hypothesis rather than a measurement.

[Full explanation of what each metric means and where the numbers came from →](docs/design/07-apg-artifact-meter.md)

### Themes, and a settings drawer that stays out of your way

Click the gear. You get colours for the view you are currently looking at, that
view's own settings, and the shared player chrome — not a wall of every colour in
the node.

![Theme editor](docs/images/nodes/NovaPlayerNode-themes.png)

Everything autosaves. The only save button is for themes.

**Edits: This node / Theme.** Colour changes can stay with this one player
(saved in your workflow) or be written to the theme on disk for every player
using it. There is a button to promote node changes to the theme when you like
what you have.

**Text size** and **bar relief** sliders live with the theme controls. Both are
display preferences rather than theme content, so switching theme does not
change them.

---

## Tips

- **Working on a 1440p or 4K display?** Turn up **Text size** in the settings
  drawer. The defaults were chosen against 1080p.
- **Bars look flat?** **Bar relief** controls the 3D shading. The lighting is
  derived from each bar's own colour, so it works with any theme you make.
- **Want the SAT metric to mean anything?** Point the player at FLAC output, not
  MP3. Lossy encoding smooths away the flat tops it detects.
- **Comparing takes with the APG meter?** Keep `fft_size` the same between them.
  The bin count shifts flatness and centroid.
- **Node too small?** Opening the bench strip raises the minimum height. Drag the
  node bigger, or close the strip.
- **Measuring loudness for a release?** Check `scipy` is installed. Without it
  the badge is approximate, and the node does not hide that.

---

## Madow Inputs 🎚️

Every ACE-Step generation parameter in one place, with named presets and a
`context` output that carries the exact parameters into the player's
`panel_info`.

- **27 parameters**, namespaced so the two `cfg`-shaped parameters cannot collide
  — `ksampler.cfg` is the sampler's, `text.cfg_scale` is the text encoder's.
- **Presets** as one JSON file each under `presets/`, so they are shareable,
  git-trackable and hand-editable. Loading one writes the real widgets; the
  backend never substitutes values, or the saved workflow would record a preset
  name without recording what actually ran.
- **ACE-Step's own domains** for `timesignature`, `language` and `keyscale`.
  Those three are combo inputs on `ACEStep15XLTextEncode`, so they are combo
  widgets here too, with the option lists read from that node when it is
  installed. Typed as plain strings they would not connect to it, and the
  values a human writes — `4`, `english`, an empty key — are not values it
  accepts. Presets written before this are migrated on load (`4` → `"4"`,
  `english` → `en`) and anything unreadable falls back to the default with a
  note rather than silently.
- **Cross-field validation**, warn-only. A caption saying `98 BPM` against a bpm
  widget of 122 is a live conflict ACE-Step reads both sides of.
- **`context`** carries both a seed-excluded and a seed-included hash: the first
  groups runs that differ only by seed, which is the seed-noise-floor question.
- **Output naming**: `file_prefix`, `file_name`, `file_folder` and
  `file_separator` are outputs in their own right, plus a derived `file_path`
  that assembles them as `folder/prefix<separator>name`. Empty fields collapse,
  so nothing carries a dangling separator or a leading slash. The naming fields
  are saved in presets but excluded from both hashes — renaming a file does not
  change the audio, and hashing it would split two identical renders into
  different groups.

### Two nodes, on purpose

**Madow Inputs** holds the widgets and emits four slots: `madow`, `file_path`,
`context`, `validation`. **Madow Unpack ⚪** takes the `madow` bundle and fans it
out into 28 typed outputs — the 27 parameters plus `file_path`.

The split falls where the data stops being interdependent — the hashes,
`preset_dirty`, validation and `context` all need every parameter at once, so
they stay with the widgets that produce them and nothing has to be merged back.

Two things it buys: the fan-out is optional, so wiring a couple of parameters
by hand means not placing Unpack at all; and it is repeatable, so you can put
one beside KSampler and another beside the text encoder rather than running
twenty wires across the graph.

Wire `context` into the player's optional `context` input and every measured
take records what produced it.

---

## Workflows and LoRAs

Three ready-to-run workflows live in
**[`example_workflows/`](example_workflows/)**. Two generate music with ACE-Step
1.5 XL SFT — prompt and lyrics in, measured audio out, built around Madow Inputs
and Nova Player, with the subgraphs embedded so nothing else needs importing.
The third is a **mastering chain**: load a track, master it, read the report in
the canvas, save it, and then verify the saved file still reproduces the master
you approved. That one needs no models and no other custom node pack.

The **Southern Blues Rock** LoRA that the second workflow uses is published as a
[release asset](https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer/releases/tag/assets-v1)
rather than committed here — 80 MiB in the git history would be downloaded by
everyone cloning the repository, forever.
[Direct download (80.1 MiB) →](https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer/releases/download/assets-v1/Southern_Blues_Rock.safetensors)

[Model downloads, install paths and the LoRA's checksum →](example_workflows/README.md)

More workflows and LoRAs will be added over time.

---

## Documentation

Per-node help is built in: right-click any node and choose **Help**.

| Document | What is in it |
|---|---|
| **[TECHNICAL.md](docs/TECHNICAL.md)** | Architecture, the renderer contract, adding your own view, colour roles, HTTP endpoints, the analyser data trap, local development |
| **[Design notes](docs/design/)** | Every significant decision, every bug found, and the reasoning behind each fix |

If you are here to **add a visualiser**, start with
[TECHNICAL.md § Adding a view mode](docs/TECHNICAL.md#adding-a-view-mode) and
copy `web/renderers/_template.js`. Adding one is a new file plus two lines in
`registry.js` — the pill, its width, the cycle order, the minimum node size and
its settings-panel section all follow automatically.

---

## Credits

Built by NovaFemme, with engineering assistance from Claude (Anthropic).

## Licence

MIT © NovaFemme
