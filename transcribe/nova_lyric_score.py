"""
nova_lyric_score.py — score a transcription against the intended lyrics.

Feed it the reference lyrics you wrote and the transcript from Nova Audio
Transcribe, and it reports how faithfully the generated vocal matches the words:
a 0-100 accuracy score, a letter grade, and a full breakdown (word/character
error rate, matched / missing / wrong / extra words, and an aligned diff).

Typical wiring for judging generated songs:
    (mastered audio) -> Nova Audio Transcribe (vocal_isolation=htdemucs)
                     -> transcript -> Nova Lyric Score  <- reference_lyrics

Metrics
-------
* word_accuracy = 1 - WER (Word Error Rate), the headline score.
* char_accuracy = 1 - CER (Character Error Rate) — rewards near-misses/spelling.
* similarity    = difflib ratio on the normalized text — a softer, order-tolerant score.
* breakdown     = correct / substituted / missing (deletions) / extra (insertions),
                  plus coverage (how much of the lyric was actually sung) and an
                  extra-words rate (ad-libs / hallucinations).

Everything is stdlib — no packages to install.
"""
import difflib
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple


try:
    from ..nova_categories import ANALYSIS
except ImportError:  # direct execution / test harness
    from nova_categories import ANALYSIS


try:
    from ..authoring.nova_authoring_common import banner          # type: ignore
except Exception:
    try:
        from nova_authoring_common import banner                  # type: ignore
    except Exception:
        def banner(title: str) -> str:
            bar = "=" * max(12, len(title) + 4)
            return f"{bar}\n  {title}\n{bar}"

VERSION = "1.0.0"
# ANALYSIS, not a string. This line used to hardcode
# "Nova Audio Player/Transcription", which put this node in a top-level menu
# of its own, outside the pack's seven groups -- and the import of ANALYSIS
# three lines up was sitting unused the whole time.
CATEGORY = ANALYSIS


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def normalize(text: str, lowercase: bool, strip_punctuation: bool,
              remove_section_tags: bool, ignore_parentheticals: bool) -> str:
    t = unicodedata.normalize("NFKC", text or "")
    # unify quotes/apostrophes so "don't" == "don’t"
    t = (t.replace("’", "'").replace("‘", "'")
           .replace("“", '"').replace("”", '"'))
    if remove_section_tags:
        t = re.sub(r"\[[^\]]*\]", " ", t)          # [Chorus], [Verse 1], [x2]
    if ignore_parentheticals:
        t = re.sub(r"\([^)]*\)", " ", t)           # (ad-libs), (oh yeah)
    if lowercase:
        t = t.lower()
    if strip_punctuation:
        # keep apostrophes inside words (don't), drop everything else non-word
        t = re.sub(r"[^\w\s']", " ", t)
        t = re.sub(r"(?<!\w)'|'(?!\w)", " ", t)    # stray apostrophes
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ---------------------------------------------------------------------------
# Edit distance (word level, with alignment) + character distance
# ---------------------------------------------------------------------------

def word_alignment(ref: List[str], hyp: List[str]) -> Dict[str, Any]:
    """Minimal-edit alignment of two token lists. Returns counts + op list."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    bp = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i; bp[i][0] = "D"
    for j in range(1, m + 1):
        dp[0][j] = j; bp[0][j] = "I"
    for i in range(1, n + 1):
        ri = ref[i - 1]
        for j in range(1, m + 1):
            if ri == hyp[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]; bp[i][j] = "H"
            else:
                sub, dele, ins = dp[i - 1][j - 1] + 1, dp[i - 1][j] + 1, dp[i][j - 1] + 1
                best = min(sub, dele, ins)
                dp[i][j] = best
                bp[i][j] = "S" if best == sub else ("D" if best == dele else "I")
    i, j = n, m
    ops: List[Tuple[str, Optional[str], Optional[str]]] = []
    while i > 0 or j > 0:
        op = bp[i][j]
        if op == "H":
            ops.append(("H", ref[i - 1], hyp[j - 1])); i -= 1; j -= 1
        elif op == "S":
            ops.append(("S", ref[i - 1], hyp[j - 1])); i -= 1; j -= 1
        elif op == "D":
            ops.append(("D", ref[i - 1], None)); i -= 1
        else:
            ops.append(("I", None, hyp[j - 1])); j -= 1
    ops.reverse()
    counts = {"H": 0, "S": 0, "D": 0, "I": 0}
    for op, _r, _h in ops:
        counts[op] += 1
    return {"counts": counts, "ops": ops}


def char_distance(a: str, b: str) -> int:
    """Levenshtein distance between two strings (two-row DP, distance only)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ---------------------------------------------------------------------------
