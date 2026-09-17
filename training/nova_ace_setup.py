#!/usr/bin/env python3
"""
nova_ace_setup.py — one-shot setup for Nova ACE LoRA training.

Starting from a ComfyUI install that has only the Nova node pack, this brings
the machine to the point where the four nodes under
``▶️ Nova Audio/🎓 LoRA Training`` will run:

    1. find ComfyUI and the interpreter it actually runs on
    2. work out whether that PyTorch is CUDA, ROCm, XPU or CPU
    3. install the Python packages ACE-Step's training path needs
    4. replace torchcodec when the installed wheel cannot load
    5. clone ACE-Step 1.5
    6. build the checkpoint tree, reusing weights ComfyUI already has
    7. verify the result with the node pack's OWN checks
    8. print the paths to paste into each node

THIS IS NOT NODE RUNTIME. It is a setup script you run deliberately, once,
from a terminal. Nothing in the node package imports it and nothing calls it
during a workflow — the Comfy Registry prohibition on runtime package
installation concerns nodes installing things while ComfyUI executes them,
which is exactly what having this as a separate manual step avoids.

IT NEVER TOUCHES PYTORCH. Every install runs against a constraints file
pinning the torch/torchvision/torchaudio already present, so a dependency
resolver cannot decide your ROCm or CPU build is wrong and replace it. If some
package genuinely demands a different torch, pip fails loudly instead.

    python nova_ace_setup.py --dry-run          # show the plan, change nothing
    python nova_ace_setup.py                    # do it, asking once
    python nova_ace_setup.py --yes              # unattended

Requires Python 3.10+. Run it with any interpreter; it finds ComfyUI's own.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

VERSION = "1.0.0"

ACESTEP_REPO = "https://github.com/ace-step/ACE-Step-1.5"

#: Hugging Face repo holding the VAE, the text encoder and the non-XL variants.
BASE_REPO = "ACE-Step/Ace-Step1.5"

#: variant -> (checkpoint subdirectory, Hugging Face repo, approximate GB)
#:
#: ``turbo`` is the odd one out: it has no repo of its own and ships as a
#: subfolder INSIDE the base repo, so it is fetched by pattern into the tree
#: root rather than downloaded into its own directory. Getting that wrong
#: pulls the whole 10 GB base repo into a subfolder.
VARIANTS: Dict[str, Tuple[str, str, float]] = {
    "xl_sft":   ("acestep-v15-xl-sft",   "ACE-Step/acestep-v15-xl-sft",   19.95),
    "xl_turbo": ("acestep-v15-xl-turbo", "ACE-Step/acestep-v15-xl-turbo", 19.95),
    "xl_base":  ("acestep-v15-xl-base",  "ACE-Step/acestep-v15-xl-base",  19.95),
    "sft":      ("acestep-v15-sft",      "ACE-Step/acestep-v15-sft",       4.79),
    "base":     ("acestep-v15-base",     "ACE-Step/acestep-v15-base",      4.79),
    "turbo":    ("acestep-v15-turbo",    BASE_REPO,                        4.79),
}

#: What preprocessing and training actually load. The 3.7 GB LM planner
#: (acestep-5Hz-lm-1.7B) is an inference component and is deliberately absent.
TRAINING_PATTERNS = ["vae/*", "Qwen3-Embedding-0.6B/*", "config.json", "README.md"]
INFERENCE_EXTRA_PATTERNS = ["acestep-5Hz-lm-1.7B/*", "acestep-v15-turbo/*"]

#: Imported by ACE-Step's training path (or by the XL checkpoints' remote code)
#: and NOT present in ComfyUI's own requirements.txt.
REQUIRED_PACKAGES = [
    "diffusers",                 # acestep.training_v2 model loading
    "lightning",                 # Fabric, drives the training loop
    "loguru",                    # acestep logs through it everywhere
    "peft",                      # LoRA injection and adapter saving
    "rich",                      # the trainer CLI's output layer
    "soundfile",                 # audio decode, and the pack's shim prefers it
    "vector_quantize_pytorch",   # imported by the XL checkpoints' remote code
    "einx",                      # \
    "frozendict",                #  > vector_quantize_pytorch's own chain
    "torch-einops-utils",        # /
]

RECOMMENDED_PACKAGES = [
    "tensorboard",               # loss curves; training works without it
]

OPTIONAL_PACKAGES = {
    "adamw8bit": ["bitsandbytes"],
    "prodigy":   ["prodigyopt"],
    "lokr":      ["lycoris-lora"],
}

CPU_INDEX = "https://download.pytorch.org/whl/cpu"

IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

class Out:
    def __init__(self, color: bool = True):
        self.color = color and sys.stdout.isatty() and not IS_WINDOWS
        self.problems: List[str] = []

    def _c(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def rule(self, title: str = "") -> None:
        print()
        print(self._c("1;36", f"── {title} " + "─" * max(0, 68 - len(title))))

    def step(self, text: str) -> None:
        print(self._c("1", f"  {text}"))

    def ok(self, text: str) -> None:
        print(f"  {self._c('32', 'ok')}    {text}")

    def info(self, text: str) -> None:
        print(f"        {text}")

    def warn(self, text: str) -> None:
        print(f"  {self._c('33', 'warn')}  {text}")
        self.problems.append(text)

    def fail(self, text: str) -> "SystemExit":
        print(f"  {self._c('31', 'FAIL')}  {text}", file=sys.stderr)
        return SystemExit(1)


OUT = Out()


def run(cmd: Sequence[str], *, dry: bool, cwd: Optional[Path] = None,
        check: bool = True) -> int:
    """Echo a command, then run it unless this is a dry run."""
    printable = " ".join(str(c) for c in cmd)
    print(f"        $ {printable}")
    if dry:
        return 0
    result = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None)
    if check and result.returncode != 0:
        raise OUT.fail(f"command failed with exit code {result.returncode}")
    return result.returncode


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def find_comfyui(explicit: Optional[str]) -> Path:
    """Locate the ComfyUI root, from --comfyui or by walking up from here."""
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not (root / "folder_paths.py").is_file():
            raise OUT.fail(f"{root} does not look like ComfyUI (no folder_paths.py)")
        return root

    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "folder_paths.py").is_file():
            return parent
    for candidate in (Path.cwd(), *Path.cwd().parents):
        if (candidate / "folder_paths.py").is_file():
            return candidate
    raise OUT.fail(
        "could not find ComfyUI. Run this from inside the ComfyUI tree, or "
        "pass --comfyui /path/to/ComfyUI"
    )


def find_python(comfy: Path, explicit: Optional[str]) -> Path:
    """Find the interpreter ComfyUI actually runs on.

    NEVER call .resolve() on the result. A venv's ``bin/python`` is a symlink
    to the base interpreter, and Python decides whether it is running inside a
    venv by looking for ``pyvenv.cfg`` next to the executable it was INVOKED
    as. Resolve the symlink and you get the base interpreter, which cannot see
    the venv's site-packages — so torch and everything else "disappears".
    ``absolute()`` normalises the path without following links.
    """
    if explicit:
        exe = Path(explicit).expanduser().absolute()
        if not exe.is_file():
            raise OUT.fail(f"{exe} is not a file")
        return exe

    names = ("python.exe",) if IS_WINDOWS else ("python", "python3")
    subdir = "Scripts" if IS_WINDOWS else "bin"
    for venv in (".venv", "venv", "../python_embeded"):
        for name in names:
            exe = (comfy / venv / subdir / name).absolute()
            if exe.is_file():
                return exe
            flat = (comfy / venv / name).absolute()    # python_embeded layout
            if flat.is_file():
                return flat
    OUT.warn("no venv found next to ComfyUI — falling back to this interpreter. "
             "If ComfyUI runs on a different one, pass --python")
    return Path(sys.executable)


def in_virtualenv(exe: Path) -> bool:
    """True when this interpreter path sits inside a venv layout."""
    return (exe.parent.parent / "pyvenv.cfg").is_file()


def probe_torch(python: Path) -> Dict[str, object]:
    """Ask the target interpreter what PyTorch it has."""
    snippet = (
        "import json\n"
        "try:\n"
        "    import torch\n"
        "    v = getattr(torch, 'version', None)\n"
        "    out = {'ok': True, 'version': torch.__version__,\n"
        "           'cuda': getattr(v, 'cuda', None), 'hip': getattr(v, 'hip', None),\n"
        "           'xpu': getattr(v, 'xpu', None)}\n"
        "except Exception as exc:\n"
        "    out = {'ok': False, 'error': str(exc)}\n"
        "try:\n"
        "    import importlib.util as u\n"
        "    out['pip'] = u.find_spec('pip') is not None\n"
        "    out['hf'] = u.find_spec('huggingface_hub') is not None\n"
        "except Exception:\n"
        "    out['pip'] = False; out['hf'] = False\n"
        "print(json.dumps(out))\n"
    )
    try:
        res = subprocess.run([str(python), "-c", snippet],
                             capture_output=True, text=True, timeout=180)
        return json.loads(res.stdout.strip().splitlines()[-1])
    except Exception as exc:
        raise OUT.fail(f"could not run {python}: {exc}")


def torch_backend(info: Dict[str, object]) -> str:
    if info.get("hip"):
        return "rocm"
    if info.get("cuda"):
        return "cuda"
    if info.get("xpu"):
        return "xpu"
    return "cpu"


# ---------------------------------------------------------------------------
# Package installation
# ---------------------------------------------------------------------------

def installer_prefix(python: Path, has_pip: bool) -> Tuple[List[str], bool]:
    """pip when the venv has it, otherwise uv — uv-made venvs often have no pip.

    Returns ``(argv_prefix, is_uv)``. The flag matters because the two spell
    "replace what is already there" differently.
    """
    if has_pip:
        return [str(python), "-m", "pip", "install"], False
    uv = python.parent / ("uv.exe" if IS_WINDOWS else "uv")
    uv_path = str(uv) if uv.is_file() else shutil.which("uv")
    if not uv_path:
        raise OUT.fail(
            f"{python} has no pip and no uv was found. Install pip into that "
            "environment, or put uv on PATH."
        )
    return [uv_path, "pip", "install", "--python", str(python)], True


def write_constraints(python: Path, tmpdir: Path) -> Optional[Path]:
    """Pin the torch stack so no dependency resolver can swap it out."""
    snippet = (
        "import json\n"
        "out = {}\n"
        "for name in ('torch', 'torchvision', 'torchaudio'):\n"
        "    try:\n"
        "        import importlib.metadata as md\n"
        "        out[name] = md.version(name)\n"
        "    except Exception:\n"
        "        pass\n"
        "print(json.dumps(out))\n"
    )
    res = subprocess.run([str(python), "-c", snippet], capture_output=True,
                         text=True, timeout=120)
    try:
        pins = json.loads(res.stdout.strip().splitlines()[-1])
    except Exception:
        return None
    if not pins:
        return None
    path = tmpdir / "nova-torch-constraints.txt"
    path.write_text("".join(f"{k}=={v}\n" for k, v in pins.items()), encoding="utf-8")
    OUT.info("pinned so they cannot be replaced: "
             + ", ".join(f"{k}=={v}" for k, v in pins.items()))
    return path


def install_packages(prefix: List[str], packages: List[str],
                     constraints: Optional[Path], dry: bool) -> None:
    if not packages:
        return
    cmd = list(prefix)
    if constraints:
        cmd += ["--constraint", str(constraints)]
    cmd += packages
    run(cmd, dry=dry)


def missing_packages(python: Path, packages: List[str]) -> List[str]:
    """Which of these cannot be imported by the target interpreter."""
    # distribution name -> import name, where they differ
    import_name = {
        "torch-einops-utils": "torch_einops_utils",
        "vector_quantize_pytorch": "vector_quantize_pytorch",
        "lycoris-lora": "lycoris",
        "tensorboard": "tensorboard",
    }
    probe = {p: import_name.get(p, p.replace("-", "_")) for p in packages}
    snippet = (
        "import json, importlib.util as u\n"
        f"probe = {probe!r}\n"
        "print(json.dumps([d for d, m in probe.items() "
        "if u.find_spec(m) is None]))\n"
    )
    res = subprocess.run([str(python), "-c", snippet], capture_output=True,
                         text=True, timeout=180)
    try:
        return json.loads(res.stdout.strip().splitlines()[-1])
    except Exception:
        return packages


def torchcodec_state(python: Path) -> str:
    """'ok', 'absent', or 'broken' — a wheel built for the wrong backend."""
    snippet = (
        "try:\n"
        "    from torchcodec.decoders import AudioDecoder\n"
        "    print('ok')\n"
        "except ImportError:\n"
        "    print('absent')\n"
        "except Exception:\n"
        "    print('broken')\n"
    )
    res = subprocess.run([str(python), "-c", snippet], capture_output=True,
                         text=True, timeout=180)
    return (res.stdout.strip().splitlines() or ["broken"])[-1]


# ---------------------------------------------------------------------------
# Checkpoint tree
# ---------------------------------------------------------------------------

def safetensors_keys(path: Path) -> Optional[List[str]]:
    """Read a .safetensors header without loading the tensors.

    Layout is an 8-byte little-endian header length, then that many bytes of
    JSON. A 10 GB file costs a couple of hundred kilobytes to inspect.
    """
    try:
        with open(path, "rb") as handle:
            length = int.from_bytes(handle.read(8), "little")
            if not 0 < length < 200_000_000:
                return None
            header = json.loads(handle.read(length).decode("utf-8"))
        return sorted(k for k in header if k != "__metadata__")
    except Exception:
        return None


def hf_index_keys(repo: str) -> Optional[List[str]]:
    """Tensor names the Hugging Face repo's shard index declares."""
    import urllib.request
    url = f"https://huggingface.co/{repo}/resolve/main/model.safetensors.index.json"
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
        return sorted(data.get("weight_map", {}))
    except Exception:
        return None


