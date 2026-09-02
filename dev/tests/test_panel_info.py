"""build_panel_info() — the bench panel's contents as a string.

Run:  python3 dev/tests/test_panel_info.py

Dependency-free, like test_bench.py. The point of these checks is that the
string mirrors the strip: same values, same formatting rules, same order. A
formatting change in bench-panel.js that is not made here is a bug, because the
whole reason this output exists is that one measurement should not disagree
with itself across two nodes.
"""

import csv
import importlib.util
import io
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "panel_info", os.path.join(os.path.dirname(_HERE), "..", "nova_player", "panel_info.py"))
panel_info = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(panel_info)

PASS = FAIL = 0


def ck(name, ok, detail=""):
    detail = "" if not detail else (detail if isinstance(detail, str) else repr(detail))
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")


# A take shaped like a real one: just under full scale, mostly correlated.
TAKE = {
    "filename": "nova_player_a3f1b2c4.wav",
    "duration": 222.417,
    "sample_rate": 44100,
    "stereo": True,
    "lufs": -13.7,
    "filesize": 39_234_560,
    "bench": {
        "peak_db": -1.32, "peak_linear": 0.859,
        "rms_db": -14.15, "rms_mono_db": -15.14, "crest_db": 12.83,
        "dc_offset": -0.00012, "over_fs": 0, "clipped_samples": 87,
        "clipped_pct": 0.0003, "lr_corr": 0.591,
        "bands": {"BASS": 41.2, "MID": 38.7, "PRES": 14.6, "HF": 5.5},
        "hf_outliers": 3, "samples": 9_808_594, "channels": 2,
    },
}

print("build_panel_info()\n")

# ---- json -----------------------------------------------------------------
j = json.loads(panel_info.build_panel_info(TAKE, "json"))

ck("json parses", isinstance(j, dict))
ck("raw numbers survive unrounded", j["levels"]["rms_db"] == -14.15, f"{j['levels']['rms_db']}")
ck("peak is carried", j["levels"]["peak_db"] == -1.32)
ck("lufs comes from the payload, not the bench dict", j["levels"]["lufs"] == -13.7)
ck("clipping keeps over_fs distinct from clipped_samples",
   j["clipping"]["over_fs"] == 0 and j["clipping"]["clipped_samples"] == 87)
ck("all four bands present, in panel order",
   list(j["bands_pct"]) == ["BASS", "MID", "PRES", "HF"], str(list(j["bands_pct"])))
ck("band shares total 100%", abs(sum(j["bands_pct"].values()) - 100.0) < 0.05)
ck("generated_at is present and UTC",
   j["generated_at"].endswith("+00:00"), j["generated_at"])
ck("a clean take reports no warnings", j["warnings"] == [], str(j["warnings"]))

# ---- warnings mirror the rows the strip colours ---------------------------
hot = json.loads(json.dumps(TAKE))
hot["bench"].update({"peak_db": 1.32, "over_fs": 412, "lr_corr": -0.2})
jh = json.loads(panel_info.build_panel_info(hot, "json"))
ck("an over-full-scale peak warns", any("over full scale" in w for w in jh["warnings"]))
ck("clipping by the WAV write warns", any("clipped by the WAV write" in w for w in jh["warnings"]))
ck("negative correlation warns", "out of phase" in jh["warnings"])

# ---- text -----------------------------------------------------------------
t = panel_info.build_panel_info(TAKE, "text")
ck("text has both panel headings", "BENCH METRICS" in t and "FILE" in t)
ck("text formats dB exactly as fmtDb does", "-1.32 dBFS" in t)
ck("text shows the clipped count and percentage", "87 (0.0003%)" in t)
ck("text renders length as m:ss plus seconds", "3:42 (222.42 s)" in t,
   [l for l in t.splitlines() if "LENGTH" in l])
ck("text groups the sample count", "9,808,594" in t)
# 39,234,560 B is 37.417 MB. Above 10 the strip drops the decimal, so this is
# "37 MB" — matching fmtBytes() in bench-panel.js, not what looks tidier here.
ck("text renders file size in whole units above 10", "37 MB" in t,
   [l for l in t.splitlines() if "SIZE" in l])
ck("text keeps one decimal below 10 units",
   "5.2 MB" in panel_info.build_panel_info({**TAKE, "filesize": 5_452_595}, "text"),
   [l for l in panel_info.build_panel_info(
       {**TAKE, "filesize": 5_452_595}, "text").splitlines() if "SIZE" in l])
ck("byte rounding matches Math.round, not banker's rounding",
   panel_info._fmt_bytes(36.5 * 1024 * 1024) == "37 MB",
   panel_info._fmt_bytes(36.5 * 1024 * 1024))
ck("text keeps the panel's row order",
   t.index("PEAK") < t.index("RMS") < t.index("CREST") < t.index("CLIPPED"))

# ---- csv_row --------------------------------------------------------------
row = panel_info.build_panel_info(TAKE, "csv_row")
ck("csv_row is a single line", "\n" not in row and "\r" not in row)
parsed = next(csv.reader(io.StringIO(row)))
ck("csv_row has one cell per declared column",
   len(parsed) == len(panel_info.CSV_COLUMNS),
   f"{len(parsed)} cells vs {len(panel_info.CSV_COLUMNS)} columns")
