# ComfyUI-NovaAudioMaster

A reusable mastering helper node for generated music in ComfyUI.

## What it does

`Nova Audio Master 🎚️` accepts ComfyUI `AUDIO`, analyses the track, and can apply:

- high-pass filtering
- restrained spectral correction
- bass / low-mid / mid / presence / air EQ
- stereo width control
- mono-compatible low end
- gentle crest-factor reduction
- RMS-oriented gain staging
- final peak limiting
- before/after mastering report

It provides:

1. `mastered_audio`
2. `original_audio` for A/B comparison
3. `report`

## Modes

### Auto
Analyses the source and derives bounded corrections from the selected profile.

### Assist
Combines automatic recommendations with your manual EQ settings.

### Manual
Uses your EQ and width settings directly. Automatic crest reduction is skipped.

## Profiles

- Metal
- EDM-Trance
- K-Pop
- Balanced

The profiles are intentionally conservative. They are not meant to force every song into the same tonal balance.

## Recommended starting settings

For your generated metal material:

- Mode: `Auto`
- Profile: `Metal`
- Strength: `70%`
- Target Peak: `-1.0 dBFS`
- Target RMS: `-12.0 dBFS`
- Target Crest: `9.0 dB`
- High Pass: `30 Hz`
- Stereo Width: `100%`
- Mono Below: `120 Hz`

Then audition the result and adjust `Strength`.

## Installation

Clone or copy this folder into:

```text
ComfyUI/custom_nodes/ComfyUI-NovaAudioMaster
```

Example:

```bash
cd ~/ComfyUI/custom_nodes
git clone <your-repository-url> ComfyUI-NovaAudioMaster
```

Restart ComfyUI.

The node appears under:

```text
Nova / Audio / Nova Audio Master 🎚️
```

## Suggested workflow

```text
ACE-Step AUDIO
      |
      v
Nova Audio Master
      |
      +---- mastered_audio ---> Nova Audio Player ---> Save Audio
      |
      +---- original_audio ----> optional second Nova Audio Player
      |
      +---- report ------------> text preview/display node
```

## Design notes

This first version deliberately avoids external DSP dependencies and uses PyTorch,
which ComfyUI already provides. That makes installation simple.

The processing is deliberately bounded. Auto mode is intended as a safe starting
point, not a substitute for listening.

## Important

The node currently targets peak/RMS/crest and spectral balance. It does not yet
implement a standards-compliant ITU-R BS.1770 / EBU R128 LUFS meter.

A future version can add:

- proper integrated LUFS
- true-peak oversampling
- multiband dynamic EQ
- transient preservation
- section-aware mastering
- profile presets saved to JSON
- direct Nova Player metadata integration
