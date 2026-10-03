#!/usr/bin/env python3
"""
Local development server for the Nova Player front end.

Serves the package directory and answers the config endpoints from the real
NovaConfigManager, so the whole UI can be exercised without ComfyUI running.

    python3 dev/devserver.py          # from anywhere; paths are self-locating
    -> http://127.0.0.1:8731/dev/harness.html

The harness feeds every renderer a synthetic signal, so every view works
without an audio file. `folder_paths` is stubbed in dev/stubs/ because it only
exists inside a ComfyUI process.
"""

import argparse
import http.server
import json
import os
import socketserver
import sys
from pathlib import Path

# Locate the package from this file, not from the working directory — running
# `python3 dev/devserver.py` puts dev/ on sys.path, not the package root.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

sys.path.insert(0, str(HERE / "stubs"))   # stub folder_paths
sys.path.insert(0, str(ROOT))             # so `import nova_player` resolves

try:
    from nova_player.config_manager import NovaConfigManager
    from nova_player.sequences import SequenceStore
except ModuleNotFoundError as e:
    sys.exit(
        f"Could not import nova_player from {ROOT}\n"
        f"  ({e})\n"
        "Run this script from inside the extracted package, e.g.\n"
        "  python3 dev/devserver.py\n"
    )

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=8731)
parser.add_argument("--host", default="127.0.0.1")
args = parser.parse_args()

manager = NovaConfigManager(ROOT)
manager.ensure_files_exist()

# Recorded sequences go to a throwaway folder by default, so a dev session
# never writes into a real ComfyUI user folder. NOVA_SEQUENCES_DIR overrides.
import tempfile
from urllib.parse import unquote
SEQ_ROOT = os.environ.get("NOVA_SEQUENCES_DIR") or os.path.join(
    tempfile.gettempdir(), "nova_dev_sequences")
sequences = SequenceStore(SEQ_ROOT)


def _seq_parts(path):
    """/nova_player/sequences/<renderer>[/<name>] -> (renderer, name or None)."""
    rest = path.split("?", 1)[0][len("/nova_player/sequences/"):]
    parts = [unquote(p) for p in rest.split("/") if p]
    return (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else None)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/nova_player/sequences/"):
            rid, name = _seq_parts(self.path)
            if name is None:
                ok, res = sequences.list(rid)
                return self._json({"status": "success", **res} if ok
                                  else {"status": "error", "message": res}, 200 if ok else 400)
            ok, res = sequences.read(rid, name)
            return self._json({"status": "success", "sequence": res} if ok
                              else {"status": "error", "message": res},
                              200 if ok else (404 if res == "Not found" else 400))
        if self.path.startswith("/nova_player/config/version"):
            return self._json({"version": manager.version})
        if self.path.startswith("/nova_player/config"):
            return self._json(manager.snapshot())
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            return self._json({"status": "error", "message": "Invalid JSON body"}, 400)

        if self.path.startswith("/nova_player/sequences/"):
            rid, _ = _seq_parts(self.path)
            ok, res = sequences.save(rid, payload.get("name"), payload.get("sequence"))
            return self._json({"status": "success", **res} if ok
                              else {"status": "error", "message": res}, 200 if ok else 400)

        if self.path.startswith("/nova_player/config/reload"):
            manager.reload_all()
            return self._json({"status": "success", "version": manager.version})

        if self.path.startswith("/nova_player/config/theme"):
            ok, msg = manager.save_theme(payload.get("name"), payload.get("theme", {}),
                                         bool(payload.get("makeActive")))
            return self._json({"status": "success" if ok else "error", "message": msg,
                               "version": manager.version}, 200 if ok else 400)

        if self.path.startswith("/nova_player/config/active-theme"):
            ok, msg = manager.set_active_theme(payload.get("name"))
            return self._json({"status": "success" if ok else "error", "message": msg,
                               "version": manager.version}, 200 if ok else 400)

        if self.path.startswith("/nova_player/config/appearance"):
            ok, msg = manager.save_appearance(payload or {})
            return self._json({"status": "success" if ok else "error",
                               "message": msg, "version": manager.version},
                              200 if ok else 400)

        if self.path.startswith("/nova_player/config/renderer/"):
            rid = self.path.rsplit("/", 1)[-1]
            ok, msg = manager.save_renderer_params(rid, payload)
            return self._json({"status": "success" if ok else "error", "message": msg,
                               "version": manager.version}, 200 if ok else 400)

        self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/nova_player/sequences/"):
            rid, name = _seq_parts(self.path)
            ok, res = sequences.delete(rid, name or "")
            return self._json({"status": "success" if ok else "error", "message": res},
                              200 if ok else (404 if res == "Not found" else 400))
        if self.path.startswith("/nova_player/config/theme/"):
            name = self.path.rsplit("/", 1)[-1]
            ok, msg = manager.delete_theme(name)
            return self._json({"status": "success" if ok else "error", "message": msg,
                               "version": manager.version}, 200 if ok else 400)
        self.send_error(404)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
    print(f"Nova Player dev server — serving {ROOT}")
    print(f"  http://{args.host}:{args.port}/dev/harness.html")
    print("  Ctrl-C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
