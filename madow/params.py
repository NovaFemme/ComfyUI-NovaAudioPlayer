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
    # control_after_generate gives the widget ComfyUI's own fixed / increment /
    # decrement / randomize control, the same one KSampler and ACE-Step's text
    # encoder carry. Left plain, a seed has to be typed by hand for every run,
    # which is the difference between sweeping a setting and not bothering.
    #
    # It changes the WIDGET, never the value: the seed that reaches the bundle,
    # the hashes and `context` is whatever the widget holds when the graph
    # runs. That is the point -- a randomised seed is recorded as the number it
    # actually was, so a take can be reproduced by setting the control to fixed
    # and typing it back.
    ("ksampler.seed",        "Sampler", "seed",                 "INT",
     0, {"min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),

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

#: One line of help per parameter, shown as the widget's tooltip. Keyed like
#: PARAMS. A parameter without an entry simply has no tooltip.
TOOLTIPS = {
    "apg.eta": "APG: how much of the guidance that runs parallel to the prediction is kept. "
               "0 removes it; above 1.0 amplifies it, and a warning is raised.",
    "apg.norm_threshold": "APG: caps the size of the guidance update. 0 turns the cap off.",
    "apg.momentum": "APG: running average applied to the guidance from step to step. "
                    "Negative values damp it.",
    "sched.shift": "Shift of the noise schedule. Higher spends more of the steps at high noise.",
    "ksampler.steps": "Number of sampling steps.",
    "ksampler.cfg": "Guidance scale of the sampler. Not the same parameter as text_cfg_scale.",
    "ksampler.sampler_name": "The sampling algorithm.",
    "ksampler.scheduler": "How the noise levels are spaced across the steps.",
    "ksampler.denoise": "How much of the latent is re-generated. 1.0 is a full generation.",
    "ksampler.seed": "The random seed. Set the control below it to fixed to reproduce a take, "
                     "or randomize to sweep. context records the seed the run used.",
    "caption.prompt": "The caption: genre, instruments, voice, mood. A BPM or a key written "
                      "here is checked against the bpm and keyscale widgets.",
    "caption.lyrics": "The lyrics, with section tags such as [verse] and [chorus]. "
                      "Leave empty for an instrumental.",
    "music.bpm": "Tempo in beats per minute.",
    "music.duration": "Length of the track in seconds. Checked against latent_seconds when that is wired.",
    "music.timesignature": "Beats per bar, as the text encoder expects it.",
    "music.language": "Language of the lyrics, as the text encoder's language code.",
    "music.keyscale": "Key and scale, e.g. E minor.",
    "text.cfg_scale": "Guidance scale of the text encoder's language model, which writes the "
                      "audio codes. A different stage from the sampler's cfg.",
    "lm.temperature": "Randomness of the language model. Lower is more predictable.",
    "lm.top_p": "Nucleus sampling: keep the most likely tokens up to this total probability. 1.0 turns it off.",
    "lm.top_k": "Keep only the k most likely tokens. 0 turns it off. Use one truncation method at a time.",
    "lm.min_p": "Drop tokens less likely than this share of the top token. 0 turns it off. "
                "Use one truncation method at a time.",
    "lm.generate_audio_codes": "On: the language model writes audio codes for the sampler to follow. "
                               "Off: that stage is skipped.",
    "file.prefix": "First part of the file name. file_path is assembled as folder/prefix<separator>name.",
    "file.name": "Last part of the file name.",
    "file.folder": "Folder part of file_path. Empty leaves it out.",
    "file.separator": "Text placed between prefix and name.",
}

KEYS = [p[0] for p in PARAMS]
OUTPUT_NAMES = tuple(p[2] for p in PARAMS)
DEFAULTS = {p[0]: p[4] for p in PARAMS}
GROUPS = {p[0]: p[1] for p in PARAMS}
KIND = {p[0]: p[3] for p in PARAMS}

# key -> the argument name run() receives. ComfyUI passes widgets by their
# INPUT_TYPES name, and a dot is not valid in a Python identifier, so the
# widget name is the namespaced key with dots replaced.
ARG = {k: k.replace(".", "_") for k in KEYS}