ck("csv_row values land in their declared columns",
   parsed[panel_info.CSV_COLUMNS.index("rms_db")] == "-14.15")
ck("csv_row quotes a filename containing a comma",
   '"' in panel_info.build_panel_info(
       {**TAKE, "filename": "take,01.wav"}, "csv_row"))

# ---- the analysis block: rows must be self-describing ---------------------
# A row that does not say what it was measured under cannot be validated later.
# Bin count shifts FLATNESS and CENTROID; the smoothing constant shifts FLUX.
# Neither leaves a trace in the numbers themselves.
a = j["analysis"]
ck("json carries the analyser configuration",
   {"fft_size", "analyser_fps", "analyser_smoothing", "band_edges_hz"} <= set(a),
   str(sorted(a)))
ck("fft_size is the real configured value", a["fft_size"] == 4096, str(a["fft_size"]))
ck("band edges are recorded, contiguous and open-ended",
   a["band_edges_hz"] == "0/250/2000/6000/inf", a["band_edges_hz"])

t2 = panel_info.build_panel_info(TAKE, "text")
ck("text carries an ANALYSIS block", "ANALYSIS" in t2 and "FFT SIZE" in t2)

row2 = next(csv.reader(io.StringIO(panel_info.build_panel_info(TAKE, "csv_row"))))
ck("csv_row carries the analyser configuration too",
   row2[panel_info.CSV_COLUMNS.index("fft_size")] == "4096",
   row2[panel_info.CSV_COLUMNS.index("fft_size")])
# ---- provenance -----------------------------------------------------------
# Four different peak values were once on record for "the same take". A hash
# ends that: two rows either describe the same bytes or they do not.
WITH_ID = {**TAKE, "audio_sha256": "a" * 64, "context": '{"seed": 12345}'}
jj = json.loads(panel_info.build_panel_info(WITH_ID, "json"))
ck("json carries a schema version", jj["schema_ver"] == panel_info.SCHEMA_VER,
   str(jj.get("schema_ver")))
ck("json carries the audio hash", jj["audio_sha256"] == "a" * 64)
ck("context is passed through verbatim, not parsed",
   jj["context"] == '{"seed": 12345}', repr(jj["context"]))
ck("a row without context carries null rather than an empty string",
   json.loads(panel_info.build_panel_info(TAKE, "json"))["context"] is None)

rowid = next(csv.reader(io.StringIO(panel_info.build_panel_info(WITH_ID, "csv_row"))))
ck("csv_row carries the hash and context",
   rowid[panel_info.CSV_COLUMNS.index("audio_sha256")] == "a" * 64
   and rowid[panel_info.CSV_COLUMNS.index("context")] == '{"seed": 12345}')
ck("a context containing a comma does not corrupt the row",
   len(next(csv.reader(io.StringIO(panel_info.build_panel_info(
       {**TAKE, "context": "seed=1,cfg=2.8"}, "csv_row"))))) == len(panel_info.CSV_COLUMNS))

# audio_sha256() itself: of the FILE, streamed.
import hashlib, tempfile
with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tf:
    tf.write(b"nova" * 5000)
    tmp_name = tf.name
ck("audio_sha256 hashes the file's actual bytes",
   panel_info.audio_sha256(tmp_name) == hashlib.sha256(b"nova" * 5000).hexdigest())
ck("a missing file yields None rather than raising",
   panel_info.audio_sha256("/nonexistent/nope.wav") is None)
os.unlink(tmp_name)

ck("the new columns were APPENDED, not inserted",
   panel_info.CSV_COLUMNS.index("generated_at") == 0
   and panel_info.CSV_COLUMNS.index("hf_outliers") == 21,
   "an existing log would shift if these moved")

# panel_info keeps its own copy of the band edges so it stays dependency-free.
# Two copies means one is eventually wrong, so pin them together.
_AIO = importlib.util.spec_from_file_location(
    "audio_io_for_edges",
    os.path.join(os.path.dirname(_HERE), "..", "nova_player", "audio_io.py"))
try:
    _aio_mod = importlib.util.module_from_spec(_AIO)
    _AIO.loader.exec_module(_aio_mod)
    ck("panel_info's band edges match audio_io's",
       tuple(_aio_mod.BAND_EDGES_HZ) == tuple(panel_info.BAND_EDGES_HZ),
       f"{_aio_mod.BAND_EDGES_HZ} vs {panel_info.BAND_EDGES_HZ}")
except ImportError:
    ck("panel_info's band edges match audio_io's", True, "(numpy absent — skipped)")

# ---- degenerate input -----------------------------------------------------
ck("a payload with no bench data does not raise",
   isinstance(panel_info.build_panel_info({"filename": "x.wav"}, "json"), str))
empty = json.loads(panel_info.build_panel_info({}, "json"))
ck("an empty payload still returns valid json", "generated_at" in empty)
ck("an unknown format falls back to json",
   json.loads(panel_info.build_panel_info(TAKE, "nonsense"))["levels"]["rms_db"] == -14.15)
ck("a mono take reports mono rather than a correlation",
   "mono" in panel_info.build_panel_info(
       {**TAKE, "bench": {**TAKE["bench"], "lr_corr": None}}, "text"))
ck("a missing dB value reads as a dash, not -120",
   "—" in panel_info.build_panel_info(
       {**TAKE, "bench": {**TAKE["bench"], "peak_db": -120.0}}, "text"))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
