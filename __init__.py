"""
ComfyUI-NovaAudioPlayer — a Nova Audio node pack.

Nova Player: an audio player node with twelve live visualisers.
Madow Inputs: every ACE-Step generation parameter in one node.
Madow Unpack: fans a Madow bundle out into typed outputs.

WEB_DIRECTORY is declared here and nowhere else.  The previous layout had a
second, unreachable copy of the front end under nova_player/npjs/ plus a no-op
`WEB_DIRECTORY = "./web"` on the node class (ComfyUI reads the module-level
constant, not a class attribute), which made it easy to edit the copy nobody
loads.  One source directory now: ./web.
"""

from .nova_player.node import (
    NODE_CLASS_MAPPINGS as NOVA_PLAYER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_PLAYER_NAMES,
)
from .madow.node import (
    NODE_CLASS_MAPPINGS as MADOW_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as MADOW_NAMES,
)
from .madow.unpack import (
    NODE_CLASS_MAPPINGS as MADOW_UNPACK_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as MADOW_UNPACK_NAMES,
)
from .madow.routes import register_routes as register_madow_routes
from .nova_player.config_manager import manager
from .nova_player.routes import register_routes
from .nova_player.web_cache import install as install_web_cache

# Give the user real files to edit by hand on first run.
manager.ensure_files_exist()
register_routes()
register_madow_routes()
# Make the browser revalidate this pack's JS instead of guessing at its
# freshness; see nova_player/web_cache.py for why that guess bites.
install_web_cache()

NODE_CLASS_MAPPINGS = {**NOVA_PLAYER_MAPPINGS, **MADOW_MAPPINGS,
                       **MADOW_UNPACK_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**NOVA_PLAYER_NAMES, **MADOW_NAMES,
                              **MADOW_UNPACK_NAMES}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
