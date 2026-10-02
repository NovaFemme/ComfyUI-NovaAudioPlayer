"""No shipped module may put the pack on sys.path.

Why this test exists
--------------------
In October 2026, 28 modules began with

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from nova_categories import X

to get "clean absolute imports". It worked for this pack and changed imports
for everything else in the ComfyUI process: with the pack folder first on the
search path, a plain `import training`, `import utilities`, `import analysis`
or `import install` anywhere resolved to THIS pack's folders. Another pack
with a module of the same name would have been handed the wrong code. Two
root-level files went one level too high and added `custom_nodes/` itself.

The pack is a package. Its modules reach each other with relative imports
(`from ..nova_categories import X`), with an absolute fallback under
`except ImportError` for these tests, which import modules directly with the
pack root on the path.

What is allowed
---------------
Adding the user's ACE-Step clone to sys.path INSIDE A FUNCTION, when a node
runs: that is how the training nodes find `acestep`. It is listed below by
file, so a new one is a conscious decision.

`training/nova_ace_setup.py` is a standalone script, not a node module.

Run:  python3 dev/tests/test_no_syspath.py
"""

import ast
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

SKIP_DIRS = {".git", "__pycache__", "dev", "docs", "transcribe", "node_modules"}
STANDALONE = {"install.py", "training/nova_ace_setup.py"}

#: Files that may extend sys.path inside a function, and why.
ALLOWED_IN_FUNCTION = {
    "training/nova_ace_preprocess.py": "adds the user's ACE-Step clone when the node runs",
    "training/nova_ace_check.py": "adds the user's ACE-Step clone when the node runs",
}

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def is_sys_path_write(node):
    """sys.path.insert(...), sys.path.append(...), sys.path.extend(...)."""
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    return (isinstance(f, ast.Attribute) and f.attr in ("insert", "append", "extend")
            and isinstance(f.value, ast.Attribute) and f.value.attr == "path"
            and isinstance(f.value.value, ast.Name) and f.value.value.id == "sys")


def scan(path):
    """(module-level writes, in-function writes) as line numbers."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    in_function = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for sub in ast.walk(node):
                if is_sys_path_write(sub):
                    in_function.add(sub.lineno)
    every = {n.lineno for n in ast.walk(tree) if is_sys_path_write(n)}
    return sorted(every - in_function), sorted(in_function)


print("sys.path stays untouched\n")

module_level, unlisted = [], []
checked = 0
for d, ds, fs in os.walk(ROOT):
    ds[:] = [x for x in ds if x not in SKIP_DIRS]
    for f in sorted(fs):
        if not f.endswith(".py"):
            continue
        full = os.path.join(d, f)
        rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
        if rel in STANDALONE:
            continue
        checked += 1
        top, inner = scan(full)
        module_level += [f"{rel}:{n}" for n in top]
        if inner and rel not in ALLOWED_IN_FUNCTION:
            unlisted += [f"{rel}:{n}" for n in inner]

print(f"  {checked} modules checked\n")
ck("no module changes sys.path when it is imported", not module_level,
   ", ".join(module_level[:4]) + (" …" if len(module_level) > 4 else ""))
ck("sys.path is extended inside a function only where listed", not unlisted,
   ", ".join(unlisted[:4]))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
