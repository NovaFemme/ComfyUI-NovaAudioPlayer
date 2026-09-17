"""
install.py — run once when this pack is installed or updated.

ComfyUI-Manager executes a custom node's ``install.py`` with ComfyUI's own
interpreter after installing or updating it. That is the packaging hook the
Comfy Registry standards point to when they say dependency installation
belongs in "the package/dependency installation mechanism" rather than in node
runtime: this runs while the pack is being installed, not while a workflow is
executing.

WHAT IT DOES
------------
Installs the Python packages the LoRA training nodes need and cannot get from
ComfyUI's own requirements.txt, and replaces torchcodec when the installed
wheel was built for a different compute backend.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
* It does not download models. The checkpoints are ~21 GB and an install that
  quietly pulls that is hostile. Run ``training/nova_ace_setup.py`` when you
  actually want them.
* It does not clone ACE-Step.
* It does not touch PyTorch. Every install is pinned against the torch already
  present, so nothing can decide your ROCm or CPU build is wrong.
* It never fails the install. The other 24 nodes in this pack have nothing to
  do with LoRA training and must stay usable, so a problem here is reported
  loudly and the exit status stays 0.

Everything it does can be done by hand — see training/USER_GUIDE.md.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SETUP = HERE / "training" / "nova_ace_setup.py"

BANNER = "=" * 72


def main() -> int:
    print(BANNER)
    print("  ComfyUI-NovaAudioPlayer — LoRA training dependencies")
    print(BANNER)

    if not SETUP.is_file():
        print(f"  {SETUP} is missing; skipping.")
        print("  The pack still works — only the 🎓 LoRA Training nodes need it.")
        return 0

    # Hand off to the setup script, which already knows how to find ComfyUI,
    # detect the compute backend, pin torch and choose pip or uv. Models and
    # the ACE-Step clone are explicitly skipped: see the module docstring.
    argv = [
        sys.executable, str(SETUP),
        "--skip-models",
        "--skip-clone",
        "--yes",
        "--no-color",
    ]
    print("  $ " + " ".join(argv))
    print()

    try:
        code = subprocess.call(argv, cwd=str(HERE))
    except Exception as exc:                       # pragma: no cover
        print(f"\n  Could not run the setup script: {exc}")
        code = 1

    print()
    print(BANNER)
    if code == 0:
        print("  Done. For the models and the ACE-Step clone, run:")
        print(f"      {sys.executable} {SETUP}")
    else:
        print("  Dependency setup did not complete.")
        print("  This does NOT break the pack — only the 🎓 LoRA Training nodes")
        print("  need these packages, and each one reports exactly what is")
        print("  missing when you run it. To retry:")
        print(f"      {sys.executable} {SETUP} --skip-models --skip-clone")
    print(BANNER)

    # Always 0: a failure here must not mark the whole pack as failed to
    # install. The nodes that need these packages say so themselves.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
