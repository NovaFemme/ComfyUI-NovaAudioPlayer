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

# ---------------------------------------------------------------------------
# ACE-Step's own combo domains.
#
# `timesignature`, `language` and `keyscale` are combo inputs on
# ACEStep15XLTextEncode, so a STRING or INT output will not connect to them --
# the same refusal `sampler_name` gets from KSampler, and the same fix.
#
# The lists are READ FROM THE LIVE NODE where possible rather than copied. A
# copy would be a second definition of someone else's data: their list changes
# with their pack and ours would not, and the failure is a value the encoder
# rejects at run time. The literals below exist only for when that node is not
# installed -- there is then nothing to connect to anyway, and they keep the
# widgets from collapsing to an empty dropdown.
_FALLBACK = {
    "TIMESIGNATURES": ["2", "3", "4", "6"],
    "LANGUAGES": ["en", "ja", "zh", "es", "de", "fr", "pt", "ru", "it", "nl",
                  "pl", "tr", "vi", "cs", "fa", "id", "ko", "uk", "hu", "ar",
                  "sv", "ro", "el"],
    "KEYSCALES": [f"{root} {quality}"
                  for quality in ("major", "minor")
                  for root in ("C", "C#", "Db", "D", "D#", "Eb", "E", "F",
                               "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb",
                               "B")],
}

# (node class name, input name) to read each domain from.
_SOURCE = {
    "TIMESIGNATURES": ("ACEStep15XLTextEncode", "timesignature"),
    "LANGUAGES": ("ACEStep15XLTextEncode", "language"),
    "KEYSCALES": ("ACEStep15XLTextEncode", "keyscale"),
}

_resolved = {}


def ace_combo(kind):
    """The live option list for an ACE-Step combo, or the fallback.

    Resolved once per process and cached: INPUT_TYPES is called on every
    /object_info request, and a dict lookup per parameter per request is not
    something to pay for repeatedly.
    """
    if kind in _resolved:
        return _resolved[kind]
    options = None
    node_name, input_name = _SOURCE[kind]
    try:
        from nodes import NODE_CLASS_MAPPINGS
        spec = NODE_CLASS_MAPPINGS[node_name].INPUT_TYPES()["required"][input_name][0]
        if isinstance(spec, (list, tuple)) and len(spec) > 0:
            options = [str(v) for v in spec]
    except Exception:                                         # noqa: BLE001
        options = None
    _resolved[kind] = options or list(_FALLBACK[kind])
    return _resolved[kind]


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
    if kind in _SOURCE:
        return ace_combo(kind)
    return kind
