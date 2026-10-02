"""Recorded sequences: the four HTTP routes (nova_player/routes.py).

test_sequences.py covers the store. This covers what a browser, or anything
else that can reach ComfyUI's port, can do through the routes that sit on top
of it:

    GET    /nova_player/sequences/{renderer}
    GET    /nova_player/sequences/{renderer}/{name}
    POST   /nova_player/sequences/{renderer}
    DELETE /nova_player/sequences/{renderer}/{name}

The routes have no authentication, so the question each check asks is the
Registry reviewer's: can a caller make this read, write or delete a file
outside the sequences folder? Status codes are checked too, because the drawer
relies on 404 meaning "not found" and 400 meaning "refused".

No ComfyUI and no aiohttp needed: `server`, `aiohttp.web` and `folder_paths`
are stand-ins that record the handlers, and the handlers are called directly.

Run:  python3 dev/tests/test_sequence_routes.py
"""

import asyncio
import importlib
import json
import os
import sys
import tempfile
import types

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


# ---------------------------------------------------------------- stand-ins
TMP = tempfile.mkdtemp(prefix="nova_seq_routes_")
SEQ_ROOT = os.path.join(TMP, "sequences")
os.environ["NOVA_SEQUENCES_DIR"] = SEQ_ROOT

# A file outside the sequences folder that no route may read, change or delete.
OUTSIDE = os.path.join(TMP, "outside.json")
with open(OUTSIDE, "w", encoding="utf-8") as fh:
    json.dump({"secret": "do not serve"}, fh)


class Response:
    def __init__(self, data=None, status=200, **_):
        self.data, self.status = data, status


class Routes:
    def __init__(self):
        self.table = {}

    def _add(self, method, path):
        def deco(fn):
            self.table[(method, path)] = fn
            return fn
        return deco

    def get(self, path):
        return self._add("GET", path)

    def post(self, path):
        return self._add("POST", path)

    def delete(self, path):
        return self._add("DELETE", path)


ROUTES = Routes()

web = types.ModuleType("aiohttp.web")
web.json_response = lambda data=None, status=200, **kw: Response(data, status)
web.Response = Response
web.FileResponse = Response
web.HTTPFound = type("HTTPFound", (Exception,), {})
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = web
sys.modules["aiohttp"], sys.modules["aiohttp.web"] = aiohttp, web

server = types.ModuleType("server")
server.PromptServer = type("PromptServer", (), {"instance": type("I", (), {"routes": ROUTES})()})
sys.modules["server"] = server

sys.path.insert(0, os.path.join(ROOT, "dev", "stubs"))      # folder_paths

# Import nova_player.routes without running nova_player/__init__.py, which
# imports the node and with it torch.
pkg = types.ModuleType("nova_player")
pkg.__path__ = [os.path.join(ROOT, "nova_player")]
sys.modules["nova_player"] = pkg
routes_mod = importlib.import_module("nova_player.routes")


class Request:
    def __init__(self, body=None, bad_json=False, **match):
        self.match_info, self._body, self._bad = match, body, bad_json
        self.query = {}

    async def json(self):
        if self._bad:
            raise ValueError("not json")
        return self._body


def call(method, path, **kw):
    return asyncio.run(ROUTES.table[(method, path)](Request(**kw)))


LIST = "/nova_player/sequences/{renderer_id}"
ONE = "/nova_player/sequences/{renderer_id}/{name}"
SEQ = {"start": {"tilt": 0}, "steps": [{"wait_ms": 500, "key": "tilt", "value": 30}],
       "end_ms": 1000}

print("recorded sequences — HTTP routes\n")

ck("register_routes() registers", routes_mod.register_routes() is True)
for key in (("GET", LIST), ("GET", ONE), ("POST", LIST), ("DELETE", ONE)):
    ck(f"{key[0]} {key[1]} is registered", key in ROUTES.table)

# -- the ordinary round trip ---------------------------------------------------
r = call("POST", LIST, renderer_id="halo", body={"name": "Slow Turn", "sequence": SEQ})
ck("POST saves a sequence", r.status == 200 and r.data.get("status") == "success", str(r.data))
ck("the file is inside the sequences folder",
   os.path.isfile(os.path.join(SEQ_ROOT, "halo", "Slow Turn.json")))

r = call("GET", LIST, renderer_id="halo")
ck("GET lists it", r.status == 200 and "Slow Turn" in json.dumps(r.data), str(r.data)[:120])

r = call("GET", ONE, renderer_id="halo", name="Slow Turn")
ck("GET returns it", r.status == 200 and r.data.get("sequence", {}).get("end_ms") == 1000, str(r.data)[:120])

