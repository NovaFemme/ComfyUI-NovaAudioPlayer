"""Cross-field validation. Warn only — never block, never auto-correct.

The rule the node pays for itself with is the BPM one: a caption saying
"98 BPM" against a bpm widget of 122 is a live conflict ACE-Step reads both
sides of, and it cost a five-minute render to not notice.

Everything here is advisory by design. A validator that blocks execution turns
a warning into an outage the first time its regex is wrong, and a validator
that silently corrects makes the logged parameters differ from what the user
believes they ran — which is the provenance failure this whole effort exists to
close.
"""

import re

# Two to three digits: "8 BPM" is not a tempo, and four digits is not either.
_BPM_RE = re.compile(r"(\d{2,3})\s*BPM", re.I)

# "G major", "Eb minor", "F# min". Accepts the sharp/flat spellings ACE-Step
# captions actually use.
_KEY_RE = re.compile(
    r"\b([A-G])\s*(#|b|♯|♭)?\s*(major|minor|maj|min)\b", re.I)

_VOCAL_TERMS = (
    "vocal", "vocals", "singer", "sung", "singing", "choir", "chorus",
    "male voice", "female voice", "lyrics", "rap", "rapping", "screaming",
)

# Terms that pull the mix in opposite directions on brightness. A caption
# carrying both is not wrong, but it is under-specified, and the resulting
# take is hard to attribute to any one setting.
_DARK_TERMS = ("dark", "heavy", "sludgy", "muddy", "doom", "low-end",
               "bass-heavy", "warm", "mellow", "murky")
_BRIGHT_TERMS = ("bright", "crisp", "airy", "presence", "sparkle", "shimmer",
                 "sharp", "trebly", "sizzling", "glossy")


def _norm_key(m):
    letter = m.group(1).upper()
    accidental = (m.group(2) or "").replace("♯", "#").replace("♭", "b")
    mode = m.group(3).lower()
    mode = "major" if mode.startswith("maj") else "minor"
    return f"{letter}{accidental} {mode}"


def validate(params, latent_seconds=None):
    """Return a list of human-readable warnings, in a stable order.

    @param params          namespaced parameter dict
    @param latent_seconds  EmptyAceStepLatentAudio `seconds`, when wired in;
                           None when it is not, and the check is skipped rather
                           than guessed at
    """
    out = []
    caption = str(params.get("caption.prompt") or "")
    lyrics = str(params.get("caption.lyrics") or "")
    low = caption.lower()

    # -- BPM conflict ------------------------------------------------------
    m = _BPM_RE.search(caption)
    if m:
        said = int(m.group(1))
        widget = int(params.get("music.bpm") or 0)
        if said != widget:
            out.append(f"caption says {said} BPM, bpm widget is {widget} "
                       f"— ACE-Step reads both")

    # -- key conflict ------------------------------------------------------
    km = _KEY_RE.search(caption)
    if km:
        said = _norm_key(km)
        widget = str(params.get("music.keyscale") or "").strip()
        if widget and said.lower().replace(" ", "") != widget.lower().replace(" ", ""):
            out.append(f"caption says {said}, keyscale is {widget}")

    # -- duration vs latent ------------------------------------------------
    if latent_seconds is not None:
        dur = float(params.get("music.duration") or 0)
        if abs(dur - float(latent_seconds)) > 0.5:
            out.append(f"duration {dur:g}s vs latent {float(latent_seconds):g}s")

    # -- vocals without lyrics --------------------------------------------
    if not lyrics.strip() and any(t in low for t in _VOCAL_TERMS):
        out.append("caption requests vocals, lyrics field is empty")

    # -- truncation gate ---------------------------------------------------
    # Each of these truncates the token distribution by a different rule. With
    # more than one active the effective constraint is whichever binds first,
    # so a sweep over one of them reads non-linearly and its derivative is not
    # the derivative of anything.
    active = []
    if float(params.get("lm.top_k") or 0) > 0:
        active.append("top_k")
    if float(params.get("lm.top_p") or 1) < 1:
        active.append("top_p")
    if float(params.get("lm.min_p") or 0) > 0:
        active.append("min_p")
    if len(active) >= 2:
        out.append(f"multiple truncation methods active ({', '.join(active)}) "
                   f"— effective constraint is whichever binds first; sweeps "
                   f"will read non-linearly")

    # -- APG eta range -----------------------------------------------------
    eta = float(params.get("apg.eta") or 0)
    if eta > 1.0:
        out.append(f"eta {eta:g} above 1.0 amplifies the parallel guidance "
                   f"component past standard CFG, opposite to APG's usual "
                   f"purpose — intentional?")

    # -- prompt tension ----------------------------------------------------
    dark = [t for t in _DARK_TERMS if t in low]
    bright = [t for t in _BRIGHT_TERMS if t in low]
    if dark and bright:
        out.append(f"caption pulls both ways on brightness "
                   f"({dark[0]} vs {bright[0]})")

    return out
