"""
authoring — the ▶️ Nova Audio/Authoring node group.

A metadata-authoring chain that sits beside the mastering and player nodes and
does not touch them:

    Nova SQLite Reader ──NOVA_TABLE──┐
                                     ├──> Nova Tag Writer ──console──> Nova Console
    Nova Batch Load Audio ─NOVA_FILES┘            │
                                                  └─files─> Nova Tag Reader ──console──> Nova Console

Nova Load Audio lives here too (it moved from ../mastering/) but deliberately
keeps its original top-level "▶️ Nova Audio" category, so existing workflows and
menus are unchanged.

This module aggregates the per-node mappings so the pack's root __init__.py
needs a single import.
"""

from .nova_load_audio import (
    NODE_CLASS_MAPPINGS as _LOAD_AUDIO_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _LOAD_AUDIO_NAMES,
)
from .nova_sqlite_reader import (
    NODE_CLASS_MAPPINGS as _SQLITE_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _SQLITE_NAMES,
)
from .nova_batch_audio_load import (
    NODE_CLASS_MAPPINGS as _BATCH_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _BATCH_NAMES,
)
from .nova_tag_writer import (
    NODE_CLASS_MAPPINGS as _TAG_WRITER_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _TAG_WRITER_NAMES,
)
from .nova_tag_reader import (
    NODE_CLASS_MAPPINGS as _TAG_READER_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _TAG_READER_NAMES,
)
from .nova_console import (
    NODE_CLASS_MAPPINGS as _CONSOLE_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _CONSOLE_NAMES,
)

NODE_CLASS_MAPPINGS = {
    **_LOAD_AUDIO_CLASSES,
    **_SQLITE_CLASSES,
    **_BATCH_CLASSES,
    **_TAG_WRITER_CLASSES,
    **_TAG_READER_CLASSES,
    **_CONSOLE_CLASSES,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **_LOAD_AUDIO_NAMES,
    **_SQLITE_NAMES,
    **_BATCH_NAMES,
    **_TAG_WRITER_NAMES,
    **_TAG_READER_NAMES,
    **_CONSOLE_NAMES,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
