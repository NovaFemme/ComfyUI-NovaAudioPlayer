"""
nova_ace_preprocess.py — generate ACE-Step training tensors.

This node is a THIN WRAPPER on purpose. It calls
``acestep.training_v2.preprocess.preprocess_audio_files`` rather than writing
the tensors itself.

Why: the .pt schema the trainer consumes is not a published contract, it is
whatever that module writes today — currently target_latents, attention_mask,
encoder_hidden_states, encoder_attention_mask, context_latents and metadata,
produced in two passes (VAE + text encoder, then the DIT encoder). A
reimplementation would drift the first time upstream changes a key, and the
failure would be silent: training runs, loss falls, the LoRA is quietly wrong.
Borrowing their writer is the only way to stay correct for free.

DEPENDENCY, handled per the Comfy Registry rules: ACE-Step is NOT installed by
this node and NOT downloaded at runtime. If it is missing the node says exactly
what to install and stops. Same for the checkpoint tree — it is validated
before any model loads, so a wrong path costs a second instead of a long
download followed by a traceback.
"""

import json
import os
import sys
from typing import Any, Dict, List

try:
    from .nova_ace_common import (
        ACE_VERSION, DATASET_TYPE, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, describe_checkpoint_requirement,
        check_remote_code_imports, describe_remote_code_requirement,
    )
    from ..authoring.nova_authoring_common import banner
    from .nova_ace_audio_shim import apply_decode_shim, TORCHCODEC_FIX
except ImportError:  # direct execution / test harness
    from nova_ace_common import (
        ACE_VERSION, DATASET_TYPE, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, describe_checkpoint_requirement,
        check_remote_code_imports, describe_remote_code_requirement,
    )
    from nova_authoring_common import banner
    from nova_ace_audio_shim import apply_decode_shim, TORCHCODEC_FIX

INSTALL_HINT = (
    "ACE-Step's training code is not importable.\n"
    "  This node does not install or download anything — the Comfy Registry "
    "standards prohibit runtime package installation.\n"
    "  Clone https://github.com/ace-step/ACE-Step-1.5 and either install it into "
    "ComfyUI's Python environment, or set acestep_repo_path on this node to the "
    "clone so it can be imported."
)


