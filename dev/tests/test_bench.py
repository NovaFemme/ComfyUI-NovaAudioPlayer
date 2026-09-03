"""compute_bench() — the single source of truth for the bench strip.

Run:  python3 dev/tests/test_bench.py

Deliberately dependency-free: it fakes the small slice of the torch tensor API
that audio_io actually uses, so the DSP can be checked without torch or ComfyUI
installed.
"""

import importlib.util
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE)) if os.path.basename(_HERE) == "tests" else _HERE
_SPEC = importlib.util.spec_from_file_location(
    "audio_io", os.path.join(os.path.dirname(_HERE), "..", "nova_player", "audio_io.py"))
audio_io = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(audio_io)


class FakeTensor:
    """Just enough of the torch surface for audio_io: dim/shape/slice/cpu/numpy."""

    def __init__(self, a):
        self.a = np.asarray(a)

    def dim(self):
        return self.a.ndim

    @property
    def shape(self):
        return self.a.shape

    def __getitem__(self, k):
        return FakeTensor(self.a[k])

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return self

    def numpy(self):
        return self.a

    def mean(self, dim=None):
        return FakeTensor(self.a.mean(axis=dim))


PASS = FAIL = 0


def ck(name, ok, note=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('   ' + note) if note else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


SR = 48000


def tone(freq, amp, secs=2.0, phase=0.0):
    t = np.arange(int(SR * secs)) / SR
    return amp * np.sin(2 * np.pi * freq * t + phase)


def stereo(l, r):
    return FakeTensor(np.stack([l, r]).astype(np.float32))


print("compute_bench()\n")

# ---- levels ---------------------------------------------------------------
sig = tone(440, 0.5)
b = audio_io.compute_bench(stereo(sig, sig), SR)
ck("peak of a 0.5 sine is -6.02 dBFS", abs(b["peak_db"] - (-6.02)) < 0.02, f"{b['peak_db']}")
ck("RMS of a 0.5 sine is -9.03 dBFS", abs(b["rms_db"] - (-9.03)) < 0.05, f"{b['rms_db']}")
ck("crest of a sine is 3.01 dB", abs(b["crest_db"] - 3.01) < 0.05, f"{b['crest_db']}")
ck("a clean signal reports no clipping", b["clipped_samples"] == 0 and b["over_fs"] == 0)

# ---- above full scale: the case that motivated all this -------------------
hot = tone(440, 1.2)
b = audio_io.compute_bench(stereo(hot, hot), SR)
over_expected = int(np.count_nonzero(np.abs(hot) > 1.0) * 2)
ck("an over-full-scale take reports a POSITIVE peak",
   b["peak_db"] > 0, f"{b['peak_db']:+.2f} dBFS")
ck("it counts the samples save_wav will clamp",
   b["over_fs"] == over_expected, f"{b['over_fs']} vs {over_expected}")
ck("peak_linear is reported unclamped for the true figure",
   abs(b["peak_linear"] - 1.2) < 1e-3, f"{b['peak_linear']}")

# ---- correlation ----------------------------------------------------------
a = tone(300, 0.4)
ck("identical channels correlate at +1",
   abs(audio_io.compute_bench(stereo(a, a), SR)["lr_corr"] - 1.0) < 1e-3)
ck("inverted channels correlate at -1",
   abs(audio_io.compute_bench(stereo(a, -a), SR)["lr_corr"] + 1.0) < 1e-3)
b = audio_io.compute_bench(stereo(tone(300, 0.4), tone(1100, 0.4)), SR)
ck("unrelated tones correlate near 0", abs(b["lr_corr"]) < 0.1, f"{b['lr_corr']}")
mono = audio_io.compute_bench(FakeTensor(np.stack([a]).astype(np.float32)), SR)
ck("mono reports no correlation", mono["lr_corr"] is None)
ck("mono reports one channel", mono["channels"] == 1)

# ---- bands: the whole reason for redoing them -----------------------------
b = audio_io.compute_bench(stereo(sig, sig), SR)
total = sum(b["bands"].values())
ck("band shares always total 100%", abs(total - 100.0) < 0.05, f"{total:.2f}%")

cases = [
    (60, "BASS"), (150, "BASS"),
    (400, "MID"), (1500, "MID"),
    (3000, "PRES"), (5000, "PRES"),
    (9000, "HF"), (15000, "HF"),
]
for freq, expect in cases:
    s = tone(freq, 0.6)
    bands = audio_io.compute_bench(stereo(s, s), SR)["bands"]
    top = max(bands, key=bands.get)
    ck(f"a {freq} Hz tone lands in {expect}", top == expect,
       f"got {top} ({bands[top]:.1f}%)")

# A tone at 300 Hz sits in the gap the OLD disjoint bands (60-250 / 500-2000)
# dropped entirely. Contiguous edges must still account for it.
s = tone(300, 0.6)
bands = audio_io.compute_bench(stereo(s, s), SR)["bands"]
ck("300 Hz — in the old band gap — is still counted",
   abs(sum(bands.values()) - 100.0) < 0.05 and bands["MID"] > 50,
   f"MID {bands['MID']:.1f}%, total {sum(bands.values()):.1f}%")

# ---- DC -------------------------------------------------------------------
d = tone(440, 0.3) + 0.25
b = audio_io.compute_bench(stereo(d, d), SR)
ck("DC offset is measured", abs(b["dc_offset"] - 0.25) < 1e-3, f"{b['dc_offset']}")

# ---- clipped_samples must not double-count the overshoot ------------------
# The bug: `at_ceiling` counts |x| >= 32767/32768 and `over` counts |x| > 1.0,
# so every over-full-scale sample appears in BOTH. Summing them reported 174
# clipped samples on a take that had 87, and 10 on a take that had 5 — always
# exactly double, which is what made it visible in a screenshot.
hot = tone(440, 1.2)
b = audio_io.compute_bench(stereo(hot, hot), SR)
true_over = int(np.count_nonzero(np.abs(np.stack([hot, hot])) > 1.0))
true_at_ceiling = int(np.count_nonzero(
    np.abs(np.stack([hot, hot])) >= 0.999969482421875))

ck("over_fs counts samples ABOVE full scale",
   b["over_fs"] == true_over, f"{b['over_fs']} vs {true_over}")
ck("clipped_samples counts samples AT OR ABOVE the ceiling",
   b["clipped_samples"] == true_at_ceiling,
   f"{b['clipped_samples']} vs {true_at_ceiling}")
ck("clipped_samples does not double-count: it is never 2x over_fs",
   b["clipped_samples"] != 2 * b["over_fs"] or b["over_fs"] == 0,
   f"clipped {b['clipped_samples']}, over {b['over_fs']}")
ck("clipped_samples is a SUPERSET of over_fs, never smaller",
   b["clipped_samples"] >= b["over_fs"],
   f"{b['clipped_samples']} >= {b['over_fs']}")
ck("on a pure overshoot the two are equal, not double",
   b["clipped_samples"] == b["over_fs"],
   f"clipped {b['clipped_samples']}, over {b['over_fs']}")
ck("clipped_pct is derived from the same count",
   abs(b["clipped_pct"] - 100.0 * b["clipped_samples"] / (len(hot) * 2)) < 1e-4,
   f"{b['clipped_pct']}")

# A take that reaches the ceiling WITHOUT overshooting: clipped > 0, over == 0.
at_ceil_only = np.full(1000, 0.9999847, dtype=np.float32)   # >= ceiling, <= 1.0
b2 = audio_io.compute_bench(stereo(at_ceil_only, at_ceil_only), SR)
ck("a take at the ceiling but not over it reports clipping and no overshoot",
   b2["clipped_samples"] == 2000 and b2["over_fs"] == 0,
   f"clipped {b2['clipped_samples']}, over {b2['over_fs']}")

# ---- the two RMS conventions ----------------------------------------------
# A mono-summing meter and a both-channels meter disagree by a knowable amount.
# This pins the relationship so the -14.15 / -15.14 style split can never be
# mistaken for a bug again. See docs/TECHNICAL.md, "Two RMS conventions".
rng = np.random.default_rng(20260901)


def correlated_pair(r, n=SR * 2, amp=0.1):
    """Two equal-power channels with L/R correlation r."""
    a = rng.standard_normal(n)
    b = rng.standard_normal(n)
    left = a
    right = r * a + np.sqrt(max(0.0, 1.0 - r * r)) * b
    return (left * amp).astype(np.float32), (right * amp).astype(np.float32)


for r_target in (1.0, 0.9, 0.591, 0.0):
    L, R = correlated_pair(r_target)
    b = audio_io.compute_bench(stereo(L, R), SR)
    r = b["lr_corr"]
    expected = 10.0 * np.log10((1.0 + r) / 2.0)
    actual = b["rms_mono_db"] - b["rms_db"]
    ck(f"at r={r:+.3f} the mono downmix reads 10*log10((1+r)/2) lower",
       abs(actual - expected) < 0.03,
       f"both {b['rms_db']:.2f} mono {b['rms_mono_db']:.2f} "
       f"delta {actual:+.3f} expected {expected:+.3f}")

# Fully correlated: the two conventions must agree exactly.
b = audio_io.compute_bench(stereo(sig, sig), SR)
ck("on a mono-identical signal both RMS conventions agree",
   abs(b["rms_mono_db"] - b["rms_db"]) < 0.01,
   f"{b['rms_db']} vs {b['rms_mono_db']}")

# ---- degenerate input -----------------------------------------------------
ck("empty input returns cleanly, no exception",
   audio_io.compute_bench(FakeTensor(np.zeros((2, 0), np.float32)), SR) == {})
z = audio_io.compute_bench(stereo(np.zeros(SR), np.zeros(SR)), SR)
ck("digital silence does not produce NaN or inf",
   all(not isinstance(v, float) or np.isfinite(v)
       for v in z.values() if not isinstance(v, dict)),
   f"peak {z['peak_db']} rms {z['rms_db']}")

# A batched (1, ch, samples) tensor is what ComfyUI actually hands the node.
batched = FakeTensor(np.stack([np.stack([sig, sig])]).astype(np.float32))
ck("a batched (1, ch, n) tensor is handled",
   abs(audio_io.compute_bench(batched, SR)["peak_db"] - (-6.02)) < 0.02)

# ---- DC is not bass ---------------------------------------------------------
# Bin 0 is the DC term. ACE-Step's decoder leaves ~0.002 of constant offset on
# every take measured, and counted as bass it inflates the one band that is
# hardest to check by ear. The renderer skips bin 0 for the same reason.
quiet = tone(1000.0, 0.2, 3.0)
b_clean = audio_io.compute_bench(stereo(quiet, quiet), SR)["bands"]
shifted = quiet + 0.05                    # a DC offset far larger than real
b_dc = audio_io.compute_bench(stereo(shifted, shifted), SR)["bands"]
ck("a large DC offset does not become bass",
   abs(b_dc["BASS"] - b_clean["BASS"]) < 1.0,
   f"clean {b_clean['BASS']:.2f}% vs offset {b_dc['BASS']:.2f}%")
ck("...and the shares still total 100",
   abs(sum(b_dc.values()) - 100.0) < 0.05, f"{sum(b_dc.values()):.2f}%")

# ---- the per-bin invariant --------------------------------------------------
# THE ONE THAT SURVIVES BOTH PATHS CHANGING TOGETHER. At 8192/48k the bass band
# holds ~42 bins and HF ~3500, so a per-band share says little on its own: a
# domain error hides inside the bin counts. Energy per BIN does not.
bass_heavy = tone(80.0, 0.5, 3.0)
bands = audio_io.compute_bench(stereo(bass_heavy, bass_heavy), SR)["bands"]
BIN_HZ = SR / 8192.0
bins = {"BASS": 250.0 / BIN_HZ, "MID": (2000.0 - 250.0) / BIN_HZ,
        "PRES": (6000.0 - 2000.0) / BIN_HZ, "HF": (SR / 2 - 6000.0) / BIN_HZ}
per_bin = {k: bands[k] / bins[k] for k in bands}
ck("bass energy per bin is orders above HF on bass-heavy material",
   per_bin["BASS"] / max(per_bin["HF"], 1e-12) > 100,
   f"{per_bin['BASS'] / max(per_bin['HF'], 1e-12):.0f} : 1")

# ---- the three band-edge tables must be one table ---------------------------
# Bug 2 in the review: edges defined in three places drift, and then a domain
# fix cannot be verified because an edge mismatch is confounded with it. This
# reads the other two and compares.
import re

_ROOT_DIR = os.path.dirname(os.path.dirname(_HERE))


def _js_edges():
    src = open(os.path.join(_ROOT_DIR, "web", "renderers",
                            "freq_percentages.js"), encoding="utf-8").read()
    m = re.search(r"const BAND_EDGES_HZ = \[([^\]]+)\]", src)
    if not m:
        return None
    out = []
    for tok in m.group(1).split(","):
        tok = tok.strip()
        out.append(float("inf") if tok == "Infinity" else float(tok))
    return tuple(out)


def _panel_info_edges():
    spec = importlib.util.spec_from_file_location(
        "panel_info_edges", os.path.join(_ROOT_DIR, "nova_player", "panel_info.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return tuple(mod.BAND_EDGES_HZ)


ck("the renderer's band edges match compute_bench's",
   _js_edges() == tuple(audio_io.BAND_EDGES_HZ),
   f"js {_js_edges()} vs py {tuple(audio_io.BAND_EDGES_HZ)}")
ck("panel_info's band edges match compute_bench's",
   _panel_info_edges() == tuple(audio_io.BAND_EDGES_HZ),
   f"panel_info {_panel_info_edges()}")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
