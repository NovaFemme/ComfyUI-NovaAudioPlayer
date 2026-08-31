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

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
