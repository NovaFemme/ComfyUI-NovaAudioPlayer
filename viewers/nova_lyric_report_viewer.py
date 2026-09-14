"""
nova_lyric_report_viewer.py — visual report for Nova Audio Transcribe + Nova Lyric Score.

A sibling to the Track Inspector viewer, in the same dark card style. It renders
the transcription + lyric-accuracy data into three views:

    Dashboard      — score/grade, KPI tiles, breakdown, a colour-coded diff
                     preview, and (if wired) a track-volatility strip.
    Transcription  — the lyrics as a timed list + a volatility-over-time chart of
                     the track; repetition-loop segments (Whisper hallucinations)
                     are flagged.
    Lyric Report   — the full styled score with the complete colour-coded
                     actual-vs-transcription diff.

Inputs are JSON strings produced elsewhere in the graph:
    lyric_report_json   <- Nova Lyric Score (report_json)   [required]
    transcription_json  <- Nova Audio Transcribe (json)     [optional]
    inspection_json     <- Nova Track Inspector             [optional, for the
                            stability/volatility timeline]

Rendering is self-contained (inline CSS/SVG) and pushed to the node via
`ui.nova_lyric_report`; web/nova_lyric_report_viewer.js injects it. Nothing here
touches the transcribe/score nodes.
"""
from __future__ import annotations
import html as _html
import json
from typing import Any, Dict, List, Optional, Tuple

try:
    from ..nova_categories import REPORT              # type: ignore
except Exception:
    try:
        from nova_categories import REPORT            # type: ignore
    except Exception:
        REPORT = "Nova Audio Player/Report"

VERSION = "1.0.0"

# Palettes — "Nova Dark" matches the Track Inspector.
THEMES = {
    "Nova Dark":      dict(bg="#0d1117", panel="#161b26", panel2="#1b2333", border="#232c3c",
                           text="#c9d3df", muted="#8592a3", blue="#4aa3ff", green="#3fb950",
                           amber="#d29922", red="#f85149", track="#0b0f16", grid="#1f2836"),
    "High Contrast":  dict(bg="#000000", panel="#0b0b0b", panel2="#151515", border="#333333",
                           text="#ffffff", muted="#b6b6b6", blue="#5ab0ff", green="#37d353",
                           amber="#ffbf47", red="#ff5b52", track="#000000", grid="#222222"),
    "Studio Slate":   dict(bg="#1b1f27", panel="#232935", panel2="#2b323f", border="#3a4250",
                           text="#dce3ec", muted="#93a0b2", blue="#6bb3ff", green="#57c66a",
                           amber="#e0a93a", red="#ff6b62", track="#171b22", grid="#2c3444"),
}

# Every renderer receives its palette as a dict of colours. We pass this VARS
# dict (each colour -> a CSS custom property reference) instead of literal hex,
# so the produced HTML is theme-NEUTRAL: the front-end sets --bg/--fs/… from the
# node's theme + font_scale dropdowns and can re-theme a loaded report live,
# without re-running the graph. palette_css() emits the concrete :root values.
PALETTE_KEYS = ("bg", "panel", "panel2", "border", "text", "muted",
                "blue", "green", "amber", "red", "track", "grid")
VARS = {k: f"var(--{k})" for k in PALETTE_KEYS}


def palette_css(theme: str, font_scale: float) -> str:
    """The :root block: concrete palette + font multiplier for one theme."""
    T = THEMES.get(theme, THEMES["Nova Dark"])
    fs = max(0.75, min(1.6, float(font_scale)))
    decls = ";".join(f"--{k}:{T.get(k, '#000')}" for k in PALETTE_KEYS)
    return f":root{{{decls};--fs:{fs:.3f}}}"


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def esc(x: Any) -> str:
    return _html.escape(str(x if x is not None else ""), quote=True)


def _load(s: Any) -> Optional[Dict[str, Any]]:
    if not s:
        return None
    if isinstance(s, dict):
        return s
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def mmss(seconds: Optional[float]) -> str:
    try:
        s = float(seconds)
    except (TypeError, ValueError):
        return "--:--"
    m, s = divmod(int(round(s)), 60)
    return f"{m:d}:{s:02d}"


