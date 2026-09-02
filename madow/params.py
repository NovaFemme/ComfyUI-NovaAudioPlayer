"""The parameter table — one definition, five consumers.

The outputs, the widgets, the canonical hash, the preset file and the context
blob all derive from this list. Defining it once is not tidiness: the spec's
warning about two `cfg`-shaped parameters colliding is exactly the failure a
second hand-maintained copy would reintroduce, and it would corrupt every fit
built on the logged data before anyone noticed.

NAMESPACING (spec 1.2). Widget names, JSON keys and DB columns all use the
same namespaced form. `ksampler.cfg` and `text.cfg_scale` are different
parameters at different stages; flattened, they collide silently.

ORDER IS THE OUTPUT ORDER. RETURN_TYPES, RETURN_NAMES and the return tuple are
all generated from this sequence, so a parameter cannot be added to one and
forgotten in another.
"""

# (key, group, output_name, kind, default, spec)
#
# `kind` is the ComfyUI type. "SAMPLERS" and "SCHEDULERS" are resolved against
# comfy.samplers at import time — see node.py — because they must be the real
# combo lists or KSampler's type checker refuses the connection (spec 1.1).
PARAMS = [
    # -- APG sampler ------------------------------------------------------
    ("apg.eta",              "APG",     "apg_eta",              "FLOAT",
     0.45, {"min": -10.0, "max": 10.0, "step": 0.01}),
    ("apg.norm_threshold",   "APG",     "apg_norm_threshold",   "FLOAT",
     4.00, {"min": 0.0, "max": 100.0, "step": 0.01}),
    ("apg.momentum",         "APG",     "apg_momentum",         "FLOAT",
     0.20, {"min": -5.0, "max": 5.0, "step": 0.01}),

    # -- scheduling / sampler --------------------------------------------
    ("sched.shift",          "Sampler", "shift",                "FLOAT",
     3.00, {"min": 0.0, "max": 100.0, "step": 0.01}),
    ("ksampler.steps",       "Sampler", "steps",                "INT",
     80, {"min": 1, "max": 10000}),
    # NOT the text encoder's cfg_scale. See text.cfg_scale below.
    ("ksampler.cfg",         "Sampler", "cfg",                  "FLOAT",
     2.80, {"min": 0.0, "max": 100.0, "step": 0.01}),
    ("ksampler.sampler_name", "Sampler", "sampler_name",        "SAMPLERS",
     "er_sde", {}),
    ("ksampler.scheduler",   "Sampler", "scheduler",            "SCHEDULERS",
     "linear_quadratic", {}),
    ("ksampler.denoise",     "Sampler", "denoise",              "FLOAT",
     1.00, {"min": 0.0, "max": 1.0, "step": 0.01}),
    ("ksampler.seed",        "Sampler", "seed",                 "INT",
     0, {"min": 0, "max": 0xFFFFFFFFFFFFFFFF}),

    # -- caption / musical -------------------------------------------------
    ("caption.prompt",       "Text",    "prompt",               "STRING",
     "", {"multiline": True}),
    ("caption.lyrics",       "Text",    "lyrics",               "STRING",
     "", {"multiline": True}),
    ("music.bpm",            "Text",    "bpm",                  "INT",
     120, {"min": 1, "max": 400}),
    ("music.duration",       "Text",    "duration",             "FLOAT",
     120.0, {"min": 1.0, "max": 3600.0, "step": 0.1}),
    # These three are ACE-Step's own combo domains, not free text. The encoder
    # holds them as lists, so a STRING would neither connect to it nor carry a
    # value it accepts: it wants the string "4", the code "en", and one of its
    # 34 key names -- never 4, "english" or "". See comfy_types.ace_combo.
    ("music.timesignature",  "Text",    "timesignature",        "TIMESIGNATURES",
     "4", {}),
    ("music.language",       "Text",    "language",             "LANGUAGES",
     "en", {}),
    ("music.keyscale",       "Text",    "keyscale",             "KEYSCALES",
     "E minor", {}),

    # -- text encoder / language model ------------------------------------
    # NOT the KSampler cfg. Two cfg-shaped parameters, different stages.
    ("text.cfg_scale",       "Text",    "text_cfg_scale",       "FLOAT",
     2.00, {"min": 0.0, "max": 100.0, "step": 0.01}),
    ("lm.temperature",       "Text",    "temperature",          "FLOAT",
     0.72, {"min": 0.0, "max": 10.0, "step": 0.01}),
    ("lm.top_p",             "Text",    "top_p",                "FLOAT",
     0.90, {"min": 0.0, "max": 1.0, "step": 0.01}),
    ("lm.top_k",             "Text",    "top_k",                "INT",
     0, {"min": 0, "max": 10000}),
    ("lm.min_p",             "Text",    "min_p",                "FLOAT",
     0.0, {"min": 0.0, "max": 1.0, "step": 0.01}),
    ("lm.generate_audio_codes", "Text", "generate_audio_codes", "BOOLEAN",
     True, {}),

    # -- output naming -----------------------------------------------------
    # Last, so they sit at the bottom of the widget stack immediately above the
    # preset row. `file_path` is not here: it is DERIVED from these four (see
    # naming.py), and storing a computed value beside its parts is how the two
    # end up disagreeing.
    ("file.prefix",          "File",    "file_prefix",          "STRING",
     "", {}),
    ("file.name",            "File",    "file_name",            "STRING",
     "", {}),
    ("file.folder",          "File",    "file_folder",          "STRING",
     "", {}),
    ("file.separator",       "File",    "file_separator",       "STRING",
     "_", {}),
]

# Excluded from `params_sha256` so runs differing only by seed group together —
# that grouping IS the seed-noise-floor query (spec 4).
SEED_KEY = "ksampler.seed"

# Parameters that do not change the AUDIO, and so must not change either hash.
#
# Where a file lands has no effect on what was generated. Hashing it would make
# two identical renders saved under different names look like different
# parameter sets, which breaks the grouping the log exists to support — the
# same failure the seed exclusion avoids, arriving from the other direction.
#
# They ARE carried in context.params and saved in presets: a preset can
# reasonably own a naming scheme, and the log should record where the file went.
NON_AUDIO_KEYS = frozenset({
    "file.prefix", "file.name", "file.folder", "file.separator",
})

# Free-text fields whose leading and trailing whitespace is stripped before
# anything sees them — the emitted output as well as the hash, so the two can
# never describe different strings.
#
# The reason is a stray Enter. A multiline widget keeps the newline, it is
# invisible in the UI, and it lands inside params_sha256: the same caption
# typed twice, once with an accidental return, hashes as two different
# configurations and splits the log on whitespace nobody can see. Same class of
# silent fragmentation as unrounded floats.
#
# INTERNAL newlines are untouched. Lyrics keep their line structure; only the
# ends are trimmed.
TRIMMED_KEYS = frozenset({"caption.prompt", "caption.lyrics"})

# What a preset does not set unless told otherwise: loading one must never
# clobber a seed the user is deliberately holding (spec 2).
DEFAULT_EXCLUDES = [SEED_KEY]

KEYS = [p[0] for p in PARAMS]
OUTPUT_NAMES = tuple(p[2] for p in PARAMS)
DEFAULTS = {p[0]: p[4] for p in PARAMS}
GROUPS = {p[0]: p[1] for p in PARAMS}
KIND = {p[0]: p[3] for p in PARAMS}

# key -> the argument name run() receives. ComfyUI passes widgets by their
# INPUT_TYPES name, and a dot is not valid in a Python identifier, so the
# widget name is the namespaced key with dots replaced.
ARG = {k: k.replace(".", "_") for k in KEYS}
