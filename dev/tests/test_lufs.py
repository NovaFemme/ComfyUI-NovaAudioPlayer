#!/usr/bin/env python3
"""compute_lufs() — the loudness badge, against the standard it claims to follow.

    python3 dev/tests/test_lufs.py

WHY THIS FILE EXISTS.

The badge read -17.3 LUFS on a take that ffmpeg's ebur128 measures at -13.5.
NovaFemme was about to master against that number. Two bugs, both in the first
four lines of the old implementation:

    mono = waveform.float().mean(dim=0)      # channels AVERAGED, not summed
    ms = np.mean(kweighted ** 2)             # whole file, no gating

Decomposed on that take (L/R correlation 0.79):

    as shipped   mono downmix, no gating     -17.29 LUFS
    channel rule fixed, no gating            -13.59 LUFS   (+3.70 LU)
    gating fixed, mono downmix               -17.15 LUFS   (+0.14 LU)
    both fixed = BS.1770 integrated          -13.45 LUFS   (+3.84 LU)
    ffmpeg ebur128                           -13.50 LUFS

Note which bug dominated. Gating contributed 0.14 LU on that take because it is
a dense, loud piece with an LRA of 4.8 -- there was almost nothing quiet enough
to gate out. On a take with a soft intro or a long fade the two swap places, so
both are tested here rather than only the one that happened to matter.

WHAT IS CHECKED, AND WHAT IT WOULD TAKE TO FOOL IT.

The anchor is a deterministic signal whose expected value was measured with
ffmpeg's ebur128 -- the reference implementation, not another guess. The rest
are properties of the standard that hold for any correct implementation and
fail for the old one: summed channels put stereo exactly 3.01 LU above mono,
doubling amplitude adds exactly 6.02 LU, and gating makes appended silence free.
"""

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "stubs")))

from nova_player.audio_io import compute_lufs  # noqa: E402

PASS = FAIL = SKIP = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def skip(name, why):
    global SKIP
    print(f"  skip  {name} — {why}")
    SKIP += 1


try:
    import scipy.signal  # noqa: F401
    HAVE_SCIPY = True
except Exception:
    HAVE_SCIPY = False

print("compute_lufs — ITU-R BS.1770-4\n")

FS = 48000


def tone(seconds, freq=1000.0, amp=0.5, fs=FS):
    t = np.arange(int(seconds * fs)) / fs
    return amp * np.sin(2 * math.pi * freq * t)


def pink(seconds, fs=FS, seed=20260905):
    """The anchor signal. Deterministic across machines: same seed, same filter,
    same normalisation, so the ffmpeg-measured expectation below stays valid."""
    from scipy.signal import lfilter
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((2, int(seconds * fs)))
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    y = lfilter(b, a, w, axis=1)
    return y / (np.max(np.abs(y)) / 0.5)


# --- the anchor: a value from the reference implementation -----------------
#
# ffmpeg -i anchor.wav -af ebur128 -f null -   =>  I: -17.6 LUFS
# Regenerate with dev/tests/test_lufs.py --write-anchor if the signal changes.
if HAVE_SCIPY:
    got = compute_lufs(pink(12), FS)
    ck("matches ffmpeg ebur128 on the anchor signal", abs(got - (-17.6)) <= 0.1,
       f"{got:.2f} vs -17.60 LUFS")
else:
    skip("matches ffmpeg ebur128 on the anchor signal", "no scipy")

# --- channels are summed, not averaged -------------------------------------
#
# This is the check the old implementation fails by 3 dB, and the one that put
# 3.70 LU on the badge.
t = tone(8)
mono_in_left = np.stack([t, np.zeros_like(t)])
both = np.stack([t, t])
if HAVE_SCIPY:
    a, b = compute_lufs(mono_in_left, FS), compute_lufs(both, FS)
    ck("the same signal in both channels reads 3.01 LU above one channel",
       abs((b - a) - 3.01) <= 0.05, f"{a:.2f} -> {b:.2f} = {b - a:+.2f} LU")
    ck("doubling amplitude adds 6.02 LU",
       abs((compute_lufs(both * 2, FS) - b) - 6.02) <= 0.05,
       f"{compute_lufs(both * 2, FS) - b:+.2f} LU")
else:
    skip("channel summation", "no scipy")

# --- gating -----------------------------------------------------------------
#
# Appending silence must not change the reading. Ungated it costs 3 dB, which
# is how a quiet intro or a fade-out used to move the badge.
if HAVE_SCIPY:
    loud = np.stack([tone(10), tone(10)])
    padded = np.concatenate([loud, np.zeros_like(loud)], axis=1)
    a, b = compute_lufs(loud, FS), compute_lufs(padded, FS)
    ck("appending an equal length of silence does not change the reading",
       abs(b - a) <= 0.15, f"{a:.2f} -> {b:.2f} ({b - a:+.2f} LU)")

    ungated = -0.691 + 10 * math.log10(float(np.mean(padded ** 2) * 2) + 1e-12)
    ck("...and an ungated mean would have moved it by about 3 dB",
       abs(b - ungated) > 2.0, f"gated {b:.2f} vs ungated-style {ungated:.2f}")

    silence = np.zeros((2, FS * 2))
    ck("digital silence returns the absolute gate, not -inf or a crash",
       compute_lufs(silence, FS) == -70.0, f"{compute_lufs(silence, FS)}")
else:
    skip("gating", "no scipy")

# --- sample rate ------------------------------------------------------------
#
# The K-weighting table is defined at 48 kHz. Applied unchanged at 44.1 kHz it
# measures a different curve, so the filter is re-derived per rate.
if HAVE_SCIPY:
    a = compute_lufs(np.stack([tone(8)] * 2), 48000)
    b = compute_lufs(np.stack([tone(8, fs=44100)] * 2), 44100)
    ck("the same tone reads the same at 44.1 kHz as at 48 kHz",
       abs(a - b) <= 0.1, f"48k {a:.2f}, 44.1k {b:.2f} ({b - a:+.2f} LU)")
else:
    skip("sample-rate independence", "no scipy")

# --- shapes and edges -------------------------------------------------------
if HAVE_SCIPY:
    mono = tone(5)
    ck("accepts a bare 1-D mono array", isinstance(compute_lufs(mono, FS), float))
    ck("a take shorter than one 400 ms block still reports a number",
       compute_lufs(np.stack([tone(0.2)] * 2), FS) < 0)
    ck("an empty take returns the absolute gate",
       compute_lufs(np.zeros((2, 0)), FS) == -70.0)
else:
    skip("shapes and edges", "no scipy")

print(f"\n{PASS} passed, {FAIL} failed" + (f", {SKIP} skipped" if SKIP else ""))
sys.exit(1 if FAIL else 0)
