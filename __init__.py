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
from .mastering.nova_track_inspector import (
    NODE_CLASS_MAPPINGS as NOVA_TRACK_INSPECTOR_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_TRACK_INSPECTOR_NAMES,
)
from .viewers.nova_track_inspector_report_viewer import (
    NODE_CLASS_MAPPINGS as NOVA_TRACK_INSPECTOR_REPORT_VIEWER_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_TRACK_INSPECTOR_REPORT_VIEWER_NAMES,
)
from .utilities.nova_memory_probe import (
    NODE_CLASS_MAPPINGS as NOVA_MEMORY_PROBE_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as NOVA_MEMORY_PROBE_NAMES,
)
# Node classes, imported directly so the tables below can be literals.
from .nova_player.node import NovaPlayerNode
from .madow.node import MadowInputs
from .madow.unpack import MadowUnpack
from .authoring.nova_batch_audio_load import NovaBatchLoadAudio
from .authoring.nova_console import NovaConsole
from .authoring.nova_load_audio import NovaLoadAudio
from .authoring.nova_sqlite_reader import NovaSQLiteReader
from .authoring.nova_tag_reader import NovaTagReader
from .authoring.nova_tag_writer import NovaTagWriter
from .mastering.nova_audio_master import NovaAudioMaster
from .mastering.nova_final_master_validator import NovaFinalMasterValidator
from .mastering.nova_master_identity import NovaMasterIdentity
from .mastering.nova_save_audio_flac24 import NovaAudioSaveFLAC24
from .mastering.nova_save_audio_wav import NovaAudioSaveWAV
from .mastering.nova_track_inspector import NovaTrackInspector
from .training.nova_ace_dataset import NovaACEDatasetBuilder, NovaACEDatasetReview
from .training.nova_ace_preprocess import NovaACEPreprocess
from .training.nova_ace_train import NovaACELoRATrainer
from .training.nova_ace_check import NovaACESetupCheck
from .utilities.nova_memory_probe import NovaMemoryProbe
from .utilities.nova_namepath_manager import NovaNamePathManager
from .utilities.nova_sql_dump import NovaSQLDump
from .viewers.nova_master_report_viewer import NovaMasterReportViewer
from .viewers.nova_track_inspector_report_viewer import NovaTrackInspectorReportViewer

from .madow.routes import register_routes as register_madow_routes
from .mastering.routes import register_routes as register_master_routes
from .mastering.routes_final_master_validator import register_routes as register_master_validator_routes
from .nova_player.config_manager import manager
from .nova_player.routes import register_routes
from .viewers.nova_report_capture import register_routes as register_report_capture_routes
from .nova_player.web_cache import install as install_web_cache

# Give the user real files to edit by hand on first run.
manager.ensure_files_exist()
register_routes()
register_madow_routes()
register_master_routes()
register_master_validator_routes()
register_namepath_routes()
register_report_capture_routes()
# Make the browser revalidate this pack's JS instead of guessing at its
# freshness; see nova_player/web_cache.py for why that guess bites.
install_web_cache()

# ---------------------------------------------------------------------------
# The node tables, written as literals ON PURPOSE
# ---------------------------------------------------------------------------
#
# These used to be built by merging each module's own dict with ** spreads,
# which is correct Python and unreadable to a static analyser: the keys only
# exist once the code has run. The Comfy Registry reads a published pack's node
# list WITHOUT executing it, found nothing, and ComfyUI-Manager's "Node Pack
# Info" panel showed "No nodes found - the pack's nodes either could not be
# parsed, or the pack is a frontend extension only". Twenty-eight nodes,
# invisible to anyone browsing the registry.
#
# Evidence, from four packs' /comfy-nodes endpoints:
#
#     comfyui-kjnodes           literal dict, string keys          populated
#     comfyui-videohelpersuite  re-exported from one module        populated
#     rgthree-comfy             literal dict, keys are X.NAME      null
#     comfyui-novaaudioplayer   merged with ** from many modules   null
#
# The split falls exactly where a static parser would break: it resolves literal
# string keys and a plain re-export, and gives up on anything computed. rgthree
# is the useful one - a very widely used pack with the same symptom, so an empty
# node list is not evidence of a broken package.
#
# The keys are therefore spelled out and the classes imported directly. Each
# module still owns its own NODE_CLASS_MAPPINGS as the source of truth, and
# dev/tests/test_registry_nodes.py parses both the way the registry does and
# fails if they disagree. Adding a node means adding it there and here; the test
# says so if you forget.

