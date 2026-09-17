"""
nova_ace_check.py — Nova ACE Setup Check.

Answers one question, in the graph, before you queue anything expensive:
**is this machine ready to preprocess and train?**

It is the same set of checks ``nova_ace_setup.py --skip-packages --skip-clone
--skip-models`` performs, minus the terminal. Two of them are literally the
same functions the Preprocess and Trainer nodes call, so a green result here
means those nodes will not stop on the same grounds.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
It installs nothing, downloads nothing and spawns no process. Every check is
an ``importlib.util.find_spec`` or a stat of the filesystem, run in ComfyUI's
own interpreter, which is the only one whose answers matter. A node that
installed packages would be a Comfy Registry security violation; a node that
merely reports what is missing, and prints the command you would run yourself,
is what the standards ask for instead.

The cost of that honesty is that this node can only ever tell you. Fixing is
``install.py`` at the pack root (run for you when the pack is installed or
updated) or ``training/nova_ace_setup.py`` (run by you, once).
"""

import importlib.util
import os
import platform
import sys
from typing import Dict, List, Optional, Tuple

try:
    from .nova_ace_common import (
        ACE_VERSION, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, check_remote_code_imports,
        describe_checkpoint_requirement, install_command,
    )
    from ..authoring.nova_authoring_common import banner
except ImportError:  # direct execution / test harness
    from nova_ace_common import (
        ACE_VERSION, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, check_remote_code_imports,
        describe_checkpoint_requirement, install_command,
    )
    from nova_authoring_common import banner

#: Packages ComfyUI's own requirements.txt provides. If one of these is
#: missing, the ComfyUI install is broken — and "pip install --no-deps torch"
#: is actively harmful advice, because it would drop a generic CPU wheel on
#: top of a ROCm or CUDA build. Report, never suggest.
COMFYUI_PROVIDED = {
    "torch", "torchvision", "torchaudio", "numpy", "einops", "transformers",
    "tokenizers", "safetensors", "scipy", "av", "tqdm", "pyyaml", "pillow",
}

#: (import name, distribution name, what stops working without it)
TRAINING_REQUIREMENTS: List[Tuple[str, str, str]] = [
    ("diffusers",   "diffusers",   "ACE-Step cannot load its models"),
    ("lightning",   "lightning",   "the training loop cannot start"),
    ("loguru",      "loguru",      "ACE-Step logs through it everywhere"),
    ("peft",        "peft",        "no LoRA injection, no adapter to save"),
    ("rich",        "rich",        "the trainer's own CLI output layer"),
    ("soundfile",   "soundfile",   "preferred audio decoder (PyAV is the fallback)"),
]

#: (import name, distribution name, what you lose, what turns it on)
TRAINING_OPTIONAL: List[Tuple[str, str, str, str]] = [
    ("tensorboard", "tensorboard",  "no loss curves — training is unaffected", ""),
    ("bitsandbytes", "bitsandbytes", "cannot use the adamw8bit optimizer", "optimizer = adamw8bit"),
    ("prodigyopt",  "prodigyopt",   "cannot use the prodigy optimizer", "optimizer = prodigy"),
]