class NovaACEPreprocess:
    CATEGORY = TRAINING_CATEGORY
    FUNCTION = "preprocess"
    RETURN_TYPES = ("STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("tensor_dir", "processed", "failed", "console")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "Directory holding the .pt tensors — point the trainer at this.",
        "Samples successfully written.",
        "Samples that failed.",
        "Run log — wire into Nova Console.",
    )
    DESCRIPTION = (
        f"Nova ACE Preprocess v{ACE_VERSION} — runs ACE-Step's own two-pass tensor "
        "generation over a Nova dataset. Prepares training data; does not train."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dataset_json": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "From Nova ACE Dataset Builder",
                    "tooltip": "Dataset JSON path. Its audio_path fields locate the audio.",
                }),
                "output_dir": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "~/Datasets/my_lora/tensors",
                    "tooltip": "Where the .pt tensors go. Existing tensors are skipped, so a cancelled run resumes.",
                }),
                "checkpoint_dir": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "/path/to/ACE-Step checkpoints (HuggingFace layout)",
                    "tooltip": "Must contain the variant folder, vae/, Qwen3-Embedding-0.6B/ and silence_latent.pt. ComfyUI's single-file safetensors will NOT work.",
                }),
                "variant": (list(VARIANT_DIRS), {
                    "default": "xl_sft",
                    "tooltip": "Which checkpoint to encode against. Match the model you will train.",
                }),
                "max_duration": ("FLOAT", {
                    "default": 240.0, "min": 10.0, "max": 3600.0, "step": 10.0,
                    "tooltip": "Audio longer than this is truncated. Longer means more VRAM.",
                }),
                "device": (["auto", "cuda", "cpu"], {
                    "default": "auto",
                    "tooltip": "auto detects your GPU. On ROCm, cuda is the right choice — that is what torch calls it.",
                }),
                "precision": (["auto", "bf16", "fp16", "fp32"], {
                    "default": "auto",
                    "tooltip": "bf16 matches the bf16 checkpoints and is the safe pick on RDNA.",
                }),
            },
            "optional": {
                "acestep_repo_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "~/Github/ACE-Step-1.5 (only if not pip-installed)",
                    "tooltip": "Path to an ACE-Step clone, prepended to sys.path for the import. Leave empty if the package is installed.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # writes tensors; never cache

    def preprocess(self, dataset_json, output_dir, checkpoint_dir, variant,
                   max_duration, device, precision, acestep_repo_path="", **kwargs):
        log: List[str] = [banner(f"NOVA ACE PREPROCESS v{ACE_VERSION}")]

        dataset = os.path.abspath(os.path.expanduser((dataset_json or "").strip().strip('"')))
        out = os.path.abspath(os.path.expanduser((output_dir or "").strip().strip('"')))
        ckpt = os.path.abspath(os.path.expanduser((checkpoint_dir or "").strip().strip('"'))) \
            if (checkpoint_dir or "").strip() else ""

        if not os.path.isfile(dataset):
            raise FileNotFoundError(
                f"Nova ACE Preprocess: no dataset JSON at {dataset}. "
                "Run Nova ACE Dataset Builder first."
            )
        if not out:
            raise ValueError("Nova ACE Preprocess: output_dir is required.")

        # Checkpoint tree first: a wrong path should cost a second, not a
        # multi-gigabyte load followed by a traceback.
        missing = check_checkpoint_tree(ckpt, variant)
        if missing:
            raise FileNotFoundError(
                "Nova ACE Preprocess: the checkpoint directory is missing "
                + ", ".join(missing) + ".\n" + describe_checkpoint_requirement(ckpt, variant)
            )

        # The XL checkpoints load through trust_remote_code, and transformers
        # will not run that code if its imports are missing. Upstream discovers
        # this in Pass 2 — after Pass 1 has already encoded every file on the
        # GPU. Checking here costs milliseconds.
        absent = check_remote_code_imports(ckpt, variant)
        if absent:
            raise ImportError(
                "Nova ACE Preprocess: the "
                + VARIANT_DIRS.get(variant, variant)
                + " checkpoint needs " + ", ".join(absent)
                + ", which is not installed in ComfyUI's Python.\n"
                + describe_remote_code_requirement(absent)
            )

        repo = (acestep_repo_path or "").strip().strip('"')
        if repo:
            repo = os.path.abspath(os.path.expanduser(repo))
            if not os.path.isdir(repo):
                raise NotADirectoryError(
                    f"Nova ACE Preprocess: acestep_repo_path {repo} is not a directory."
                )
            if repo not in sys.path:
                sys.path.insert(0, repo)
                log.append(f"Added to sys.path: {repo}")

        try:
            from acestep.training_v2.preprocess import preprocess_audio_files
        except ImportError as exc:
            raise ImportError(f"Nova ACE Preprocess: {INSTALL_HINT}\n  ({exc})") from exc

        # torchaudio >= 2.9 decodes through torchcodec, whose PyPI wheel is a
        # CUDA build that cannot load against ROCm. Patch ACE-Step's Pass 1
        # decoder only when that is provably the case here.
        shim_active, shim_lines = apply_decode_shim()

        with open(dataset, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        samples = payload if isinstance(payload, list) else payload.get("samples", [])

        log.append(f"Dataset    : {dataset}  ({len(samples)} sample(s))")
        log.append(f"Checkpoint : {ckpt}  [{variant} -> {VARIANT_DIRS.get(variant, variant)}/]")
        log.append(f"Output     : {out}")
        log.append(f"Device     : {device} / {precision}   max_duration {max_duration:.0f}s")
        if shim_lines:
            log.append("")
            log.extend(shim_lines)
        log.append("")
        log.append("Two passes: VAE + text encoder, then the DIT encoder. Existing "
                   ".pt files are skipped, so a cancelled run resumes where it stopped.")
        log.append("")
        print("\n".join(log))

        try:
            from comfy.utils import ProgressBar
            bar = ProgressBar(max(1, len(samples)))
        except Exception:
            bar = None

        state: Dict[str, Any] = {"last": ""}

        def progress(current, total, message):
            state["last"] = f"{current}/{total}  {message}"
            print(f"[Nova ACE Preprocess] {state['last']}")
            if bar is not None:
                try:
                    bar.update_absolute(min(current, total), total)
                except Exception:
                    pass

        result = preprocess_audio_files(
            audio_dir=None,                 # the dataset JSON carries audio_path
            output_dir=out,
            checkpoint_dir=ckpt,
            variant=variant,
            max_duration=float(max_duration),
            dataset_json=dataset,
            device=device,
            precision=precision,
            progress_callback=progress,
        )

        processed = int(result.get("processed", 0))
        failed = int(result.get("failed", 0))
        tensors = sorted(f for f in os.listdir(out) if f.endswith(".pt")) if os.path.isdir(out) else []

        log.append(f"processed : {processed}")
        log.append(f"failed    : {failed}")
        log.append(f"tensors   : {len(tensors)} .pt file(s) in {out}")
        if failed:
            log.append("Check the ComfyUI console for the per-file Pass 1/Pass 2 errors.")
            if shim_active and not processed:
                log.append("")
                log.extend(TORCHCODEC_FIX.splitlines())
        log.append("")
        log.append("Next: point ACE-Step's LoRA trainer at this tensor directory.")

        text = "\n".join(log)
        print(text)
        return {"ui": {"text": [text]},
                "result": (out, processed, failed, text)}


NODE_CLASS_MAPPINGS = {"NovaACEPreprocess": NovaACEPreprocess}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaACEPreprocess": "Nova ACE Preprocess 🧮"}
