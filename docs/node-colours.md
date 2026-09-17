# Node colours

Every node in this pack carries a default colour chosen by **the role it plays
in a flow**. Applied by `web/nova_node_colours.js` at node registration.

## Why role and not menu category

Several templates draw every node from one sub-category. The Tag Writer
template is entirely Delivery & Metadata; colouring by menu would render it as
one flat colour and tell the reader nothing. Role is the distinction the eye is
looking for — where does the audio come in, what changes it, what writes to
disk — so that is what the colour carries.

## The scheme

Colours are the nine LiteGraph offers under **right-click → Colors**
(`LGraphCanvas.node_colors`), so a node coloured here is indistinguishable from
one coloured by hand, and the palette stays consistent with core ComfyUI nodes.

| Colour | Role | Nodes |
|---|---|---|
| `green` | Input & Load | Nova Load Audio · Nova Batch Load Audio · Nova ACE Dataset Builder |
| `brown` | Data & Catalogue | Nova SQLite Reader · Nova Tag Reader · Nova SQL Dump |
| `purple` | Generation | Madow Inputs · Madow Unpack · Nova ACE LoRA Trainer |
| `blue` | Process | Nova Audio Master · Nova ACE Preprocess |
| `yellow` | Identity & Provenance | Nova Master Identity |
| `cyan` | Analysis & Validation | Nova Final Master Validator · Nova Track Inspector · Nova Audio Transcribe · Nova Lyric Score · Nova ACE Dataset Review · Nova ACE Setup Check · Nova Memory Probe |
| `red` | Writes to disk | Save Audio WAV · Save Audio FLAC 24-bit · Nova Tag Writer |
| `pale_blue` | View & Report | Nova Master Report Viewer · Nova Lyric Report · Nova Track Inspector Report · Nova Player · Nova Console |
| `black` | Plumbing | Nova NamePath Manager |

28 of 28 nodes.

### Hex values

| name | title bar | body | group |
|---|---|---|---|
| red | `#322` | `#533` | `#A88` |
| brown | `#332922` | `#593930` | `#b06634` |
| green | `#232` | `#353` | `#8A8` |
| blue | `#223` | `#335` | `#88A` |
| pale_blue | `#2a363b` | `#3f5159` | `#3f789e` |
| cyan | `#233` | `#355` | `#8AA` |
| purple | `#323` | `#535` | `#a1309b` |
| yellow | `#432` | `#653` | `#b58b2a` |
| black | `#222` | `#000` | `#444` |

Group boxes take the **group** column of the same entry, so a group sits behind
its nodes without competing with them.

## Two choices that are not obvious

**Nova Tag Writer is red, not brown.** It reads like a database node, and it is
fed by one, but it edits your audio files **in place**. That is the same class
of act as a save, and the colour should say so before the run rather than after.

**Nova Master Identity has yellow to itself.** One node, one colour — it is the
hinge of the provenance chain, sitting between the blue master and the cyan
validator, and it earns the separation.

## What a flow looks like

```
Mastering   green -> blue -> brown -> yellow -> cyan -> red -> pale_blue
Tag Writer  brown -> green -> red -> pale_blue
Validation  green -> cyan -> pale_blue
Tag Reader  green -> brown -> pale_blue
Training    green -> blue -> cyan -> purple -> pale_blue
```

## Your colours win, and nothing is baked into your workflows

`LGraphNode` declares `color` and `bgcolor` as class fields, so every node owns
an `undefined` for both. The renderer resolves colour as

```
this.color || this.constructor.color || LiteGraph.NODE_DEFAULT_COLOR
```

The default here is a **static on the node class**, which is that middle term.
The instance is consulted first, so recolouring a node by hand always wins.

A prototype value would never be seen at all — the instance field shadows it.
That is worth knowing if you ever write something similar.

Because the instance field stays `undefined` until you choose a colour,
serialisation (`this.color && (o.color = this.color)`) writes nothing, so saved
workflows stay free of colour and pick the scheme up live. Change the scheme
later and every workflow follows, including ones saved today.

## Turning it off

**Settings → Nova Audio → Appearance → "Colour nodes by role"**, on by default.
It applies to nodes added after the change; reload to restyle a graph that is
already open.

Only the 28 node types in the table are touched. `beforeRegisterNodeDef`
returns immediately for anything else, so no other pack's nodes are read or
modified — Comfy Registry §6. If the settings API ever changes shape the check
falls back to "on" rather than letting an exception escape into node
registration: a cosmetic extension must not be able to stop nodes registering.
