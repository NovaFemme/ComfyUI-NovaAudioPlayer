#!/usr/bin/env python3
"""Can the Comfy Registry see this pack's nodes without running it?

    python3 dev/tests/test_registry_nodes.py

ComfyUI-Manager's "Node Pack Info" panel reported **No nodes found - the pack's
nodes either could not be parsed, or the pack is a frontend extension only**
against a published, Active version. The pack was fine; it was unreadable.

`__init__.py` built its tables by merging each module's dict:

    NODE_CLASS_MAPPINGS = {**NOVA_PLAYER_MAPPINGS, **MADOW_MAPPINGS, ...}

Correct Python, and invisible to a static analyser: nothing in the file states a
single node name, because the keys only exist after the code has run. The
registry does not run it. Four packs' /comfy-nodes endpoints, checked directly:

    comfyui-kjnodes           literal dict, string keys          populated
    comfyui-videohelpersuite  re-exported from one module        populated
    rgthree-comfy             literal dict, keys are X.NAME      null
    comfyui-novaaudioplayer   merged with ** from many modules   null

So this file parses the package exactly the way an extractor would -- ast only,
no imports, no torch, no ComfyUI -- and asserts the two views agree:

  * every node any module declares appears in __init__.py's literal table;
  * every node __init__.py declares is backed by a real module;
  * the display-name table covers the same set;
  * nothing is built with ** or a computed key, which would make the file
    readable to Python and blank to the registry again.

It is a duplication check, and the duplication is the point: the literal table
is what the registry reads, and a test is cheaper than another silent release.
"""

import ast
import os
import pathlib
import sys

ROOT = pathlib.Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def literal_tables(path):
    """{table name: {key: value node}} for dict literals with string keys."""
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Dict):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id not in ("NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"):
                continue
            table = out.setdefault(target.id, {})
            for k, v in zip(node.value.keys, node.value.values):
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    table[k.value] = v
    return out


print("registry node extraction\n")

# --- what the modules declare ----------------------------------------------
declared = {}
for p in sorted(ROOT.rglob("*.py")):
    rel = p.relative_to(ROOT).as_posix()
    if rel.startswith("dev/") or "__pycache__" in rel or rel == "__init__.py":
        continue
    try:
        tables = literal_tables(p)
    except SyntaxError:
        continue
    for key in tables.get("NODE_CLASS_MAPPINGS", {}):
        declared[key] = rel

# --- what __init__.py exposes ----------------------------------------------
init = ROOT / "__init__.py"
tables = literal_tables(init)
exposed = set(tables.get("NODE_CLASS_MAPPINGS", {}))
named = set(tables.get("NODE_DISPLAY_NAME_MAPPINGS", {}))

print(f"  {len(declared)} nodes declared across {len(set(declared.values()))} modules\n")

ck("__init__.py states its nodes as literal string keys", bool(exposed),
   f"{len(exposed)} found" if exposed else "none — the registry will see nothing")

missing = sorted(set(declared) - exposed)
ck("every node a module declares is in the table", not missing,
   ", ".join(missing[:4]) + (" …" if len(missing) > 4 else ""))

orphan = sorted(exposed - set(declared))
ck("every node in the table is backed by a module", not orphan,
   ", ".join(orphan[:4]) + (" …" if len(orphan) > 4 else ""))

ck("the display-name table covers the same nodes", named == exposed,
   f"{len(named)} names for {len(exposed)} nodes")

# --- the shape that caused it, guarded against coming back -----------------
tree = ast.parse(init.read_text(encoding="utf-8"))
computed = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Dict):
        continue
    if not any(isinstance(t, ast.Name)
               and t.id in ("NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS")
               for t in node.targets):
        continue
    for k in node.value.keys:
        if k is None:                       # `**other` inside the literal
            computed.append("** spread")
        elif not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
            computed.append(ast.dump(k)[:40])
ck("no ** spread or computed key in either table", not computed,
   ", ".join(sorted(set(computed))[:3]))

# --- the classes are importable by name, not hidden behind a dict lookup ----
imported = set()
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom):
        imported |= {a.asname or a.name for a in node.names}
unresolvable = sorted(
    key for key, v in tables.get("NODE_CLASS_MAPPINGS", {}).items()
    if not (isinstance(v, ast.Name) and v.id in imported)
)
ck("every value is a directly imported class", not unresolvable,
   ", ".join(unresolvable[:4]) + (" …" if len(unresolvable) > 4 else ""))

# --- categories come from nova_categories, not from a string --------------
#
# Nova Lyric Score imported ANALYSIS, never used it, and hardcoded
# "Nova Audio Player/Transcription" instead -- which gave it a top-level menu of
# its own, outside the pack's seven groups. It went unnoticed long enough to be
# missing from the hand-written node-menu map, because it was not in the menu
# anyone was reading.
hardcoded = []
for p in sorted(ROOT.rglob("*.py")):
    rel = p.relative_to(ROOT).as_posix()
    if rel.startswith("dev/") or "__pycache__" in rel:
        continue
    try:
        t = ast.parse(p.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        continue
    for node in ast.walk(t):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(x, ast.Name) and x.id == "CATEGORY" for x in node.targets):
            continue
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            hardcoded.append(f"{rel}:{node.lineno} {node.value.value!r}")
ck("no node hardcodes its menu category", not hardcoded, "; ".join(hardcoded[:3]))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
