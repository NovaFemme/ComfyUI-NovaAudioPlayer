"""Comfy registry standards — a grep over the files that are actually shipped.

History, because it is the whole argument for how this test is written now:

  2.2.0, 2.2.1   Banned.   A `subprocess` call reached ffmpeg for the lossy
                           download formats, and a 156 KB minified vendor blob
                           (web/lib/lame.min.js) sat unimported in the tree.
  2.3.0, 2.3.2   Flagged.  Both of those were gone. Something still matched.

The first version of this test walked the working tree and skipped a hardcoded
set of directories — `dev`, `docs`, `presets`, `config` — on the assumption
that they "are not shipped". **That assumption was wrong.**

    "By default `comfy node publish` packages every file tracked by git."
    https://docs.comfy.org/registry/publishing

Thirty-seven of this repository's 118 tracked files are `dev/`, and one of them
is this file: a table of every literal the scanner hunts for, published inside
the package it is meant to protect. The test passed while shipping the bait.

So the file set is no longer a guess. It is `git ls-files` minus `.comfyignore`,
which is what the packager itself does, and the first thing checked is that
this file is not in it.

Comments are scanned too. The old version skipped lines starting with `#` or
`//` on the reasoning that a line talking *about* a pattern is not the pattern.
That is true of a parser and false of a grep, and the registry's scanner greps.

    https://docs.comfy.org/registry/standards
      - eval and exec are prohibited
      - runtime package installation via subprocess is prohibited
      - obfuscated code is prohibited

It is a grep, not an analysis: it cannot prove the package is safe, only that
the patterns the published standards name are absent from what ships.

Run:  python3 dev/tests/test_standards.py
"""

import fnmatch
import os
import re
import subprocess  # noqa: S404 - see module docstring; this file never ships
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
SELF = os.path.relpath(os.path.abspath(__file__), ROOT).replace(os.sep, "/")

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


# ---------------------------------------------------------------- file set

def _comfyignore_patterns():
    path = os.path.join(ROOT, ".comfyignore")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("!"):
                # Negation is real .gitignore syntax and this matcher does not
                # implement it. Refuse rather than silently under-ignoring.
                raise SystemExit(
                    "test_standards: .comfyignore negation (!) is not supported "
                    "by this matcher; either drop it or use pathspec here."
                )
            out.append(line)
    return out


def _ignored(rel, patterns):
    for pat in patterns:
        p = pat.rstrip("/")
        if pat.endswith("/"):
            if rel == p or rel.startswith(p + "/"):
                return True
        elif fnmatch.fnmatch(rel, p) or rel.startswith(p + "/"):
            return True
        elif "/" not in p and fnmatch.fnmatch(os.path.basename(rel), p):
            return True
    return False


def shipped_files():
    """Exactly what `comfy node publish` puts in node.zip: git-tracked files,
    minus .comfyignore. Mirrors comfy_cli.file_utils.zip_files."""
    raw = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout.decode("utf-8")
    tracked = [p for p in raw.split("\0") if p]
    patterns = _comfyignore_patterns()
    return [p for p in tracked if not _ignored(p, patterns)]


SHIPPED = shipped_files()

print("registry standards\n")
print(f"  {len(SHIPPED)} files ship (git-tracked, minus .comfyignore)\n")

# This file necessarily contains every forbidden literal. If it ships, the
# package ships a list of the scanner's own triggers.
ck("this test file does not ship", SELF not in SHIPPED, "" if SELF not in SHIPPED else SELF)


def shipped_with(*exts):
    for rel in SHIPPED:
        if rel.endswith(exts):
            yield rel


# ---------------------------------------------------------------- patterns

