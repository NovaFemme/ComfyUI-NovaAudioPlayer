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
from .mastering.nova_audio_master import (
    NODE_CLASS_MAPPINGS as NOVA_AUDIO_MASTER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_AUDIO_MASTER_NAMES,
)
from .mastering.nova_master_identity import (
    NODE_CLASS_MAPPINGS as NOVA_MASTER_IDENTITY_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_MASTER_IDENTITY_NAMES,
)
from .mastering.nova_final_master_validator import (
    NODE_CLASS_MAPPINGS as NOVA_MASTER_VALIDATOR_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_MASTER_VALIDATOR_NAMES,
)
from .viewers.nova_master_report_viewer import (
    NODE_CLASS_MAPPINGS as NOVA_MASTER_REPORT_VIEWER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_MASTER_REPORT_VIEWER_NAMES,
)
from .mastering.nova_save_audio_flac24 import (
    NODE_CLASS_MAPPINGS as NOVA_SAVE_AUDIO_FLAC24_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_SAVE_AUDIO_FLAC24_NAMES,
)
from .mastering.nova_save_audio_wav import (
    NODE_CLASS_MAPPINGS as NOVA_SAVE_AUDIO_WAV_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_SAVE_AUDIO_WAV_NAMES,
)
from .authoring import (
    NODE_CLASS_MAPPINGS as NOVA_AUTHORING_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_AUTHORING_NAMES,
)
from .training import (
    NODE_CLASS_MAPPINGS as NOVA_TRAINING_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_TRAINING_NAMES,
)
from .utilities.nova_sql_dump import (
    NODE_CLASS_MAPPINGS as NOVA_SQL_DUMP_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_SQL_DUMP_NAMES,
)
from .utilities import (
    NODE_CLASS_MAPPINGS as NOVA_UTILITIES_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_UTILITIES_NAMES,
    register_routes as register_namepath_routes,
)
from .transcribe.nova_audio_transcribe import (
    NODE_CLASS_MAPPINGS as NOVA_AUDIO_TRANSCRIBE_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_AUDIO_TRANSCRIBE_NAMES,
)
from .transcribe.nova_lyric_score import (
    NODE_CLASS_MAPPINGS as NOVA_LYRIC_SCORE_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_LYRIC_SCORE_NAMES,
)
from .mastering.nova_track_inspector import (
    NODE_CLASS_MAPPINGS as NOVA_TRACK_INSPECTOR_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_TRACK_INSPECTOR_NAMES,
)
from .viewers.nova_track_inspector_report_viewer import (
    NODE_CLASS_MAPPINGS as NOVA_TRACK_INSPECTOR_REPORT_VIEWER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_TRACK_INSPECTOR_REPORT_VIEWER_NAMES,
)
from .viewers.nova_lyric_report_viewer import (
    NODE_CLASS_MAPPINGS as NOVA_LYRIC_REPORT_VIEWER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_LYRIC_INSPECTOR_REPORT_VIEWER_NAMES,
)
from .utilities.nova_memory_probe import (
    NODE_CLASS_MAPPINGS as NOVA_MEMORY_PROBE_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_MEMORY_PROBE_NAMES,
)
from .viewers.nova_reports_to_images import (
    NODE_CLASS_MAPPINGS as NOVA_REPORT_TO_IMAGE_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_REPORT_TO_IMAGE_NAMES,
)
from .madow.routes import register_routes as register_madow_routes
from .mastering.routes import register_routes as register_master_routes
from .mastering.routes_final_master_validator import register_routes as register_master_validator_routes
from .nova_player.config_manager import manager
from .nova_player.routes import register_routes
from .nova_player.web_cache import install as install_web_cache

# Give the user real files to edit by hand on first run.
manager.ensure_files_exist()
register_routes()
register_madow_routes()
register_master_routes()
register_master_validator_routes()
register_namepath_routes()
# Make the browser revalidate this pack's JS instead of guessing at its
# freshness; see nova_player/web_cache.py for why that guess bites.
install_web_cache()

NODE_CLASS_MAPPINGS = {**NOVA_PLAYER_MAPPINGS, **MADOW_MAPPINGS,
                       **MADOW_UNPACK_MAPPINGS, **NOVA_AUDIO_MASTER_MAPPINGS, **NOVA_MASTER_IDENTITY_MAPPINGS, **NOVA_MASTER_VALIDATOR_MAPPINGS, **NOVA_MASTER_REPORT_VIEWER_MAPPINGS, **NOVA_SAVE_AUDIO_FLAC24_MAPPINGS, **NOVA_SAVE_AUDIO_WAV_MAPPINGS,
                       **NOVA_AUTHORING_MAPPINGS, **NOVA_UTILITIES_MAPPINGS,
                       **NOVA_TRAINING_MAPPINGS, **NOVA_SQL_DUMP_MAPPINGS, **NOVA_AUDIO_TRANSCRIBE_MAPPINGS, **NOVA_LYRIC_SCORE_MAPPINGS, **NOVA_TRACK_INSPECTOR_MAPPINGS, **NOVA_TRACK_INSPECTOR_REPORT_VIEWER_MAPPINGS, **NOVA_LYRIC_REPORT_VIEWER_MAPPINGS,**NOVA_MEMORY_PROBE_MAPPINGS, **NOVA_REPORT_TO_IMAGE_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**NOVA_PLAYER_NAMES, **MADOW_NAMES,
                              **MADOW_UNPACK_NAMES, **NOVA_AUDIO_MASTER_NAMES, **NOVA_MASTER_IDENTITY_NAMES, **NOVA_MASTER_VALIDATOR_NAMES, **NOVA_MASTER_REPORT_VIEWER_NAMES, **NOVA_SAVE_AUDIO_FLAC24_NAMES, **NOVA_SAVE_AUDIO_WAV_NAMES,
                              **NOVA_AUTHORING_NAMES, **NOVA_UTILITIES_NAMES,
                              **NOVA_TRAINING_NAMES, **NOVA_SQL_DUMP_NAMES, **NOVA_AUDIO_TRANSCRIBE_NAMES, **NOVA_LYRIC_SCORE_NAMES, **NOVA_TRACK_INSPECTOR_NAMES, **NOVA_TRACK_INSPECTOR_REPORT_VIEWER_NAMES, **NOVA_LYRIC_INSPECTOR_REPORT_VIEWER_NAMES,**NOVA_MEMORY_PROBE_NAMES, **NOVA_REPORT_TO_IMAGE_NAMES}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
