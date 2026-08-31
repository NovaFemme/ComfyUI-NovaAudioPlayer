# Nova Audio Player

An audio player node for ComfyUI with fourteen live visualisers, a whole-file
measurement panel, and a theme system you can drive from inside the node.

Built for listening to what a generation actually produced — not just playing it
back.

<!-- Replace with a screenshot of the node in your own workflow -->
![Nova Audio Player](docs/images/waveform.png)

---

## Install

Clone into your ComfyUI custom nodes folder and restart:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR-USERNAME/ComfyUI-NovaAudioPlayer.git
```

No dependencies beyond what ComfyUI already ships. `scipy` is used for accurate
LUFS if present, and the node falls back to plain RMS if it is not.

Drop the **Nova Player ▶️** node into a workflow and connect any `AUDIO` output.

---

## What you get

### Fourteen views, one button

Cycle them with the pill in the transport row. Every view is a separate module
and every one is themeable.

| | |
|---|---|
| **Waveform** | Stereo peak bars with a pulse at the playhead |
| **Spectrum / EQ** | Filled spectrum curve with a neon rim |
| **Analyzer** | Goniometer and phase-correlation needle |
| **Spectrogram** | Scrolling heat map, on a real time axis |
| **Combined** | Waveform, spectrum and spectrogram together |
| **Peak / RMS** | Level meters with peak hold and decay |
| **L/R Correlation** | Phase relationship over time |
| **Freq %** | Energy split across four contiguous bands |
| **Combined Suite** | Meters, correlation and bands in one view |
| **FFT Analyzer** | High-resolution spectrum with peak hold |
| **RTA Analyzer** | 1/3-octave real-time analyser |
| **APG Meter** | Artifact metrics for tuning generation settings |

![Frequency bands](docs/images/freq-bands.png)

<!-- Add your own screenshots here — one per view you want to show off -->

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

![APG meter](docs/images/apg-meter.png)

Click the panel to freeze a reference take. Every row then shows a delta against
it, so you can change one generation setting, render again, and read which way
the audio moved. There is a directional hint line, and it is clearly marked as a
hypothesis rather than a measurement.

[Full explanation of what each metric means and where the numbers came from →](docs/design/07-apg-artifact-meter.md)

### Themes, and a settings drawer that stays out of your way

Click the gear. You get colours for the view you are currently looking at, that
view's own settings, and the shared player chrome — not a wall of every colour in
the node.

![Settings panel](docs/images/settings-panel.png)

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

---

## Documentation

| Document | What is in it |
|---|---|
| **[TECHNICAL.md](docs/TECHNICAL.md)** | Architecture, the renderer contract, adding your own view, colour roles, HTTP endpoints, the analyser data trap, local development |
| **[Design notes](docs/design/)** | Ten documents covering every significant decision, every bug found, and the reasoning behind each fix |

If you are here to **add a visualiser**, start with
[TECHNICAL.md § Adding a view mode](docs/TECHNICAL.md#adding-a-view-mode) and
copy `web/renderers/_template.js`. Adding one is a new file plus two lines in
`registry.js` — the pill, its width, the cycle order, the minimum node size and
its settings-panel section all follow automatically.

---

## Credits

Built by ANovaFemme, with engineering assistance from Claude (Anthropic).

## Licence

MIT © NovaFemme

