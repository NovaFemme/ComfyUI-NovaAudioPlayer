"""The `context` blob — the interop contract with Nova Audio Player.

The player copies this verbatim into `panel_info` and never parses it. That
decoupling is the whole point: ACE-Step's parameter set will keep changing and
the player's signature must not move with it.

THE TWO HASHES ARE NOT REDUNDANT.

  params_sha256         seed EXCLUDED. Groups runs that differ only by seed,
                        which is precisely the seed-noise-floor query: how much
                        does a metric move when nothing but the seed changes?
                        Without this grouping key that question cannot be asked
                        of the log at all.
  params_seeded_sha256  seed INCLUDED. Identifies an exact configuration, for
                        "did I already run this?"

CANONICAL FORM matters more than it looks. Two runs with identical parameters
must hash identically across machines, Python versions and widget round-trips,
so: sorted keys, no whitespace, and floats formatted to a fixed 6 decimal
places. Without the float rule, 0.45 arriving as 0.4500000000000001 from a
frontend round-trip produces a different hash for the same configuration, and
the grouping silently fragments.
"""

import hashlib
import json

SCHEMA_VER = 1
EMITTER = "MadowInputs"
EMITTER_VERSION = "0.1.0"


def canonical(params):
    """Deterministic JSON for hashing. Sorted, compact, floats fixed to 6 dp."""
    clean = {}
    for k in sorted(params):
        v = params[k]
        if isinstance(v, bool):
            clean[k] = v                    # before the number check: bool is an int
        elif isinstance(v, float):
            clean[k] = f"{v:.6f}"
        elif isinstance(v, int):
            clean[k] = v
        else:
            clean[k] = "" if v is None else str(v)
    return json.dumps(clean, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hashes(params, seed_key, non_audio=()):
    """(params_sha256, params_seeded_sha256).

    `non_audio` names parameters that do not affect the generated audio — the
    output naming fields — and they are dropped from BOTH hashes. Renaming a
    file must not make an identical render look like a different configuration.
    The seed is dropped from the first hash only, which is what makes runs
    differing solely by seed group together.
    """
    skip = set(non_audio)
    audio = {k: v for k, v in params.items() if k not in skip}
    without_seed = {k: v for k, v in audio.items() if k != seed_key}
    return _sha(canonical(without_seed)), _sha(canonical(audio))


def _as_declared(value, kind):
    """A value in the type its parameter declares.

    THE BUG THIS FIXES. A preset is written by the browser, and
    `JSON.stringify(4.0)` is `4` — JavaScript has one number type and drops a
    trailing `.0`. Python then reads back the integer 4 where the widget holds
    the float 4.0, and `canonical` renders those two differently on purpose:
    "4.000000" against 4. So every preset containing a float parameter that
    happens to sit on a whole number — cfg 4.00, denoise 1.00 — read as dirty
    the instant it was saved, which made the flag worse than useless: it was
    reliably wrong in the direction that hides real tweaks in the noise.

    Hashing is left alone. It only ever sees values that came from ComfyUI, so
    it is internally consistent; this crossing of the JS boundary is the one
    place the type can change under a value.
    """
    try:
        if kind == "FLOAT":
            return float(value)
        if kind == "INT":
            return int(value)
        if kind == "BOOLEAN":
            return bool(value)
    except (TypeError, ValueError):
        return value
    return value


def preset_dirty(params, preset_params, excludes, kinds=None):
    """True when the current values differ from the loaded preset.

    Without this a preset run and a preset-then-tweaked run are
    indistinguishable in the log, and the tweak-chain analysis depends on
    exactly that distinction.

    `kinds` maps key -> declared ComfyUI type. Passed in rather than imported
    so this module stays loadable on its own. Without it the comparison is the
    old one, which is right whenever both sides came from the same place.
    """
    if not preset_params:
        return False
    skip = set(excludes or ())
    kinds = kinds or {}
    for k, v in preset_params.items():
        if k in skip:
            continue
        if k not in params:
            return True
        kind = kinds.get(k)
        a = canonical({k: _as_declared(params[k], kind)})
        b = canonical({k: _as_declared(v, kind)})
        if a != b:
            return True
    return False


def build(params, validation, seed_key, preset_name=None, preset_params=None,
          excludes=None, env=None, non_audio=(), file_path=None, kinds=None):
    """Assemble the context blob. Never raises — see build_json."""
    unseeded, seeded = hashes(params, seed_key, non_audio)
    return {
        "schema_ver": SCHEMA_VER,
        "emitter": EMITTER,
        "emitter_version": EMITTER_VERSION,
        "params_sha256": unseeded,
        "params_seeded_sha256": seeded,
        "preset_name": preset_name or None,
        "preset_dirty": preset_dirty(params, preset_params, excludes, kinds),
        "params": params,
        # The assembled output path, recorded so a logged row can be matched to
        # the file on disk without re-deriving it and risking a different
        # answer. Excluded from the hashes above, deliberately.
        "file_path": file_path,
        "hash_excludes": sorted(set(non_audio)),
        "validation": list(validation or ()),
        "env": env or {},
    }


def build_json(*a, **kw):
    """`build`, serialised. A failure here must not fail the whole graph.

    The node's job is to emit parameters; if the provenance blob cannot be
    assembled, the run should still happen and the blob should say so, rather
    than taking a five-minute render down with it.
    """
    try:
        return json.dumps(build(*a, **kw), indent=2, ensure_ascii=False)
    except Exception as exc:                                  # noqa: BLE001
        print(f"[MadowInputs] context could not be built: {exc}")
        return json.dumps({"schema_ver": SCHEMA_VER, "emitter": EMITTER,
                           "error": str(exc)})
