# Nova ACE Setup Check

Answers one question before you queue anything expensive: **is this machine
ready to preprocess and train?**

It reports. It never installs, downloads or spawns a process — every check is an
import probe or a look at the filesystem, run inside ComfyUI's own interpreter,
which is the only one whose answers matter. When something is missing it prints
the command you would run yourself.

## Why bother, when Preprocess and the Trainer already check

Those two check the parts they need, at the moment they need them — and the
expensive parts happen first. Upstream's own remote-code import check fires
inside Pass 2, after Pass 1 has already spent GPU time encoding every file in
your dataset. This node asks the same questions in a second, before any of that,
and adds the ones the other nodes never ask: which compute backend torch was
built for, whether the GPU is visible at all, whether `tensorboard` is there to
give you a loss curve, whether the optimizer you chose is even installed.

Two of the checks call the *same functions* the other nodes call, so a green
result here means those nodes will not stop on the same grounds.

## Inputs

| Widget | Purpose |
|---|---|
| `checkpoint_dir` | The HuggingFace checkpoint tree. Leave it empty to check everything except the tree. |
| `variant` | Which variant to look for — match what you will train. |
| `acestep_repo_path` | Optional. Checked for importability. |

## Outputs

`ready` (BOOLEAN) and `console` (STRING). Wire `console` into **Nova Console**.

`ready` is true only when nothing would stop a run. Advisory items — no
tensorboard, no `checkpoint_dir` given — do not clear it.

## Reading the report

**ENVIRONMENT** — the interpreter, the platform, torch's version and backend
(`cuda`, `rocm` or `cpu`), and the GPU with its VRAM. If torch will not import
at all, everything else is moot and the report says so.

**ACE-STEP** — whether `acestep` is importable, and from where. A warning here
is worth reading even when it is importable: the **Trainer runs as a separate
process** and does not inherit a `sys.path` entry another node added, so
`acestep_repo_path` has to be set on the Trainer too.

**CHECKPOINT TREE** — the same `check_checkpoint_tree` the Preprocess node uses,
then the same `check_remote_code_imports`. The second one matters for the XL
checkpoints, which load through `trust_remote_code`: transformers executes the
`modeling_*.py` shipped inside the checkpoint folder, and that file imports
packages ComfyUI does not ship.

**AUDIO** — whether torchcodec loads. `torchaudio` 2.9+ decodes through it and
cannot decode without it. A torchcodec built for the wrong backend is not fatal
— Nova's decode shim covers it with soundfile → PyAV — and the report says so
rather than alarming you. It only becomes blocking if soundfile *and* PyAV are
missing too.

**TRAINING PACKAGES** — the six ACE-Step's training path imports that ComfyUI
does not provide, each with what breaks without it.

**OPTIONAL** — `tensorboard` (loss curves), `bitsandbytes` (`adamw8bit`),
`prodigyopt` (`prodigy`). Absent is fine; you just lose that one thing.

## The install line

Anything missing is collected into a single command, using `pip` or `uv`
depending on what your environment actually has — a uv-made venv, the common
ComfyUI layout now, has no `pip` inside it at all.

`--no-deps` is deliberate. It keeps the resolver from deciding your torch build
is wrong and replacing it, which is how a working ROCm or CUDA install gets
turned into a broken CPU one.

**Packages ComfyUI itself ships are never suggested.** If `torch`,
`transformers`, `einops` or the like show up as missing, that is a broken
ComfyUI install or the wrong interpreter, and the report says so instead —
`pip install --no-deps torch` would drop a generic wheel over your CUDA or ROCm
build and make things considerably worse.

## Fixing things

This node only tells you. Two things fix:

- `install.py` at the pack root — run for you when the pack is installed or
  updated through ComfyUI-Manager. Packages only; it deliberately does not
  download the ~21 GB of models.
- `training/nova_ace_setup.py` — run once, by you, from a terminal. Does the
  packages, clones ACE-Step, builds the checkpoint tree, and ends by running
  these same checks against what it built.

Restart ComfyUI after installing anything, then queue this node again.

## Notes

- `IS_CHANGED` returns NaN on purpose. The environment can change under a saved
  workflow, so this must never be served from cache.
- It is safe to leave in a graph. It reads nothing expensive and touches no GPU.
