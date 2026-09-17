"""
training — the ▶️ Nova Audio/🎓 LoRA Training group.

The whole path from a folder of mastered audio to a trained LoRA:

    Nova Batch Load Audio ──> Nova ACE Dataset Builder ──> Nova ACE Dataset Review
                                        │
                                        └──> Nova ACE Preprocess ──> .pt tensors
                                                     │
                                                     └──> Nova ACE LoRA Trainer

Nova owns the dataset JSON, where it has metadata nothing else does. The
tensor writer and the training loop are ACE-Step's own, called rather than
reimplemented — see nova_ace_common.py for why that split is the one that
stays correct.
"""

from .nova_ace_dataset import (
    NODE_CLASS_MAPPINGS as _DATASET_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _DATASET_NAMES,
)
from .nova_ace_preprocess import (
    NODE_CLASS_MAPPINGS as _PRE_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _PRE_NAMES,
)
from .nova_ace_train import (
    NODE_CLASS_MAPPINGS as _TRAIN_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _TRAIN_NAMES,
)
from .nova_ace_check import (
    NODE_CLASS_MAPPINGS as _CHECK_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _CHECK_NAMES,
)

NODE_CLASS_MAPPINGS = {**_CHECK_CLASSES, **_DATASET_CLASSES, **_PRE_CLASSES, **_TRAIN_CLASSES}
NODE_DISPLAY_NAME_MAPPINGS = {**_CHECK_NAMES, **_DATASET_NAMES, **_PRE_NAMES, **_TRAIN_NAMES}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
