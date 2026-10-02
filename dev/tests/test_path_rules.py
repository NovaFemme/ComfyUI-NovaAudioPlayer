"""Caller-chosen paths: what the pack will open, and what it refuses.

The Registry reviewer holds versions for "arbitrary file read" (policy v0.5).
Two questions decide it: can a caller reach the code through /prompt or an
unauthenticated route, and does it open a file at a path the caller chooses?

Until 2.7.0 the SQLite browser let an absolute path straight through
(`if os.path.isabs(path): return path`), so three requests to its routes
returned the rows of any SQLite file on the machine. This test is that attack,
kept as a regression test, plus the same rule on the deprecated Reader and the
check on `acestep_repo_path`, which names a folder code is imported from.

No ComfyUI needed: `server`, `aiohttp.web` and `folder_paths` are stand-ins.

Run:  python3 dev/tests/test_path_rules.py
"""

import asyncio
import importlib.util
import json
import os
import sqlite3
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


# ---------------------------------------------------------------- a fake ComfyUI
TMP = os.path.realpath(tempfile.mkdtemp(prefix="nova_paths_"))
INPUT, OUTPUT, TEMP, USER = (os.path.join(TMP, d) for d in ("input", "output", "temp", "user"))
for d in (INPUT, OUTPUT, TEMP, USER, os.path.join(INPUT, "Album Databases"), os.path.join(TMP, "elsewhere")):
    os.makedirs(d)


def make_db(path, value):
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE tracks (title TEXT, note TEXT)")
        conn.execute("INSERT INTO tracks VALUES (?, ?)", ("one", value))
    return path


INSIDE = make_db(os.path.join(INPUT, "Album Databases", "album.db"), "inside-value")
OUTSIDE = make_db(os.path.join(TMP, "elsewhere", "cookies.sqlite"), "SECRET-outside-value")
os.symlink(OUTSIDE, os.path.join(INPUT, "link.db"))            # a link out of the folder

fp = types.ModuleType("folder_paths")
fp.get_input_directory = lambda: INPUT
fp.get_output_directory = lambda: OUTPUT
fp.get_temp_directory = lambda: TEMP
fp.get_user_directory = lambda: USER
sys.modules["folder_paths"] = fp


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


ROUTES = Routes()
web = types.ModuleType("aiohttp.web")
web.json_response = lambda data=None, status=200, **kw: Response(data, status)
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = web
sys.modules["aiohttp"], sys.modules["aiohttp.web"] = aiohttp, web
server = types.ModuleType("server")
server.PromptServer = type("PromptServer", (), {"instance": type("I", (), {"routes": ROUTES})()})
sys.modules["server"] = server
sys.path.insert(0, ROOT)                    # nova_definitions, nova_categories


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Request:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def post(path, body):
    return asyncio.run(ROUTES.table[("POST", path)](Request(body))).data


# ---------------------------------------------------------------- SQLite browser
print("caller-chosen paths\n\nSQLite browser routes")
browser = load("nova_sqlite_browser_t", "authoring/nova_sqlite_browser.py")


def three_requests(db):
    """The attack: tables, then columns, then the rows."""
    t = post("/sqlite_browser/get_tables", {"database_path": db})
    c = post("/sqlite_browser/get_columns", {"database_path": db, "table_name": "tracks"})
    r = post("/sqlite_browser/preview/browser",
             {"database_path": db, "table_name": "tracks", "selected_columns": '["title","note"]'})
    return t, c, r


REFUSED = {
    "an absolute path outside input/": OUTSIDE,
    "a relative path that climbs out": "../elsewhere/cookies.sqlite",
    "a symlink inside input/ that points out": "link.db",
    "an absolute path through the symlink": os.path.join(INPUT, "link.db"),
    "/etc/passwd": "/etc/passwd",
    "input/../elsewhere": os.path.join(INPUT, "..", "elsewhere", "cookies.sqlite"),
}
for label, db in REFUSED.items():
    t, c, r = three_requests(db)
    leaked = "SECRET" in json.dumps([t, c, r])
    ck(f"refused: {label}", not t.get("tables") and not c.get("columns")
       and not r.get("row_count") and not leaked,
       "LEAKED the row" if leaked else "")
    ck(f"  and the node itself refuses it (/prompt)", browser._resolve_db_path(db) == "")

