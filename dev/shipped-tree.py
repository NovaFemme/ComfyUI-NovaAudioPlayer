#!/usr/bin/env python3
"""Materialise exactly what `comfy node publish` uploads, so a scanner can read it.

    python3 dev/shipped-tree.py /tmp/shipcheck
    nodesafe scan /tmp/shipcheck

Point a scanner at the repository and it reads the working tree: `.trash/`
(scratch the sandbox cannot delete), `dev/` (the test suite, one file of which
is a table of the literals scanners hunt for), and any untracked file lying
around. None of that is published.

    "By default `comfy node publish` packages every file tracked by git."
    https://docs.comfy.org/registry/publishing

So the published set is `git ls-files` minus `.comfyignore`, and that is what a
verdict should be formed on. `nodesafe scan ./` returned 0.85 / malicious on
this repository, with the single `eval()` finding coming from a two-line probe
file that has never been in a release archive.
"""

import fnmatch
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def patterns():
    f = ROOT / ".comfyignore"
    if not f.exists():
        return []
    return [ln.strip() for ln in f.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")]


def ignored(rel, pats):
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


def main():
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/shipcheck").resolve()
    if dest.exists():
        shutil.rmtree(dest)

    raw = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT,
                         check=True, capture_output=True).stdout.decode()
    pats = patterns()
    files = [p for p in raw.split("\0") if p and not ignored(p, pats)]

    for rel in files:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, target)

    print(f"{len(files)} files -> {dest}")
    print(f"\n  nodesafe scan {dest}")


if __name__ == "__main__":
    main()
