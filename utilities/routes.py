"""
routes.py — read-only HTTP endpoints for Nova NamePath Manager's profile picker.

WHY THESE EXIST AT ALL (ComfyUI standards, client/server architecture)
----------------------------------------------------------------------
ComfyUI's guidance is to prefer normal node inputs and outputs and to add direct
client/server communication only where genuinely required, because such nodes
may not work in API mode.

The node does not require these routes. Every profile operation — apply, save,
save as — happens inside the execute function through ordinary ComfyUI data
flow, so the node behaves identically headless, in API mode, and with the
frontend extension absent or failing to load.

These endpoints exist only so the Load button can show a saved profile's values
in the widgets before a run. That is a convenience, and it is why both routes
are GET and neither writes anything: nothing that changes state travels over
HTTP here.

    GET /nova_namepath/profiles          -> {"profiles": ["Tag Audio Files", …]}
    GET /nova_namepath/profile/{name}    -> {"name": …, "values": {…}}

Names are validated against the same pattern the store uses, so a crafted
request cannot read outside profiles/namepath/.
"""

import logging

from . import nova_profile_store as profiles

logger = logging.getLogger("NovaAudioPlayer")


def register_routes() -> bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError as exc:
        logger.info(
            "[NovaNamePathManager] Not running inside ComfyUI, routes skipped (%s)", exc
        )
        return False

    routes = PromptServer.instance.routes

    @routes.get("/nova_namepath/profiles")
    async def list_profiles(request):
        return web.json_response({"profiles": profiles.list_profiles()})

    @routes.get("/nova_namepath/profile/{name}")
    async def read_profile(request):
        name = request.match_info.get("name", "")
        if not profiles.valid_name(name):
            return web.json_response({"error": "invalid profile name"}, status=400)
        values = profiles.load(name)
        if values is None:
            return web.json_response({"error": "profile not found"}, status=404)
        return web.json_response({"name": name, "values": values})

    return True
