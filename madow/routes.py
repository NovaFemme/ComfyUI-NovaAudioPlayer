"""HTTP routes for the preset bar.

    GET    /madow/presets          -> [{name, note, created}]
    GET    /madow/presets/{name}   -> full preset JSON
    POST   /madow/presets          -> {name, note, params, excludes}
    DELETE /madow/presets/{name}

Managed from the frontend rather than through a COMBO widget, deliberately.
COMBO options are evaluated inside INPUT_TYPES(), which the server runs when it
serves /object_info — so a newly saved preset would not appear in the dropdown
until the frontend re-fetched the whole node definition. Driving the list from
these routes means a save shows up immediately, with no restart and no
/object_info refresh.

Registration mirrors nova_player/routes.py: the import guard is narrow so that
running outside ComfyUI is a logged skip rather than a mystery, and the
handlers themselves are not wrapped in blanket try/except — a broken handler
should return a real status code.
"""

import json
import logging

from . import presets as store
from .params import ARG, DEFAULT_EXCLUDES, GROUPS, KEYS

logger = logging.getLogger("MadowInputs")


def register_routes() -> bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError as e:
        logger.info("[MadowInputs] Not running inside ComfyUI, routes skipped (%s)", e)
        return False

    routes = PromptServer.instance.routes

    @routes.get("/madow/params")
    async def param_table(request):
        """The parameter table, so the frontend never keeps a second copy.

        The widget name is the namespaced key with dots replaced by
        underscores, which is LOSSY in reverse: `apg_norm_threshold` could
        reverse to `apg.norm.threshold` or `apg.norm_threshold`, and guessing
        produces keys that silently do not match the ones in the hash. Serving
        the mapping keeps one definition.
        """
        return web.json_response([
            {"key": k, "arg": ARG[k], "group": GROUPS[k]} for k in KEYS
        ])

    @routes.get("/madow/presets")
    async def list_presets(request):
        return web.json_response(store.list_presets())

    @routes.get("/madow/presets/{name}")
    async def get_preset(request):
        data = store.load(request.match_info["name"])
        if data is None:
            return web.Response(status=404, text="No such preset")
        return web.json_response(data)

    @routes.post("/madow/presets")
    async def save_preset(request):
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            return web.Response(status=400, text="Body must be JSON")
        if not isinstance(body, dict):
            return web.Response(status=400, text="Body must be a JSON object")

        ok, message = store.save(
            body.get("name", ""),
            body.get("params") or {},
            note=body.get("note", ""),
            # A preset that does not say what it excludes excludes the seed,
            # so loading one never clobbers a seed being held deliberately.
            excludes=body.get("excludes", DEFAULT_EXCLUDES),
        )
        if not ok:
            return web.Response(status=400, text=message)
        return web.json_response({"ok": True, "message": message})

    @routes.delete("/madow/presets/{name}")
    async def delete_preset(request):
        ok, message = store.delete(request.match_info["name"])
        if not ok:
            return web.Response(status=404, text=message)
        return web.json_response({"ok": True, "message": message})

    logger.info("[MadowInputs] preset routes registered")
    return True