ALLOWED = {
    "a relative path inside input/": "Album Databases/album.db",
    "an absolute path that points inside input/": INSIDE,
}
for label, db in ALLOWED.items():
    t, c, r = three_requests(db)
    ck(f"allowed: {label}", t.get("tables") == ["tracks"] and "note" in json.dumps(c)
       and "inside-value" in json.dumps(r), json.dumps(r)[:100])

ck("a list value (how the widget sends it) is still resolved",
   browser._resolve_db_path(["Album Databases/album.db"]) == INSIDE)
ck("the 'no database' placeholder resolves to nothing", browser._resolve_db_path(browser.NO_DB) == "")

# ---------------------------------------------------------------- deprecated Reader
print("\nNova SQLite Reader (deprecated)")
reader = load("nova_sqlite_reader_t", "authoring/nova_sqlite_reader.py")


def refuses(fn, *args):
    try:
        fn(*args)
    except PermissionError:
        return True
    except Exception as exc:                  # anything else is the wrong refusal
        return f"{type(exc).__name__}: {exc}"
    return False


ck("opens a database inside input/", reader._resolve_database("Album Databases/album.db", "", "") == (INSIDE, False))
ck("opens it by absolute path too", reader._resolve_database(INSIDE, "", "") == (INSIDE, False))
ck("refuses a database outside input/", refuses(reader._resolve_database, OUTSIDE, "", "") is True)
ck("refuses the symlink out of input/", refuses(reader._resolve_database, "link.db", "", "") is True)
ck("refuses ~ expansion out of input/", refuses(reader._resolve_database, "~/x.db", "", "") is True)
target = os.path.join(TMP, "elsewhere", "made")
ck("refuses to create a database outside input/", refuses(reader._resolve_database, "", target, "new") is True
   and not os.path.exists(target))
path, created = reader._resolve_database("", "new folder", "fresh")
ck("still creates one inside input/", created and path == os.path.join(INPUT, "new folder", "fresh.db")
   and os.path.isfile(path), path)

# ---------------------------------------------------------------- acestep_repo_path
print("\nacestep_repo_path")
defs = load("nova_definitions_t", "nova_definitions.py")


def clone(parent, name="ACE-Step-1.5", package=True):
    root = os.path.join(parent, name)
    os.makedirs(os.path.join(root, "acestep"))
    if package:
        open(os.path.join(root, "acestep", "__init__.py"), "w").close()
    return root


good = clone(os.path.join(TMP, "elsewhere"))
ck("an empty value is fine (the package is installed)", defs.check_acestep_repo("") == ("", ""))
ck("a real clone is accepted", defs.check_acestep_repo(good) == (good, ""))
ck("quotes around the path are stripped", defs.check_acestep_repo(f'"{good}"') == (good, ""))
ck("a folder that does not exist is refused", bool(defs.check_acestep_repo(os.path.join(TMP, "nope"))[1]))
ck("a folder with no acestep/__init__.py is refused",
   "does not look like" in defs.check_acestep_repo(clone(os.path.join(TMP, "elsewhere"), "empty", False))[1])
for label, parent in (("input", INPUT), ("output", OUTPUT), ("temp", TEMP)):
    bad = clone(parent)
    ck(f"a clone inside ComfyUI's {label} folder is refused",
       "is inside ComfyUI's" in defs.check_acestep_repo(bad)[1])
os.symlink(os.path.join(INPUT, "ACE-Step-1.5"), os.path.join(TMP, "elsewhere", "innocent"))
ck("a symlink that leads into the input folder is refused",
   "is inside ComfyUI's" in defs.check_acestep_repo(os.path.join(TMP, "elsewhere", "innocent"))[1])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
