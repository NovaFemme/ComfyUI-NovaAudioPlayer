#!/usr/bin/env python3
"""Do the nodes that are meant to connect have matching socket types?

    python3 dev/tests/test_link_types.py

ComfyUI joins an output to an input only when their types are equal. B-19
(handover Revision 4): Nova Track Inspector put `inspection_json` out as
STRING and its Report viewer took it as NOVA_REPORT, so the link was refused.
Twelve suites passed, because none of them looked at this.

Read with ast only: no imports, no torch, no ComfyUI.

  * every connection in CONNECTIONS has the same type on both ends;
  * no type this pack invents is one-sided: a custom type that is only ever an
    output, or only ever an input, can never be connected to anything.
"""

import ast
import os
import pathlib
import sys

ROOT = pathlib.Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
SKIP = {"dev", "docs", ".git", ".trash", "__pycache__", "web", "node_modules"}

# (source class, output name) -> (target class, input name). The connections
# the README, the help pages and the example workflows describe.
CONNECTIONS = [
    ("NovaTrackInspector", "inspection_json", "NovaTrackInspectorReportViewer", "inspection_json"),
    ("NovaTrackInspector", "inspection_json", "NovaLyricReportViewer", "inspection_json"),
    ("NovaTrackInspector", "inspection_json", "NovaConsole", "value"),
    ("NovaTrackInspectorReportViewer", "inspection_json", "NovaConsole", "value"),
    ("NovaAudioMaster", "report_json", "NovaMasterReportViewer", "report_json"),
    ("NovaAudioMaster", "report_json", "NovaMasterIdentity", "report_json"),
    ("NovaAudioMaster", "report_json", "NovaFinalMasterValidator", "reference_report_json"),
    ("NovaMasterReportViewer", "report_json", "NovaMasterIdentity", "report_json"),
    ("NovaSQLiteSingleRowNode", "single_row_json", "NovaMasterIdentity", "identity_fields_json"),
]

# Types ComfyUI itself defines, or that other packs' nodes provide and accept.
# LIST and SAMPLE_RATE are outputs kept for other packs' nodes; nothing in this
# pack takes them, by design.
KNOWN = {"STRING", "INT", "FLOAT", "BOOLEAN", "AUDIO", "IMAGE", "MASK", "LATENT",
         "MODEL", "CLIP", "VAE", "CONDITIONING", "COMBO", "*", "LIST", "SAMPLE_RATE"}

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


CONSTANTS = {}   # module-level NAME = "TEXT" in the file being read


def text(node):
    """A string constant, or a module-level name that holds one."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        if "ANY" in node.id.upper():
            return "*"
        return CONSTANTS.get(node.id)
    return None


def strings(node):
    """The entries of a tuple/list literal. For `("A", "B") + (...) * N` the
    literal part on the left, which is where the named outputs are."""
    if isinstance(node, ast.BinOp):
        return strings(node.left)
    if isinstance(node, (ast.Tuple, ast.List)):
        return [text(e) for e in node.elts]
    return None


def socket_type(value):
    """The type an INPUT_TYPES entry declares: ("STRING", {...}) -> "STRING"."""
    if not isinstance(value, ast.Tuple) or not value.elts:
        return None
    first = value.elts[0]
    if text(first):
        return text(first)
    if isinstance(first, (ast.List, ast.Name, ast.Call, ast.Attribute, ast.BinOp, ast.ListComp)):
        return "COMBO"
    return None


def read_classes():
    """{class name: {"out": {name: type}, "in": {name: type}, "file": path}}"""
    found = {}
    for path in sorted(ROOT.rglob("*.py")):
        if SKIP & set(path.relative_to(ROOT).parts):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        CONSTANTS.clear()
        for item in tree.body:
            if isinstance(item, ast.Assign) and len(item.targets) == 1 \
                    and isinstance(item.targets[0], ast.Name) \
                    and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str):
                CONSTANTS[item.targets[0].id] = item.value.value
        for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
            types = names = None
            inputs = {}
            for item in cls.body:
                if isinstance(item, ast.Assign) and len(item.targets) == 1 \
                        and isinstance(item.targets[0], ast.Name):
                    if item.targets[0].id == "RETURN_TYPES":
                        types = strings(item.value)
                    elif item.targets[0].id == "RETURN_NAMES":
                        names = strings(item.value)
                elif isinstance(item, ast.FunctionDef) and item.name == "INPUT_TYPES":
                    for d in [n for n in ast.walk(item) if isinstance(n, ast.Dict)]:
                        for k, v in zip(d.keys, d.values):
                            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                t = socket_type(v)
                                if t:
                                    inputs[k.value] = t
            if types is None and not inputs:
                continue
            out = {}
            for i, t in enumerate(types or []):
                name = names[i] if names and i < len(names) and names[i] else (t or f"#{i}")
                if t:
                    out[name] = t
            found[cls.name] = {"out": out, "in": inputs,
                               "file": str(path.relative_to(ROOT))}
    return found


def main():
    classes = read_classes()
    ck("node classes were read", len(classes) >= 25, f"{len(classes)} classes")

    print("\nDocumented connections")
    for src, out, dst, inp in CONNECTIONS:
        label = f"{src}.{out} -> {dst}.{inp}"
        a = classes.get(src, {}).get("out", {}).get(out)
        b = classes.get(dst, {}).get("in", {}).get(inp)
        if a is None or b is None:
            ck(label, False, f"not found: output {a!r}, input {b!r}")
        else:
            ck(label, a == b or "*" in (a, b), f"{a} -> {b}")

    print("\nTypes this pack invents")
    outs, ins = {}, {}
    for name, c in classes.items():
        for t in c["out"].values():
            outs.setdefault(t, set()).add(name)
        for t in c["in"].values():
            ins.setdefault(t, set()).add(name)
    custom = sorted((set(outs) | set(ins)) - KNOWN)
    for t in custom:
        ck(f"{t} has both an output and an input", t in outs and t in ins,
           f"out: {sorted(outs.get(t, []))}  in: {sorted(ins.get(t, []))}")
    if not custom:
        ck("no custom socket types", True)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
