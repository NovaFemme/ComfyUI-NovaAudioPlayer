# Madow Inputs 🎚️

Every ACE-Step generation parameter in one node, so a run can be set up in one
place and — more to the point — **recorded**. Parameters normally live scattered
across four nodes, which means nothing downstream knows what produced the audio
it is measuring. `context` closes that gap.

## Outputs

| | |
|---|---|
| **`madow`** | the parameter bundle. Feed it to **Madow Unpack ⚪** to get typed sockets, or leave it unconnected if you are wiring by hand |
| **`file_path`** | `folder/prefix<separator>name`, assembled from the four naming fields. Empty fields collapse, so nothing carries a dangling separator |
| **`context`** | JSON: every parameter, two hashes, the preset it came from and whether the widgets have drifted from it. Wire it into Nova Player's `context` input, or straight to a database node |
| **`validation`** | warnings, newline-separated. Empty when there is nothing to say |

## The parameters

27 of them, namespaced. The namespacing is not decoration: `ksampler.cfg` and
`text.cfg_scale` are different parameters at different stages of the same
generation, and flattened to `cfg` they collide silently.

**`timesignature`, `language` and `keyscale`** are dropdowns, and their options
come from `ACEStep15XLTextEncode` itself when that pack is installed. They have
to: those are combo inputs on the encoder, so a plain string neither connects to
them nor carries a value they accept — it wants `"4"`, not `4`, and `en`, not
`english`.

**`seed`** carries ComfyUI's own fixed / increment / decrement / randomize
control. Set it to *randomize* to sweep, *fixed* to reproduce. Whichever it is,
`context` records the number the run actually used, so a take you liked can be
reproduced by switching to fixed and typing that number back.

## Presets

One JSON file per preset under `presets/`, so they are shareable, git-trackable
and editable in a text editor. **Save as** writes the current widgets; picking a
name loads it.

`seed` is excluded by default — a preset describes a sound, not a particular
roll of the dice — and the four naming fields are excluded from both hashes for
the same reason: renaming a file does not change the audio.

Loading a preset writes the **real widgets**. The backend never substitutes
values at execution time; if it did, the saved workflow would record a preset
name without recording what actually ran, and every logged row would be a lie.

Presets written before `timesignature`, `language` and `keyscale` became
dropdowns are migrated as they load — `4` → `"4"`, `english` → `en` — and a
value with no sane reading falls back to the default with a note in the log.

## The two hashes

`context` carries `params_sha256` and `params_seeded_sha256`. The first excludes
the seed, so runs that differ **only** by seed group together — which is the
seed-noise-floor question, and the one you cannot ask if the seed is baked into
the identity. The second includes it and identifies exactly one run.

`preset_dirty` says whether the widgets still match the preset they came from.

## Validation

Warn-only, never blocking. The rule that pays for the node is the BPM one: a
caption saying `98 BPM` against a bpm widget of 122 is a live conflict, because
ACE-Step reads both sides. Also checked: key conflicts between caption and
`keyscale`, duration against the latent's `seconds` when it is wired in, vocals
requested with an empty lyrics field, more than one truncation method active at
once, and `apg.eta` above 1.0.

Nothing here is a hard stop. A warning is a question, not a refusal.