first = open(os.path.join(SEQ_ROOT, "halo", "Slow Turn.json"), encoding="utf-8").read()
r = call("POST", LIST, renderer_id="halo", body={"name": "Slow Turn", "sequence": dict(SEQ, end_ms=2000)})
ck("POST of a name that exists is saved under a new name", r.status == 200
   and r.data.get("name") == "Slow Turn (2)", str(r.data.get("name")))
ck("and the first file is not overwritten",
   open(os.path.join(SEQ_ROOT, "halo", "Slow Turn.json"), encoding="utf-8").read() == first)

# -- what a hostile caller tries ----------------------------------------------
for rid in ("../halo", "..", "Halo", "a/b", "", "x" * 41):
    r = call("GET", LIST, renderer_id=rid)
    ck(f"GET list refuses renderer id {rid[:12]!r}", r.status == 400, f"status {r.status}")

for name in ("../outside", "../../outside.json", "/etc/passwd", "..", "outside.json/..", OUTSIDE):
    r = call("GET", ONE, renderer_id="halo", name=name)
    ck(f"GET refuses the name {name[-22:]!r}", r.status in (400, 404) and "secret" not in json.dumps(r.data),
       f"status {r.status}")
    r = call("DELETE", ONE, renderer_id="halo", name=name)
    ck(f"DELETE refuses the name {name[-22:]!r}", r.status in (400, 404), f"status {r.status}")

ck("the file outside the folder is untouched",
   os.path.isfile(OUTSIDE) and json.load(open(OUTSIDE)) == {"secret": "do not serve"})

# A save cleans the name instead of refusing it, so the check is where the file
# lands: inside <root>/halo/, whatever the caller asked for.
before = sorted(os.listdir(TMP))
for name in ("../escape", "../../escape2", "/tmp/escape3", "a/b", "..\\..\\escape4"):
    r = call("POST", LIST, renderer_id="halo", body={"name": name, "sequence": SEQ})
    saved = r.data.get("name", "") if r.status == 200 else ""
    inside = r.status == 400 or (
        saved and os.sep not in saved and "/" not in saved and ".." not in saved
        and os.path.isfile(os.path.join(SEQ_ROOT, "halo", saved + ".json")))
    ck(f"POST with the name {name!r} stays inside the folder", bool(inside),
       f"status {r.status}, saved as {saved!r}")
for junk in ("", "///", " .. "):
    r = call("POST", LIST, renderer_id="halo", body={"name": junk, "sequence": SEQ})
    ck(f"POST refuses the empty name {junk!r}", r.status == 400, f"status {r.status}")
r = call("POST", LIST, renderer_id="../halo", body={"name": "x", "sequence": SEQ})
ck("POST refuses a renderer id that climbs out", r.status == 400, f"status {r.status}")
ck("nothing was written outside the sequences folder", sorted(os.listdir(TMP)) == before
   and sorted(os.listdir(SEQ_ROOT)) == ["halo"],
   str(sorted(os.listdir(TMP))) + " " + str(sorted(os.listdir(SEQ_ROOT))))
ck("no temp file is left behind", not [f for f in os.listdir(os.path.join(SEQ_ROOT, "halo"))
                                      if not f.endswith(".json")])

# -- malformed bodies ------------------------------------------------------------
r = call("POST", LIST, renderer_id="halo", bad_json=True)
ck("POST with a body that is not JSON is a 400", r.status == 400)
r = call("POST", LIST, renderer_id="halo", body=["not", "an", "object"])
ck("POST with a JSON list is a 400, not a crash", r.status == 400, f"status {r.status}")
r = call("POST", LIST, renderer_id="halo", body={"name": "No Steps", "sequence": {"nope": 1}})
ck("POST with something that is not a sequence is a 400", r.status == 400, f"status {r.status}")
r = call("POST", LIST, renderer_id="halo",
         body={"name": "Too Long", "sequence": {"start": {}, "end_ms": 1,
               "steps": [{"wait_ms": 1, "key": "tilt", "value": 1}] * 50001}})
ck("POST with more than 50,000 steps is a 400", r.status == 400, f"status {r.status}")

# -- not found, and delete ---------------------------------------------------------
r = call("GET", ONE, renderer_id="halo", name="Never Saved")
ck("GET of a name that does not exist is a 404", r.status == 404, f"status {r.status}")
r = call("DELETE", ONE, renderer_id="halo", name="Never Saved")
ck("DELETE of a name that does not exist is a 404", r.status == 404, f"status {r.status}")
r = call("DELETE", ONE, renderer_id="halo", name="Slow Turn")
ck("DELETE removes a saved sequence", r.status == 200
   and not os.path.exists(os.path.join(SEQ_ROOT, "halo", "Slow Turn.json")), str(r.data))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