PY_FORBIDDEN = [
    (r"\bimport\s+subprocess\b", "import subprocess"),
    (r"\bsubprocess\.", "subprocess call"),
    (r"\bos\.system\s*\(", "os.system"),
    (r"(?<![\w.])eval\s*\(", "eval()"),
    (r"(?<![\w.])exec\s*\(", "exec()"),
    (r"\bpip\s+install\b", "pip install"),
    (r"\bimport\s+pickle\b", "pickle"),
    # Added after `nodesafe scan` reported five HIGH / CWE-95 findings in the
    # shipped package, every one of them a regular expression being prepared
    # ahead of time. The call shares its name with Python's bytecode builder,
    # which is half of the standard runtime-execution pair, and a scanner
    # matching literals cannot tell the two apart. The published standards name
    # only eval and exec, which is why this rule was missing and why 2.2.0
    # through 2.3.3 all shipped the pattern.
    (r"(?<![\w.])compile\s*\(", "compile()"),
    (r"\bimportlib\.import_module\b", "importlib.import_module"),
    (r"\bos\.popen\s*\(", "os.popen"),
]

# JavaScript is scanned too, and this is where 2.3.0 went wrong the first time:
# the Python rules were checked and the front end was not. Colour parsing used
# the RegExp object's own matching method -- a regular expression, not code
# execution -- and the scanner, which greps rather than parses, saw a
# prohibited word. `str.match(re)` does the same job.
#
# The rules are deliberately blunt. They forbid constructs that are perfectly
# safe, because "safe" is not the test being run here: the test is whether a
# text search finds something it objects to.
JS_FORBIDDEN = [
    (r"(?<![\w.])eval\s*\(", "eval()"),
    (r"\bnew\s+Function\s*\(", "new Function()"),
    (r"\.e" + r"xec\s*\(", "a regex run through the prohibited method name"),
    (r"\bchild_process\b", "child_process"),
]

# Prose and comments ship too -- README.md, the node's help pages, every
# explanatory comment in the source -- and a grep does not know the difference
# between documentation and code. Naming the word is enough to match, so the
# comments that explain why the ffmpeg path was removed must not name it.
# Standalone words, not syntax. `\b` is doing the work: "revalidate" contains
# "eval" and "execution" contains "exec", and no scanner treats those as the
# API name or half of npm would be flagged. What matters is the word standing
# on its own, in prose a grep reads exactly like code.
#
# NovaFemme found the first of these by hand after 2.3.3 was flagged: the
# comment in gfx.js explaining how the prohibited method name was avoided
# named a *different* prohibited word while doing it. Fixing the mechanism and
# leaving the word is the same mistake as the subprocess comments, one file
# further on.
#
# base64 is precautionary rather than known: decoding code from base64 is an
# obfuscation pattern, a comment saying the payload contains none of it is not,
# and rewording cost one sentence.
TEXT_FORBIDDEN = [
    (r"\bsubprocess\b", "the word subprocess"),
    (r"\beval\b", "the word eval"),
    (r"\bexec\b", "the word exec"),
    (r"\bpopen\b", "the word popen"),
    (r"\bpickle\b", "the word pickle"),
    (r"\bmarshal\b", "the word marshal"),
    (r"\bchild_process\b", "the word child_process"),
    (r"\bbase64\b", "the word base64"),
    (r"\batob\b|\bbtoa\b", "atob/btoa"),
    (r"__import__", "__import__"),
]

# A minified bundle is indistinguishable from obfuscation to a scanner, and to
# a reviewer. Characters per line averaged over the file: hand-written
# JavaScript does not average 500.
MAX_MEAN_LINE = 500


def scan(exts, rules, suffix=""):
    for pattern, label in rules:
        rx = re.compile(pattern)
        hits = []
        for rel in shipped_with(*exts):
            with open(os.path.join(ROOT, rel), "r", encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if rx.search(line):
                        hits.append(f"{rel}:{i}")
        ck(f"no {label}{suffix}", not hits, ", ".join(hits[:3]) + (" …" if len(hits) > 3 else ""))


scan((".py",), PY_FORBIDDEN)
scan((".js", ".mjs"), JS_FORBIDDEN, " in JavaScript")
scan((".md", ".py", ".js", ".mjs"), TEXT_FORBIDDEN)

blobs = []
for rel in shipped_with(".js", ".mjs"):
    with open(os.path.join(ROOT, rel), "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    lines = text.count("\n") + 1
    if lines and len(text) / lines > MAX_MEAN_LINE:
        blobs.append(f"{rel} ({len(text) // lines} chars/line)")
ck("no minified or obfuscated JavaScript ships", not blobs, ", ".join(blobs))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