def _squash(text: str) -> str:
    """Lowercase, drop separators: acestep_v1.5_xl_sft == acestep-v15-xl-sft."""
    return "".join(c for c in text.lower() if c.isalnum())


def find_existing_weights(comfy: Path, subdir: str) -> List[Path]:
    """ACE-Step weights ComfyUI may already hold FOR THIS VARIANT.

    Matching is on the whole variant directory name, squashed. A looser test
    on the suffix alone makes ``acestep_v1.5_xl_sft_bf16.safetensors`` look
    like a match for the non-XL ``sft`` variant, which would link a 4B model
    in where a 2B one belongs.

    ``aio`` files are skipped: those are all-in-one bundles carrying the VAE
    and text encoder too, not a bare DIT checkpoint.
    """
    want = _squash(subdir)
    hits: List[Path] = []
    for folder in ("models/diffusion_models", "models/checkpoints", "models/unet"):
        base = comfy / folder
        if not base.is_dir():
            continue
        for item in sorted(base.glob("*.safetensors")):
            name = _squash(item.stem)
            if want in name and "aio" not in name:
                hits.append(item)
    return hits


def link_or_copy(source: Path, target: Path, dry: bool) -> bool:
    """Prefer a relative symlink; fall back to a copy where links are refused."""
    if dry:
        OUT.info(f"would link {target.name} -> {source}")
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        target.unlink()
    try:
        relative = os.path.relpath(source, target.parent)
        target.symlink_to(relative)
        OUT.ok(f"linked {target.name} -> {relative}")
        return True
    except OSError as exc:
        OUT.warn(f"symlink refused ({exc}); copying {human(source.stat().st_size)} instead"
                 + (" — enable Developer Mode on Windows to avoid this" if IS_WINDOWS else ""))
        try:
            shutil.copy2(source, target)
            OUT.ok(f"copied {target.name}")
            return True
        except OSError as copy_exc:
            OUT.warn(f"copy failed too ({copy_exc})")
            return False