# Scoring + rendering
# ---------------------------------------------------------------------------

def _grade(score: float) -> str:
    for threshold, letter in ((95, "A+"), (90, "A"), (80, "B"), (70, "C"),
                              (55, "D"), (0, "F")):
        if score >= threshold:
            return letter
    return "F"


def _pct(x: float) -> float:
    return round(max(0.0, min(1.0, x)) * 100.0, 1)


def render_diff(ops, limit: int = 400) -> str:
    """Readable inline diff. Legend: word ok | {ref>hyp} sub | -miss- | +extra+."""
    out: List[str] = []
    for op, r, h in ops[:limit]:
        if op == "H":
            out.append(r)
        elif op == "S":
            out.append("{%s>%s}" % (r, h))
        elif op == "D":
            out.append("-%s-" % r)
        elif op == "I":
            out.append("+%s+" % h)
    tail = "" if len(ops) <= limit else f" … (+{len(ops) - limit} more)"
    return " ".join(out) + tail


def score_lyrics(reference: str, hypothesis: str, *, lowercase=True,
                 strip_punctuation=True, remove_section_tags=True,
                 ignore_parentheticals=False,
                 primary_metric="word_accuracy") -> Dict[str, Any]:
    ref_norm = normalize(reference, lowercase, strip_punctuation, remove_section_tags, ignore_parentheticals)
    hyp_norm = normalize(hypothesis, lowercase, strip_punctuation, remove_section_tags, ignore_parentheticals)
    ref_words, hyp_words = ref_norm.split(), hyp_norm.split()

    align = word_alignment(ref_words, hyp_words)
    c = align["counts"]
    n_ref = max(1, len(ref_words))
    n_hyp = max(1, len(hyp_words))

    wer = (c["S"] + c["D"] + c["I"]) / n_ref
    word_accuracy = _pct(1 - wer)

    cdist = char_distance(ref_norm, hyp_norm)
    cer = cdist / max(1, len(ref_norm))
    char_accuracy = _pct(1 - cer)

    similarity = _pct(difflib.SequenceMatcher(None, ref_norm, hyp_norm).ratio())

    correct_rate = _pct(c["H"] / n_ref)
    coverage = _pct((c["H"] + c["S"]) / n_ref)      # heard (matched or attempted)
    extra_rate = _pct(c["I"] / n_hyp)               # ad-libs / hallucinations

    scores = {"word_accuracy": word_accuracy, "char_accuracy": char_accuracy,
              "similarity": similarity}
    headline = scores.get(primary_metric, word_accuracy)
    grade = _grade(headline)

    report = {
        "score": headline,
        "grade": grade,
        "primary_metric": primary_metric,
        "word_accuracy": word_accuracy,
        "char_accuracy": char_accuracy,
        "similarity": similarity,
        "wer": round(wer, 4),
        "cer": round(cer, 4),
        "reference_words": len(ref_words),
        "transcribed_words": len(hyp_words),
        "correct": c["H"],
        "substituted": c["S"],
        "missing": c["D"],
        "extra": c["I"],
        "correct_rate": correct_rate,
        "coverage": coverage,
        "extra_words_rate": extra_rate,
    }
    report["diff"] = render_diff(align["ops"])
    return report


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------

