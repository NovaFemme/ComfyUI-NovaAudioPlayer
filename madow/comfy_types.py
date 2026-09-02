"""ComfyUI type resolution, in one place.

`sampler_name` and `scheduler` must be typed as the REAL combo lists or
KSampler's type checker refuses the connection. Two nodes now emit those types
— Madow Inputs no longer does, but Madow Unpack does — and a second copy of
this resolution is exactly how the two would come to disagree about what a
sampler is.

The import is guarded so the package stays importable outside a ComfyUI
process: the whole Python test suite depends on that, and so does reading the
code without a GPU to hand.
"""

from .params import KIND

try:
    import comfy.samplers
    SAMPLERS = comfy.samplers.KSampler.SAMPLERS
    SCHEDULERS = comfy.samplers.KSampler.SCHEDULERS
    COMFY_AVAILABLE = True
except Exception:                                             # noqa: BLE001
    # Placeholders, never shipped to a running graph — inside ComfyUI the real
    # lists are always there. They exist so INPUT_TYPES/RETURN_TYPES can still
    # be built for a test.
    SAMPLERS = ["euler"]
    SCHEDULERS = ["normal"]
    COMFY_AVAILABLE = False

# The bundle passed from Madow Inputs to Madow Unpack. An unknown type name is
# opaque to ComfyUI, so it will only connect to a matching socket — which is
# the wanted behaviour: it cannot be mis-wired into a FLOAT.
BUNDLE_TYPE = "MADOW"
BUNDLE_SCHEMA_VER = 1


def kind_for(key):
    """ComfyUI type for a parameter key: a type name, or a real combo list."""
    kind = KIND[key]
    if kind == "SAMPLERS":
        return SAMPLERS
    if kind == "SCHEDULERS":
        return SCHEDULERS
    return kind
