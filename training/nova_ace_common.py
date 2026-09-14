"""
nova_ace_common.py — shared pieces for the ACE-Step LoRA dataset nodes.

WHAT THESE NODES DO, AND DELIBERATELY DO NOT DO
-----------------------------------------------
They prepare a dataset. They do not train.

The tensor format ACE-Step's trainer consumes is not documented anywhere
stable — it is whatever `acestep/training_v2/preprocess.py` writes today. So
the preprocess node CALLS THAT FUNCTION rather than reimplementing it. A
reimplementation would drift from upstream the first time they touch the
schema, and the failure mode is silent: training runs, loss falls, the LoRA is
subtly wrong. Owning the dataset JSON (where Nova has metadata nobody else
has) and borrowing the tensor writer is the split that stays correct.

THE DATASET JSON, as read by acestep.training_v2.preprocess_discovery
.load_sample_metadata: either a bare list or {"samples": [...]}, each entry
keyed by `filename` (basename) or `audio_path`:

    filename, audio_path, caption, lyrics, genre, bpm, keyscale,
    timesignature, duration, is_instrumental, custom_tag, prompt_override

`custom_tag` is the LoRA trigger word. `prompt_override` ("caption" | "genre" |
null) picks which text the prompt builder uses per sample.
"""

import ast
import importlib.util
import os
import sys
from typing import Any, Dict, List

try:
    from ..nova_categories import TRAINING
except ImportError:  # direct execution / test harness
    from nova_categories import TRAINING

TRAINING_CATEGORY = TRAINING
ACE_VERSION = "1.0.0"

DATASET_TYPE = "NOVA_ACE_DATASET"

# variant -> checkpoint subdirectory, mirroring _VARIANT_DIR in
# acestep/training_v2/model_loader.py. Duplicated rather than imported so the
# dataset nodes stay usable with no acestep install present.
VARIANT_DIRS = {
    "xl_sft": "acestep-v15-xl-sft",
    "xl_turbo": "acestep-v15-xl-turbo",
    "xl_base": "acestep-v15-xl-base",
    "sft": "acestep-v15-sft",
    "turbo": "acestep-v15-turbo",
    "base": "acestep-v15-base",
}

# Everything load_sample_metadata fills in when a field is absent.
SAMPLE_DEFAULTS = {
    "caption": "",
    "lyrics": "[Instrumental]",
    "genre": "",
    "bpm": None,
    "keyscale": "",
    "timesignature": "",
    "duration": 0,
    "is_instrumental": True,
    "custom_tag": "",
    "prompt_override": None,
}

INSTRUMENTAL = "[Instrumental]"


def check_checkpoint_tree(checkpoint_dir: str, variant: str) -> List[str]:
    """Return a list of what is missing from an ACE-Step checkpoint directory.

    The trainer loads these with `from_pretrained`, so it needs HuggingFace
    *directories* — a ComfyUI single-file .safetensors will not do, which is
    the most common surprise when you already 'have the models'.
    """
    root = (checkpoint_dir or "").strip()
    if not root:
        return ["checkpoint_dir is empty"]
    if not os.path.isdir(root):
        return [f"{root} is not a directory"]

    missing: List[str] = []
    variant_dir = VARIANT_DIRS.get(variant, variant)
    for name in (variant_dir, "vae", "Qwen3-Embedding-0.6B"):
        if not os.path.isdir(os.path.join(root, name)):
            missing.append(f"{name}/")

    # A directory full of configs is not a checkpoint. from_pretrained needs
    # actual weights, and an earlier version of this check passed a folder that
    # had every .py and .json but no tensors at all — which fails much later,
    # after the loader has already started.
    for name in (variant_dir, "vae", "Qwen3-Embedding-0.6B"):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder):
            continue
        try:
            entries = os.listdir(folder)
        except OSError:
            entries = []
        has_weights = any(
            e.endswith((".safetensors", ".bin", ".pth"))
            and not e.endswith(".index.json")
            for e in entries
        )
        if not has_weights:
            missing.append(f"{name}/ has no weights (.safetensors or .bin)")

    # silence_latent.pt is NOT required at the root. Mirror the search order in
    # acestep.training_v2.model_loader.load_silence_latent exactly: root first,
    # then the variant subdirectory, then any known variant subdirectory. An
    # earlier version of this check only looked at the root and reported a
    # complete upstream checkout as broken, which would have sent you off to
    # re-download a file you already had.
    candidates = [os.path.join(root, "silence_latent.pt"),
                  os.path.join(root, variant_dir, "silence_latent.pt")]
    candidates += [os.path.join(root, d, "silence_latent.pt") for d in VARIANT_DIRS.values()]
    if not any(os.path.isfile(c) for c in candidates):
        missing.append("silence_latent.pt")
    return missing


