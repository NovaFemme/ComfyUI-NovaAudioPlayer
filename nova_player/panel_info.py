"""panel_info — the bench panel's contents as a string, for other nodes.

WHY THIS EXISTS

The bench strip is the one place in the workflow where a take's measurements all
agree with each other, because they come from a single `compute_bench()` call on
the same tensor that produced the file. That was previously visible only on
screen. This module renders the identical set of figures to a string so it can
be logged to a database, shown in a text node, or appended to a CSV.

MIRRORS THE PANEL, DELIBERATELY. Every value here appears on the strip, in the
same order, formatted by the same rules — `fmtDb`, the band percentages, the
"none" for no clipping, the em dash for a missing figure. If the panel and this
output ever disagree, this file is wrong. The one addition is `generated_at`,
which the panel has no reason to show but a logged row does.

Kept out of node.py because that file's job is to render audio and hand the
front end a payload, and formatting rules that must track `bench-panel.js`
belong somewhere they can be read next to it.
"""

import csv
import io
import json
from datetime import datetime, timezone

# Matches DB_FLOOR in web/ui/bench-panel.js: values this low are "nothing"
# rather than a real measurement, and read as a dash.
DB_FLOOR = -119.0

# Band order as the strip draws it, left to right.
BANDS = (("BASS", "0-250"), ("MID", "250-2k"), ("PRES", "2k-6k"), ("HF", "6k+"))

# Column order for csv_row. Stable: appending to an existing log must not
# silently shift columns, so new fields go on the END of this tuple.
CSV_COLUMNS = (
    "generated_at", "filename", "duration_s", "sample_rate", "channels",
    "stereo", "samples", "filesize_bytes", "lufs",
    "peak_db", "rms_db", "crest_db", "clipped_samples", "clipped_pct",
    "over_fs", "lr_corr", "dc_offset",
    "band_bass_pct", "band_mid_pct", "band_pres_pct", "band_hf_pct",
    "hf_outliers",
)


def _fmt_db(v):
    """Same rule as fmtDb() in bench-panel.js."""
    if v is None or v <= DB_FLOOR:
        return "—"
    return f"{'+' if v > 0 else ''}{v:.2f} dBFS"


def _fmt_bytes(n):
    """Same rule as fmtBytes() in bench-panel.js."""
    if not n:
        return None
    units = ("B", "kB", "MB", "GB")
    i, v = 0, float(n)
    while v >= 1024 and i < len(units) - 1:
        v /= 1024.0
        i += 1
    # int(v + 0.5), not round(): Python rounds halves to even and JS's
    # Math.round rounds them up, so round() would disagree with the strip on an
    # exact .5. Cosmetic, but this file exists to not disagree with the strip.
    return f"{v:.1f} {units[i]}" if v < 10 and i else f"{int(v + 0.5)} {units[i]}"


def _fmt_time(seconds):
    """m:ss, as the transport's time labels read."""
    if seconds is None:
        return "—"
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def _warnings(bench):
    """The reasons the strip colours a row. Only these are ever shouted."""
    out = []
    peak = bench.get("peak_db")
    if peak is not None and peak > 0:
        out.append(f"+{peak:.2f} dB over full scale")
    if bench.get("over_fs"):
        out.append(f"{bench['over_fs']} samples clipped by the WAV write")
    corr = bench.get("lr_corr")
    if corr is not None and corr < 0:
        out.append("out of phase")
    return out


def _rows(data):
    """The panel's two columns as ordered (label, value) pairs."""
    bench = data.get("bench") or {}

    metrics = [
        ("PEAK", _fmt_db(bench.get("peak_db"))),
        ("RMS", _fmt_db(bench.get("rms_db"))),
        ("CREST", "—" if bench.get("crest_db") is None
                  else f"{bench['crest_db']:.2f} dB"),
        ("CLIPPED", f"{bench['clipped_samples']} ({bench.get('clipped_pct', 0):.4f}%)"
                    if bench.get("clipped_samples") else "none"),
        ("L/R CORR", "mono" if bench.get("lr_corr") is None
                     else f"{bench['lr_corr']:.3f}"),
        ("DC", "—" if bench.get("dc_offset") is None
               else f"{bench['dc_offset']:.5f}"),
    ]

    bands = bench.get("bands") or {}
    for key, hint in BANDS:
        metrics.append((f"{key} ({hint})", f"{bands.get(key, 0.0):.1f}%"))
    if bench.get("hf_outliers"):
        metrics.append(("HF OUTLIERS >16k", str(bench["hf_outliers"])))

    fmt = f"{data.get('sample_rate') or '?'} Hz · " \
          f"{'stereo' if data.get('stereo') else 'mono'}"
    if bench.get("channels"):
        fmt += f" · {bench['channels']} ch"

    duration = data.get("duration")
    info = [
        ("FILE", data.get("filename") or "—"),
        ("FORMAT", fmt),
        ("LENGTH", "—" if duration is None
                   else f"{_fmt_time(duration)} ({duration:.2f} s)"),
    ]
    if bench.get("samples"):
        info.append(("SAMPLES", f"{bench['samples']:,}"))
    if data.get("lufs") is not None:
        info.append(("LOUDNESS", f"{data['lufs']:.1f} LUFS"))
    size = _fmt_bytes(data.get("filesize"))
    if size:
        info.append(("SIZE", size))

    return metrics, info


