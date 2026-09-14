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

# THE RULES, AS PUBLISHED. https://docs.comfy.org/registry/standards
#
#   "The use of `eval` and `exec` functions is prohibited in custom nodes due
#    to security concerns."
#   "Runtime package installation through subprocess calls is not permitted."
#   "Code obfuscation is prohibited in custom nodes."
#
# That is the whole list, and this file used to be stricter than it in three
# places. The extra rules were written while five versions sat flagged and
# nobody knew why; when the flag lifted it lifted on versions that still
# contained every pattern they forbade, so they were guarding against something
# that was never happening. What they did do was block legitimate code:
#
#   * `subprocess` outright. The rule is about INSTALLING PACKAGES through it.
#     Nova ACE LoRA Trainer runs `python -m acestep...cli.train_fixed` as a
#     child process, which the standard permits, and this test refused it.
#     That misreading already cost this package its mp3 export once.
#   * `importlib.import_module`. Not in the standard at all -- imported from a
#     third-party scanner's ruleset, and that scanner also reports `re.compile`
#     as CWE-95.
#   * A regex run through the prohibited method name in JavaScript, and the
#     bare WORDS eval/exec/subprocess appearing in prose. Both were precautions
#     against a grep-based scanner nobody has evidence exists. Keeping them
#     means a training node cannot document that it spawns a child process.
#
# `compile(` stays, guarded so `re.compile` does not match: bare compile() is a
# genuine code-execution primitive and the pair to exec().
PY_FORBIDDEN = [
    (r"(?<![\w.])eval\s*\(", "eval()"),
    (r"(?<![\w.])exec\s*\(", "exec()"),
    (r"(?<![\w.])compile\s*\(", "compile()"),
    (r"\bimport\s+pickle\b", "pickle"),
    (r"__import__", "__import__"),
]

JS_FORBIDDEN = [
    (r"(?<![\w.])eval\s*\(", "eval()"),
    (r"\bnew\s+Function\s*\(", "new Function()"),
]

# THE ONE RULE THAT NEEDS MORE THAN A WORD MATCH.
#
# "Runtime package installation through subprocess calls is not permitted."
# Both halves have to be present on the same line: something that executes, and
# something that installs. That passes the two shapes this package actually
# contains --
#
#   subprocess.Popen(argv, ...)            argv is a training module, no install
#   f"    {exe} -m pip install --no-deps"  a string printed for the user to run
#
# -- and fails the shape the rule is about, `subprocess.run([sys.executable,
# "-m", "pip", "install", ...])`.
#
# It is a grep, not an analysis: split the call across two lines and it sees
# nothing. That is a known limit, not an oversight. The check that matters more
# is reading what any new execution call actually runs.
_EXECUTES = r"subprocess\.|\bPopen\b|\bcheck_call\b|\bcheck_output\b|\bos\.system\b|\bos\.popen\b|\brun\s*\("
_INSTALLS = r"\bpip\s+install\b|\bpip3\s+install\b|\buv\s+pip\b|[\"']install[\"']|\beasy_install\b"

# A minified bundle is indistinguishable from obfuscation to a scanner, and to
# a reviewer. Characters per line averaged over the file: hand-written
# JavaScript does not average 500.
MAX_MEAN_LINE = 500


def scan_install():
    """The actual subprocess rule: execution AND installation on one line."""
    ex, ins = re.compile(_EXECUTES), re.compile(_INSTALLS)
    hits = []
    for rel in shipped_with(".py"):
        with open(os.path.join(ROOT, rel), "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                if ex.search(line) and ins.search(line):
                    hits.append(f"{rel}:{i}")
    ck("no runtime package installation through a subprocess call",
       not hits, ", ".join(hits[:3]))


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
scan_install()
scan((".js", ".mjs"), JS_FORBIDDEN, " in JavaScript")

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
