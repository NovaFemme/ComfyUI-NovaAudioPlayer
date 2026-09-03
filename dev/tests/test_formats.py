"""The download formats, checked against libsndfile itself.

THE BUG THIS PINS. Every format was written with subtype PCM_16. WAV and FLAC
take PCM_16, so two of the three worked and the constant looked right; OGG is a
container for Vorbis-encoded data and libsndfile refused it with "Invalid
combination of format, subtype and endian". The menu offered a format that
could not be produced, and only a click found out.

A table of format constants is exactly the thing to check against the library
rather than by reading: `sf.check_format` answers definitively, and writing a
second of audio through each proves the pair round-trips.

Skips cleanly where soundfile is absent — it is an optional dependency and the
node degrades without it.

Run:  python3 dev/tests/test_formats.py
"""

import io
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    globals().__setitem__("PASS" if ok else "FAIL", (PASS if ok else FAIL) + 1)


print("download formats\n")

# Read the table out of routes.py rather than importing it: routes.py imports
# folder_paths, which only exists inside ComfyUI.
src = open(os.path.join(ROOT, "nova_player", "routes.py"), encoding="utf-8").read()
block = re.search(r"SOUNDFILE_FORMAT = \{(.*?)\n\}", src, re.S)
table = {m[0]: (m[1], m[2])
         for m in re.findall(r'"(\w+)":\s*\("(\w+)",\s*"(\w+)"\)', block.group(1) if block else "")}

ck("the format table was found and parsed", len(table) == 3, str(table))

mime = re.search(r"MIME = \{(.*?)\n\}", src, re.S)
offered = set(re.findall(r'"(\w+)":', mime.group(1) if mime else ""))
ck("every format the route offers has a writer",
   offered == set(table), f"offered {sorted(offered)} vs writers {sorted(table)}")

try:
    import numpy as np
    import soundfile as sf
except ImportError as exc:
    print(f"\n  (soundfile unavailable — {exc}; the pair checks need it)")
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

SR = 48000
tone = (0.3 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)).astype(np.float32)
stereo = np.stack([tone, tone], axis=1)

for fmt, (container, subtype) in sorted(table.items()):
    ck(f"{fmt}: libsndfile accepts {container}/{subtype}",
       sf.check_format(container, subtype))
    try:
        data = stereo if subtype == "VORBIS" else (stereo * 32767).astype(np.int16)
        buf = io.BytesIO()
        sf.write(buf, data, SR, format=container, subtype=subtype)
        back, sr_back = sf.read(io.BytesIO(buf.getvalue()), always_2d=True)
        ok = sr_back == SR and back.shape[0] > SR * 0.9 and back.shape[1] == 2
        ck(f"{fmt}: a second of stereo round-trips",
           ok, f"{len(buf.getvalue()):,} bytes -> {back.shape} @ {sr_back} Hz")
    except Exception as exc:                                  # noqa: BLE001
        ck(f"{fmt}: a second of stereo round-trips", False, str(exc))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