def _flat(data, generated_at):
    """Raw values, one level deep, for csv_row. Keys match CSV_COLUMNS."""
    bench = data.get("bench") or {}
    bands = bench.get("bands") or {}
    return {
        "generated_at": generated_at,
        "filename": data.get("filename"),
        "duration_s": data.get("duration"),
        "sample_rate": data.get("sample_rate"),
        "channels": bench.get("channels"),
        "stereo": bool(data.get("stereo")),
        "samples": bench.get("samples"),
        "filesize_bytes": data.get("filesize"),
        "lufs": data.get("lufs"),
        "peak_db": bench.get("peak_db"),
        "rms_db": bench.get("rms_db"),
        "crest_db": bench.get("crest_db"),
        "clipped_samples": bench.get("clipped_samples"),
        "clipped_pct": bench.get("clipped_pct"),
        "over_fs": bench.get("over_fs"),
        "lr_corr": bench.get("lr_corr"),
        "dc_offset": bench.get("dc_offset"),
        "band_bass_pct": bands.get("BASS"),
        "band_mid_pct": bands.get("MID"),
        "band_pres_pct": bands.get("PRES"),
        "band_hf_pct": bands.get("HF"),
        "hf_outliers": bench.get("hf_outliers"),
    }


def build_panel_info(data, fmt="json"):
    """Render the bench panel's contents as a string.

    @param data  the same payload the front end receives: filename, duration,
                 sample_rate, stereo, lufs, filesize, bench
    @param fmt   "json" | "text" | "csv_row"

    Never raises: a formatting failure here must not fail the whole workflow
    when the audio itself rendered fine.
    """
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    try:
        bench = data.get("bench") or {}

        if fmt == "csv_row":
            flat = _flat(data, generated_at)
            buf = io.StringIO()
            # QUOTE_MINIMAL with a real csv writer, because a filename could
            # contain a comma and hand-joining would corrupt the log silently.
            csv.writer(buf, lineterminator="").writerow(
                ["" if flat[c] is None else flat[c] for c in CSV_COLUMNS])
            return buf.getvalue()

        if fmt == "text":
            metrics, info = _rows(data)
            width = max((len(k) for k, _ in metrics + info), default=0)
            lines = ["BENCH METRICS"]
            lines += [f"  {k.ljust(width)}  {v}" for k, v in metrics]
            lines += ["", "FILE"]
            lines += [f"  {k.ljust(width)}  {v}" for k, v in info]
            for w in _warnings(bench):
                lines.append(f"  ! {w}")
            lines += ["", f"generated_at  {generated_at}"]
            return "\n".join(lines)

        # json (the default, and the fallback for an unrecognised value)
        bands = bench.get("bands") or {}
        return json.dumps({
            "generated_at": generated_at,
            "file": {
                "filename": data.get("filename"),
                "sample_rate": data.get("sample_rate"),
                "channels": bench.get("channels"),
                "stereo": bool(data.get("stereo")),
                "duration_s": data.get("duration"),
                "samples": bench.get("samples"),
                "filesize_bytes": data.get("filesize"),
            },
            "levels": {
                "peak_db": bench.get("peak_db"),
                "rms_db": bench.get("rms_db"),
                "crest_db": bench.get("crest_db"),
                "lufs": data.get("lufs"),
                "dc_offset": bench.get("dc_offset"),
                "lr_corr": bench.get("lr_corr"),
            },
            "clipping": {
                "clipped_samples": bench.get("clipped_samples"),
                "clipped_pct": bench.get("clipped_pct"),
                "over_fs": bench.get("over_fs"),
            },
            "bands_pct": {k: bands.get(k) for k, _ in BANDS},
            "hf_outliers": bench.get("hf_outliers"),
            "warnings": _warnings(bench),
        }, indent=2)

    except Exception as exc:                                  # noqa: BLE001
        # A broken string is worth far less than a completed render.
        print(f"[NovaPlayer] panel_info ({fmt}) failed: {exc}")
        return json.dumps({"generated_at": generated_at, "error": str(exc)})
