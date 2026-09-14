"""
nova_categories.py — the single source of truth for this pack's node menu.

ComfyUI treats "/" inside CATEGORY as a menu separator, so every constant here
is exactly two levels: the pack's root menu, then one group. The group labels
deliberately drop a second "Nova" — the parent menu already says it, and a
label containing " / " would split into a third, redundant level.

Changing a CATEGORY does not break saved workflows: ComfyUI resolves nodes by
the key in NODE_CLASS_MAPPINGS, not by menu position.
"""

ROOT = "▶️ Nova Audio"

UTILITY_IO = f"{ROOT}/🛠️ Utility & IO"
GENERATION = f"{ROOT}/🤖 Generation & Synthesis"
MASTERING = f"{ROOT}/🎛️ Mastering Process"
ANALYSIS = f"{ROOT}/📊 Analysis & Validation"
DELIVERY = f"{ROOT}/📦 Delivery & Metadata"
TRAINING = f"{ROOT}/🎓 LoRA Training"
REPORT = f"{ROOT}/🗂️ Data Viewers"

ALL_CATEGORIES = (UTILITY_IO, GENERATION, MASTERING, ANALYSIS, DELIVERY, TRAINING)
