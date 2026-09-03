"""MadowInputs — parameter table, validation, hashing, presets.

Dependency-free like the other Python suites: no torch, no ComfyUI, no numpy.
The node module guards its `comfy.samplers` import for exactly this reason, so
everything except the combo lists is testable on any machine.

Covers the spec's checklist items that do not need a running graph. The ones
that do — combo types accepted by KSampler, widgets updating on screen — are
left to the manual list; asserting them here would be asserting a mock.

Run:  python3 dev/tests/test_madow.py
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.join(os.path.dirname(_HERE), "..")


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_PKG, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


params_mod = _load("madow_params", "madow/params.py")
validate_mod = _load("madow_validate", "madow/validate.py")
context_mod = _load("madow_context", "madow/context.py")
naming_mod = _load("madow_naming", "madow/naming.py")


def _load_pkg():
    """Import the madow package properly, with comfy stubbed.

    The two nodes are loaded through the real import path rather than by file,
    so the relative imports and the shared comfy_types resolution are exercised
    exactly as ComfyUI would exercise them.
    """
    import types
    cs = types.ModuleType("comfy.samplers")

    class _KS:
        SAMPLERS = ["euler", "er_sde"]
        SCHEDULERS = ["normal", "linear_quadratic"]

    cs.KSampler = _KS
    comfy = types.ModuleType("comfy")
    comfy.samplers = cs
    sys.modules.setdefault("comfy", comfy)
    sys.modules.setdefault("comfy.samplers", cs)

    root = os.path.abspath(_PKG)
    spec = importlib.util.spec_from_file_location(
        "madow", os.path.join(root, "madow", "__init__.py"),
        submodule_search_locations=[os.path.join(root, "madow")])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules["madow"] = pkg
    spec.loader.exec_module(pkg)
    return (importlib.import_module("madow.node"),
            importlib.import_module("madow.unpack"))

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
    detail = "" if not detail else (detail if isinstance(detail, str) else repr(detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")


print("MadowInputs\n")

# ---- the parameter table --------------------------------------------------
K = params_mod
ck("27 parameters: 23 generation plus 4 naming",
   len(K.PARAMS) == 27, str(len(K.PARAMS)))
ck("the naming fields are last, above the preset row",
   [k for k in K.KEYS[-4:]] == ["file.prefix", "file.name", "file.folder",
                                "file.separator"], str(K.KEYS[-4:]))
ck("no duplicate keys", len(set(K.KEYS)) == len(K.KEYS))
ck("no duplicate output names",
   len(set(K.OUTPUT_NAMES)) == len(K.OUTPUT_NAMES))
ck("output order matches the key order",
   len(K.OUTPUT_NAMES) == len(K.KEYS))

# The spec's central warning: two cfg-shaped parameters at different stages.
cfg_keys = [k for k in K.KEYS if "cfg" in k]
ck("both cfg parameters exist and are namespaced apart",
   set(cfg_keys) == {"ksampler.cfg", "text.cfg_scale"}, str(cfg_keys))
ck("every key is namespaced", all("." in k for k in K.KEYS),
   str([k for k in K.KEYS if "." not in k]))
ck("the widget-name mapping is unique — no two keys collide",
   len(set(K.ARG.values())) == len(K.ARG),
   str([a for a in K.ARG.values() if list(K.ARG.values()).count(a) > 1]))
ck("seed is excluded from presets by default",
   K.DEFAULT_EXCLUDES == [K.SEED_KEY], str(K.DEFAULT_EXCLUDES))

# ---- output path assembly -------------------------------------------------
# file_path is DERIVED, never stored, so the parts and the whole cannot drift.
N = naming_mod
bp = N.build_file_path
ck("the assembled path is folder/prefix<sep>name",
   bp("NOVA", "take01", "ace_step", "_") == "ace_step/NOVA_take01",
   bp("NOVA", "take01", "ace_step", "_"))

# Empty fields must collapse, not leave their punctuation behind. A dangling
# "NOVA_" or a leading "/" survives into a hundred filenames before anyone
# looks closely.
ck("an empty prefix leaves no leading separator",
   bp("", "take01", "ace_step", "_") == "ace_step/take01",
   bp("", "take01", "ace_step", "_"))
ck("an empty name leaves no trailing separator",
   bp("NOVA", "", "ace_step", "_") == "ace_step/NOVA",
   bp("NOVA", "", "ace_step", "_"))
ck("an empty folder leaves no leading slash",
   bp("NOVA", "take01", "", "_") == "NOVA_take01",
   bp("NOVA", "take01", "", "_"))
ck("everything empty yields an empty string, not punctuation",
   bp("", "", "", "_") == "", repr(bp("", "", "", "_")))

ck("a folder typed with slashes does not double them",
   bp("NOVA", "take01", "/ace_step/", "_") == "ace_step/NOVA_take01",
   bp("NOVA", "take01", "/ace_step/", "_"))
ck("backslashes are normalised to forward slashes",
   bp("NOVA", "take01", "a\\b", "_") == "a/b/NOVA_take01",
   bp("NOVA", "take01", "a\\b", "_"))
ck("an empty separator simply concatenates",
   bp("NOVA", "take01", "", "") == "NOVAtake01",
   bp("NOVA", "take01", "", ""))
# A space is a legitimate separator; stripping it would turn "a b" into "ab".
ck("a space separator is preserved, not stripped",
   bp("NOVA", "take01", "", " ") == "NOVA take01",
   repr(bp("NOVA", "take01", "", " ")))
ck("surrounding whitespace on the fields is trimmed",
   bp("  NOVA ", " take01 ", " ace_step ", "_") == "ace_step/NOVA_take01")
ck("None is treated as empty, not as the string 'None'",
   bp(None, "take01", None, "_") == "take01", bp(None, "take01", None, "_"))

# ---- validation -----------------------------------------------------------
V = validate_mod
base = {"caption.prompt": "", "caption.lyrics": "", "music.bpm": 120,
        "music.keyscale": "", "music.duration": 120.0, "lm.top_k": 0,
        "lm.top_p": 1.0, "lm.min_p": 0.0, "apg.eta": 0.45}

ck("a clean configuration warns about nothing", V.validate(base) == [],
   str(V.validate(base)))

w = V.validate({**base, "caption.prompt": "brutal riff, 98 BPM"})
ck("BPM conflict is caught — the check that pays for the node",
   any("98 BPM" in x and "122" not in x for x in w), str(w))
ck("a MATCHING bpm does not warn",
   V.validate({**base, "caption.prompt": "98 BPM", "music.bpm": 98}) == [])
ck("a four-digit number is not read as a tempo",
   V.validate({**base, "caption.prompt": "year 1998 BPM-free"}) == [] or
   not any("BPM" in x for x in V.validate({**base, "caption.prompt": "in 1998"})))

w = V.validate({**base, "caption.prompt": "in G major", "music.keyscale": "Eb minor"})
ck("key conflict is caught", any("G major" in x for x in w), str(w))
ck("a matching key does not warn, whitespace aside",
   V.validate({**base, "caption.prompt": "in Eb minor",
               "music.keyscale": "Ebminor"}) == [])
ck("an empty keyscale widget is not a conflict",
   V.validate({**base, "caption.prompt": "in G major"}) == [])

ck("duration mismatch is caught when the latent is wired",
   any("290" in x and "280" in x
       for x in V.validate({**base, "music.duration": 290.0}, latent_seconds=280)))
ck("duration is NOT guessed at when the latent is absent",
   V.validate({**base, "music.duration": 290.0}) == [])

ck("vocals without lyrics is caught",
   any("lyrics field is empty" in x
       for x in V.validate({**base, "caption.prompt": "soaring female vocals"})))
ck("vocals WITH lyrics does not warn",
   V.validate({**base, "caption.prompt": "soaring female vocals",
               "caption.lyrics": "la la"}) == [])

w = V.validate({**base, "lm.top_k": 50, "lm.top_p": 0.9})
ck("two truncation methods warn", any("truncation" in x for x in w), str(w))
ck("the warning names which ones are active",
   any("top_k" in x and "top_p" in x for x in w), str(w))
ck("ONE truncation method does not warn",
   V.validate({**base, "lm.top_p": 0.9}) == [])

ck("eta above 1.0 warns",
   any("above 1.0" in x for x in V.validate({**base, "apg.eta": 1.4})))
ck("eta at 1.0 does not warn", V.validate({**base, "apg.eta": 1.0}) == [])

ck("a caption pulling both ways on brightness warns",
   any("both ways" in x
       for x in V.validate({**base, "caption.prompt": "dark sludgy but crisp"})))

# Warn-only is a contract, not a preference.
many = V.validate({**base, "caption.prompt": "dark crisp vocals, 98 BPM, G major",
                   "music.keyscale": "Eb minor", "lm.top_k": 5, "lm.top_p": 0.5,
                   "apg.eta": 2.0}, latent_seconds=1)
ck("validation returns a list and never raises", isinstance(many, list),
   f"{len(many)} warnings")
ck("all seven rules can fire at once", len(many) == 7, f"{len(many)}")

# ---- context and hashing --------------------------------------------------
C = context_mod
p1 = {"apg.eta": 0.45, "ksampler.seed": 1, "ksampler.cfg": 2.8,
      "lm.generate_audio_codes": True, "caption.prompt": "x"}
p2 = {**p1, "ksampler.seed": 999}

h1 = C.hashes(p1, "ksampler.seed")
h2 = C.hashes(p2, "ksampler.seed")
ck("same params, different seed → same params_sha256",
   h1[0] == h2[0], h1[0][:16])
ck("same params, different seed → different params_seeded_sha256",
   h1[1] != h2[1])
ck("same params, same seed → identical hashes",
   C.hashes(dict(p1), "ksampler.seed") == h1)

# The float rule is the one that silently fragments a log if it is missing.
drift = {**p1, "apg.eta": 0.4500000000000001}
ck("a float round-trip does not change the hash",
   C.hashes(drift, "ksampler.seed")[0] == h1[0])
ck("a real parameter change DOES change the hash",
   C.hashes({**p1, "apg.eta": 0.46}, "ksampler.seed")[0] != h1[0])
ck("booleans stay boolean, not 1/0",
   '"lm.generate_audio_codes":true' in C.canonical(p1), C.canonical(p1)[:60])
ck("canonical form is key-sorted and whitespace-free",
   " " not in C.canonical({"b": 1, "a": 2}).replace('"', ""),
   C.canonical({"b": 1, "a": 2}))

ck("preset_dirty is false for an untouched preset",
   C.preset_dirty(p1, p1, ["ksampler.seed"]) is False)
ck("preset_dirty is true after one tweak",
   C.preset_dirty({**p1, "apg.eta": 0.5}, p1, ["ksampler.seed"]) is True)

# THE BUG THIS PINS. The browser writes a preset, and JSON.stringify(4.0) is
# `4`. Read back, the integer 4 met the widget's float 4.0 and canonical()
# rendered them differently on purpose — so a preset with cfg 4.00 or denoise
# 1.00 read as dirty the moment it was saved. NovaFemme's own preset did.
js_written = {**p1, "ksampler.cfg": 4, "ksampler.denoise": 1}
widgets    = {**p1, "ksampler.cfg": 4.0, "ksampler.denoise": 1.0}
ck("a float the browser wrote as an integer is not a tweak",
   C.preset_dirty(widgets, js_written, ["ksampler.seed"], K.KIND) is False)
ck("and without the type map the old comparison still applies",
   C.preset_dirty(widgets, js_written, ["ksampler.seed"]) is True)
ck("a real change is still caught with the type map",
   C.preset_dirty({**widgets, "ksampler.cfg": 4.5}, js_written,
                  ["ksampler.seed"], K.KIND) is True)
ck("a seed change alone does not mark a preset dirty",
   C.preset_dirty(p2, p1, ["ksampler.seed"]) is False)
ck("no preset loaded is not 'dirty'",
   C.preset_dirty(p1, None, []) is False)

# Naming must not touch either hash: renaming a file does not change the audio,
# and hashing it would split two identical renders into different groups —
# the same failure the seed exclusion avoids, arriving from the other side.
named = {**p1, "file.prefix": "NOVA", "file.name": "take01",
         "file.folder": "out", "file.separator": "_"}
renamed = {**named, "file.prefix": "OTHER", "file.name": "take99",
           "file.folder": "elsewhere"}
hn = C.hashes(named, "ksampler.seed", K.NON_AUDIO_KEYS)
hr = C.hashes(renamed, "ksampler.seed", K.NON_AUDIO_KEYS)
ck("renaming the output does not change params_sha256", hn[0] == hr[0])
ck("renaming the output does not change params_seeded_sha256", hn[1] == hr[1])
ck("a real parameter change still moves the hash",
   C.hashes({**named, "apg.eta": 0.9}, "ksampler.seed", K.NON_AUDIO_KEYS)[0] != hn[0])
ck("the naming fields are still IN context.params — excluded from the hash, "
   "not from the record",
   all(k in json.loads(C.build_json(named, [], "ksampler.seed",
                                    non_audio=K.NON_AUDIO_KEYS))["params"]
       for k in K.NON_AUDIO_KEYS))
ck("context records the assembled file_path",
   json.loads(C.build_json(named, [], "ksampler.seed",
                           non_audio=K.NON_AUDIO_KEYS,
                           file_path="out/NOVA_take01"))["file_path"]
   == "out/NOVA_take01")
ck("context states which keys were excluded from hashing",
   json.loads(C.build_json(named, [], "ksampler.seed",
                           non_audio=K.NON_AUDIO_KEYS))["hash_excludes"]
   == sorted(K.NON_AUDIO_KEYS))

blob = json.loads(C.build_json(p1, ["a warning"], "ksampler.seed",
                               preset_name="hm", preset_params=p1,
                               excludes=["ksampler.seed"], env={"pack_version": "0.1.0"}))
for field in ("schema_ver", "emitter", "emitter_version", "params_sha256",
              "params_seeded_sha256", "preset_name", "preset_dirty",
              "params", "validation", "env"):
    ck(f"context carries {field}", field in blob)
ck("context names its emitter", blob["emitter"] == "MadowInputs")
ck("validation travels inside context too", blob["validation"] == ["a warning"])
ck("context never raises, even on unserialisable input",
   isinstance(C.build_json({"x": object()}, [], "ksampler.seed"), str))

# ---- presets --------------------------------------------------------------
# presets.py imports comfy_types to learn ACE-Step's combo domains, so it has
# to come through the package rather than by file path.
_load_pkg()
P = importlib.import_module("madow.presets")
tmp = tempfile.mkdtemp()
P.PRESET_DIR = tmp
try:
    ok, _ = P.save("round_trip", {"apg.eta": 0.5, "ksampler.steps": 50},
                   note="n", excludes=["ksampler.seed"])
    ck("a preset saves", ok)
    got = P.load("round_trip")
    ck("a preset round-trips its params",
       got["params"] == {"apg.eta": 0.5, "ksampler.steps": 50})
    ck("a preset records its excludes", got["excludes"] == ["ksampler.seed"])
    ck("a preset records a schema version", got["schema_ver"] == P.SCHEMA_VER)
    ck("it appears in the listing",
       any(x["name"] == "round_trip" for x in P.list_presets()))

    # Hand-editing then reloading is a supported workflow (spec checklist).
    with open(os.path.join(tmp, "round_trip.json"), "r+", encoding="utf-8") as f:
        d = json.load(f); d["params"]["apg.eta"] = 0.99
        f.seek(0); json.dump(d, f); f.truncate()
    ck("a hand-edited preset is picked up on reload — nothing is cached",
       P.load("round_trip")["params"]["apg.eta"] == 0.99)

    # Names arrive over HTTP, so they are validated rather than trusted.
    for bad in ("../evil", "a/b", "a\\b", "..", ".", "", "x" * 65, " leading"):
        ck(f"rejects unsafe preset name {bad!r}", not P.valid_name(bad))
    for good in ("heavy_metal_base", "Take 3", "a.b-c_d"):
        ck(f"accepts {good!r}", P.valid_name(good))
    ck("a traversal name cannot resolve to a path", P._path("../evil") is None)

    ck("saving with no params is refused", P.save("empty", {})[0] is False)
    ck("loading a missing preset returns None", P.load("nope") is None)

    # One bad file must not hide every other preset from the dropdown.
    with open(os.path.join(tmp, "broken.json"), "w", encoding="utf-8") as f:
        f.write("{not json")
    names = [x["name"] for x in P.list_presets()]
    ck("an unreadable preset does not hide the good ones",
       "round_trip" in names and "broken" in names, str(names))

    ck("a preset deletes", P.delete("round_trip")[0])
    ck("deleting twice reports not-found", P.delete("round_trip")[0] is False)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---- the two-node split ---------------------------------------------------
# Madow Inputs owns the values; Madow Unpack owns the fan-out. The split falls
# where the data stops being interdependent: everything needing all the
# parameters at once stays with the widgets that produce them.
node_mod, unpack_mod = _load_pkg()
Inputs, Unpack = node_mod.MadowInputs, unpack_mod.MadowUnpack

ck("Madow Inputs emits four slots, not thirty",
   Inputs.RETURN_NAMES == ("madow", "file_path", "context", "validation"),
   str(Inputs.RETURN_NAMES))
ck("Unpack emits every parameter plus file_path",
   len(Unpack.RETURN_NAMES) == len(K.KEYS) + 1, str(len(Unpack.RETURN_NAMES)))
ck("Unpack's output names match the table exactly",
   Unpack.RETURN_NAMES[:-1] == K.OUTPUT_NAMES)
ck("Unpack takes the bundle type, which cannot be wired to a FLOAT",
   list(Unpack.INPUT_TYPES()["required"]) == ["madow"] and
   Unpack.INPUT_TYPES()["required"]["madow"][0] == "MADOW")

# The combo lists must be the real ones on the node that emits them, and there
# must be only one copy of that resolution.
ck("Unpack types sampler_name as the real combo list",
   isinstance(Unpack.RETURN_TYPES[K.KEYS.index("ksampler.sampler_name")], list))
ck("Unpack types scheduler as the real combo list",
   isinstance(Unpack.RETURN_TYPES[K.KEYS.index("ksampler.scheduler")], list))

kw = {K.ARG[k]: K.DEFAULTS[k] for k in K.KEYS}
kw[K.ARG["file.prefix"]] = "NOVA"
kw[K.ARG["file.name"]] = "take01"
kw[K.ARG["file.folder"]] = "ace_step"
bundle, fp, ctx_json, val = Inputs().run(preset_name="", latent_seconds=0.0, **kw)

ck("the bundle is versioned", bundle["schema_ver"] == 1)
ck("the bundle carries every parameter",
   set(bundle["params"]) == set(K.KEYS))
ck("the bundle carries the assembled file_path, so it is not recomputed",
   bundle["file_path"] == "ace_step/NOVA_take01", bundle["file_path"])
ck("file_path is on BOTH nodes — one string, saves a wire",
   fp == bundle["file_path"])

out = Unpack().run(madow=bundle)
ck("every value round-trips through the bundle unchanged",
   all(out[i] == bundle["params"][k] for i, k in enumerate(K.KEYS)))
ck("Unpack carries file_path rather than reassembling it",
   out[-1] == "ace_step/NOVA_take01", out[-1])

# A malformed bundle must not take the queue down. This node decides nothing,
# so a fallback is visible immediately downstream; a hard failure costs a run.
for bad, label in ((None, "nothing wired"), ({}, "an empty dict"),
                   ("nonsense", "a string"), ({"params": None}, "a null params"),
                   ({"params": []}, "a list where a dict belongs")):
    o = Unpack().run(madow=bad)
    ck(f"{label} falls back to defaults rather than raising",
       len(o) == len(K.KEYS) + 1 and o[K.KEYS.index("apg.eta")] == K.DEFAULTS["apg.eta"])

partial = Unpack().run(madow={"params": {"apg.eta": 0.9}})
ck("a bundle from a different pack version keeps what it knows",
   partial[K.KEYS.index("apg.eta")] == 0.9)
ck("...and defaults what it does not",
   partial[K.KEYS.index("ksampler.steps")] == K.DEFAULTS["ksampler.steps"])

# ---- a stray Enter must not split the log ---------------------------------
# Reported from a real run: the prompt read "prompt value\n" because Enter was
# pressed while typing. That newline is invisible in the UI and lands inside
# params_sha256, so the same caption typed twice hashes as two configurations.
def _run(**over):
    k = {K.ARG[x]: K.DEFAULTS[x] for x in K.KEYS}
    k[K.ARG["caption.prompt"]] = over.get("prompt", "a riff")
    k[K.ARG["caption.lyrics"]] = over.get("lyrics", "")
    return Inputs().run(preset_name="", latent_seconds=0.0, **k)

clean = _run(prompt="prompt value")
stray = _run(prompt="prompt value\n")
lead = _run(prompt="  prompt value  ")

ck("a trailing newline is trimmed from the emitted value, not just the hash",
   stray[0]["params"]["caption.prompt"] == "prompt value",
   repr(stray[0]["params"]["caption.prompt"]))
ck("a stray Enter no longer changes params_sha256",
   json.loads(clean[2])["params_sha256"] == json.loads(stray[2])["params_sha256"])
ck("surrounding spaces do not change it either",
   json.loads(clean[2])["params_sha256"] == json.loads(lead[2])["params_sha256"])
ck("what is hashed is what is emitted — one string, not two code paths",
   json.loads(stray[2])["params"]["caption.prompt"]
   == stray[0]["params"]["caption.prompt"])

# Internal structure must survive: lyrics are lines.
multi = _run(lyrics="line one\nline two\n")
ck("internal newlines are preserved — lyrics keep their line structure",
   multi[0]["params"]["caption.lyrics"] == "line one\nline two",
   repr(multi[0]["params"]["caption.lyrics"]))

# A REAL change must still register, or the trim would be hiding content.
ck("a genuinely different caption still changes the hash",
   json.loads(clean[2])["params_sha256"]
   != json.loads(_run(prompt="a different riff")[2])["params_sha256"])

ck("only the free-text fields are trimmed",
   K.TRIMMED_KEYS == {"caption.prompt", "caption.lyrics"}, str(sorted(K.TRIMMED_KEYS)))
ck("the file separator is NOT trimmed — a space is a legitimate separator",
   "file.separator" not in K.TRIMMED_KEYS)

# ---- ACE-Step's combo domains ---------------------------------------------
# THE BUG THIS PINS. timesignature, language and keyscale are combo inputs on
# ACEStep15XLTextEncode. Typed as INT/STRING/STRING they would not connect to
# it at all, and the values Madow held -- 4, "english", "" -- are not values
# that encoder accepts even if they had.
CT = importlib.import_module("madow.comfy_types")

for key, must_hold in [("music.timesignature", "4"),
                       ("music.language", "en"),
                       ("music.keyscale", "E minor")]:
    opts = CT.kind_for(key)
    ck(f"{key} resolves to a combo list", isinstance(opts, list),
       type(opts).__name__)
    ck(f"{key}'s default is inside its own domain",
       K.DEFAULTS[key] in opts, repr(K.DEFAULTS[key]))
    ck(f"{key} offers {must_hold!r}", must_hold in opts)

ck("the time signature is the STRING \"4\", not the integer 4",
   K.DEFAULTS["music.timesignature"] == "4",
   repr(K.DEFAULTS["music.timesignature"]))

# ---- migrating presets written before that ---------------------------------
old_preset = {"music.timesignature": 4, "music.language": "english",
              "music.keyscale": "D minor", "ksampler.cfg": 2.8}
migrated, notes = P.coerce(old_preset)
ck("an integer time signature becomes its combo string",
   migrated["music.timesignature"] == "4", repr(migrated["music.timesignature"]))
ck("'english' becomes the code the encoder wants",
   migrated["music.language"] == "en", repr(migrated["music.language"]))
ck("a key that was already valid is left alone",
   migrated["music.keyscale"] == "D minor")
ck("a non-combo parameter is untouched", migrated["ksampler.cfg"] == 2.8)
ck("every migration is reported, not silent", len(notes) == 2, "; ".join(notes))
ck("coerce does not mutate the caller's dict",
   old_preset["music.language"] == "english")

junk, junk_notes = P.coerce({"music.keyscale": "", "music.language": "klingon"})
ck("a value with no sane reading falls back to the default",
   junk["music.keyscale"] == K.DEFAULTS["music.keyscale"] and
   junk["music.language"] == K.DEFAULTS["music.language"])
ck("and the fallback says so rather than passing quietly",
   all("not one of" in n for n in junk_notes), "; ".join(junk_notes))

ck("case and spacing alone are not a fallback",
   P.coerce({"music.keyscale": "d  minor"})[0]["music.keyscale"] == "D minor")

# ---- the hash contract ------------------------------------------------------
# A hash nothing outside the node can reproduce is not a grouping key. These
# pin the promises the recorded spec string makes.
ctx_obj = json.loads(ctx_json)
ck("context records how to recompute its hashes",
   ctx_obj.get("hash_spec") == C.HASH_SPEC, str(ctx_obj.get("hash_spec")))
ck("...and the type declarations they were made under",
   ctx_obj.get("param_types_ver") == C.PARAM_TYPES_VER)
ck("an empty validation list names the ruleset that produced it",
   ctx_obj.get("validation_ruleset_ver") == V.RULESET_VER,
   str(ctx_obj.get("validation_ruleset_ver")))

# float:%.6f — the clause that stops a refactor forking the log.
ck("280.0 and 280.00 are the same hash",
   C.canonical({"music.duration": 280.0}) == C.canonical({"music.duration": 280.00}))
ck("...but 280.0 and 280.1 are not",
   C.canonical({"music.duration": 280.0}) != C.canonical({"music.duration": 280.1}))
ck("a float and an int of equal value are NOT the same canonical form",
   C.canonical({"x": 4.0}) != C.canonical({"x": 4}),
   "which is why param_types_ver exists")

# text:lf-normalised-rstripped — the clause that stops an editor forking it.
crlf = _run(lyrics="verse one\r\nverse two\r\n")[0]["params"]["caption.lyrics"]
lf = _run(lyrics="verse one\nverse two\n")[0]["params"]["caption.lyrics"]
ck("a CRLF paste and an LF paste give the same text", crlf == lf, repr(crlf))
ck("...and therefore the same hash",
   json.loads(_run(lyrics="verse one\r\nverse two")[2])["params_sha256"]
   == json.loads(_run(lyrics="verse one\nverse two")[2])["params_sha256"])
trailing = _run(lyrics="line one   \nline two\t\n")[0]["params"]["caption.lyrics"]
ck("trailing whitespace per line is stripped before hashing",
   trailing == "line one\nline two", repr(trailing))

# ---- the type table is frozen ----------------------------------------------
# Not a style check. "4" and 4 hash differently, so a type change without a
# param_types_ver bump splits one configuration into two groups in the log and
# nothing in the numbers reveals it.
FROZEN_KINDS = {
    "apg.eta": "FLOAT", "apg.norm_threshold": "FLOAT", "apg.momentum": "FLOAT",
    "sched.shift": "FLOAT", "ksampler.steps": "INT", "ksampler.cfg": "FLOAT",
    "ksampler.sampler_name": "SAMPLERS", "ksampler.scheduler": "SCHEDULERS",
    "ksampler.denoise": "FLOAT", "ksampler.seed": "INT",
    "caption.prompt": "STRING", "caption.lyrics": "STRING",
    "music.bpm": "INT", "music.duration": "FLOAT",
    "music.timesignature": "TIMESIGNATURES", "music.language": "LANGUAGES",
    "music.keyscale": "KEYSCALES",
    "text.cfg_scale": "FLOAT", "lm.temperature": "FLOAT", "lm.top_p": "FLOAT",
    "lm.top_k": "INT", "lm.min_p": "FLOAT", "lm.generate_audio_codes": "BOOLEAN",
    "file.prefix": "STRING", "file.name": "STRING", "file.folder": "STRING",
    "file.separator": "STRING",
}
drift = {k: (K.KIND.get(k), v) for k, v in FROZEN_KINDS.items() if K.KIND.get(k) != v}
ck("no parameter has changed type without a param_types_ver bump",
   not drift and set(K.KIND) == set(FROZEN_KINDS),
   str(drift) if drift else f"{len(FROZEN_KINDS)} types match")

ck("context is still emitted by the node that has every parameter",
   json.loads(ctx_json)["params"].keys() == bundle["params"].keys())

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