def describe_checkpoint_requirement(checkpoint_dir: str, variant: str) -> str:
    variant_dir = VARIANT_DIRS.get(variant, variant)
    return (
        f"ACE-Step's preprocessor loads its models with from_pretrained, so "
        f"checkpoint_dir must be the HuggingFace checkpoint tree, not ComfyUI's "
        f"single-file .safetensors. Expected under {checkpoint_dir or '<unset>'}:\n"
        f"    {variant_dir}/\n"
        f"    vae/\n"
        f"    Qwen3-Embedding-0.6B/\n"
        f"    silence_latent.pt\n"
        "Download it from the ACE-Step HuggingFace repo for this variant."
    )


# Packages the remote-code modeling files need that nothing else in a ComfyUI
# install pulls in. Listed for the error message only — nothing here is
# installed or downloaded by this node.
REMOTE_CODE_HINTS = {
    "vector_quantize_pytorch": "vector_quantize_pytorch",
    "einx": "einx",
    "einops": "einops",
    "torch_einops_utils": "torch-einops-utils",
    "frozendict": "frozendict",
}

# Because the suggested command uses --no-deps (to keep the resolver away from
# a ROCm/Intel torch build), the pure-Python dependencies have to be named
# explicitly or the next run just fails one import further along.
REMOTE_CODE_EXTRAS = {
    "vector_quantize_pytorch": ["einx", "frozendict", "torch-einops-utils"],
    "einx": ["frozendict"],
}


def check_remote_code_imports(checkpoint_dir: str, variant: str) -> List[str]:
    """Return the third-party modules the variant's remote code imports but
    that are not installed here.

    ACE-Step's XL checkpoints load through ``trust_remote_code``: transformers
    executes ``modeling_*.py`` straight out of the checkpoint folder, and
    refuses with an ImportError if any of that file's imports are missing. That
    check happens inside Pass 2 — i.e. only after Pass 1 has spent real GPU
    time on every file in the dataset. Doing the same check here costs a few
    milliseconds and fails before a single model loads.

    Deliberately NOT using ``transformers.dynamic_module_utils.check_imports``:
    it is an internal, undocumented API. This reads the same information from
    the same files with the stdlib ``ast`` module.

    Only module-level imports are inspected, and imports guarded by ``try`` or
    ``if`` are skipped — those are optional by construction, so flagging them
    would refuse to run a graph that works.
    """
    root = (checkpoint_dir or "").strip()
    if not root:
        return []
    folder = os.path.join(root, VARIANT_DIRS.get(variant, variant))
    if not os.path.isdir(folder):
        return []

    try:
        names = sorted(f for f in os.listdir(folder) if f.endswith(".py"))
    except OSError:
        return []

    wanted: List[str] = []
    for name in names:
        try:
            with open(os.path.join(folder, name), "r", encoding="utf-8") as handle:
                tree = ast.parse(handle.read())
        except (OSError, SyntaxError):
            continue
        for node in tree.body:                     # module level only
            if isinstance(node, ast.Import):
                wanted += [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if not node.level and node.module:  # skip relative imports
                    wanted.append(node.module.split(".")[0])

    missing: List[str] = []
    for module in dict.fromkeys(wanted):
        if module in sys.stdlib_module_names or module in missing:
            continue
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(module)
    return missing


def describe_remote_code_requirement(missing: List[str]) -> str:
    """Say exactly what to install, without installing it."""
    packages: List[str] = []
    for module in missing:
        for package in [REMOTE_CODE_HINTS.get(module, module)] + REMOTE_CODE_EXTRAS.get(module, []):
            if package not in packages:
                packages.append(package)
    exe = sys.executable
    if importlib.util.find_spec("pip") is not None:
        command = f"    {exe} -m pip install --no-deps " + " ".join(packages)
    else:
        uv = os.path.join(os.path.dirname(exe), "uv")
        uv = uv if os.path.exists(uv) else "uv"
        command = f"    {uv} pip install --python {exe} --no-deps " + " ".join(packages)
    return (
        "This checkpoint loads through trust_remote_code — transformers runs "
        "the modeling_*.py shipped inside the checkpoint folder, and that file "
        "imports packages ComfyUI does not install.\n"
        "Install them yourself, then restart ComfyUI (this node installs "
        "nothing — Comfy Registry standards prohibit runtime installation):\n"
        + command + "\n"
        "  --no-deps is deliberate: it keeps the resolver from deciding your "
        "torch build is wrong and replacing it. Re-run the node afterwards — "
        "it names whatever is still missing."
    )


def normalise_sample(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Fill defaults so every emitted sample has the full field set."""
    out = dict(SAMPLE_DEFAULTS)
    out.update({k: v for k, v in entry.items() if v is not None or k == "prompt_override"})
    return out
