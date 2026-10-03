"""Recorded sequences: the on-disk store (nova_player/sequences.py).

The folder is one users are told they may copy files into and out of by hand,
so the store is tested for what that invites: names that try to leave the
folder, files that are not JSON, files that are JSON but not sequences, and
two sequences wanting the same name. Nothing here may overwrite a file or
write outside <root>/<renderer>/.

Dependency-free: the store imports nothing from ComfyUI.

Run:  python3 dev/tests/test_sequences.py
"""

import importlib.util
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

PASS = FAIL = 0


def ck(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


# Load the module by path: importing the package would pull in the node, which
# imports folder_paths, which only exists inside ComfyUI.
spec = importlib.util.spec_from_file_location(
    "nova_sequences", os.path.join(ROOT, "nova_player", "sequences.py"))
seq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seq)

print("recorded sequences — store\n")

tmp = tempfile.mkdtemp(prefix="nova_seq_test_")
store = seq.SequenceStore(tmp)
SEQ = {"start": {"tilt": 0}, "steps": [{"wait_ms": 500, "key": "tilt", "value": 30},
                                       {"wait_ms": 1500, "key": "spin", "value": 0.2}],
       "end_ms": 1000}

# -- names ------------------------------------------------------------------
ck("clean_name keeps an ordinary name", seq.clean_name("Spinning Fury Master xyz") == "Spinning Fury Master xyz")
ck("clean_name strips path characters", seq.clean_name("../../etc/passwd") == "etcpasswd",
   repr(seq.clean_name("../../etc/passwd")))
ck("clean_name of only junk is empty", seq.clean_name("/// \\\\ ..") == "")
ck("renderer ids are checked", seq.valid_renderer_id("halo") and not seq.valid_renderer_id("../x")
   and not seq.valid_renderer_id("Halo"))

# -- save / list / read ---------------------------------------------------------
ok, res = store.save("halo", "Spinning Fury", SEQ)
ck("save writes the file", ok and os.path.isfile(os.path.join(tmp, "halo", "Spinning Fury.json")), str(res))
ok, res = store.save("halo", "Spinning Fury", SEQ)
ck("a clash never overwrites: second save becomes (2)", ok and res["name"] == "Spinning Fury (2)", str(res))
saved = json.load(open(os.path.join(tmp, "halo", "Spinning Fury.json"), encoding="utf-8"))
ck("saved file carries format, version, renderer and name",
   saved.get("format") == seq.FORMAT and saved.get("version") == seq.VERSION
   and saved.get("renderer") == "halo" and saved.get("name") == "Spinning Fury")

ok, res = store.list("halo")
names = [i["name"] for i in res["items"]] if ok else []
ck("list returns both, sorted", names == ["Spinning Fury", "Spinning Fury (2)"], str(names))
first = res["items"][0] if ok else {}
ck("list summarises steps and length", first.get("steps") == 2 and first.get("duration_ms") == 3000, str(first))
ck("list reports the folder", ok and res["folder"] == os.path.join(tmp, "halo"))

ok, res = store.read("halo", "Spinning Fury")
ck("read returns the sequence", ok and res["steps"][0]["key"] == "tilt")

# -- per renderer ---------------------------------------------------------------
ok, res = store.list("spectrum")
ck("another renderer has its own (empty) folder", ok and res["items"] == [])

# -- hostile input ---------------------------------------------------------------
ok, _ = store.read("halo", "../halo/Spinning Fury")
ck("read refuses a name with a path in it", not ok)
ok, _ = store.delete("halo", "..")
ck("delete refuses '..'", not ok)
ok, _ = store.save("../evil", "x", SEQ)
ck("save refuses a bad renderer id", not ok and not os.path.exists(os.path.join(tmp, "..", "evil")))
ok, res = store.save("halo", "../../escape", SEQ)
ck("a path-y name is cleaned and stays in the folder",
   ok and os.path.isfile(os.path.join(tmp, "halo", res["name"] + ".json")), str(res))
ok, _ = store.save("halo", "", SEQ)
ck("an empty name is refused", not ok)
ok, _ = store.save("halo", "x", {"no": "steps"})
ck("a body without steps is refused", not ok)
ok, _ = store.save("halo", "x", {"steps": [{}] * (seq.MAX_STEPS + 1)})
ck("too many steps is refused", not ok)

# Files dropped in by hand.
open(os.path.join(tmp, "halo", "broken.json"), "w").write("{not json")
open(os.path.join(tmp, "halo", "array.json"), "w").write("[1,2,3]")
open(os.path.join(tmp, "halo", "notes.txt"), "w").write("ignored")
ok, res = store.list("halo")
by = {i["name"]: i for i in res["items"]} if ok else {}
ck("a broken file is listed with an error (so it can be deleted)", "error" in by.get("broken", {}), str(by.get("broken")))
ck("a non-object JSON file is listed without crashing", "array" in by and by["array"].get("steps") == 0)
ck("non-JSON files are not listed", "notes" not in by)
ok, _ = store.read("halo", "array")
ck("reading a non-object file is an error, not a crash", not ok)

# -- delete -----------------------------------------------------------------------
ok, _ = store.delete("halo", "Spinning Fury (2)")
ck("delete removes the file", ok and not os.path.exists(os.path.join(tmp, "halo", "Spinning Fury (2).json")))
ok, msg = store.delete("halo", "Spinning Fury (2)")
ck("deleting it again says Not found", not ok and msg == "Not found")

# -- default location ---------------------------------------------------------------
os.environ.pop("NOVA_SEQUENCES_DIR", None)
root = seq.default_root()
ck("default root ends in nova_player/sequences (or the package fallback)",
   root.replace("\\", "/").endswith(("nova_player/sequences", "/sequences")), root)
os.environ["NOVA_SEQUENCES_DIR"] = "/tmp/xyz"
ck("NOVA_SEQUENCES_DIR overrides the root", seq.default_root() == "/tmp/xyz")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
