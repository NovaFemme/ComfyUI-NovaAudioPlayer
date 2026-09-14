"""
nova_ace_train.py — run an ACE-Step LoRA training job from a ComfyUI graph.

WHAT IT DOES
------------
Drives ``acestep.training_v2.cli.train_fixed`` — upstream's *corrected*
training loop (continuous logit-normal timestep sampling, CFG dropout,
``r = t``) — over the .pt tensors that Nova ACE Preprocess wrote.

WHY A SUBPROCESS AND NOT AN IMPORT
----------------------------------
A LoRA run is hours long and owns the GPU. Called in-process it would block
ComfyUI's queue for the whole run, an OOM inside it would take the server down
with it, and the trainer's own ``_cleanup_gpu`` cannot give back memory that
PyTorch has already fragmented inside the server's allocator. As a child
process it can be cancelled from the ComfyUI UI, it cannot crash the server,
and every byte of VRAM comes back when it exits. The cost is that progress is
text rather than a real progress bar, which is a fair trade for a job measured
in hours.

ComfyUI's own models are unloaded before the child starts, otherwise the two
processes fight over the same card.

WHAT THIS NODE FIXES ON THE WAY THROUGH
---------------------------------------
1. XL VARIANTS DO NOT WORK THROUGH THE STANDALONE CLI AS DOCUMENTED.
   ``cli/validation.validate_paths`` resolves the variant through
   ``cli/args.VARIANT_DIR_MAP``, which only knows turbo/base/sft — the XL
   entries live in ``model_loader._VARIANT_DIR``, which that code path never
   consults. So ``--model-variant xl_sft`` fails validation before training
   starts, even with the checkpoint sitting right there. Every one of the
   three resolvers falls back to treating the variant as a literal folder
   name, so this node passes the folder name (``acestep-v15-xl-sft``) and
   sends the alias through ``--base-model``, which is what that flag is for.

2. THE SHIPPED PRESETS ARE TURBO-TUNED.
   Every file in ``training_v2/presets/`` hardcodes ``shift: 3.0`` and
   ``num_inference_steps: 8``. Upstream's own help text says those should be
   1.0 and 50 for base/sft, and their wizard computes them from the variant —
   but a preset overrides that, so loading ``recommended`` for an SFT
   checkpoint silently trains against a turbo noise schedule. This node reads
   ``is_turbo`` out of the checkpoint's own config.json and derives both,
   which is more reliable than matching on the variant's name.

NOTHING IS INSTALLED OR DOWNLOADED. Missing packages are reported with the
command to run, per the Comfy Registry standards.
"""

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    from .nova_ace_common import (
        ACE_VERSION, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, describe_checkpoint_requirement,
        check_remote_code_imports, describe_remote_code_requirement,
    )
    from ..authoring.nova_authoring_common import banner
except ImportError:  # direct execution / test harness
    from nova_ace_common import (
        ACE_VERSION, TRAINING_CATEGORY, VARIANT_DIRS,
        check_checkpoint_tree, describe_checkpoint_requirement,
        check_remote_code_imports, describe_remote_code_requirement,
    )
    from nova_authoring_common import banner

#: Upstream's preset directory, relative to the acestep package root.
PRESET_SUBPATH = os.path.join("training_v2", "presets")

#: Shown when no preset file can be found — the argparse defaults, which are
#: upstream's `recommended` preset in all but name.
FALLBACK_PRESET: Dict[str, Any] = {
    "name": "built-in defaults",
    "rank": 64, "alpha": 128, "dropout": 0.1,
    "target_modules_str": "q_proj k_proj v_proj o_proj",
    "attention_type": "both", "bias": "none",
    "learning_rate": 1e-4, "batch_size": 1, "gradient_accumulation": 4,
    "epochs": 100, "warmup_steps": 100, "weight_decay": 0.01,
    "max_grad_norm": 1.0, "seed": 42,
    "optimizer_type": "adamw", "scheduler_type": "cosine", "cfg_ratio": 0.15,
    "save_every": 10, "log_every": 10, "log_heavy_every": 50,
    "gradient_checkpointing": True, "offload_encoder": False,
    "sample_every_n_epochs": 0,
}