class NovaLyricScore:
    CATEGORY = CATEGORY
    FUNCTION = "score"
    RETURN_TYPES = ("FLOAT", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("score", "grade", "report_json", "report_text")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "Headline accuracy 0-100 (the chosen primary metric).",
        "Letter grade for the score.",
        "Full metrics as JSON.",
        "Human-readable report incl. the aligned diff — wire into Nova Console.",
    )
    DESCRIPTION = (
        f"Nova Lyric Score v{VERSION} — compares a transcript against the intended "
        "lyrics and scores accuracy (WER/CER, matched/missing/extra, aligned diff)."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference_lyrics": ("STRING", {
                    "default": "", "multiline": True, "forceInput": False,
                    "placeholder": "Paste the intended lyrics here.",
                    "tooltip": "The ground-truth lyrics you generated the song from.",
                }),
                "transcript": ("STRING", {
                    "default": "", "multiline": True, "forceInput": True,
                    "tooltip": "The transcript to score — wire the 'text' output of Nova Audio Transcribe here.",
                }),
                "primary_metric": (["word_accuracy", "similarity", "char_accuracy"], {
                    "default": "word_accuracy",
                    "tooltip": "Which metric the headline score/grade uses. word_accuracy = 1-WER (strict); similarity = softer, order-tolerant.",
                }),
            },
            "optional": {
                "lowercase": ("BOOLEAN", {"default": True, "tooltip": "Case-insensitive comparison."}),
                "strip_punctuation": ("BOOLEAN", {"default": True, "tooltip": "Ignore punctuation (keeps apostrophes in words)."}),
                "remove_section_tags": ("BOOLEAN", {"default": True, "tooltip": "Drop [Chorus], [Verse 1], [x2] style tags from the reference."}),
                "ignore_parentheticals": ("BOOLEAN", {"default": False, "tooltip": "Also drop (ad-libs) in parentheses before scoring."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import hashlib
        h = hashlib.blake2b(digest_size=16)
        for key in sorted(kwargs):
            h.update(f"{key}={kwargs[key]}".encode("utf-8", "ignore"))
        return h.hexdigest()

    def score(self, reference_lyrics, transcript, primary_metric,
              lowercase=True, strip_punctuation=True, remove_section_tags=True,
              ignore_parentheticals=False, **kwargs):
        report = score_lyrics(
            reference_lyrics, transcript,
            lowercase=lowercase, strip_punctuation=strip_punctuation,
            remove_section_tags=remove_section_tags,
            ignore_parentheticals=ignore_parentheticals,
            primary_metric=primary_metric,
        )

        lines: List[str] = [banner(f"NOVA LYRIC SCORE v{VERSION}")]
        lines.append(f"Score       : {report['score']:.1f} / 100   grade {report['grade']}"
                     f"   ({report['primary_metric']})")
        lines.append(f"Word acc    : {report['word_accuracy']:.1f}%   (WER {report['wer']:.3f})")
        lines.append(f"Char acc    : {report['char_accuracy']:.1f}%   (CER {report['cer']:.3f})")
        lines.append(f"Similarity  : {report['similarity']:.1f}%")
        lines.append("")
        lines.append(f"Reference   : {report['reference_words']} words   "
                     f"Transcribed: {report['transcribed_words']} words")
        lines.append(f"Correct     : {report['correct']}   ({report['correct_rate']:.1f}%)")
        lines.append(f"Substituted : {report['substituted']}")
        lines.append(f"Missing     : {report['missing']}   (coverage {report['coverage']:.1f}%)")
        lines.append(f"Extra       : {report['extra']}   (extra-words {report['extra_words_rate']:.1f}%)")
        lines.append("")
        lines.append("Diff  (word ok | {ref>hyp} wrong | -missing- | +extra+):")
        lines.append(report["diff"])

        text = "\n".join(lines)
        print(text)
        report_json = json.dumps(report, ensure_ascii=False, indent=2)
        return {"ui": {"text": [text]},
                "result": (float(report["score"]), report["grade"], report_json, text)}


NODE_CLASS_MAPPINGS = {"NovaLyricScore": NovaLyricScore}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaLyricScore": "Nova Lyric Score 📊"}
