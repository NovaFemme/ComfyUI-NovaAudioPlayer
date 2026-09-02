"""MadowUnpack — fan a Madow bundle out into typed outputs.

WHY IT IS A SEPARATE NODE. Madow Inputs carries 27 widgets and 30 output slots,
which is about 1400px of node. Splitting the fan-out moves half of that
alongside instead of below, and the split falls where the data stops being
interdependent: everything needing all the parameters at once — the two hashes,
preset_dirty, cross-field validation, context — stays with the widgets that
produce them. Nothing has to be merged back together.

It also means the fan-out is optional and repeatable. Wiring two parameters by
hand? Do not place this node. Feeding a KSampler at one end of the graph and a
text encoder at the other? Place two, each beside what it feeds, instead of
running twenty wires across the canvas.

Deliberately stateless: no widgets, no validation, no config. Everything it
emits was decided upstream, so there is nothing here that can disagree with
`context`.
"""

from .comfy_types import BUNDLE_TYPE, kind_for
from .params import DEFAULTS, KEYS, OUTPUT_NAMES


class MadowUnpack:
    CATEGORY = " 🎛️ Nova Audio"
    FUNCTION = "run"
    DESCRIPTION = ("Fan a Madow Inputs bundle out into its typed outputs. "
                   "Place one beside each node you are feeding, or none at all.")

    RETURN_TYPES = tuple(kind_for(k) for k in KEYS) + ("STRING",)
    RETURN_NAMES = OUTPUT_NAMES + ("file_path",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "madow": (BUNDLE_TYPE, {
                    "tooltip": "The bundle from Madow Inputs.",
                }),
            },
        }

    def run(self, madow=None):
        # A bundle that is missing, malformed, or from a NEWER pack version
        # falls back per key rather than failing. A parameter this build does
        # not recognise is skipped; one it expects but the bundle lacks comes
        # from the table's default. Either way the graph runs, which matters
        # more here than strictness — this node makes no decisions of its own,
        # so a wrong default is visible immediately downstream, while a hard
        # failure costs the whole queue.
        params = {}
        if isinstance(madow, dict):
            params = madow.get("params") or {}
        if not isinstance(params, dict):
            params = {}

        values = tuple(params.get(k, DEFAULTS[k]) for k in KEYS)

        # Derived upstream and carried, not recomputed: two implementations of
        # the same assembly is how the parts and the whole come to disagree.
        file_path = ""
        if isinstance(madow, dict):
            file_path = madow.get("file_path") or ""

        return values + (file_path,)


NODE_CLASS_MAPPINGS = {"MadowUnpack": MadowUnpack}
NODE_DISPLAY_NAME_MAPPINGS = {"MadowUnpack": "Madow Unpack 🔌"}
