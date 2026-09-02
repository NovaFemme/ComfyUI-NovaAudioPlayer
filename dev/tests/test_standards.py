"""Comfy registry standards — a grep the release cannot forget to run.

2.2.0 and 2.2.1 were both flagged by the registry's scanner. The two things in
this package a scanner could plausibly have objected to were a `subprocess`
call reaching ffmpeg for the lossy download formats, and a 156 KB minified
vendor blob (web/lib/lame.min.js) that nothing imported. Both are gone.

This test exists so neither comes back by accident. It is a grep, not an
analysis: it cannot prove the package is safe, only that the specific patterns
the published standards name are absent.

    https://docs.comfy.org/registry/standards
      - eval and exec are prohibited
      - runtime package installation via subprocess is prohibited
      - obfuscated code is prohibited

Run:  python3 dev/tests/test_standards.py
"""

import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

# Directories that are not shipped, and this file, which necessarily names
# every pattern it looks for.
SKIP_DIRS = {".git", ".trash", "__pycache__", "node_modules", "dev", "docs",
             "presets", "config"}

PY_FORBIDDEN = [
    (r"\bimport\s+subprocess\b", "import subprocess"),
    (r"\bsubprocess\.", "subprocess call"),
    (r"\bos\.system\s*\(", "os.system"),
    (r"(?<![\w.])eval\s*\(", "eval()"),
    (r"(?<![\w.])exec\s*\(", "exec()"),
    (r"\bpip\s+install\b", "pip install"),
    (r"\bimport\s+pickle\b", "pickle"),
]

# A minified bundle is indistinguishable from obfuscation to a scanner, and to
# a reviewer. The threshold is characters per line averaged over the file:
# hand-written JavaScript does not average 500.
MAX_MEAN_LINE = 500

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def shipped(ext):
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn.endswith(ext):
                yield os.path.join(base, fn)


print("registry standards\n")

for pattern, label in PY_FORBIDDEN:
    hits = []
    rx = re.compile(pattern)
    for path in shipped(".py"):
        with open(path, "r", encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                # A line that only talks ABOUT the pattern is not the pattern.
                stripped = line.lstrip()
                if stripped.startswith("#"):
                    continue
                if rx.search(line):
                    hits.append(f"{os.path.relpath(path, ROOT)}:{i}")
    ck(f"no {label}", not hits, ", ".join(hits[:3]))

blobs = []
for path in shipped(".js"):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.count("\n") + 1
    if lines and len(text) / lines > MAX_MEAN_LINE:
        blobs.append(f"{os.path.relpath(path, ROOT)} ({len(text) // lines} chars/line)")
ck("no minified or obfuscated JavaScript ships", not blobs, ", ".join(blobs))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