def hf_download(python: Path, repo: str, dest: Path, patterns: Optional[List[str]],
                dry: bool) -> None:
    """snapshot_download inside the target interpreter, so its cache is used."""
    snippet = (
        "import sys\n"
        "from huggingface_hub import snapshot_download\n"
        "repo, dest = sys.argv[1], sys.argv[2]\n"
        "allow = sys.argv[3:] or None\n"
        "snapshot_download(repo_id=repo, local_dir=dest, allow_patterns=allow,\n"
        "                  max_workers=4)\n"
    )
    cmd = [str(python), "-c", snippet, repo, str(dest)] + (patterns or [])
    print(f"        $ {python} -c '<snapshot_download>' {repo} -> {dest}")
    if patterns:
        OUT.info("only: " + ", ".join(patterns))
    if dry:
        return
    result = subprocess.run([str(c) for c in cmd])
    if result.returncode != 0:
        raise OUT.fail(f"download of {repo} failed")


# ---------------------------------------------------------------------------
# Verification — using the node pack's own checks
# ---------------------------------------------------------------------------

VERIFY_SNIPPET = r"""
import json, sys, importlib.util
pack, ckpt, variant = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, pack)
spec = importlib.util.spec_from_file_location(
    "nova_ace_common", pack + "/training/nova_ace_common.py")
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except Exception as exc:
    print(json.dumps({"error": "could not load the pack's checks: %s" % exc}))
    raise SystemExit(0)
print(json.dumps({
    "tree": mod.check_checkpoint_tree(ckpt, variant),
    "imports": mod.check_remote_code_imports(ckpt, variant),
}))
"""