#: The preset names upstream ships. Listed rather than globbed so the widget
#: has a stable order and still works before acestep is on sys.path.
PRESET_NAMES = [
    "recommended", "quick_test", "high_quality",
    "vram_8gb", "vram_12gb", "vram_16gb", "vram_24gb_plus",
]

#: Optimizers that need a package ComfyUI does not ship.
OPTIMIZER_REQUIREMENTS = {
    "adamw8bit": ("bitsandbytes", "bitsandbytes"),
    "prodigy": ("prodigyopt", "prodigyopt"),
}

USE_PRESET = "from preset"

#: How many trailing lines of the child's output to keep for the console
#: socket. Training prints thousands; the node's job is to hand Nova Console
#: something readable, while the full stream still goes to the terminal.
CONSOLE_TAIL_LINES = 400

_EPOCH_RE = re.compile(r"epoch[^0-9]{0,4}(\d+)\s*/\s*(\d+)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Preset handling
# ---------------------------------------------------------------------------

def find_acestep_root(repo_path: str = "") -> str:
    """Return the directory containing the ``acestep`` package, or ""."""
    if repo_path:
        candidate = os.path.join(repo_path, "acestep")
        if os.path.isdir(candidate):
            return candidate
    try:
        import importlib.util
        spec = importlib.util.find_spec("acestep")
    except (ImportError, ValueError):
        return ""
    if spec and spec.submodule_search_locations:
        return list(spec.submodule_search_locations)[0]
    return ""


def schedule_shape(samples: int, batch_size: int, grad_accum: int,
                   epochs: int, warmup_steps: int) -> Dict[str, Any]:
    """Work out how many OPTIMIZER steps this configuration will actually take.

    Epochs are not steps, and on a small dataset the difference decides whether
    the run learns anything. Upstream accumulates gradients across batches and
    flushes whatever is left at the end of each epoch, so:

        batches/epoch = ceil(samples / batch_size)
        steps/epoch   = ceil(batches per epoch / gradient_accumulation)

    Three samples at batch_size 1 with gradient_accumulation 4 is ONE step per
    epoch — the accumulator never fills, and only the end-of-epoch flush fires.
    A hundred epochs is then a hundred steps, and a preset carrying
    ``warmup_steps: 100`` spends the entire run ramping the learning rate,
    reaching full LR just as training stops. The cosine decay never happens.

    The same arithmetic also exposes a cosmetic lie in upstream's config panel,
    which prints ``Effective batch = batch_size x gradient_accumulation``
    whether or not that many batches exist.
    """
    batch_size = max(1, int(batch_size))
    grad_accum = max(1, int(grad_accum))
    epochs = max(1, int(epochs))
    batches = max(1, -(-int(samples) // batch_size))          # ceil
    steps_per_epoch = max(1, -(-batches // grad_accum))       # ceil
    total = steps_per_epoch * epochs
    return {
        "batches_per_epoch": batches,
        "steps_per_epoch": steps_per_epoch,
        "total_steps": total,
        "claimed_batch": batch_size * grad_accum,
        "effective_batch": min(grad_accum, batches) * batch_size,
        "warmup_steps": int(warmup_steps),
        "warmup_fraction": (float(warmup_steps) / total) if total else 0.0,
    }


def schedule_complaints(shape: Dict[str, Any]) -> List[str]:
    """Human-readable warnings about a schedule that will not do what it says."""
    out: List[str] = []
    warmup, total = shape["warmup_steps"], shape["total_steps"]
    if warmup >= total:
        out.append(
            f"warmup_steps ({warmup}) is >= the whole run ({total} optimizer "
            f"steps, {shape['steps_per_epoch']}/epoch). The learning rate ramps "
            "from zero for the entire run and hits full LR as training ends — "
            "the cosine decay never happens. Lower warmup_steps, or raise the "
            "step count by lowering gradient_accumulation."
        )
    elif shape["warmup_fraction"] > 0.25:
        out.append(
            f"warmup_steps ({warmup}) is {shape['warmup_fraction'] * 100:.0f}% of "
            f"the {total}-step run. Most schedules want under 10%."
        )
    if shape["effective_batch"] != shape["claimed_batch"]:
        out.append(
            f"effective batch is {shape['effective_batch']}, not "
            f"{shape['claimed_batch']}: there are only "
            f"{shape['batches_per_epoch']} batches per epoch, so the "
            "accumulator never fills and the end-of-epoch flush does the step. "
            "(Upstream's config panel will still print the larger number.)"
        )
    return out


def common_ancestor(paths: List[str]) -> str:
    """Deepest directory containing every one of *paths*, or "" .

    This becomes the child process's working directory, which matters more
    than it looks: ``acestep.training.path_safety`` captures
    ``_SAFE_ROOT = realpath(os.getcwd())`` **at import time** and refuses any
    path that escapes it. Point the child at the ACE-Step clone and a dataset
    living anywhere else is rejected as a path-injection attempt. The cwd has
    to be an ancestor of every path the run touches — dataset, output,
    checkpoints and any resume directory.
    """
    usable = [os.path.realpath(p) for p in paths if p]
    if not usable:
        return ""
    try:
        ancestor = os.path.commonpath(usable)
    except ValueError:            # different drives on Windows
        return ""
    # commonpath is purely lexical, so walk up to something that exists — a
    # cwd that is not a directory would fail the spawn outright.
    while ancestor and not os.path.isdir(ancestor):
        parent = os.path.dirname(ancestor)
        if parent == ancestor:
            return ""
        ancestor = parent
    return ancestor


def find_acestep_import_root(repo_path: str = "") -> str:
    """Return the directory to put on a child process's PYTHONPATH, or "".

    ``sys.path`` entries added by another node in this process do NOT reach a
    subprocess, which is the whole reason this exists: Nova ACE Preprocess
    inserts its ``acestep_repo_path`` into the server's own ``sys.path``, so
    ``acestep`` imports fine here and then vanishes the moment we fork. Locate
    it the same way an import would and hand the answer to the child.
    """
    package = find_acestep_root(repo_path)
    return os.path.dirname(package) if package else ""


def load_preset(name: str, repo_path: str = "") -> Tuple[Dict[str, Any], str]:
    """Load one of upstream's preset JSONs. Returns ``(values, source)``.

    Falls back to the built-in defaults rather than failing: a missing preset
    file is not a reason to refuse to train.
    """
    root = find_acestep_root(repo_path)
    if root:
        path = os.path.join(root, PRESET_SUBPATH, f"{name}.json")
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, dict):
                    merged = dict(FALLBACK_PRESET)
                    merged.update(data)
                    return merged, path
            except (OSError, json.JSONDecodeError):
                pass
    return dict(FALLBACK_PRESET), "built-in defaults (preset file not found)"


def read_checkpoint_config(checkpoint_dir: str, variant_dir: str) -> Dict[str, Any]:
    path = os.path.join(checkpoint_dir, variant_dir, "config.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def schedule_for_checkpoint(config: Dict[str, Any], variant: str) -> Tuple[float, int, str]:
    """Return ``(shift, num_inference_steps, why)`` for this checkpoint.

    Preferring the checkpoint's own ``is_turbo`` over its folder name, because
    the name is a convention and the flag is a fact.
    """
    if "is_turbo" in config:
        turbo = bool(config["is_turbo"])
        return (3.0, 8, "config.json is_turbo=true") if turbo else \
               (1.0, 50, "config.json is_turbo=false")
    turbo = "turbo" in (variant or "").lower()
    return (3.0, 8, "variant name contains 'turbo'") if turbo else \
           (1.0, 50, "variant name is not a turbo model")


# ---------------------------------------------------------------------------
# Command construction
# ---------------------------------------------------------------------------

def build_command(*, python_exe: str, tensor_dir: str, output_dir: str,
                  checkpoint_dir: str, variant: str, preset: Dict[str, Any],
                  overrides: Dict[str, Any], shift: float,
                  num_inference_steps: int, device: str, precision: str,
                  resume_from: str = "") -> List[str]:
    """Build the argv for ``python -m acestep.training_v2.cli.train_fixed``.

    ``overrides`` holds only the settings the user actually changed; anything
    absent comes from the preset. Booleans use argparse's
    BooleanOptionalAction spelling (``--x`` / ``--no-x``).
    """
    def value(key: str) -> Any:
        return overrides[key] if key in overrides else preset.get(key)

    # The variant is sent as the literal folder name, not the alias — see the
    # module docstring, point 1.
    variant_dir = VARIANT_DIRS.get(variant, variant)

    argv = [
        python_exe, "-m", "acestep.training_v2.cli.train_fixed",
        "--plain", "--yes",
        "--checkpoint-dir", checkpoint_dir,
        "--model-variant", variant_dir,
        "--dataset-dir", tensor_dir,
        "--output-dir", output_dir,
        "--device", device,
        "--precision", precision,
        "--shift", repr(float(shift)),
        "--num-inference-steps", str(int(num_inference_steps)),
    ]
    if variant in VARIANT_DIRS:
        argv += ["--base-model", variant]

    argv += [
        "--adapter-type", "lora",
        "--rank", str(int(value("rank"))),
        "--alpha", str(int(value("alpha"))),
        "--dropout", repr(float(value("dropout"))),
        "--bias", str(value("bias")),
        "--attention-type", str(value("attention_type")),
        "--lr", repr(float(value("learning_rate"))),
        "--batch-size", str(int(value("batch_size"))),
        "--gradient-accumulation", str(int(value("gradient_accumulation"))),
        "--epochs", str(int(value("epochs"))),
        "--warmup-steps", str(int(value("warmup_steps"))),
        "--weight-decay", repr(float(value("weight_decay"))),
        "--max-grad-norm", repr(float(value("max_grad_norm"))),
        "--seed", str(int(value("seed"))),
        "--optimizer-type", str(value("optimizer_type")),
        "--scheduler-type", str(value("scheduler_type")),
        "--cfg-ratio", repr(float(value("cfg_ratio"))),
        "--save-every", str(int(value("save_every"))),
        "--log-every", str(int(value("log_every"))),
        "--log-heavy-every", str(int(value("log_heavy_every"))),
        "--sample-every-n-epochs", str(int(value("sample_every_n_epochs"))),
    ]

    modules = str(value("target_modules_str") or "").split()
    if modules:
        argv += ["--target-modules"] + modules

    argv.append("--gradient-checkpointing" if value("gradient_checkpointing")
                else "--no-gradient-checkpointing")
    argv.append("--offload-encoder" if value("offload_encoder")
                else "--no-offload-encoder")

    if resume_from:
        argv += ["--resume-from", resume_from]
    return argv


def quote_command(argv: List[str]) -> str:
    """A copy-pasteable rendering of argv, wrapped so it fits a console.

    Flags stay glued to their values across the line breaks — a wrapped
    command you cannot read pair-by-pair is not much use for debugging.
    """
    import shlex
    parts = [shlex.quote(a) for a in argv]

    # Group into atoms: a flag plus everything up to the next flag.
    atoms: List[str] = []
    for part in parts:
        if part.startswith("-") or not atoms:
            atoms.append(part)
        else:
            atoms[-1] += " " + part

    lines: List[str] = []
    current = ""
    for atom in atoms:
        if current and len(current) + len(atom) + 1 > 68:
            lines.append("    " + current + " \\")
            current = atom
        else:
            current = (current + " " + atom).strip()
    if current:
        lines.append("    " + current)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------

class NovaACELoRATrainer:
    CATEGORY = TRAINING_CATEGORY
    FUNCTION = "train"
    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("lora_dir", "output_dir", "exit_code", "console")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "The finished adapter — output_dir/final. Empty if the run did not finish.",
        "The run's output directory, holding final/, checkpoints/ and runs/.",
        "The trainer's exit code. 0 is success, 130 means cancelled.",
        "Run log — wire into Nova Console.",
    )
    DESCRIPTION = (
        f"Nova ACE LoRA Trainer v{ACE_VERSION} — runs ACE-Step's corrected "
        "training loop over preprocessed tensors, as a cancellable child "
        "process so a multi-hour run cannot block or crash ComfyUI."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tensor_dir": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "From Nova ACE Preprocess",
                    "tooltip": "Directory of .pt tensors to train on.",
                }),
                "output_dir": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "~/Datasets/my_lora/run1",
                    "tooltip": "Where the adapter goes. final/ is the finished LoRA; checkpoints/ holds the per-epoch saves.",
                }),
                "checkpoint_dir": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "Same checkpoint tree the preprocess node used",
                    "tooltip": "Must be the SAME checkpoint the tensors were encoded against. Different weights means the tensors describe a model you are not training.",
                }),
                "variant": (list(VARIANT_DIRS), {
                    "default": "xl_sft",
                    "tooltip": "Match the variant used for preprocessing.",
                }),
                "preset": (PRESET_NAMES, {
                    "default": "recommended",
                    "tooltip": "Upstream's preset, loaded from training_v2/presets/. Everything below set to 'from preset' or 0 comes from here.",
                }),
                "rank": ("INT", {
                    "default": 0, "min": 0, "max": 512, "step": 8,
                    "tooltip": "LoRA rank. 0 = take it from the preset. Higher means more capacity and more VRAM.",
                }),
                "alpha": ("INT", {
                    "default": 0, "min": 0, "max": 1024, "step": 8,
                    "tooltip": "LoRA alpha. 0 = from the preset. Convention is 2x rank.",
                }),
                "learning_rate": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 0.01, "step": 0.00001, "round": False,
                    "tooltip": "0 = from the preset (1e-4).",
                }),
                "epochs": ("INT", {
                    "default": 0, "min": 0, "max": 100000,
                    "tooltip": "0 = from the preset. quick_test is 10, recommended 100, high_quality 1000.",
                }),
                "batch_size": ("INT", {
                    "default": 0, "min": 0, "max": 64,
                    "tooltip": "0 = from the preset.",
                }),
                "gradient_accumulation": ("INT", {
                    "default": 0, "min": 0, "max": 256,
                    "tooltip": "0 = from the preset. Effective batch is batch_size x this.",
                }),
                "save_every": ("INT", {
                    "default": 0, "min": 0, "max": 10000,
                    "tooltip": "Checkpoint every N epochs. 0 = from the preset.",
                }),
                "optimizer": ([USE_PRESET, "adamw", "adamw8bit", "adafactor", "prodigy"], {
                    "default": USE_PRESET,
                    "tooltip": "adamw8bit needs bitsandbytes, prodigy needs prodigyopt. Both are checked before the run starts.",
                }),
                "gradient_checkpointing": ([USE_PRESET, "on", "off"], {
                    "default": USE_PRESET,
                    "tooltip": "Recomputes activations: 40-60% less VRAM, 10-30% slower.",
                }),
                "device": (["auto", "cuda", "cpu"], {
                    "default": "auto",
                    "tooltip": "On ROCm, cuda is correct — that is what torch calls it.",
                }),
                "precision": (["auto", "bf16", "fp16", "fp32"], {
                    "default": "bf16",
                    "tooltip": "bf16 matches the bf16 checkpoints.",
                }),
                "dry_run": ("BOOLEAN", {
                    "default": False, "label_on": "show command only", "label_off": "train",
                    "tooltip": "Run every pre-flight check and print the exact command, without starting it.",
                }),
                # APPENDED, not inserted. ComfyUI serialises a node's widget
                # values positionally, so slotting a new widget in beside the
                # one it belongs next to (epochs) would shift every value after
                # it and silently scramble workflows already saved with this
                # node. New widgets go on the end; the tooltip carries the
                # context the position cannot.
                "warmup_steps": ("INT", {
                    "default": 0, "min": 0, "max": 100000,
                    "tooltip": "LR warmup, counted in OPTIMIZER STEPS, not epochs. 0 = from the preset (100), which on a small dataset is longer than the entire run. The banner reports the real step count before anything launches.",
                }),
            },
            "optional": {
                "acestep_repo_path": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "/path/to/ACE-Step-1.5 (only if not pip-installed)",
                    "tooltip": "Path to an ACE-Step clone. Passed to the child through PYTHONPATH.",
                }),
                "resume_from": ("STRING", {
                    "default": "", "multiline": False,
                    "placeholder": "output_dir/checkpoints/epoch_50_loss_0.1234",
                    "tooltip": "Resume from a saved checkpoint directory.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # a training run is never a cache hit

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _release_comfy_vram(log: List[str]) -> None:
        """Hand the GPU to the child. Two processes on one card is an OOM."""
        try:
            import comfy.model_management as mm
            mm.unload_all_models()
            if hasattr(mm, "soft_empty_cache"):
                mm.soft_empty_cache()
            log.append("Freed ComfyUI's VRAM before launching the trainer.")
        except Exception as exc:
            log.append(f"Could not unload ComfyUI's models ({exc}); "
                       "if the trainer OOMs, restart ComfyUI first.")

    @staticmethod
    def _check_optimizer(optimizer: str) -> Optional[str]:
        requirement = OPTIMIZER_REQUIREMENTS.get(optimizer)
        if not requirement:
            return None
        module, package = requirement
        try:
            import importlib.util
            if importlib.util.find_spec(module) is not None:
                return None
        except (ImportError, ValueError):
            pass
        return (f"optimizer '{optimizer}' needs the {package} package, which is "
                f"not installed in {sys.executable}.")

    def _stream(self, proc, log: List[str], tail: List[str], bar) -> int:
        """Forward the child's output, staying cancellable while it runs."""
        lines: "queue.Queue[Optional[str]]" = queue.Queue()

        def reader():
            try:
                for line in proc.stdout:
                    lines.put(line.rstrip("\n"))
            finally:
                lines.put(None)

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        interrupted = False
        while True:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                # Nothing to read is the normal state during a long step, so
                # the cancel check lives here rather than in the read loop —
                # otherwise a stalled trainer could not be cancelled at all.
                if not interrupted and self._cancelled():
                    interrupted = True
                    print("[Nova ACE Trainer] Cancel requested — stopping the trainer.")
                    self._terminate(proc)
                if proc.poll() is not None and lines.empty():
                    break
                continue
            if line is None:
                break
            print(line)
            tail.append(line)
            if len(tail) > CONSOLE_TAIL_LINES:
                del tail[:-CONSOLE_TAIL_LINES]
            if bar is not None:
                match = _EPOCH_RE.search(line)
                if match:
                    try:
                        bar.update_absolute(int(match.group(1)), int(match.group(2)))
                    except Exception:
                        pass
            if not interrupted and self._cancelled():
                interrupted = True
                print("[Nova ACE Trainer] Cancel requested — stopping the trainer.")
                self._terminate(proc)

        thread.join(timeout=5)
        code = proc.wait()
        if interrupted:
            log.append("Cancelled from ComfyUI. Checkpoints already written are intact.")
        return code

    @staticmethod
    def _cancelled() -> bool:
        try:
            import comfy.model_management as mm
            mm.throw_exception_if_processing_interrupted()
        except ImportError:
            return False
        except Exception:
            return True
        return False

    @staticmethod
    def _terminate(proc) -> None:
        """SIGTERM, then SIGKILL. The trainer traps SIGINT to save state."""
        try:
            proc.terminate()
        except Exception:
            return
        deadline = time.time() + 30.0
        while time.time() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.5)
        try:
            proc.kill()
        except Exception:
            pass

    # -- main ---------------------------------------------------------------

    def train(self, tensor_dir, output_dir, checkpoint_dir, variant, preset,
              rank, alpha, learning_rate, epochs, batch_size,
              gradient_accumulation, save_every, optimizer,
              gradient_checkpointing, device, precision, dry_run,
              warmup_steps=0, acestep_repo_path="", resume_from="", **kwargs):
        log: List[str] = [banner(f"NOVA ACE LORA TRAINER v{ACE_VERSION}")]

        def clean(value):
            return os.path.abspath(os.path.expanduser((value or "").strip().strip('"'))) \
                if (value or "").strip() else ""

        tensors = clean(tensor_dir)
        out = clean(output_dir)
        ckpt = clean(checkpoint_dir)
        repo = clean(acestep_repo_path)
        resume = clean(resume_from)

        # -- Pre-flight. Everything that can be known before a model loads --
        if not tensors or not os.path.isdir(tensors):
            raise NotADirectoryError(
                f"Nova ACE LoRA Trainer: no tensor directory at {tensors or '<unset>'}. "
                "Run Nova ACE Preprocess first."
            )
        found = sorted(f for f in os.listdir(tensors) if f.endswith(".pt"))
        if not found:
            raise FileNotFoundError(
                f"Nova ACE LoRA Trainer: {tensors} holds no .pt tensors. "
                "Nova ACE Preprocess writes them; check that it reported "
                "processed > 0."
            )
        if not out:
            raise ValueError("Nova ACE LoRA Trainer: output_dir is required.")

        missing = check_checkpoint_tree(ckpt, variant)
        if missing:
            raise FileNotFoundError(
                "Nova ACE LoRA Trainer: the checkpoint directory is missing "
                + ", ".join(missing) + ".\n"
                + describe_checkpoint_requirement(ckpt, variant)
            )
        absent = check_remote_code_imports(ckpt, variant)
        if absent:
            raise ImportError(
                "Nova ACE LoRA Trainer: the "
                + VARIANT_DIRS.get(variant, variant)
                + " checkpoint needs " + ", ".join(absent)
                + ", which is not installed in ComfyUI's Python.\n"
                + describe_remote_code_requirement(absent)
            )
        if repo and not os.path.isdir(repo):
            raise NotADirectoryError(
                f"Nova ACE LoRA Trainer: acestep_repo_path {repo} is not a directory."
            )

        # Find acestep HERE rather than letting the child fail on the import.
        # A subprocess does not inherit sys.path entries this process added, so
        # "it worked in the preprocess node" is not evidence that the child can
        # import it.
        import_root = find_acestep_import_root(repo)
        if not import_root:
            raise ImportError(
                "Nova ACE LoRA Trainer: cannot find ACE-Step's training code.\n"
                "  Set acestep_repo_path on this node to your ACE-Step clone — "
                "the same path Nova ACE Preprocess uses. Setting it there is "
                "not enough: the trainer runs as a separate process, which "
                "does not inherit this one's import paths.\n"
                "  This node does not install or download anything."
            )

        safe_root = common_ancestor([tensors, out, ckpt, resume])

        warnings: List[str] = []
        if os.path.normpath(out) == os.path.normpath(tensors):
            warnings.append(
                "output_dir is the same folder as tensor_dir. It will work — the "
                "adapter goes into final/ and checkpoints/ — but the run's output "
                "then lives inside your dataset. A separate folder is easier to "
                "delete and re-run."
            )

        # -- Preset, then the overrides the user actually set ----------------
        values, source = load_preset(preset, repo)
        overrides: Dict[str, Any] = {}
        for key, given in (("rank", rank), ("alpha", alpha),
                           ("epochs", epochs), ("batch_size", batch_size),
                           ("gradient_accumulation", gradient_accumulation),
                           ("warmup_steps", warmup_steps),
                           ("save_every", save_every)):
            if given:                      # 0 means "leave the preset alone"
                overrides[key] = int(given)
        if learning_rate:
            overrides["learning_rate"] = float(learning_rate)
        if optimizer != USE_PRESET:
            overrides["optimizer_type"] = optimizer
        if gradient_checkpointing != USE_PRESET:
            overrides["gradient_checkpointing"] = gradient_checkpointing == "on"

        chosen_optimizer = overrides.get("optimizer_type", values.get("optimizer_type"))
        complaint = self._check_optimizer(chosen_optimizer)
        if complaint:
            raise ImportError("Nova ACE LoRA Trainer: " + complaint)

        def setting(key):
            return overrides[key] if key in overrides else values.get(key)

        shape = schedule_shape(
            samples=len(found), batch_size=setting("batch_size"),
            grad_accum=setting("gradient_accumulation"), epochs=setting("epochs"),
            warmup_steps=setting("warmup_steps"),
        )
        warnings.extend(schedule_complaints(shape))

        variant_dir = VARIANT_DIRS.get(variant, variant)
        config = read_checkpoint_config(ckpt, variant_dir)
        shift, steps, why = schedule_for_checkpoint(config, variant)

        argv = build_command(
            python_exe=sys.executable, tensor_dir=tensors, output_dir=out,
            checkpoint_dir=ckpt, variant=variant, preset=values,
            overrides=overrides, shift=shift, num_inference_steps=steps,
            device=device, precision=precision, resume_from=resume,
        )

        # -- Report -----------------------------------------------------------
        log.append(f"Tensors    : {tensors}  ({len(found)} sample(s))")
        log.append(f"Checkpoint : {ckpt}  [{variant} -> {variant_dir}/]")
        log.append(f"Output     : {out}")
        log.append(f"Preset     : {preset}  ({source})")
        if overrides:
            log.append("Overrides  : " + ", ".join(
                f"{k}={v}" for k, v in sorted(overrides.items())))
        else:
            log.append("Overrides  : none — every setting comes from the preset")
        log.append(f"Schedule   : shift {shift}, {steps} inference steps  ({why})")
        log.append(
            f"Steps      : {shape['steps_per_epoch']}/epoch x "
            f"{setting('epochs')} epochs = {shape['total_steps']} optimizer "
            f"steps, warmup {shape['warmup_steps']}"
        )
        log.append(f"Device     : {device} / {precision}   optimizer {chosen_optimizer}")
        log.append(f"ACE-Step   : {import_root}")
        log.append(f"Safe root  : {safe_root or '<none — paths share no ancestor>'}")
        if resume:
            log.append(f"Resuming   : {resume}")
        for note in warnings:
            log.append("")
            log.append("Note: " + note)
        log.append("")

        try:
            import importlib.util
            if importlib.util.find_spec("tensorboard") is None:
                log.append("No tensorboard installed, so no loss curves will be "
                           "written. Training itself is unaffected.")
                log.append("")
        except (ImportError, ValueError):
            pass

        log.append("Command:")
        log.append(quote_command(argv))
        log.append("")

        if dry_run:
            log.append("dry_run is on — nothing was started.")
            text = "\n".join(log)
            print(text)
            return {"ui": {"text": [text]}, "result": ("", out, 0, text)}

        os.makedirs(out, exist_ok=True)
        self._release_comfy_vram(log)
        log.append("Training runs as a child process: cancel it from ComfyUI, "
                   "and watch the terminal for per-epoch output.")
        log.append("")
        print("\n".join(log))

        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = import_root + (os.pathsep + existing if existing else "")

        try:
            from comfy.utils import ProgressBar
            bar = ProgressBar(max(1, int(overrides.get("epochs", values.get("epochs", 1)))))
        except Exception:
            bar = None

        tail: List[str] = []
        started = time.time()
        try:
            proc = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, env=env, cwd=safe_root or None,
            )
        except OSError as exc:
            raise RuntimeError(
                f"Nova ACE LoRA Trainer: could not start the trainer ({exc}). "
                f"Tried: {sys.executable} -m acestep.training_v2.cli.train_fixed"
            ) from exc

        code = self._stream(proc, log, tail, bar)
        elapsed = time.time() - started

        final = os.path.join(out, "final")
        lora_dir = final if os.path.isdir(final) else ""

        log.append("")
        log.append(f"exit code  : {code}" + ("  (cancelled)" if code == 130 else ""))
        log.append(f"elapsed    : {elapsed / 60.0:.1f} min")
        if lora_dir:
            log.append(f"adapter    : {lora_dir}")
        checkpoints = os.path.join(out, "checkpoints")
        if os.path.isdir(checkpoints):
            saved = sorted(os.listdir(checkpoints))
            log.append(f"checkpoints: {len(saved)} in {checkpoints}")
        # Exit code alone is NOT a success signal. FixedLoRATrainer.train() is a
        # generator whose body is wrapped in `except Exception: yield
        # TrainingUpdate(kind="fail")`, so a hard failure is reported as a line
        # of text and the process still exits 0. The honest test is whether an
        # adapter appeared.
        failed = code not in (0, 130) or (code == 0 and not lora_dir)
        if failed:
            complaints = [l for l in tail if "[FAIL]" in l or "Traceback" in l]
            log.append("")
            if code == 0 and not lora_dir:
                log.append("FAILED — the trainer exited 0 but wrote no final/ adapter.")
                log.append("(Upstream catches its own exceptions and still returns 0, "
                           "so the output below is the real story, not the exit code.)")
            else:
                log.append("FAILED — the trainer exited with a non-zero status.")
            if complaints:
                log.append("")
                log.append("What it reported:")
                log.extend("  " + line for line in complaints[-10:])
            log.append("")
            log.append("Last lines:")
            log.extend("  " + line for line in tail[-25:])

        text = "\n".join(log)
        print(text)
        return {"ui": {"text": [text]},
                "result": (lora_dir, out, int(code), text)}


NODE_CLASS_MAPPINGS = {"NovaACELoRATrainer": NovaACELoRATrainer}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaACELoRATrainer": "Nova ACE LoRA Trainer 🎓"}
