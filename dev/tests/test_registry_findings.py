"""Predict the Registry scanner's flags before publishing.

Every version of this pack has been flagged by the Registry's scanner and held
for a human reviewer. The scanner is a grep, and what it matched on 2.6.1 is on
record (the handover, Appendix B). This test runs the same patterns over the
files that ship and compares the result with a committed inventory,

    dev/registry_findings_expected.txt

where every expected finding has a one-line justification. A finding that is
not in the inventory fails the test: either remove the code, or add the line
and say why a reviewer should accept it. An inventory line that no longer
matches anything fails too, so the file cannot rot.

Findings are keyed on file, rule and the text of the line, not on the line
number, so unrelated edits above a finding do not break the test.

Run:  python3 dev/tests/test_registry_findings.py
      python3 dev/tests/test_registry_findings.py --list    # print current findings
"""

import fnmatch
import os
import re
import subprocess  # noqa: S404 - this file never ships (dev/ is in .comfyignore)
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
EXPECTED = os.path.join(ROOT, "dev", "registry_findings_expected.txt")

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def _patterns():
    path = os.path.join(ROOT, ".comfyignore")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


def _ignored(rel, pats):
    for pat in pats:
        p = pat.rstrip("/")
        if pat.endswith("/"):
            if rel == p or rel.startswith(p + "/"):
                return True
        elif fnmatch.fnmatch(rel, p) or rel.startswith(p + "/"):
            return True
        elif "/" not in p and fnmatch.fnmatch(os.path.basename(rel), p):
            return True
    return False


def shipped():
    raw = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True,
                         capture_output=True).stdout.decode("utf-8")
    pats = _patterns()
    return [p for p in raw.split("\0") if p and not _ignored(p, pats)]


# The patterns the scanner matched on 2.6.1, by the rule name it reported.
PY_RULES = [
    ("subprocess", re.compile(r"\bsubprocess\.(run|call|Popen|check_call|check_output)\s*\(")),
    ("network", re.compile(r"\burlopen\s*\(")),
    ("sqlite", re.compile(r"\bsqlite3\.connect\s*\(")),
    ("pymysql", re.compile(r"\.connect\s*\(\s*$|pymysql\(\)\.connect\s*\(|pymysql\.connect\s*\(")),
    ("environ", re.compile(r"\bos\.environ\s*\[")),
]
JS_RULES = [
    ("js-connect", re.compile(r"\.connect\s*\(")),
]
SEMI = re.compile(r"(;.*){5,}")


def norm(line):
    return " ".join(line.strip().split())


def findings():
    out = []
    for rel in shipped():
        if rel.endswith(".py"):
            rules = PY_RULES
        elif rel.endswith((".js", ".mjs")):
            rules = JS_RULES
        else:
            continue
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                for name, rx in rules:
                    if rx.search(line):
                        out.append((rel, name, norm(line), i))
                if rel.endswith(".py") and SEMI.search(line) and not line.lstrip().startswith("#"):
                    out.append((rel, "semicolon_5", norm(line), i))
    return out


def expected():
    rows = {}
    if not os.path.isfile(EXPECTED):
        return rows
    with open(EXPECTED, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = [p.strip() for p in line.split(" || ")]
            if len(parts) != 4:
                rows[("?", "?", f"line {n} is not 'file || rule || code || why'")] = ""
                continue
            rows[(parts[0], parts[1], parts[2])] = parts[3]
    return rows


FOUND = findings()

if "--list" in sys.argv:
    for rel, name, text, i in FOUND:
        print(f"{rel} || {name} || {text} || ")
    sys.exit(0)

print("registry findings inventory\n")
EXP = expected()
found_keys = {(rel, name, text) for rel, name, text, _ in FOUND}

ck("the inventory file exists", os.path.isfile(EXPECTED), EXPECTED)
malformed = [k[2] for k in EXP if k[0] == "?"]
ck("every inventory line is well formed", not malformed, "; ".join(malformed[:3]))

new = sorted({f"{rel}:{i} [{name}] {text[:70]}" for rel, name, text, i in FOUND
              if (rel, name, text) not in EXP})
ck("no finding ships that the inventory does not list", not new,
   "; ".join(new[:4]) + (" …" if len(new) > 4 else ""))

stale = sorted(f"{k[0]} [{k[1]}] {k[2][:60]}" for k in EXP if k[0] != "?" and k not in found_keys)
ck("no inventory line is stale", not stale, "; ".join(stale[:4]) + (" …" if len(stale) > 4 else ""))

blank = sorted(f"{k[0]} [{k[1]}]" for k, why in EXP.items() if k[0] != "?" and len(why) < 15)
ck("every expected finding carries a justification", not blank, "; ".join(blank[:4]))

print(f"\n  {len(FOUND)} findings in {len(shipped())} shipped files")
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