def verify(python: Path, pack: Path, ckpt: Path, variant: str) -> Dict[str, object]:
    res = subprocess.run(
        [str(python), "-c", VERIFY_SNIPPET, str(pack), str(ckpt), variant],
        capture_output=True, text=True, timeout=180)
    try:
        return json.loads(res.stdout.strip().splitlines()[-1])
    except Exception:
        return {"error": (res.stderr or res.stdout).strip()[:400] or "no output"}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="nova_ace_setup.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Set up everything Nova ACE LoRA training needs.",
        epilog=textwrap.dedent("""\
            examples:
              python nova_ace_setup.py --dry-run
              python nova_ace_setup.py --variant xl_sft
              python nova_ace_setup.py --comfyui ~/ComfyUI --extras adamw8bit --yes
        """))
    p.add_argument("--comfyui", help="ComfyUI root (default: found from this script)")
    p.add_argument("--python", help="ComfyUI's interpreter (default: its venv)")
    p.add_argument("--variant", default="xl_sft", choices=sorted(VARIANTS),
                   help="checkpoint to set up (default: xl_sft)")
    p.add_argument("--checkpoint-dir", help="default: <comfyui>/models/acestep")
    p.add_argument("--acestep-dir", help="default: <checkpoint-dir>/ACE-Step-1.5")
    p.add_argument("--extras", default="",
                   help="comma-separated: " + ", ".join(OPTIONAL_PACKAGES))
    p.add_argument("--with-inference", action="store_true",
                   help="also fetch the LM planner and turbo variant (+~8 GB)")
    p.add_argument("--no-reuse", action="store_true",
                   help="always download weights, never reuse ComfyUI's copy")
    p.add_argument("--skip-packages", action="store_true")
    p.add_argument("--skip-clone", action="store_true")
    p.add_argument("--skip-models", action="store_true")
    p.add_argument("--yes", "-y", action="store_true", help="do not ask")
    p.add_argument("--dry-run", action="store_true",
                   help="print the plan and change nothing")
    p.add_argument("--no-color", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    global OUT
    OUT = Out(color=not args.no_color)
    dry = args.dry_run

    print(f"Nova ACE LoRA training setup v{VERSION}")
    print(f"{platform.system()} {platform.machine()}, driver script on Python "
          f"{sys.version_info.major}.{sys.version_info.minor}")
    if dry:
        print("DRY RUN — nothing will be installed, downloaded or written.")

    # -- 1. Discovery -------------------------------------------------------
    OUT.rule("environment")
    comfy = find_comfyui(args.comfyui)
    OUT.ok(f"ComfyUI            {comfy}")

    python = find_python(comfy, args.python)
    OUT.ok(f"interpreter        {python}"
           + ("  (venv)" if in_virtualenv(python) else ""))

    info = probe_torch(python)
    if not info.get("ok"):
        hint = ("Point --python at the environment ComfyUI actually runs on, "
                "e.g. --python " + str(comfy / ".venv" / "bin" / "python"))
        if not in_virtualenv(python):
            hint += ("\n        Note: give the venv's own bin/python, not the "
                     "interpreter it links to — a resolved symlink loses the venv.")
        raise OUT.fail(
            f"that interpreter cannot import torch ({info.get('error')}).\n"
            f"        {hint}")
    backend = torch_backend(info)
    OUT.ok(f"torch              {info['version']}  [{backend}]")

    pack = comfy / "custom_nodes" / "comfyui-novaaudioplayer"
    if (pack / "training" / "nova_ace_common.py").is_file():
        OUT.ok(f"Nova pack          {pack}")
    else:
        OUT.warn(f"Nova pack not found at {pack} — verification will be skipped")
        pack = None

    ckpt = Path(args.checkpoint_dir).expanduser().resolve() if args.checkpoint_dir \
        else (comfy / "models" / "acestep")
    acestep = Path(args.acestep_dir).expanduser().resolve() if args.acestep_dir \
        else (ckpt / "ACE-Step-1.5")
    subdir, repo, size_gb = VARIANTS[args.variant]
    in_base_repo = repo == BASE_REPO

    OUT.info("")
    OUT.info(f"checkpoint tree    {ckpt}")
    OUT.info(f"ACE-Step clone     {acestep}")
    OUT.info(f"variant            {args.variant} -> {subdir}/  (from {repo})")

    # -- 2. Plan ------------------------------------------------------------
    OUT.rule("plan")
    extras: List[str] = []
    for key in (e.strip() for e in args.extras.split(",") if e.strip()):
        if key not in OPTIONAL_PACKAGES:
            raise OUT.fail(f"unknown --extras value {key!r}; choose from "
                           + ", ".join(OPTIONAL_PACKAGES))
        extras += OPTIONAL_PACKAGES[key]

    wanted = REQUIRED_PACKAGES + RECOMMENDED_PACKAGES + extras
    to_install = [] if args.skip_packages else missing_packages(python, wanted)
    codec = torchcodec_state(python)

    variant_dir = ckpt / subdir
    have_weights = ((variant_dir / "model.safetensors").exists()
                    or bool(list(variant_dir.glob("model-*-of-*.safetensors"))))

    reuse: Optional[Path] = None
    if not have_weights and not args.no_reuse and not args.skip_models:
        candidates = find_existing_weights(comfy, subdir)
        if candidates:
            reuse = candidates[0]

    print(f"  packages to install    {len(to_install)}"
          + (": " + ", ".join(to_install) if to_install else " (all present)"))
    codec_action = {
        "ok": "",
        "absent": f"  -> will install ({'PyPI' if backend == 'cuda' else '+cpu build'})",
        "broken": f"  -> built for the wrong backend, will replace with the +cpu build",
    }[codec]
    print(f"  torchcodec             {codec}{codec_action}")
    print(f"  ACE-Step clone         "
          + ("present, will pull" if (acestep / '.git').is_dir() else "will clone"))
    base_size = "~1.6 GB" if not args.with_inference else "~9.6 GB"
    print(f"  base checkpoint files  {base_size}  (vae + text encoder"
          + (", LM planner, turbo" if args.with_inference else "") + ")")
    if have_weights:
        print(f"  {subdir:<22} weights already in place — nothing to fetch")
    elif reuse:
        print(f"  {subdir}/model.safetensors")
        print(f"                         reuse {reuse.name} "
              f"({human(reuse.stat().st_size)}) if its tensor names match the")
        print(f"                         repo index — saves a ~{size_gb:.0f} GB download")
    elif in_base_repo and args.with_inference:
        print(f"  {subdir:<22} already covered by the base files above")
    else:
        print(f"  {subdir:<22} ~{size_gb:.0f} GB from {repo}")

    if not dry and not args.yes:
        print()
        answer = input("  Proceed? [Y/n] ").strip().lower()
        if answer not in ("", "y", "yes"):
            print("  Aborted.")
            return 0

    tmpdir = Path(tempfile.mkdtemp(prefix="nova-ace-setup-"))
    try:
        # -- 3. Packages ----------------------------------------------------
        if not args.skip_packages:
            OUT.rule("python packages")
            if not to_install and codec != "broken":
                OUT.ok("nothing to install")
            else:
                prefix, is_uv = installer_prefix(python, bool(info.get("pip")))
                OUT.info("installer: " + ("uv" if is_uv else "pip"))
                constraints = write_constraints(python, tmpdir)
                if not constraints:
                    OUT.warn("could not pin the torch stack — check the resolver's "
                             "output before letting it replace anything")
                install_packages(prefix, to_install, constraints, dry)

                if codec != "ok":
                    if codec == "broken":
                        OUT.step(f"torchcodec cannot load against this {backend} torch")
                        OUT.info("the wheel on PyPI is built for CUDA; the +cpu "
                                 "build links only against libtorch and libc10")
                    else:
                        OUT.step("torchcodec is absent — torchaudio >= 2.9 decodes "
                                 "through it and cannot decode without it")
                    cmd = prefix + ["--no-deps"]
                    if codec == "broken":
                        cmd.append("--reinstall" if is_uv else "--force-reinstall")
                    if backend != "cuda":
                        # The CUDA wheel cannot load against ROCm, XPU or CPU
                        # PyTorch. The +cpu build links only against libtorch
                        # and libc10, which every build provides. Decoding is
                        # CPU work either way.
                        cmd += ["--index-url", CPU_INDEX]
                    run(cmd + ["torchcodec"], dry=dry)

        # -- 4. ACE-Step ----------------------------------------------------
        if not args.skip_clone:
            OUT.rule("ACE-Step 1.5")
            if not shutil.which("git"):
                raise OUT.fail("git is not on PATH — install it, or clone "
                               f"{ACESTEP_REPO} manually to {acestep}")
            if (acestep / ".git").is_dir():
                OUT.step("already cloned — pulling")
                run(["git", "pull", "--ff-only"], dry=dry, cwd=acestep, check=False)
            else:
                acestep.parent.mkdir(parents=True, exist_ok=True)
                run(["git", "clone", "--depth", "1", ACESTEP_REPO, str(acestep)],
                    dry=dry)
            OUT.info("its requirements.txt pins torch==2.10.0+cu128 — do NOT "
                     "install it; this script installs only what training needs")

        # -- 5. Checkpoints -------------------------------------------------
        if not args.skip_models:
            OUT.rule("checkpoint tree")
            if not info.get("hf"):
                OUT.step("installing huggingface_hub (needed to fetch the models)")
                prefix, _ = installer_prefix(python, bool(info.get("pip")))
                install_packages(prefix, ["huggingface_hub"],
                                 write_constraints(python, tmpdir), dry)

            patterns = list(TRAINING_PATTERNS)
            if args.with_inference:
                patterns += INFERENCE_EXTRA_PATTERNS
            OUT.step(f"base files from {BASE_REPO}")
            hf_download(python, BASE_REPO, ckpt, patterns, dry)

            target_dir = ckpt / subdir
            weights = target_dir / "model.safetensors"
            sharded = list(target_dir.glob("model-*-of-*.safetensors"))
            present = weights.exists() or bool(sharded)

            if reuse and in_base_repo:
                OUT.info(f"{subdir} is a subfolder of the base repo and is not "
                         "sharded — fetching it directly rather than linking")
                reuse = None

            if reuse and not present:
                OUT.step(f"reusing {reuse.name} instead of downloading "
                         f"~{size_gb:.0f} GB")
                OUT.info("verifying it is the same model, by tensor names")
                local = safetensors_keys(reuse)
                remote = hf_index_keys(repo)
                if local and remote:
                    if local == remote:
                        OUT.ok(f"tensor names match exactly ({len(local)} tensors)")
                    else:
                        OUT.warn(f"tensor names differ (local {len(local)}, "
                                 f"repo {len(remote)}) — downloading instead")
                        reuse = None
                elif local:
                    OUT.warn("could not reach the repo index to compare; linking "
                             f"anyway ({len(local)} tensors found locally)")
                else:
                    OUT.warn("could not read that file's header — downloading instead")
                    reuse = None

                if reuse:
                    # The small files are still needed: config, remote code,
                    # silence_latent. About 4 MB in total.
                    hf_download(python, repo, target_dir,
                                ["*.py", "*.json", "silence_latent.pt", "README.md"],
                                dry)
                    if not link_or_copy(reuse, weights, dry):
                        reuse = None

            if present:
                kind = "sharded" if sharded else (
                    "symlinked" if weights.is_symlink() else "a file")
                OUT.ok(f"{subdir} weights already present ({kind})")
            elif not reuse:
                OUT.step(f"downloading {subdir} from {repo} (~{size_gb:.0f} GB)")
                if in_base_repo:
                    # A subfolder of the base repo: fetch by pattern into the
                    # tree root, or the whole repo lands inside target_dir.
                    hf_download(python, repo, ckpt, [f"{subdir}/*"], dry)
                else:
                    hf_download(python, repo, target_dir, None, dry)

        # -- 6. Verify ------------------------------------------------------
        OUT.rule("verification")
        if dry:
            OUT.info("skipped — dry run")
        elif pack is None:
            OUT.info("skipped — the Nova pack was not found")
        else:
            result = verify(python, pack, ckpt, args.variant)
            if "error" in result:
                OUT.warn(f"could not run the pack's checks: {result['error']}")
            else:
                tree = result.get("tree") or []
                imports = result.get("imports") or []
                if tree:
                    OUT.warn("checkpoint tree is missing: " + ", ".join(tree))
                else:
                    OUT.ok("checkpoint tree complete (checked by the node's own code)")
                if imports:
                    OUT.warn("the checkpoint's remote code still needs: "
                             + ", ".join(imports))
                else:
                    OUT.ok("every package the checkpoint's remote code imports is present")

            codec_after = torchcodec_state(python)
            if codec_after == "broken":
                OUT.warn("torchcodec still cannot load — the node's decode shim "
                         "will cover it, but the permanent fix is the +cpu wheel")
            else:
                OUT.ok(f"audio decoding: torchcodec {codec_after}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # -- 7. What to type into the nodes ------------------------------------
    OUT.rule("paths for the nodes")
    print(textwrap.dedent(f"""\
          B  checkpoint_dir      {ckpt}
          C  acestep_repo_path   {acestep}

          Fill B and C on BOTH Nova ACE Preprocess and Nova ACE LoRA Trainer.
          The trainer runs as a separate process and does not inherit paths
          another node added, so C must be set on it too.

          Still yours to choose:
          A  folder of tagged masters  -> Nova Batch Load Audio . folder_path
          D  dataset JSON to write     -> Nova ACE Dataset Builder . dataset_json_path
          E  tensor output folder      -> Nova ACE Preprocess . output_dir
          F  training output folder    -> Nova ACE LoRA Trainer . output_dir

          Keep D, E and F apart — in particular F must not be E.
          Set variant = {args.variant} on both Preprocess and the Trainer."""))

    OUT.rule("")
    if OUT.problems:
        print(f"  Finished with {len(OUT.problems)} thing(s) to look at:")
        for problem in OUT.problems:
            print(f"    - {problem}")
    else:
        print("  Done. Restart ComfyUI, then build the graph from the user guide.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
