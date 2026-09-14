"""
utilities — the ▶️ Nova Audio/🛠️ Utility & I/O group.

Nova NamePath Manager holds the database, batch and output paths a delivery
workflow needs, and stores the whole set as a named profile.

Nova Load Audio, Nova Batch Load Audio and Nova Console live in ../authoring/
for historical reasons but are categorised into this same group; see
nova_categories.py.
"""

from .nova_namepath_manager import (
    NODE_CLASS_MAPPINGS as _NAMEPATH_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _NAMEPATH_NAMES,
)
from .routes import register_routes

NODE_CLASS_MAPPINGS = {**_NAMEPATH_CLASSES}
NODE_DISPLAY_NAME_MAPPINGS = {**_NAMEPATH_NAMES}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "register_routes"]
