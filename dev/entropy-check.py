#!/usr/bin/env python3
"""Does a Shannon-entropy threshold distinguish documentation from a payload?

    python3 dev/entropy-check.py

`nodesafe scan` reports every module docstring in this package as
`code_obfuscation_high_entropy`, CWE-506, "well above the natural-text
baseline. Likely an encoded payload." Eighteen findings, all of them prose.

Rather than argue about it, measure it. The comparison that settles it is not
"is 4.6 a big number" but "what else scores 4.6, and what scores lower". Two
results decide it:

  * this repository's MIT LICENSE scores higher than every flagged docstring,
    and higher than obfuscated JavaScript;
  * hex-encoded random bytes score BELOW the threshold, so a real encoded
    payload in the most obvious encoding would pass.

A rule that flags a software licence and misses a hex payload is measuring
character variety, not encoding. Technical prose scores high because it mixes
case, punctuation, backticks and identifiers; literary prose scores low because
it does not. Nothing here is fixable in the package, and rewriting docstrings
to lower their entropy would trade documentation for a number.
"""

import ast
import base64
import io
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def entropy(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    freq: dict[str, int] = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    return -sum((v / n) * math.log2(v / n) for v in freq.values())


def docstring(rel: str) -> str:
    src = io.open(ROOT / rel, encoding="utf-8").read()
    return ast.get_docstring(ast.parse(src)) or ""


THRESHOLD = 4.5   # where nodesafe v0.6.0 starts reporting

rows = [
    ("MIT LICENSE (this repo)", io.open(ROOT / "LICENSE", encoding="utf-8").read()),
    ("README.md, first 1200 chars",
     io.open(ROOT / "README.md", encoding="utf-8").read()[:1200]),
    ("nova_player/node.py docstring — FLAGGED", docstring("nova_player/node.py")),
    ("madow/node.py docstring — FLAGGED", docstring("madow/node.py")),
    ("Declaration of Independence, opening",
     "When in the Course of human events, it becomes necessary for one people "
     "to dissolve the political bands which have connected them with another, "
     "and to assume among the powers of the earth, the separate and equal "
     "station to which the Laws of Nature and of Nature's God entitle them."),
    ("Moby-Dick, opening",
     "Call me Ishmael. Some years ago—never mind how long precisely—having "
     "little or no money in my purse, and nothing particular to interest me "
     "on shore, I thought I would sail about a little and see the watery part "
     "of the world."),
    (None, None),
    ("base64 of 400 random bytes", base64.b64encode(os.urandom(400)).decode()),
    ("hex of 400 random bytes", os.urandom(400).hex()),
    ("obfuscated JavaScript",
     "var _0x1a2b=['\\x70\\x75\\x73\\x68','\\x6c\\x65\\x6e\\x67\\x74\\x68'];"
     "(function(_0x2d8f05,_0x4b81bd){var _0x1c4e=function(_0x3f2a){"
     "while(--_0x3f2a){_0x2d8f05['push'](_0x2d8f05['shift']());}};}"
     "(_0x1a2b,0x1e8));"),
]

print(f"Shannon entropy, bits/char — flagged at >= {THRESHOLD}\n")
for name, text in rows:
    if name is None:
        print("\n  -- actual encodings, for contrast --")
        continue
    h = entropy(text)
    print(f"  {h:5.2f}  {'FLAG' if h >= THRESHOLD else '    '}  {name}")

lic = entropy(io.open(ROOT / "LICENSE", encoding="utf-8").read())
hexed = entropy(os.urandom(400).hex())
print(f"\n  The MIT licence scores {lic:.2f}; hex-encoded random bytes score "
      f"{hexed:.2f}.")
print("  The rule flags the licence and misses the payload.")
