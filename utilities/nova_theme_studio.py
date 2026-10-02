"""Nova Theme Studio — the node DEFINITION only. All behaviour is in the .js.

WHY A PYTHON FILE FOR A NODE THAT NEVER RUNS.

ComfyUI builds its node index — the search dialog, the titles, the categories,
the descriptions — from the backend's `/object_info`. A node registered purely
in the frontend is not in there, so the frontend SYNTHESISES a definition for
it, and that synthetic one hardcodes the raw type name as the display name and
`__frontend_only__` as the category. Nothing set on the JavaScript class
reaches it: that is why the studio turned up in search as "NovaThemeStudio"
under `__frontend_only__` rather than by its real name in this pack's own menu.

Six lines of Python fix it properly. This class exists to be read, not to run:
the frontend node carries `isVirtualNode = true`, so `graphToPrompt` skips it
and it is never sent to the backend. `run()` is here because a node definition
needs one, and it returns nothing.
"""

import logging

logger = logging.getLogger("NovaThemeStudio")

# The pack's own category constant, found by VALUE rather than by name.
#
# Hardcoding "Nova Audio/Utility & IO" would silently drift the day that menu
# is reorganised, and importing a constant by name means guessing which name it
# has. Matching on the value finds it whatever it is called, and the literal is
# only the fallback for a pack laid out differently.
import sys
from pathlib import Path

# insert node to root folder into syspath
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Clean absolute imports
from nova_categories import UTILITY_IO


class NovaThemeStudio:
    CATEGORY = UTILITY_IO
    FUNCTION = "run"
    # No outputs and no inputs. The node is a control panel, not a step in the
    # graph — every widget it has is built in the browser, and an empty
    # `required` is what keeps ComfyUI from generating any of its own above it.
    RETURN_TYPES = ()
    OUTPUT_NODE = False
    DESCRIPTION = (
        "Edit the ComfyUI colour palette live on the canvas — node slot, "
        "litegraph and comfy colours, each with an alpha slider — then copy, "
        "download, or save it straight into ComfyUI's custom themes. Also "
        "sets a wallpaper behind the canvas, which a theme file cannot do. "
        "Frontend only: never executed, never sent to the backend."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Never re-runs anything downstream: there is no downstream, and the
        # node is skipped before the prompt is built in any case.
        return False

    def run(self):
        return ()


NODE_CLASS_MAPPINGS = {"NovaThemeStudio": NovaThemeStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaThemeStudio": "Nova Theme Studio 🎨"}

logger.debug("[NovaThemeStudio] definition registered under %s",
             NovaThemeStudio.CATEGORY)