NODE_CLASS_MAPPINGS = {
    "NovaPlayerNode": NovaPlayerNode,
    "MadowInputs": MadowInputs,
    "MadowUnpack": MadowUnpack,
    "NovaBatchLoadAudio": NovaBatchLoadAudio,
    "NovaConsole": NovaConsole,
    "NovaLoadAudio": NovaLoadAudio,
    "NovaSQLiteReader": NovaSQLiteReader,
    "NovaTagReader": NovaTagReader,
    "NovaTagWriter": NovaTagWriter,
    "NovaAudioMaster": NovaAudioMaster,
    "NovaFinalMasterValidator": NovaFinalMasterValidator,
    "NovaMasterIdentity": NovaMasterIdentity,
    "NovaAudioSaveFLAC24": NovaAudioSaveFLAC24,
    "NovaAudioSaveWAV": NovaAudioSaveWAV,
    "NovaTrackInspector": NovaTrackInspector,
    "NovaACEDatasetBuilder": NovaACEDatasetBuilder,
    "NovaACEDatasetReview": NovaACEDatasetReview,
    "NovaACEPreprocess": NovaACEPreprocess,
    "NovaACELoRATrainer": NovaACELoRATrainer,
    "NovaACESetupCheck": NovaACESetupCheck,
    "NovaMemoryProbe": NovaMemoryProbe,
    "NovaNamePathManager": NovaNamePathManager,
    "NovaSQLDump": NovaSQLDump,
    "NovaMasterReportViewer": NovaMasterReportViewer,
    "NovaTrackInspectorReportViewer": NovaTrackInspectorReportViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaPlayerNode": 'Nova Player 🔊',
    "MadowInputs": 'Madow Inputs 🎚️',
    "MadowUnpack": 'Madow Unpack ⚪',
    "NovaBatchLoadAudio": 'Nova Batch Load Audio 🎼',
    "NovaConsole": 'Nova Console 🖥️',
    "NovaLoadAudio": 'Nova Load Audio 🔄',
    "NovaSQLiteReader": 'Nova SQLite Reader 🗃️',
    "NovaTagReader": 'Nova Tag Reader 🔖',
    "NovaTagWriter": 'Nova Tag Writer 🏷️',
    "NovaAudioMaster": 'Nova Audio Master 🧾',
    "NovaFinalMasterValidator": 'Nova Final Master Validator',
    "NovaMasterIdentity": 'Nova Master Identity \U0001faaa',
    "NovaAudioSaveFLAC24": 'Save Audio FLAC 24-bit ⬇️',
    "NovaAudioSaveWAV": 'Save Audio WAV PCM16|PCM24|FLOAT32 ⬇️',
    "NovaTrackInspector": 'Nova Track Inspector 🔬',
    "NovaACEDatasetBuilder": 'Nova ACE Dataset Builder 🧱',
    "NovaACEDatasetReview": 'Nova ACE Dataset Review 🔍',
    "NovaACEPreprocess": 'Nova ACE Preprocess 🧮',
    "NovaACELoRATrainer": 'Nova ACE LoRA Trainer 🎓',
    "NovaACESetupCheck": 'Nova ACE Setup Check 🩺',
    "NovaMemoryProbe": 'Nova Memory Probe (RAM/VRAM) 🧠',
    "NovaNamePathManager": 'Nova NamePath Manager 🧭',
    "NovaSQLDump": 'Nova SQL Dump 🛢️',
    "NovaMasterReportViewer": 'Nova Master Report Viewer 📊',
    "NovaTrackInspectorReportViewer": 'Nova Track Inspector Report 📈',
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