def grade_color(grade: str, T: Dict[str, str]) -> str:
    g = (grade or "").upper()
    if g in ("A+", "A", "A-"):
        return T["green"]
    if g in ("B", "B+", "B-", "C", "C+", "C-"):
        return T["amber"]
    return T["red"]


def score_color(pct: float, T: Dict[str, str]) -> str:
    if pct >= 80:
        return T["green"]
    if pct >= 55:
        return T["amber"]
    return T["red"]


def _first(d: Dict[str, Any], *keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


# ---------------------------------------------------------------------------
# components
# ---------------------------------------------------------------------------

def tile(label: str, value: str, T: Dict[str, str], sub: str = "", color: str = "") -> str:
    val_color = color or T["text"]
    sub_html = f'<div class="nlr-sub">{esc(sub)}</div>' if sub else ""
    return (f'<div class="nlr-tile"><div class="nlr-k">{esc(label)}</div>'
            f'<div class="nlr-v" style="color:{val_color}">{esc(value)}</div>{sub_html}</div>')


def bar(pct: float, T: Dict[str, str], color: str = "") -> str:
    pct = max(0.0, min(100.0, float(pct)))
    c = color or score_color(pct, T)
    return (f'<div class="nlr-bar"><div class="nlr-bar-fill" '
            f'style="width:{pct:.1f}%;background:{c}"></div></div>')


def score_bar_row(label: str, pct: float, T: Dict[str, str]) -> str:
    return (f'<div class="nlr-srow"><div class="nlr-slabel">{esc(label)}</div>'
            f'{bar(pct, T)}<div class="nlr-sval">{pct:.1f}</div></div>')


def render_diff(diff: str, T: Dict[str, str]) -> str:
    """Colour the compact diff string from Nova Lyric Score into wrapped tokens."""
    out: List[str] = []
    for tok in (diff or "").split(" "):
        if not tok:
            continue
        if tok.startswith("{") and tok.endswith("}") and ">" in tok:
            ref, _, hyp = tok[1:-1].partition(">")
            out.append(f'<span class="nlr-sub" title="expected: {esc(ref)}">'
                       f'<s>{esc(ref)}</s>&nbsp;{esc(hyp)}</span>')
        elif len(tok) >= 2 and tok.startswith("-") and tok.endswith("-"):
            out.append(f'<span class="nlr-del">{esc(tok[1:-1])}</span>')
        elif len(tok) >= 2 and tok.startswith("+") and tok.endswith("+"):
            out.append(f'<span class="nlr-ins">{esc(tok[1:-1])}</span>')
        elif tok.startswith("…") or tok.startswith("(+"):
            out.append(f'<span class="nlr-more">{esc(tok)}</span>')
        else:
            out.append(f'<span class="nlr-ok">{esc(tok)}</span>')
    legend = ('<div class="nlr-legend">'
              '<span class="nlr-ok">correct</span>'
              '<span class="nlr-sub"><s>ref</s>&nbsp;hyp</span>'
              '<span class="nlr-del">missing</span>'
              '<span class="nlr-ins">extra</span></div>')
    return legend + '<div class="nlr-diff">' + " ".join(out) + "</div>"


def _markers(insp: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not insp:
        return []
    raw = _first(insp, "markers", "priority_markers", "issues", default=[]) or []
    out = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        start = _first(m, "start", "t", "time", "start_s", default=None)
        end = _first(m, "end", "end_s", default=start)
        sev = str(_first(m, "severity", "priority", "level", default="")).lower()
        score = _first(m, "score", "confidence", "strength", default=None)
        out.append({"start": start, "end": end, "severity": sev,
                    "score": score, "label": _first(m, "label", "name", "category", default="")})
    return [m for m in out if m["start"] is not None]


def volatility_svg(insp: Optional[Dict[str, Any]], duration: float, T: Dict[str, str],
                   segments: Optional[List[Dict[str, Any]]] = None) -> str:
    """A volatility-over-time strip: anomaly density (from inspector markers) as
    bars, with lyric segments as a lane beneath. Higher bars = less stable."""
    W, H = 900, 150
    pad_l, pad_r, top, lane_h = 8, 8, 8, 26
    plot_h = H - top - lane_h - 22
    inner_w = W - pad_l - pad_r
    dur = max(1.0, float(duration or 1.0))
    markers = _markers(insp)

    def x(t):
        return pad_l + inner_w * max(0.0, min(1.0, float(t) / dur))

    parts = [f'<svg viewBox="0 0 {W} {H}" width="100%" preserveAspectRatio="none" '
             f'style="display:block">']
    parts.append(f'<rect x="0" y="0" width="{W}" height="{H}" style="fill:{T["track"]}" rx="6"/>')
    # time grid + labels (every ~30s)
    step = 30 if dur > 90 else 15
    t = 0
    while t <= dur:
        gx = x(t)
        parts.append(f'<line x1="{gx:.1f}" y1="{top}" x2="{gx:.1f}" y2="{top+plot_h}" '
                     f'style="stroke:{T["grid"]}" stroke-width="1"/>')
        parts.append(f'<text x="{gx:.1f}" y="{H-6}" style="fill:{T["muted"]}" font-size="10" '
                     f'text-anchor="middle">{mmss(t)}</text>')
        t += step
    # volatility bars: bin marker severity
    bins = 80
    acc = [0.0] * bins
    for m in markers:
        sev = m["severity"]
        w = 3.0 if "crit" in sev else (2.0 if "warn" in sev or "high" in sev else 1.0)
        sc = m["score"]
        try:
            w *= (0.5 + float(sc) / 100.0)
        except (TypeError, ValueError):
            pass
        b = min(bins - 1, max(0, int(bins * float(m["start"]) / dur)))
        acc[b] += w
    peak = max(acc) or 1.0
    bw = inner_w / bins
    for i, v in enumerate(acc):
        if v <= 0:
            continue
        bh = plot_h * (v / peak)
        bx = pad_l + i * bw
        intensity = v / peak
        col = T["red"] if intensity > 0.55 else (T["amber"] if intensity > 0.2 else T["blue"])
        parts.append(f'<rect x="{bx:.1f}" y="{top+plot_h-bh:.1f}" width="{max(1.0,bw-1):.1f}" '
                     f'height="{bh:.1f}" style="fill:{col}" opacity="0.85" rx="1"/>')
    # baseline
    parts.append(f'<line x1="{pad_l}" y1="{top+plot_h}" x2="{W-pad_r}" y2="{top+plot_h}" '
                 f'style="stroke:{T["border"]}" stroke-width="1"/>')
    # lyric segment lane
    lane_y = top + plot_h + 6
    for s in (segments or []):
        st = s.get("start")
        if st is None or not (s.get("text") or "").strip():
            continue
        en = s.get("end") if s.get("end") not in (None,) else st
        try:
            if float(en) < float(st):
                en = st
        except (TypeError, ValueError):
            en = st
        sx, ex = x(st), x(en if en is not None else st)
        loop = _is_loop(s.get("text", ""))
        col = T["red"] if loop else T["green"]
        parts.append(f'<rect x="{sx:.1f}" y="{lane_y}" width="{max(2.0,ex-sx):.1f}" '
                     f'height="{lane_h-8}" rx="2" style="fill:{col}" opacity="0.55"/>')
    parts.append(f'<text x="{pad_l}" y="{lane_y+lane_h-9}" style="fill:{T["muted"]}" '
                 f'font-size="9">lyrics</text>')
    parts.append("</svg>")
    cap = ('Track volatility (anomaly density from the Inspector) over time — taller = less stable. '
           'Lyric segments below; red = repetition loop.') if markers else \
          ('Lyric segments over time (wire the Inspector JSON in to overlay track volatility).')
    return '<div class="nlr-svgwrap">' + "".join(parts) + f'<div class="nlr-cap">{cap}</div></div>'


def _is_loop(text: str) -> bool:
    words = (text or "").split()
    if len(words) < 12:
        return False
    uniq = len(set(w.lower().strip(",.") for w in words))
    return uniq / max(1, len(words)) < 0.2


# ---------------------------------------------------------------------------
# views
# ---------------------------------------------------------------------------

def view_dashboard(lyric, trans, insp, T) -> str:
    if not lyric:
        return '<div class="nlr-empty">Wire a Nova Lyric Score <b>report_json</b> into this node.</div>'
    score = float(_first(lyric, "score", default=0.0) or 0.0)
    grade = str(_first(lyric, "grade", default="—"))
    gc = grade_color(grade, T)
    metric = str(_first(lyric, "primary_metric", default=""))

    head = (f'<div class="nlr-head">'
            f'<div><div class="nlr-title">NOVA LYRIC REPORT</div>'
            f'<div class="nlr-subtitle">accuracy of the sung lyrics vs. the intended lyrics</div></div>'
            f'<div class="nlr-scorebox" style="border-color:{gc}">'
            f'<div class="nlr-score" style="color:{gc}">{score:.1f}</div>'
            f'<div class="nlr-scoresub">/ 100 &nbsp; <b style="color:{gc}">{esc(grade)}</b></div>'
            f'<div class="nlr-metric">{esc(metric)}</div></div></div>')

    kpis = ('<div class="nlr-tiles">'
            + tile("Word accuracy", f'{_first(lyric,"word_accuracy",default=0):.1f}%', T,
                   f'WER {_first(lyric,"wer",default=0):.3f}', score_color(float(_first(lyric,"word_accuracy",default=0)), T))
            + tile("Char accuracy", f'{_first(lyric,"char_accuracy",default=0):.1f}%', T,
                   f'CER {_first(lyric,"cer",default=0):.3f}')
            + tile("Similarity", f'{_first(lyric,"similarity",default=0):.1f}%', T)
            + tile("Reference", f'{_first(lyric,"reference_words",default=0)}', T, "words")
            + tile("Transcribed", f'{_first(lyric,"transcribed_words",default=0)}', T, "words")
            + '</div>')

    breakdown = ('<div class="nlr-tiles">'
                 + tile("Correct", f'{_first(lyric,"correct",default=0)}', T,
                        f'{_first(lyric,"correct_rate",default=0):.1f}% of reference', T["green"])
                 + tile("Substituted", f'{_first(lyric,"substituted",default=0)}', T, "wrong words", T["amber"])
                 + tile("Missing", f'{_first(lyric,"missing",default=0)}', T,
                        f'coverage {_first(lyric,"coverage",default=0):.1f}%', T["blue"])
                 + tile("Extra", f'{_first(lyric,"extra",default=0)}', T,
                        f'{_first(lyric,"extra_words_rate",default=0):.1f}% of transcript', T["red"])
                 + '</div>')

    # interpretive callout when insertions dominate (the hallucination case)
    callout = ""
    extra = int(_first(lyric, "extra", default=0) or 0)
    corr = float(_first(lyric, "correct_rate", default=0) or 0)
    if extra > 0 and (int(_first(lyric, "transcribed_words", default=0) or 0) >
                      int(_first(lyric, "reference_words", default=1) or 1) * 1.3) and corr >= 70:
        callout = (f'<div class="nlr-note">⚠ {corr:.0f}% of the reference words were transcribed correctly, but '
                   f'{extra} <b>extra</b> words drag the strict word-accuracy down. That pattern usually means a '
                   f'Whisper repetition/hallucination on an instrumental section — turn on <b>vocal_isolation</b>, '
                   f'or judge with <b>similarity</b>.</div>')

    duration = float(_first(trans or {}, "duration_seconds", default=_first(insp or {}, "duration", default=0)) or 0)
    strip = volatility_svg(insp, duration, T, (trans or {}).get("segments")) if (insp or trans) else ""

    diff_prev = render_diff(_first(lyric, "diff", default=""), T)
    return (head + kpis + breakdown + callout
            + (f'<div class="nlr-card"><div class="nlr-h">Track volatility & lyrics over time</div>{strip}</div>' if strip else "")
            + f'<div class="nlr-card"><div class="nlr-h">Actual vs. transcription</div>{diff_prev}</div>')


def view_transcription(lyric, trans, insp, T) -> str:
    if not trans:
        return '<div class="nlr-empty">Wire the Nova Audio Transcribe <b>json</b> output into this node.</div>'
    duration = float(_first(trans, "duration_seconds", default=_first(insp or {}, "duration", default=0)) or 0)
    model = esc(_first(trans, "model", default=""))
    lang = esc(_first(trans, "language", default=""))
    head = (f'<div class="nlr-head"><div><div class="nlr-title">TRANSCRIPTION</div>'
            f'<div class="nlr-subtitle">{model} · {mmss(duration)} · lang {lang}</div></div></div>')
    strip = volatility_svg(insp, duration, T, trans.get("segments"))
    rows = []
    loops = 0
    for s in (trans.get("segments") or []):
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        loop = _is_loop(txt)
        loops += 1 if loop else 0
        cls = "nlr-seg nlr-seg-loop" if loop else "nlr-seg"
        flag = ' <span class="nlr-flag">repetition loop</span>' if loop else ""
        disp = (txt[:160] + " …") if loop and len(txt) > 160 else txt
        rows.append(f'<div class="{cls}"><span class="nlr-ts">{mmss(s.get("start"))}</span>'
                    f'<span class="nlr-segtext">{esc(disp)}{flag}</span></div>')
    warn = (f'<div class="nlr-note">⚠ {loops} segment(s) look like a repetition loop (likely a Whisper '
            f'hallucination on instrumental audio). They inflate the transcript and the extra-word count.</div>'
            if loops else "")
    return (head
            + f'<div class="nlr-card"><div class="nlr-h">Volatility & lyric timeline</div>{strip}</div>'
            + warn
            + '<div class="nlr-card"><div class="nlr-h">Lyrics (timed)</div>' + "".join(rows) + "</div>")


def view_lyric_report(lyric, trans, insp, T) -> str:
    if not lyric:
        return '<div class="nlr-empty">Wire a Nova Lyric Score <b>report_json</b> into this node.</div>'
    score = float(_first(lyric, "score", default=0.0) or 0.0)
    grade = str(_first(lyric, "grade", default="—"))
    gc = grade_color(grade, T)
    head = (f'<div class="nlr-head"><div><div class="nlr-title">NOVA LYRIC SCORE</div>'
            f'<div class="nlr-subtitle">full accuracy report</div></div>'
            f'<div class="nlr-scorebox" style="border-color:{gc}">'
            f'<div class="nlr-score" style="color:{gc}">{score:.1f}</div>'
            f'<div class="nlr-scoresub">/ 100 &nbsp; <b style="color:{gc}">{esc(grade)}</b></div></div></div>')
    metrics = ('<div class="nlr-card"><div class="nlr-h">Metrics</div>'
               + score_bar_row(f'Word accuracy  (WER {_first(lyric,"wer",default=0):.3f})', float(_first(lyric,"word_accuracy",default=0)), T)
               + score_bar_row(f'Char accuracy  (CER {_first(lyric,"cer",default=0):.3f})', float(_first(lyric,"char_accuracy",default=0)), T)
               + score_bar_row('Similarity', float(_first(lyric,"similarity",default=0)), T)
               + score_bar_row('Correct words', float(_first(lyric,"correct_rate",default=0)), T)
               + score_bar_row('Coverage (heard)', float(_first(lyric,"coverage",default=0)), T)
               + '</div>')
    counts = ('<div class="nlr-tiles">'
              + tile("Correct", f'{_first(lyric,"correct",default=0)}', T, "", T["green"])
              + tile("Substituted", f'{_first(lyric,"substituted",default=0)}', T, "", T["amber"])
              + tile("Missing", f'{_first(lyric,"missing",default=0)}', T, "", T["blue"])
              + tile("Extra", f'{_first(lyric,"extra",default=0)}', T, "", T["red"])
              + '</div>')
    diff = render_diff(_first(lyric, "diff", default=""), T)
    return head + counts + metrics + f'<div class="nlr-card"><div class="nlr-h">Actual vs. transcription</div>{diff}</div>'


# ---------------------------------------------------------------------------
# css + wrapper
# ---------------------------------------------------------------------------

def css() -> str:
    """Theme-neutral stylesheet: colours are var(--x), sizes scale by var(--fs).
    The concrete values come from palette_css()/the front-end's :root block."""
    return """<style>
.nlr { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,Arial,sans-serif;
  font-size:calc(13px * var(--fs)); padding:12px; border-radius:8px; box-sizing:border-box; line-height:1.45; }
.nlr * { box-sizing:border-box; }
.nlr-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px; }
.nlr-title { color:var(--blue); font-weight:700; letter-spacing:.06em; font-size:calc(15px * var(--fs)); }
.nlr-subtitle { color:var(--muted); font-size:calc(11px * var(--fs)); margin-top:2px; }
.nlr-scorebox { text-align:right; border:1px solid var(--border); border-radius:8px; padding:6px 12px; min-width:110px; }
.nlr-score { font-size:calc(30px * var(--fs)); font-weight:800; line-height:1; }
.nlr-scoresub { color:var(--muted); font-size:calc(11px * var(--fs)); }
.nlr-metric { color:var(--muted); font-size:calc(10px * var(--fs)); margin-top:2px; }
.nlr-tiles { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.nlr-tile { flex:1 1 120px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
.nlr-k { color:var(--muted); font-size:calc(10px * var(--fs)); text-transform:uppercase; letter-spacing:.04em; }
.nlr-v { font-size:calc(19px * var(--fs)); font-weight:700; margin-top:2px; }
.nlr-sub { color:var(--muted); font-size:calc(10px * var(--fs)); }
.nlr-card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.nlr-h { color:var(--muted); font-size:calc(11px * var(--fs)); text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
.nlr-note { background:var(--panel2); border-left:3px solid var(--amber); border-radius:4px; padding:8px 10px;
  color:var(--text); font-size:calc(11.5px * var(--fs)); margin-bottom:10px; }
.nlr-empty { color:var(--muted); padding:20px; text-align:center; }
.nlr-srow { display:flex; align-items:center; gap:10px; margin:5px 0; }
.nlr-slabel { width:230px; color:var(--text); font-size:calc(11.5px * var(--fs)); }
.nlr-sval { width:44px; text-align:right; color:var(--text); font-variant-numeric:tabular-nums; }
.nlr-bar { flex:1; height:8px; background:var(--panel2); border-radius:5px; overflow:hidden; }
.nlr-bar-fill { height:100%; border-radius:5px; }
.nlr-diff { font-family:'JetBrains Mono',Consolas,monospace; font-size:calc(12px * var(--fs)); line-height:1.9;
  word-break:break-word; }
.nlr-diff .nlr-ok { color:var(--text); }
.nlr-sub { color:var(--amber); }
.nlr-diff .nlr-del { color:var(--blue); }
.nlr-diff .nlr-ins { color:var(--red); }
.nlr-more { color:var(--muted); font-style:italic; }
.nlr-legend { display:flex; gap:14px; margin-bottom:8px; font-size:calc(10.5px * var(--fs)); }
.nlr-legend span { }
.nlr-svgwrap { }
.nlr-cap { color:var(--muted); font-size:calc(10px * var(--fs)); margin-top:4px; }
.nlr-seg { display:flex; gap:10px; padding:3px 0; border-bottom:1px solid var(--grid); }
.nlr-seg-loop { background:rgba(248,81,73,.08); }
.nlr-ts { color:var(--muted); font-variant-numeric:tabular-nums; min-width:44px; font-size:calc(11px * var(--fs)); }
.nlr-segtext { color:var(--text); font-size:calc(12.5px * var(--fs)); }
.nlr-flag { color:var(--red); font-size:calc(10px * var(--fs)); border:1px solid var(--red); border-radius:4px;
  padding:0 5px; margin-left:6px; }
</style>"""


VIEWS = {"Dashboard": view_dashboard, "Transcription": view_transcription, "Lyric Report": view_lyric_report}


def render_body(view_mode: str, lyric, trans, insp) -> str:
    """Theme-NEUTRAL HTML for one view: var()-based CSS + body, no :root.
    The front-end supplies the :root palette + --fs from the node's dropdowns,
    so a loaded report can be re-themed/re-scaled live without a graph re-run."""
    fn = VIEWS.get(view_mode, view_dashboard)
    try:
        body = fn(lyric, trans, insp, VARS)
    except Exception as exc:   # never let a render error take the node down
        body = f'<div class="nlr-empty">Could not render ({esc(type(exc).__name__)}: {esc(exc)}).</div>'
    return css() + f'<div class="nlr">{body}</div>'


def build_html(view_mode: str, theme: str, font_scale: float,
               lyric, trans, insp) -> str:
    """Self-contained HTML (for standalone use / the back-compat 'html' field):
    the neutral body prefixed with a concrete :root for the given theme+scale."""
    return (f'<style>{palette_css(theme, font_scale)}</style>'
            + render_body(view_mode, lyric, trans, insp))


# ---------------------------------------------------------------------------
# node
# ---------------------------------------------------------------------------

class NovaLyricReportViewer:
    CATEGORY = REPORT
    FUNCTION = "render"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lyric_report_json",)
    OUTPUT_NODE = True
    DESCRIPTION = ("Nova Lyric Report Viewer — visualises Nova Audio Transcribe + Nova Lyric Score "
                   "(Dashboard / Transcription / Lyric Report), in the Track Inspector's style.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lyric_report_json": ("STRING", {"forceInput": True}),
                "view_mode": (["Dashboard", "Transcription", "Lyric Report"], {"default": "Dashboard"}),
                "theme": (["Nova Dark", "High Contrast", "Studio Slate"], {"default": "Nova Dark"}),
                "font_scale": ("FLOAT", {"default": 1.0, "min": 0.75, "max": 1.5, "step": 0.05}),
            },
            "optional": {
                "transcription_json": ("STRING", {"forceInput": True}),
                "inspection_json": ("STRING", {"forceInput": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import hashlib
        h = hashlib.blake2b(digest_size=16)
        for k in sorted(kwargs):
            h.update(f"{k}={kwargs[k]}".encode("utf-8", "ignore"))
        return h.hexdigest()

    def render(self, lyric_report_json, view_mode="Dashboard", theme="Nova Dark",
               font_scale=1.0, transcription_json="", inspection_json="", **kwargs):
        lyric = _load(lyric_report_json)
        trans = _load(transcription_json)
        insp = _load(inspection_json)
        # Render ALL views once as THEME-NEUTRAL HTML, and ship the palettes.
        # The front-end applies the selected theme + font_scale from the node's
        # dropdowns, so it can switch view AND re-theme/re-scale a loaded report
        # instantly — no graph re-run. (A fresh run still bakes nothing in.)
        views = {name: render_body(name, lyric, trans, insp) for name in VIEWS}
        block = {
            "views": views,                 # {view_name: theme-neutral html}
            "themes": THEMES,                # {theme_name: {var: colour}}
            "view_mode": view_mode,          # initial selection
            "theme": theme,                  # initial theme dropdown value
            "font_scale": float(font_scale), # initial scale
            # back-compat: a self-contained render of the selected view
            "html": build_html(view_mode, theme, float(font_scale), lyric, trans, insp),
        }
        return {"ui": {"nova_lyric_report": [block]}, "result": (lyric_report_json,)}


# NOTE: no WEB_DIRECTORY here. Inside the pack, ComfyUI serves the JS from the
# pack's own web/ folder (the pack __init__.py declares WEB_DIRECTORY). Drop
# web/nova_lyric_report_viewer.js into comfyui-novaaudioplayer/web/.

NODE_CLASS_MAPPINGS = {"NovaLyricReportViewer": NovaLyricReportViewer}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaLyricReportViewer": "Nova Lyric Report 📈"}
