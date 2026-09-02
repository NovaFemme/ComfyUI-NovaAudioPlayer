# Madow Unpack ⚪

Takes the `madow` bundle from **Madow Inputs 🎚️** and fans it out into 28 typed
outputs — the 27 parameters plus the derived `file_path`.

No widgets, no state, no validation: one input, one dict lookup per output. All
of the logic stays in Madow Inputs, which is the node that has every parameter
at once and therefore the only one that can hash them, compare them against a
preset or check them against each other.

## Why it is a separate node

Height, and choice. Thirty output rows is 600 pixels of node whether or not you
use them. Splitting the values from the fan-out trades vertical for horizontal:
two shorter nodes side by side instead of one tall one.

It also means you only place Unpack when you want typed sockets — and you can
place **several**, each next to the node it feeds. One by the KSampler, one by
the text encoder, rather than twenty wires crossing the graph from a single
tall node.

## Types

Each output carries the type the receiving node expects. `sampler_name` and
`scheduler` are the real combo lists from `comfy.samplers`; `timesignature`,
`language` and `keyscale` are the combo lists from `ACEStep15XLTextEncode`.
That is what lets them connect at all — ComfyUI refuses a STRING into a combo,
and it is right to.

The `madow` bundle is its own type, so it cannot be mis-wired into a FLOAT.

## If the bundle is malformed

Every output falls back to its parameter's default rather than raising. A
missing key in a hand-edited workflow degrades to a default value, not a broken
graph.
