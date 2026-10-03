# Nova Player 🔊 — User Guide

A step-by-step guide to the Nova Player node: playing audio, reading the
displays, changing how it looks, and recording your own visual shows.

You don't need to know anything about audio measurement to use it. If you
only want something good to look at while your music plays, skip to
[Halo](#7-halo-the-view-made-for-watching) and
[Sequences](#8-sequences-record-a-show-then-sit-back).

**Contents**

1. [Install](#1-install)
2. [Your first minute](#2-your-first-minute)
3. [The controls](#3-the-controls)
4. [The views](#4-the-views)
5. [Loudness, the bench strip and downloads](#5-loudness-the-bench-strip-and-downloads)
6. [The settings drawer](#6-the-settings-drawer)
7. [Halo: the view made for watching](#7-halo-the-view-made-for-watching)
8. [Sequences: record a show, then sit back](#8-sequences-record-a-show-then-sit-back)
9. [Tips](#9-tips)
10. [If you get stuck](#10-if-you-get-stuck)

---

## 1. Install

**From the Comfy Registry (recommended):**

```bash
comfy node install comfyui-novaaudioplayer
```

**Or with git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer.git
```

Then **restart ComfyUI** and refresh your browser. The node is in the node menu
under **▶️ Nova Audio → Nova Player 🔊**.

---

## 2. Your first minute

1. **Add the node.** Double-click the canvas, type `Nova Player`, press Enter.
   It is already a working player: before you connect anything it shows a
   demo signal, so you can see what each view does.
2. **Connect audio.** Drag any `AUDIO` output (a loader, a generator, a
   mastering node) into the player's `audio` input.
3. **Run the workflow.** The player loads the result and shows its waveform.
4. **Press play.** That's the round button in the middle of the bottom row.
5. **Change the view.** Click the coloured pill (it says `WAVEFORM`) to step
   through the thirteen views.
6. **Make it bigger.** Drag the node's corner. The player fills the node.

Nothing plays until you press play.

---

## 3. The controls

![The player's controls, numbered](images/guide/player-controls.png)

| # | Control | What it does |
|---|---|---|
| 1 | **Speaker** | Mute and unmute |
| 2 | **Volume** | Drag to set the volume |
| 3 | **Back** | Jump back 10 seconds |
| 4 | **Play / Pause** | Start and stop playback |
| 5 | **Forward** | Jump forward 10 seconds |
| 6 | **Loop** | Repeat the track when it ends |
| 7 | **View pill** | Click to switch to the next view |
| 8 | **Bench** | Show or hide the measurement strip |
| 9 | **Download** | Save the audio as WAV, FLAC or OGG |
| 10 | **Settings** | Open the settings drawer |

Also:

- **The long bar above the buttons** is the position in the track. Click or drag
  it to move to another point.
- **In the Waveform view**, clicking the waveform also jumps there.
- **The top-left line** shows the sample rate, mono or stereo, and loudness.
- **Rest the pointer on any button** for a hint saying what it does.

---

## 4. The views

Click the view pill to step through them. The settings drawer follows the view
you're on.

| View | What you see | |
|---|---|---|
| **Waveform** | The whole track as bars, with the playhead | ![](images/nodes/NovaPlayerNode-waveform.png) |
| **Spectrum / EQ** | Which frequencies are sounding right now | ![](images/nodes/NovaPlayerNode-spectrum.png) |
| **Analyzer** | Stereo width and phase | ![](images/nodes/NovaPlayerNode-analyzer.png) |
| **Spectrogram** | Frequencies over time, as a scrolling heat map | ![](images/nodes/NovaPlayerNode-spectrogram.png) |
| **Combined** | Waveform, spectrum and spectrogram together | ![](images/nodes/NovaPlayerNode-combined.png) |
| **Peak / RMS** | Level meters | ![](images/nodes/NovaPlayerNode-peak-rms.png) |
| **L/R Correlation** | How alike the left and right channels are | ![](images/nodes/NovaPlayerNode-correlation.png) |
| **Freq %** | How the energy divides into bass, mids, presence and highs | ![](images/nodes/NovaPlayerNode-freq-bands.png) |
| **Combined Suite** | Meters, correlation and bands in one | ![](images/nodes/NovaPlayerNode-master-suite.png) |
| **FFT Analyzer** | A detailed spectrum with peak hold | ![](images/nodes/NovaPlayerNode-fft.png) |
| **RTA Analyzer** | The spectrum in third-octave bars | ![](images/nodes/NovaPlayerNode-rta.png) |
| **APG Meter** | Artifact measurements for tuning AI generation | ![](images/nodes/NovaPlayerNode-apg.png) |
| **Halo** | A glowing ring that moves with the music. Purely for looks | ![](images/guide/halo.png) |

Twelve of these are measurement views. **Halo** is different: it's made to be
watched, and it's the one with [sequences](#8-sequences-record-a-show-then-sit-back).

---

## 5. Loudness, the bench strip and downloads

**Loudness.** The `LUFS` figure at the top left is the track's overall
loudness, measured the standard way (ITU-R BS.1770). Streaming services aim for
roughly −14 LUFS.

**The bench strip.** Click the bar-chart button (8) to open a strip of
measurements for the whole file: peak level, loudness, clipping, stereo
correlation and the share of energy in each frequency band. Drag its top edge
to make it taller.

![The bench strip](images/bench-strip.png)

**Downloads.** Click the arrow (9) and choose **WAV**, **FLAC** or **OGG**.
There's no MP3 on purpose: this node is for checking audio, and lossy files
make some of its measurements meaningless. For final delivery, use the pack's
**Save Audio** nodes.

**Sending the numbers elsewhere.** The node's `panel_info` output carries the
bench strip's figures as text. Set `panel_format` to `json`, `text` or
`csv_row` and connect it to a display or logging node.

---

## 6. The settings drawer

Click the gear (10). A drawer opens on the right, showing settings for **the
view you're looking at**. Switch views and the drawer follows.

![The settings drawer](images/guide/drawer-settings.png)

**Good to know first**

- **Everything applies instantly.** There's no save button for settings.
- **Drag the drawer's left edge** to make it wider.
- **One section is open at a time.** Click a heading to open it.
- **Double-click a slider** to put that setting back to its default.

### The sections

| Section | What's in it |
|---|---|
| **⟨View⟩ · Settings** | Sliders and switches for the current view |
| **⟨View⟩ · Sequences** | Record and replay (decorative views only, see section 8) |
| **⟨View⟩ · Colours** | Every colour the current view uses |
| **Player chrome · Colours** | Colours of the buttons, bars and text around the view |
| **Display** | Text size, bar relief and control hints |

### Colours

![Colour settings](images/guide/drawer-colours.png)

Click a colour square to pick a new colour. The small slider beside it sets how
see-through that colour is.

### "This node" or "Theme"?

The **Edits** switch at the top decides where your changes go:

- **This node:** the change belongs to this one player and is saved in your
  workflow. Two players can look different.
- **Theme:** the change is written to the theme, and every player using that
  theme picks it up.

A setting this node has changed is marked with a coloured bar beside its name.
**Reset node** (bottom right) clears all of this node's own changes.

### Themes

- Pick a theme from the dropdown at the top.
- **New** makes a fresh theme. **Save as** saves the current look under a new
  name. **✕** deletes the selected theme.

### Display

![Display settings](images/guide/drawer-display.png)

- **Text size:** makes all text and the drawer's controls bigger. Turn it up on
  a 1440p or 4K screen.
- **Bar relief:** how 3D the bars look in the meter views.
- **Control hints:** turns the hover hints on the buttons on or off.

---

## 7. Halo: the view made for watching

Click the view pill until it says **HALO**. A ring of spikes pulses with the
music, with bubbles drifting through it.

![Halo](images/guide/halo.png)

Open the drawer (the gear) to shape it. The settings, in the order they appear:

**How it reacts to the music**

| Setting | What it does |
|---|---|
| **Intensity** | How strongly the spikes react |
| **Noise floor** | Ignores quiet sound below this level |
| **High boost** | Gives the high notes more movement |
| **Even out** | Makes every part of the ring move, even where the music is quiet. Turn it up if part of the ring sits still |
| **Release** | How slowly spikes fall back after a hit |

**The spikes**

| Setting | What it does |
|---|---|
| **Streaks** | How many spikes |
| **Streak length** | How long they grow |
| **Spike width** | How thick they are |
| **Softness** | Blends the spikes into a soft glow |
| **Gradient** | Blends each spike toward the "tip" colour along its length |

**The ring**

| Setting | What it does |
|---|---|
| **Ring size** | How big the ring is |
| **Ellipse width** | Round (low) or wide (high) |
| **Fit to view width** | Stretches the ring to suit a wide node |
| **Tilt** | Leans the ring from flat (0) to upright (90) |

**Movement**

| Setting | What it does |
|---|---|
| **Motion** | **Spin**: the spikes travel around the ring. **Rotate (3D)**: the ring turns in space. **Spin + rotate**: both. **Off**: neither |
| **Spin speed** | How fast the spikes travel. Negative reverses the direction |
| **Rotate speed** | How fast the ring turns |
| **3D depth** | How solid the turning ring looks. 0 is a flat disc |
| **Beat pulse** | How much the ring swells with the beat |
| **Pulse intensity** | Turns up everything that reacts to loudness |
| **Core glow** | The soft glow around the ring's bright line |

**Bubbles**

| Setting | What it does |
|---|---|
| **Bubbles** | How many. 0 turns them off |
| **Bubble size** | How big |
| **Bubble softness** | Crisp rings (0) or soft glowing bubbles (1) |

**Colours.** Open **Halo · Colours** to set the background, the ring, the four
bubble colours and the spikes: quiet, mid and loud spikes each have a colour,
plus the tip colour that **Gradient** blends toward.

---

## 8. Sequences: record a show, then sit back

A sequence is a recording of you changing the settings. Play it back and the
view performs those changes again, with the same timing, while the music plays.
It works like recording a macro.

Sequences are available on decorative views. Today that's **Halo**.

### Record one

![The Sequences section](images/guide/drawer-sequences.png)

1. Switch to **Halo** and open the drawer.
2. Open the **Halo · Sequences** section.
3. Click **● Record new…** and type a name, for example `Spinning Fury Master`.
4. Click **Start**. The settings section opens for you.
5. **Play with the settings.** Change speeds, tilt, bubble size, anything in
   the settings list. The pauses between your changes are recorded too.
6. Go back to the Sequences section and click **■ Stop & save**.

![Recording in progress](images/guide/drawer-recording.png)

Your sequence is saved under the name you chose and appears in the list.

> **Take your time.** The recording clock follows the song. If you need to
> think, **pause the music**. Time spent paused isn't recorded, so you won't
> end up with long dead gaps. Press play again when you're ready.

### Play one

1. Pick a sequence from the list.
2. Choose how long it runs: leave **loop** on to repeat it until you stop it,
   or switch loop off and set **Play ⟨n⟩ time(s)**.
3. Click **▶ Play**. Click **■ Stop** to end it.

While it plays:

- **Your own settings are safe.** When the sequence stops, the view goes back
  to exactly how you left it.
- **The sliders move** along with the sequence, so you can see what it's doing.
- **Pausing the music pauses the sequence.** It carries on from the same spot.
- **Touching any setting stops the sequence** and hands control back to you.

### Delete one

![Delete confirmation](images/guide/drawer-delete.png)

Pick it in the list, click **🗑**, and answer **Are you sure?** with **Delete**
or **Keep**.

### Where the files are, and sharing them

Each sequence is one small file here:

```
ComfyUI/user/nova_player/sequences/halo/<name>.json
```

The drawer shows this path under the Record button.

- **Back up** that folder to keep your sequences.
- **Share** a sequence by sending someone the file.
- **Add** someone else's by copying their file into the folder. Switch to
  another view and back to Halo, and it appears in the list.

If a file contains a setting your version doesn't have, or a value that's out
of range, that one setting is skipped and the rest plays normally. The drawer
tells you how many settings it ignored.

---

## 9. Tips

- **Big screen?** Turn up **Text size** under **Display**.
- **Drawer feels cramped?** Drag its left edge to widen it.
- **Went too far with a slider?** Double-click it to reset it.
- **Want two different looks?** Keep **Edits** on **This node** and style each
  player separately.
- **Node too small after opening the bench strip?** Drag the node taller, or
  close the strip.
- **For a relaxed Halo:** low Spin speed, Softness near 1, Bubble softness near
  1. **For an energetic one:** raise Pulse intensity and Beat pulse, and set
  Motion to Spin + rotate.

---

## 10. If you get stuck

Try these first. They fix most problems:

1. **Hard-refresh the browser** (Ctrl+Shift+R, or Cmd+Shift+R on a Mac).
2. **Restart ComfyUI**, then refresh the browser.
3. **Update the pack** to the latest version.

### Common problems

| What you see | What to do |
|---|---|
| **The node isn't in the menu** | Restart ComfyUI after installing, then refresh the browser. Look under **▶️ Nova Audio** |
| **"PLAY TO ACTIVATE" in the view** | Press play. The moving views need the music running |
| **No sound** | Check the speaker isn't muted (1) and the volume is up (2). Check your browser tab isn't muted |
| **The player is tiny, off-centre or cut off inside the node** | Update the pack and hard-refresh. This was a bug with ComfyUI's Nodes 2.0 and is fixed |
| **A new node has no player in it** | Same as above: update and hard-refresh, then add a fresh node |
| **I can't move or select the node** | Drag it by its **title bar**. Clicks on the player itself control the player. If the node fills the screen, zoom out with the mouse wheel first |
| **Part of the Halo ring doesn't move** | Turn up **Even out** and **High boost** |
| **Halo looks too busy or too bright** | Lower **Intensity** and **Pulse intensity**. Raise **Softness** |
| **There's no Sequences section** | Sequences are only on decorative views. Switch to **Halo** |
| **Recording or the sequence list shows an error** | Restart ComfyUI (a full restart, not only a browser refresh) |
| **My sequence file isn't in the list** | Check it's in `ComfyUI/user/nova_player/sequences/halo/` and ends in `.json`. Switch to another view and back |
| **"Ignoring N unusable settings"** | Normal for a file from a different version. The rest of the sequence still plays |
| **A sequence stopped by itself** | You changed a setting, which hands control back to you. Or it reached the end with loop off |
| **Nothing was recorded** | Only changes in the **Settings** section are recorded. Colour changes aren't |
| **The recording has long gaps** | Pause the music while you think. Paused time isn't recorded |
| **Text and controls are too small** | **Display → Text size** |
| **I've made a mess of the look** | Click **Reset node** at the bottom of the drawer |
| **The loudness figure seems off** | Without the optional `scipy` package the figure is approximate. Install `scipy` for the exact one |

### Still stuck?

Open an issue here:
<https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer/issues>

It helps a lot if you include:

- your **ComfyUI version**, and whether **Nodes 2.0** is on
- your **browser** and operating system
- a **screenshot** of the node
- what you **did**, what you **expected**, and what **happened**
- any **red text** from the browser console (press F12, open the **Console**
  tab) and from the ComfyUI terminal window