def _have(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _torch_report() -> Tuple[List[str], Optional[str]]:
    """Describe the compute stack. Returns (lines, backend); backend is None
    when torch itself will not import, which is fatal for everything here."""
    lines: List[str] = []
    try:
        import torch
    except Exception as exc:                       # pragma: no cover
        return ([f"  torch          NOT IMPORTABLE — {exc}",
                 "                 Nothing in this pack can run. That is a broken "
                 "ComfyUI install,",
                 "                 not something to fix by installing torch by hand."], None)

    version = getattr(torch, "version", None)
    hip = getattr(version, "hip", None)
    cuda = getattr(version, "cuda", None)
    backend = "rocm" if hip else ("cuda" if cuda else "cpu")
    lines.append(f"  torch          {torch.__version__}  [{backend}]")
    try:
        if torch.cuda.is_available():
            index = torch.cuda.current_device()
            name = torch.cuda.get_device_name(index)
            total = torch.cuda.get_device_properties(index).total_memory / (1024 ** 3)
            lines.append(f"  gpu            {name}  ({total:.1f} GiB)")
        else:
            lines.append("  gpu            none visible to torch — training will "
                         "fall back to CPU and take days")
    except Exception as exc:
        lines.append(f"  gpu            could not query ({exc})")
    return lines, backend


def _decoder_report(backend: Optional[str]) -> Tuple[List[str], bool]:
    """torchcodec is how torchaudio >= 2.9 decodes. Returns (lines, blocking)."""
    try:
        from torchcodec.decoders import AudioDecoder  # noqa: F401
        return ["  audio decode   torchcodec loads correctly"], False
    except ImportError:
        state = "not installed"
    except Exception as exc:
        first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
        state = f"will not load — {first[:70]}"

    lines = [f"  audio decode   torchcodec {state}"]
    if _have("soundfile") or _have("av"):
        lines.append("                 Nova's decode shim will cover it "
                     "(soundfile -> PyAV), so this is not blocking.")
    else:
        lines.append("                 and neither soundfile nor PyAV is present, "
                     "so NOTHING can decode audio.")
        return lines, True

    if backend and backend != "cuda":
        lines.append("                 Permanent fix — the PyPI wheel is a CUDA "
                     "build and cannot load against")
        lines.append(f"                 a {backend} PyTorch; the +cpu build links "
                     "only against libtorch:")
        lines.append(install_command(["torchcodec"], no_deps=True,
                                     index_url="https://download.pytorch.org/whl/cpu",
                                     force=True))
    return lines, False


class NovaACESetupCheck:
    CATEGORY = TRAINING_CATEGORY
    FUNCTION = "check"
    RETURN_TYPES = ("BOOLEAN", "STRING")
    RETURN_NAMES = ("ready", "console")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "True when nothing would stop a preprocess or training run.",
        "The full report — wire into Nova Console.",
    )
    DESCRIPTION = (
        f"Nova ACE Setup Check v{ACE_VERSION} — reports whether this machine can "
        "preprocess and train, before you spend GPU time finding out. Installs "
        "and downloads nothing."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "checkpoint_dir": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "Same checkpoint tree the other nodes use",
                    "tooltip": "The HuggingFace-layout checkpoint tree. Leave empty to check everything except the tree.",
                }),
                "variant": (list(VARIANT_DIRS), {
                    "default": "xl_sft",
                    "tooltip": "Which variant to check for. Match what you will train.",
                }),
            },
            "optional": {
                "acestep_repo_path": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "/path/to/ACE-Step-1.5 (only if not pip-installed)",
                    "tooltip": "Checked for importability. The trainer needs this set on its own node too — a subprocess does not inherit sys.path.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # the environment can change under a saved workflow

    def check(self, checkpoint_dir, variant, acestep_repo_path="", **kwargs):
        log: List[str] = [banner(f"NOVA ACE SETUP CHECK v{ACE_VERSION}")]
        blocking: List[str] = []
        advisory: List[str] = []
        fix_packages: List[str] = []

        ckpt = os.path.abspath(os.path.expanduser((checkpoint_dir or "").strip().strip('"'))) \
            if (checkpoint_dir or "").strip() else ""
        repo = os.path.abspath(os.path.expanduser((acestep_repo_path or "").strip().strip('"'))) \
            if (acestep_repo_path or "").strip() else ""

        # -- environment ----------------------------------------------------
        log.append("ENVIRONMENT")
        log.append(f"  python         {platform.python_version()}  ({sys.executable})")
        log.append(f"  platform       {platform.system()} {platform.machine()}")
        torch_lines, backend = _torch_report()
        log.extend(torch_lines)
        if backend is None:
            blocking.append("torch is not importable in ComfyUI's interpreter")
        log.append("")

        # -- ACE-Step -------------------------------------------------------
        log.append("ACE-STEP")
        if repo and not os.path.isdir(repo):
            log.append(f"  repo path      {repo}")
            log.append("                 NOT A DIRECTORY")
            blocking.append("acestep_repo_path is not a directory")
        elif repo and not os.path.isdir(os.path.join(repo, "acestep")):
            log.append(f"  repo path      {repo}")
            log.append("                 no acestep/ package inside — is this the "
                       "clone root?")
            blocking.append("acestep_repo_path has no acestep/ package in it")
        else:
            if repo and repo not in sys.path:
                sys.path.insert(0, repo)
            spec = None
            try:
                spec = importlib.util.find_spec("acestep")
            except (ImportError, ValueError):
                spec = None
            if spec and spec.submodule_search_locations:
                where = list(spec.submodule_search_locations)[0]
                log.append(f"  importable     yes  ({where})")
                if not repo:
                    log.append("                 but acestep_repo_path is empty. The "
                               "TRAINER runs as a separate")
                    log.append("                 process and will not inherit this "
                               "path — set it on that node.")
                    advisory.append("acestep_repo_path is empty on this node")
            else:
                log.append("  importable     NO")
                log.append("                 Clone https://github.com/ace-step/ACE-Step-1.5 "
                           "and set acestep_repo_path,")
                log.append("                 or run training/nova_ace_setup.py")
                blocking.append("ACE-Step is not importable")
        log.append("")

        # -- checkpoint tree ------------------------------------------------
        log.append("CHECKPOINT TREE")
        if not ckpt:
            log.append("  checkpoint_dir is empty — skipping the tree check")
            advisory.append("checkpoint_dir was not given, so the tree was not checked")
        elif not os.path.isdir(ckpt):
            log.append(f"  {ckpt}")
            log.append("  NOT A DIRECTORY")
            blocking.append("checkpoint_dir is not a directory")
        else:
            log.append(f"  {ckpt}  [{variant} -> {VARIANT_DIRS.get(variant, variant)}/]")
            missing = check_checkpoint_tree(ckpt, variant)
            if missing:
                log.append("  MISSING: " + ", ".join(missing))
                log.append("")
                log.extend("  " + line for line in
                           describe_checkpoint_requirement(ckpt, variant).splitlines())
                blocking.append("the checkpoint tree is incomplete")
            else:
                log.append("  complete — every folder and weight file the loaders need")

            absent = check_remote_code_imports(ckpt, variant) if not missing else []
            if absent:
                log.append("  remote code    needs " + ", ".join(absent))
                fix_packages.extend(absent)
                blocking.append("the checkpoint's remote code cannot import "
                                + ", ".join(absent))
            elif not missing:
                log.append("  remote code    every module it imports is present")
        log.append("")

        # -- decoding -------------------------------------------------------
        log.append("AUDIO")
        decoder_lines, decoder_blocks = _decoder_report(backend)
        log.extend(decoder_lines)
        if decoder_blocks:
            blocking.append("nothing on this machine can decode audio")
        log.append("")

        # -- packages -------------------------------------------------------
        log.append("TRAINING PACKAGES")
        for module, dist, why in TRAINING_REQUIREMENTS:
            if _have(module):
                log.append(f"  ok        {dist}")
            else:
                log.append(f"  MISSING   {dist:<14} {why}")
                fix_packages.append(dist)
                blocking.append(f"{dist} is not installed")
        log.append("")

        log.append("OPTIONAL")
        for module, dist, lost, enables in TRAINING_OPTIONAL:
            if _have(module):
                log.append(f"  ok        {dist}")
            else:
                suffix = f"  [{enables}]" if enables else ""
                log.append(f"  absent    {dist:<14} {lost}{suffix}")
                advisory.append(f"{dist} is absent — {lost}")
        log.append("")

        # -- verdict --------------------------------------------------------
        ready = not blocking
        if ready:
            log.append("READY — nothing here would stop a preprocess or training run.")
        else:
            log.append(f"NOT READY — {len(blocking)} blocking problem(s):")
            log.extend(f"  - {item}" for item in blocking)
        if advisory:
            log.append("")
            log.append("Worth knowing:")
            log.extend(f"  - {item}" for item in advisory)

        suggest: List[str] = []
        core_missing: List[str] = []
        for name in fix_packages:
            target = core_missing if name in COMFYUI_PROVIDED else suggest
            if name not in target:
                target.append(name)

        if core_missing:
            log.append("")
            log.append("ComfyUI's own dependencies are missing: "
                       + ", ".join(core_missing))
            log.append("  These ship with ComfyUI itself, so something is wrong "
                       "with the install or you")
            log.append("  are looking at the wrong interpreter. Do NOT pip install "
                       "them by hand — a")
            log.append("  generic wheel would replace your CUDA or ROCm build.")

        if suggest:
            log.append("")
            log.append("Install what is missing, then restart ComfyUI. This node "
                       "installs nothing:")
            log.append(install_command(suggest, no_deps=True))
            log.append("  --no-deps keeps the resolver away from your torch build.")

        log.append("")
        log.append("Full setup, including the model downloads:")
        log.append("  python custom_nodes/comfyui-novaaudioplayer/training/"
                   "nova_ace_setup.py")

        text = "\n".join(log)
        print(text)
        return {"ui": {"text": [text]}, "result": (ready, text)}


NODE_CLASS_MAPPINGS = {"NovaACESetupCheck": NovaACESetupCheck}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaACESetupCheck": "Nova ACE Setup Check 🩺"}
