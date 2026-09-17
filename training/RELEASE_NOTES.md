# Nova ACE LoRA Trainer — release notes for the Registry build

For the agent preparing `comfyui-novaaudioplayer` for the Comfy Registry.

**Scope.** This covers the five nodes in `training/`, plus `install.py`, the
`web/docs/` documentation tree, the Nova Console slot fix, the report-capture
feature (§13), the removal of `NovaReportsImages` (§14), and the Nova Track
Inspector's provisional layer and profile store (§15). The pack registers 28 nodes for release;
the rest are outside what this document vouches for, and nothing here should be
read as a review of them. Section 9 lists what the release build will trip over
regardless.

**State at time of writing.** `pyproject.toml` version `2.6.0`, publisher
`novafemme`, repo `NovaFemme/ComfyUI-NovaAudioPlayer`, branch `nova-suite`, last
commit `9cc59f1`. **The working tree is not clean** — see §10 for exactly what is
uncommitted and what must not ship.

**Changes since the previous revision of this document**

| Item | Was | Now |
|---|---|---|
| `web/docs/NovaACELoRATrainer/en.md` | MISSING — release blocker | written |
| `web/docs/NovaACESetupCheck/en.md` | MISSING — release blocker | written |
| Authoring-group help pages (6) | absent | written, with screenshots |
| `nova_categories.ALL_CATEGORIES` | omitted `REPORT` | fixed, all seven present |
| Nova Console auto-connect | linked to `label`, broke graphs | fixed, scoped to one node type |
| Subprocess decision (§3) | needs a human | **still needs a human** |
| `pyproject.toml` description + version | stale | 2.6.0, description corrected |
| Report images | a PIL node that could not match the viewer | replaced by browser capture (§13) |
| Report capture build | black exports, empty Lyric export | `v9 iframe-aware`, all five modes verified |
| `NovaReportsImages` | registered | **removed** (§14), help page removed with it |
| Track Inspector scoring | unproven heuristics with veto power | evidence-tiered (§15) |
| Registered node count | 30 counted, 29 claimed | **28**, and the description agrees |
| Node doc coverage | 8 of 28 | **28 of 28 — complete** |
| Scratch directory | `_to_delete/`, unignored | moved to `.trash/`, both ignored |

---

## 1. What ships

`training/` — seven files, no frontend assets. Plus `install.py` at the pack
root (see §3, §4).

| File | Lines | Contains |
|---|---|---|
| `__init__.py` | 34 | group registration only |
| `nova_ace_common.py` | 279 | categories, `VARIANT_DIRS`, `check_checkpoint_tree`, `check_remote_code_imports`, `install_command`, `describe_*` helpers |
| `nova_ace_dataset.py` | 371 | `NovaACEDatasetBuilder`, `NovaACEDatasetReview` |
| `nova_ace_preprocess.py` | 254 | `NovaACEPreprocess` |
| `nova_ace_train.py` | 878 | `NovaACELoRATrainer` |
| `nova_ace_check.py` | 350 | `NovaACESetupCheck` |
| `nova_ace_audio_shim.py` | 244 | conditional torchcodec fallback (not a node) |
| `nova_ace_setup.py` | 836 | standalone setup script (not imported by anything) |
| `install.py` (pack root) | 91 | ComfyUI-Manager install hook; delegates to `nova_ace_setup.py` |

Plus documentation, which is shipped content and must be included in the
published package:

| Path | Size | Contains |
|---|---|---|
| `web/docs/<NodeName>/en.md` × 23 | ~120 KB | per-node help pages |
| `web/docs/images/` | 572 KB | four shared screenshots + a `README.md` explaining the path rule |

Registered keys — these are the identifiers saved workflows resolve against and
**must not change**:

```
NovaACEDatasetBuilder   Nova ACE Dataset Builder 🧱
NovaACEDatasetReview    Nova ACE Dataset Review 🔍
NovaACEPreprocess       Nova ACE Preprocess 🧮
NovaACELoRATrainer      Nova ACE LoRA Trainer 🎓
NovaACESetupCheck       Nova ACE Setup Check 🩺
```

All five sit under `▶️ Nova Audio/🎓 LoRA Training`, sourced from
`nova_categories.TRAINING`. No `CATEGORY` string is hardcoded in `training/`.

### `NovaACELoRATrainer` node contract

`OUTPUT_NODE = True`. `IS_CHANGED` returns `float("nan")` — a training run is
never a cache hit, by design.

```
RETURN_TYPES = ("STRING", "STRING", "INT",      "STRING")
RETURN_NAMES = ("lora_dir", "output_dir", "exit_code", "console")
```

Required widgets in **serialisation order** (see §6 on why this order is
load-bearing):

```
 0 tensor_dir              STRING
 1 output_dir              STRING
 2 checkpoint_dir          STRING
 3 variant                 COMBO   xl_sft | xl_turbo | xl_base | sft | turbo | base
 4 preset                  COMBO   recommended | quick_test | high_quality | vram_8gb…24gb_plus
 5 rank                    INT     0 = from preset
 6 alpha                   INT     0 = from preset
 7 learning_rate           FLOAT   0 = from preset
 8 epochs                  INT     0 = from preset
 9 batch_size              INT     0 = from preset
10 gradient_accumulation   INT     0 = from preset
11 save_every              INT     0 = from preset
12 optimizer               COMBO   from preset | adamw | adamw8bit | adafactor | prodigy
13 gradient_checkpointing  COMBO   from preset | on | off
14 device                  COMBO   auto | cuda | cpu
15 precision               COMBO   auto | bf16 | fp16 | fp32
16 dry_run                 BOOLEAN
17 warmup_steps            INT     0 = from preset
```

Optional: `acestep_repo_path` (STRING), `resume_from` (STRING).

---

## 2. Dependency policy

Four tiers. The distinction matters because §10 requires *required* imports to
be declared and forbids silently installing anything.

**Declared in `pyproject.toml`**

- `mutagen>=1.45` — `NovaACEDatasetBuilder` reads tags with it and has no
  degraded mode.

**Provided by ComfyUI's own `requirements.txt`, deliberately not restated**

- `torch`, `torchaudio`, `av`, `numpy`. Restating them would only let this
  package churn versions ComfyUI already pins.

**Optional, with a working fallback — deliberately not declared**

- `soundfile` — first choice in the decode shim, falls back to PyAV, which
  ComfyUI does ship. Declaring it would make a hard dependency out of a
  preference.
- `torchcodec` — not imported directly; only probed. See §7.

**Never a dependency, never installed, never downloaded**

- `acestep` (ACE-Step 1.5) — the preprocess and trainer nodes drive it. If it
  is missing they print what to install and stop.
- `vector_quantize_pytorch`, `einx`, `frozendict`, `torch-einops-utils` — needed
  by the XL checkpoints' `trust_remote_code` modeling file, not by this pack.
- `tensorboard` — optional; without it there are no loss curves and training is
  otherwise unaffected. The node says so in its banner.
- `bitsandbytes` (for `adamw8bit`), `prodigyopt` (for `prodigy`) — checked with
  `importlib.util.find_spec` before the run starts, never installed.

Every `pip install` / `uv pip install` string in `training/` is inside an error
message. None is ever executed. Grep will find several; they are §10-compliant
guidance text, which is exactly what that section asks for.

---

## 3. Compliance review against the project policy

Classified using §16. Each finding states whether it is a **documented rule** or
an **engineering judgement**, per §17.

### §3 `eval` / `exec` — CLEAN

Neither appears anywhere in `training/`, nor any dynamic-string equivalent.

### §4 Runtime dependency installation — CLEAN, but read this

No `pip install` is executed by any **node**, by subprocess or otherwise. No
`os.system`. Every missing-dependency path ends in a raised exception or a
report carrying instructions, never an install.

Two files do install things, and neither is node runtime:

* **`install.py`** at the pack root. ComfyUI-Manager runs a pack's `install.py`
  after installing or updating it — the convention five other packs in the
  reference machine's `custom_nodes` already use. This is what §4 means by
  "the package/dependency installation mechanism": it runs while the pack is
  being installed, not while a workflow executes. It installs the training
  packages and fixes torchcodec, deliberately does **not** download models or
  clone ACE-Step, and always exits 0 so a failure cannot mark the whole pack
  as broken — the other 24 nodes have nothing to do with training.
* **`training/nova_ace_setup.py`**, a standalone script the user runs from a
  terminal. Nothing imports it; it is not on any node's import path. Grep will
  find `subprocess` and `pip install` in it — that is the point of it being a
  separate manual step.

Both pin the installed torch/torchvision/torchaudio via a generated constraints
file, so no resolver can replace a ROCm or CPU build.

`NovaACESetupCheck` is the node-side counterpart: it runs the same checks
in-process, installs nothing, spawns nothing, and prints the command the user
would run. It also refuses to suggest installing anything ComfyUI itself
provides — `pip install --no-deps torch` would drop a generic wheel over a
ROCm build, so those are reported as a broken ComfyUI install instead.

### §4 / §16 — `subprocess` in `NovaACELoRATrainer` — **WARNING, needs a decision**

This is the one item that requires a judgement call before publishing.

`training/nova_ace_train.py` is the only **node** in the pack that uses
`subprocess` (`nova_ace_setup.py` does too, but it is a standalone script no
node imports — see the previous section). It spawns exactly one thing:

```python
subprocess.Popen(
    [sys.executable, "-m", "acestep.training_v2.cli.train_fixed", "--plain", "--yes", ...],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env, cwd=safe_root,
)
```

`env` adds only `PYTHONUNBUFFERED=1` and prepends `PYTHONPATH`. No shell, no
`shell=True`, no user-supplied string reaching a shell, no external binary — it
re-invokes the same Python interpreter ComfyUI is running under.

**Why it is not a §4 violation.** §4's prohibition is specifically on runtime
*package installation* through subprocess. §4 states plainly that importing
`subprocess` "is not by itself evidence of a ComfyUI standards violation". Per
§17, the correct phrasing in any review is *"ComfyUI prohibits runtime package
installation through subprocess calls"* — not *"ComfyUI prohibits subprocess"*.

**Why it exists.** A LoRA run is hours long and owns the GPU. In-process it
would block ComfyUI's execution queue for the entire run, and an OOM inside the
training loop would take the server down with it; fragmented VRAM inside the
server's allocator would not be returned either. As a child process it is
cancellable from the ComfyUI UI, cannot crash the server, and returns all VRAM
on exit. ComfyUI's own models are unloaded before the child starts.

**The risk that is not about the documented rule.** `nova_player/routes.py`
records that the Registry scanner flagged versions 2.2.0 and 2.2.1, and that
"spawning an external binary was the likeliest objection" — which is why the
ffmpeg/ffprobe decode fallback was removed from two files. This new subprocess
is a different shape (same interpreter, no external binary, no install), but the
scanner's behaviour, not the written rule, is what decides a publish.

**Decision required before publishing.** Either:

1. Publish as-is and be prepared to justify it if flagged — the documented rule
   does not prohibit this; or
2. Hold `NovaACELoRATrainer` out of the Registry release and ship the other
   three training nodes, which contain no subprocess at all. The dataset →
   preprocess chain is fully useful on its own; users run ACE-Step's CLI
   themselves. This costs one node and removes the only scanner risk.

Option 2 is a real option and cheap: `training/__init__.py` imports the trainer
in its own block, so removing it is a three-line edit plus dropping one file.

### §16 Global monkey patching — WARNING, justified and documented

`nova_ace_audio_shim.apply_decode_shim()` replaces
`acestep.training.dataset_builder_modules.preprocess_audio.load_audio_stereo`.

Constraints already in place, all verifiable in the source:

- It **probes first** and does nothing at all when torchcodec loads correctly.
- It is **announced** in the node's banner — never silent.
- It is **idempotent** (`_nova_shim_active` guard).
- The original is retained as `_nova_original_load_audio_stereo`.
- Failure to patch is **reported, not fatal** — the run then fails the way it
  would have anyway, which is information the user needs.

The patched module belongs to ACE-Step, a library this pack drives, **not to
another custom node**, so §6 is not engaged. It is still a global patch and
should be declared as such in any review rather than left to be discovered.

### §9 Undocumented / unstable third-party internals — WARNING, flagged in source

`NovaACEPreprocess` and `NovaACELoRATrainer` drive ACE-Step internals that carry
no stability promise:

- `acestep.training_v2.preprocess.preprocess_audio_files`
- `acestep.training.dataset_builder_modules.preprocess_audio.load_audio_stereo`
- the `training_v2/presets/*.json` file layout
- the `cli.train_fixed` argparse flag set

Each is flagged in its module docstring with the reason borrowing beat
reimplementing: the `.pt` tensor schema the trainer consumes is not a published
contract, and a reimplementation would drift silently — training runs, loss
falls, the LoRA is quietly wrong.

Two upstream defects are worked around explicitly rather than silently; both are
documented in `claude/nova-ace-lora-training.md`:

1. XL variants fail `cli/validation.validate_paths`, which resolves through
   `cli/args.VARIANT_DIR_MAP` (turbo/base/sft only) and never consults
   `model_loader._VARIANT_DIR` where the XL entries live. The node passes the
   literal folder name and sends the alias via `--base-model`.
2. Every shipped preset hardcodes turbo values (`shift 3.0`,
   `num_inference_steps 8`). The node derives both from the checkpoint's own
   `config.json` `is_turbo` flag instead.

Note for reviewers: `acestep`'s own `path_safety` captures
`_SAFE_ROOT = realpath(os.getcwd())` **at import time**, which is why the child
process's `cwd` is set to the common ancestor of every path the run touches.
That is not arbitrary — pointing it elsewhere makes ACE-Step reject the dataset
as a path-injection attempt.

### §6 Interference with other custom nodes — CLEAN

`training/` touches no other pack. No imports from, edits to, or registration
changes affecting anything outside this package.

### §8 Workflow compatibility — CLEAN, with a rule to preserve

`warmup_steps` was added at index 17, **appended after `dry_run` rather than
placed next to `epochs` where it logically belongs**. ComfyUI serialises widget
values positionally, so inserting mid-list shifts every later value and
scrambles workflows already saved with the node. This pack has been bitten by
exactly that before (`NovaMasterReportViewer`).

**Rule for any future change: new widgets go on the end.** The comment in
`INPUT_TYPES` says so; keep it.

No class name has ever changed in `training/`.

### §10 / §11 Registry metadata — see §9 of this document

### §12 Node documentation — **RESOLVED**

All five training nodes now have a page:

```
web/docs/NovaACEDatasetBuilder/en.md    present
web/docs/NovaACEDatasetReview/en.md     present
web/docs/NovaACEPreprocess/en.md        present
web/docs/NovaACELoRATrainer/en.md       present   (7.4 KB)
web/docs/NovaACESetupCheck/en.md        present   (4.7 KB)
```

The trainer's page covers what the previous revision of this document asked for:
the preset-plus-overrides model and the `0 = from preset` convention; that
`warmup_steps` counts **optimizer steps, not epochs**; `dry_run`; what
`exit_code` does and does not tell you; and the external prerequisites in §7.

Six authoring-group pages were written at the same time (`NovaConsole`,
`NovaSQLiteReader`, `NovaTagWriter`, `NovaTagReader`, `NovaBatchLoadAudio`,
`NovaLoadAudio`), taking pack-wide coverage from 8 of 28 to **28 of 28**. §9
lists what is still uncovered.

#### Packaging note: how image paths resolve

Images live in **one shared folder**, `web/docs/images/`, and are referenced as
`images/name.png` from any page. This is not a stylistic choice — the frontend
serves the tree at `/extensions/<pack>/docs/` and resolves every relative image
against that **root**, not against the folder the `en.md` sits in. Verified
against frontend 1.45.15 by reading `nodeHelpUtil.ts` and
`markdownRendererUtil.ts` out of `comfyui_frontend_package`'s sourcemaps:

| In the markdown | Resolves to | Result |
|---|---|---|
| `![](images/tag-chain.png)` | `.../docs/images/tag-chain.png` | works |
| `![](tag-chain.png)` beside the page | `.../docs/tag-chain.png` | 404 |

Consequences for the release build:

- `web/docs/images/` **must be included in the published package.** Three pages
  share `tag-chain.png`; dropping the folder breaks all of them silently, since
  a missing image does not raise.
- Do not "tidy" images into per-node folders. That is precisely the layout that
  404s.
- `web/docs/images/README.md` records this so the next person does not have to
  rediscover it.

### §6 / §9 Nova Console slot resolution — CLEAN, but declare it

`web/nova_console.js` overrides four litegraph internals — `findInputByType`,
`findConnectByTypeSlot`, `findSlotByType`, `findInputSlotByType` — so that a
link auto-connected to Nova Console lands on its wildcard `value` input.

**Why it exists.** In the current frontend every widget is also a connectable
input, so the node offers four. Auto-connect picks by type, and a STRING source
is an *exact* match for `label` while a wildcard is not — so the link landed on
`label` and the workflow then failed to execute. An INT source went to
`max_lines`, a BOOLEAN to `print_to_server_log`.

**Why it is not a §6 violation.** The overrides are installed on the **Nova
Console node type only**, inside `beforeRegisterNodeDef` for that one class —
never on the shared `LGraphNode` prototype. No other node's behaviour changes.
Each override falls through to the original when the `value` slot cannot be
found, and each is individually wrapped in try/catch.

**§9 applies and is flagged in source.** These four are undocumented frontend
internals with no stability promise. The method table, the call paths that reach
each one, and the `isValidConnection` reasoning that proves redirecting to a
wildcard is safe rather than merely different, are recorded in
`claude/nova-authoring-nodes.md`. If a future frontend regresses this, the fix
is to find the fifth resolver the same way — the sourcemaps in
`comfyui_frontend_package/static/assets/*.js.map` carry `sourcesContent`, so the
original TypeScript is readable straight out of the venv.

Nova Console is the only node in the pack with a wildcard input, so this bug
class is contained to it.

---

## 4. Release blockers and actions

| # | Action | Severity | Blocking? | Status |
|---|---|---|---|---|
| 1 | Write `web/docs/NovaACELoRATrainer/en.md` and `.../NovaACESetupCheck/en.md` | ERROR (§12) | yes | **done** |
| 2 | Decide on the subprocess: publish, or hold the trainer node back | WARNING (§4/§16) | **yes — needs a human** | open |
| 3 | Update the `pyproject.toml` description | ERROR (§11) | **yes** | **done** — 28 nodes, removed-node phrases corrected |
| 4 | Bump the version to **2.6.0** | §11 | **yes** | **done** |
| 5 | Declare the monkey patch and the ACE-Step internals in the release notes | WARNING | no, but expected | done (§3) |
| 6 | Declare the Nova Console frontend overrides | WARNING (§9) | no, but expected | done (§3) |
| 7 | Remove the untracked test node before tagging | ERROR (§11) | **yes** | **done** — gone from the tree and all mappings |
| 8 | Confirm `web/docs/images/` is in the published package | ERROR (§12) | **yes** | **done** — see §18 item 4 |
| 9 | Load-test on ComfyUI's own interpreter and confirm 28 nodes register | ERROR (§11) | **yes** | open — static check only so far |

**On #4.** MINOR, not PATCH: this release adds a node (`NovaACESetupCheck`), adds
an install hook (`install.py`), and adds fifteen documentation pages. Nothing
breaks — no class name changed, no widget was inserted mid-list — so MAJOR is
not warranted either. **2.6.0.**

---

## 5. Verified vs unverified

Be honest about this in the Registry description. §13 is explicit that
"it runs on my machine" is not validation.

**Verified by execution, on one machine:**

- Full chain end to end: 6 tracks (22.7 min, 24-bit/48 kHz FLAC) → dataset JSON
  → 6 tensors → trained adapter. 200 epochs, 600 optimizer steps, 53m 06s,
  peak 11.3 GiB VRAM, 80 MiB adapter plus 8 checkpoints.
- The LR schedule, read back out of the TensorBoard event file: warmup to
  1.0e-4 at exactly step 60, full cosine decay to 1.0e-6 at step 600.
- Every generated argv parsed through ACE-Step's **own**
  `build_fixed_standalone_parser` and `validate_paths`, across seven
  preset/override/variant combinations.
- The decode shim against upstream's maths — exact match across FLAC/WAV/MP3/M4A,
  mono/stereo/5-channel, three durations, both backends.
- Seven negative pre-flight cases each raise the intended error.

**Not verified — state these as limitations:**

- **Linux + ROCm only.** ComfyUI 0.25.0, frontend 1.45.15, Python 3.12.13,
  torch 2.12.1+rocm7.2, AMD RX 9070 XT. **Never run on Windows, macOS or CUDA.**
  Windows in particular is untested for the child process, `os.path.commonpath`
  across drive letters, and `Popen.terminate()` semantics.
- **Cancellation is untested against a live run.** The code path exists and
  checks on the reader's idle branch (so a stalled trainer is still
  cancellable), SIGTERM then SIGKILL after 30 s — but no run has been cancelled.
- **`resume_from` is untested.**
- **The epoch-progress regex feeding `ProgressBar` is untested** beyond parsing.
- **LoKR is not offered.** `lycoris_lora` 4.0.0 was installed on the test
  machine and the trainer still logged "LyCORIS library not installed"; nobody
  chased it. The node exposes `--adapter-type lora` only.
- **No trained adapter has been loaded for inference.** Training completing is
  not evidence the LoRA is any good.

---

## 6. Behaviour a reviewer may flag as a bug, but is not

**`exit_code` 0 does not mean success, and the node knows it.**
`FixedLoRATrainer.train()` is a generator whose entire body sits inside
`except Exception: yield TrainingUpdate(kind="fail")`, so upstream reports hard
failures as a line of text and still returns 0. A second path — zero batches
processed — also returns 0. The node therefore treats *"did an adapter appear in
`output_dir/final/`?"* as the real success test and prints every `[FAIL]` and
`Traceback` line plus the last 25 lines of output whenever that check fails,
regardless of exit code. `exit_code` is still surfaced honestly as an output.

**`0` on numeric widgets is a sentinel, not a default value.** It means "take
this from the preset". Tooltips say so; the run banner prints an `Overrides`
line naming everything that was actually changed.

**`IS_CHANGED` returns NaN.** Intentional — a training run must never be served
from cache.

---

## 7. End-user environment prerequisites

Neither node installs any of this. Both print the exact command and stop. Worth
reproducing in the Registry description, because on a non-CUDA machine a user
hits both of these before anything works.

**torchcodec must match the PyTorch build.** `torchaudio` ≥ 2.9 delegates all
decoding to torchcodec, and the PyPI wheel is the CUDA build — its shared
objects need `libtorch_cuda`, `libcudart`, `libnvrtc`. On ROCm, Intel or
CPU-only PyTorch none of those exist and every `.so` fails to load. The `+cpu`
build from `download.pytorch.org/whl/cpu` links only against `libtorch` and
`libc10`. `nova_ace_audio_shim.py` covers the case where this has not been done.

**The XL checkpoints need packages ComfyUI does not ship.** They load through
`trust_remote_code`, and the modeling file imports `vector_quantize_pytorch`
(plus `einx`, `frozendict`, `torch-einops-utils`). `check_remote_code_imports()`
catches this before any model loads — upstream only discovers it in Pass 2,
after Pass 1 has already spent GPU time on every file in the dataset.

**ACE-Step itself.** Not installed, not downloaded, not vendored. Users clone it
and either install it or point `acestep_repo_path` at the clone. Note that a
`sys.path` entry added by the preprocess node does **not** reach the trainer's
child process; the trainer locates ACE-Step with `find_spec` and passes the
result as `PYTHONPATH`.

---

## 8. Suggested Registry description text for this group

> **LoRA Training** — build a labelled dataset from tagged audio, generate
> ACE-Step training tensors, and run ACE-Step's corrected LoRA training loop as
> a cancellable child process. Requires a separate ACE-Step 1.5 installation and
> its checkpoints; this package installs and downloads nothing. Verified on
> Linux/ROCm; Windows, macOS and CUDA are untested.

---

## 9. Noticed in passing — outside this document's scope

These affect the release build regardless of what happens to `training/`.

1. **`pyproject.toml` metadata — RESOLVED.** Version is now `2.6.0`, and the
   description's "Twenty-eight nodes" is correct for the shipping build: the
   count landed back on 28 once `NovaReportsImages` and the unfinished webcapture
   node came out and `NovaACESetupCheck` went in. Two phrases that described the
   removed node were corrected with it — see §18 item 2.

2. **`nova_categories.ALL_CATEGORIES` — RESOLVED.** All seven constants are now
   present, `REPORT` included.

3. **Node documentation is COMPLETE — 28 of 28**, up from 8. The last five
   pages (`NovaAudioSaveFLAC24`, `NovaMemoryProbe`, `NovaSQLDump`,
   `NovaAudioTranscribe`, `NovaLyricScore`) were written in this revision, the
   last two from the author's own release documents. §12 frames documentation
   as part of the product rather than a hard gate, so this is a quality item and
   not a blocker — every node in the two groups this document covers has a page.


---

## 10. Working tree state — read before tagging

The tree is **not clean**. §17 carries the current `git status --short` in full,
including the report-capture and Track Inspector work that landed after this
section was first written; read that one and treat this section as the
`training/` slice of it.

```
 M __init__.py                      NovaACESetupCheck registration
 M training/__init__.py             the same, group level
 M training/nova_ace_common.py      install_command(), remote-code import check
 M web/nova_console.js              the four slot overrides (§3)
?? install.py                       ComfyUI-Manager install hook
?? training/RELEASE_NOTES.md        this document
?? training/USER_GUIDE.md           the end-user guide
?? training/nova_ace_check.py       NovaACESetupCheck
?? training/nova_ace_setup.py       standalone setup script
?? web/docs/NovaACESetupCheck/      help page
?? web/docs/NovaBatchLoadAudio/     help page
?? web/docs/NovaConsole/            help page
?? web/docs/NovaLoadAudio/          help page
?? web/docs/NovaSQLiteReader/       help page
?? web/docs/NovaTagReader/          help page
?? web/docs/NovaTagWriter/          help page
?? web/docs/images/                 four shared screenshots + README
```

Everything above belongs in the release.

**The two unfinished webcapture files this section used to warn about are gone**
from the tree and from every mapping, so the naive `NODE_CLASS_MAPPINGS` count no
longer overshoots. It is 28. §17 lists the one thing still to skip.

---

## 11. Suggested commit and tag sequence

Not prescriptive; adjust to house style. The point is that the version bump and
the metadata fix land *with* the content they describe, not after it.

Steps 1 to 3 are already applied in the working tree; they are kept here so the
sequence reads as a whole.

1. ~~Remove or stash the webcapture files.~~ Done.
2. ~~Re-count registered nodes and update the `pyproject.toml` `description`.~~
   Done — 28.
3. ~~Set `version = "2.6.0"`.~~ Done.
4. Stage everything in §17's block — it supersedes §10's, which covers only the
   `training/` slice. Confirm `web/docs/images/` is included by checking the
   packaged artifact, not just `git status`: image globs are a common place for a
   packaging config to quietly exclude things. `[tool.comfy] includes = []` and
   `git check-ignore` both say it ships.
5. Resolve blocker #2 (the subprocess decision) before publishing, not after.
6. Verify the help pages render: start ComfyUI, hard-reload the browser, and
   click ❓ on Nova Console and Nova ACE LoRA Trainer. A 404 image shows as a
   broken icon and nothing in any log.
7. Right-click → Export Report Images on each of the three viewers, and confirm
   the console logs `[Nova Report Capture] v9 iframe-aware loaded`.

---

## 12. What changed in this revision, for a reviewer diffing documents

- §1 gained `install.py` and the `web/docs/` tree; line counts refreshed.
- §3 §12 went from **ERROR / release blocker** to **RESOLVED**, and gained the
  image-path packaging note.
- §3 gained the Nova Console slot-resolution section (§6 clean, §9 declared).
- §4 gained a status column and four new rows; the version bump is now pinned at
  2.6.0 with the reasoning.
- §9.2 (`ALL_CATEGORIES`) resolved; §9.3 recounted, 20 → 6 nodes undocumented.
- §10 and §11 are new: working-tree state, what must not ship, and a commit
  sequence.
- §9.1 (`pyproject.toml` metadata) resolved: version 2.6.0, description
  corrected, node count settled at 28. §9.3 recounted again, 6 → 5.
- §10 was rewritten to defer to §17, which now carries the whole working tree
  rather than the `training/` slice.
- §11 and §18 were rewritten to mark what is already applied, so the release
  agent confirms rather than redoes.
- §13 gained the iframe constraint that produced the empty Lyric Report export,
  and a Verified subsection naming the shipping build and the five report modes
  the author confirmed.
- **Unchanged and still open: the subprocess decision in §3.** It is the only
  item in this document that cannot be resolved by editing files.


---

## 13. Report capture — replacing NovaReportsImages

**What it is.** Right-click any report viewer → *Export views → images*. Every
view except Technical is rendered and saved to
`output/NovaAudioMasters/ReportImages/`, named after the source audio.

**Why it replaces a node rather than fixing one.** `NovaReportsImages` redrew the
report from scratch with PIL — `ImageDraw` primitives, hand-rolled helpers for
rounded rectangles, bars and sparklines. The viewers draw themselves with HTML
and CSS in the browser (`web/nova_master_report_viewer.js`, 795 lines, plus a
stylesheet). Two independent implementations of one layout in two technologies,
sharing no code. It could not converge on the original, and every CSS change
widened the gap. Its own docstring recorded the design: *"One node instance
renders one Nova report view to one fixed portrait image."*

**How the replacement works.** `web/nova_report_export.js` rasterises the
viewer's own live DOM with the viewer's own stylesheet, and
`viewers/nova_report_capture.py` writes the bytes. The Python half does no
layout and owns no styling, which is exactly why the output cannot drift.

### Files

| File | Lines | Contains |
|---|---|---|
| `viewers/nova_report_capture.py` | 197 | one aiohttp route, `POST /nova_report_capture/save` |
| `web/nova_report_export.js` | 494 | menu entry, title-bar hint, rasteriser |
| `__init__.py` | +2 lines | `register_report_capture_routes()` beside the four existing route registrations |

### Compliance

**§6 — CLEAN.** The extension adds nothing to the viewer nodes: no widgets, no
prototype patching. It reads the DOM element through ComfyUI's own
`addDOMWidget` contract, reads the view list off the `view_mode` widget, and
drives the viewer's existing *Apply View* button. The three viewer modules are
unmodified. This shape was arrived at by breaking the viewers twice — widgets
appended after a DOM widget made the node grow an empty band, and widgets
anywhere re-triggered a resize feedback loop the viewers' own source comments
record having already fixed once.

**§4 — CLEAN.** No subprocess, no install, no external binary. Rasterising
happens in the browser.

**Security.** The route treats its payload as hostile: the subfolder is
sanitised segment by segment, `..` is dropped, absolute paths are neutered, the
resolved destination must sit inside ComfyUI's output directory (checked on the
realpath, so a symlink cannot escape), decoded bytes must carry the PNG
signature, and limits are 24 MB per image / 96 MB per request / 32 images.
Everything is validated before anything is written, so a bad entry cannot leave
a partial set on disk. Verified: traversal blocked in both directions, absolute
paths neutered, non-PNG rejected.

### Known browser constraints, recorded so they are not rediscovered

- **CSS must go inside CDATA.** SVG is XML, and a bare `&` in a stylesheet is a
  fatal parse error. This is what made the first version fail.
- **CSS is selected by tokens read from the element**, not by a hardcoded
  prefix, plus any stylesheet served from `/extensions/comfyui-novaaudioplayer/`.
  An earlier version kept only rules containing `nova`, on the strength of one
  viewer that happened to use `nova-*` class names. The Track Inspector uses
  `nti-*` throughout, so its entire stylesheet was dropped and the export came
  out as black-on-black unstyled markup. Deriving the tokens from the DOM means a
  viewer added later works without anyone remembering this exists.
- **Resolved CSS custom properties are copied onto the clone.** Custom
  properties inherit, so a palette declared on `:root` or on an ancestor outside
  the captured element is simply absent once the element is lifted into the
  off-screen stage, and every `var()` falls back to its initial value. This was
  the deeper half of the same bug. Computed values are read from
  `documentElement`, `body` and the element, so it no longer matters where or how
  they were declared.
- **A data: URL, never a blob: URL.** In Chromium an SVG loaded from a blob URL
  taints the canvas, so the export dies at `toDataURL` *after* rendering
  correctly.
- **An iframe never renders inside a rasterised SVG.** The Lyric Report viewer
  mounts its HTML in an `<iframe srcdoc>`; serialising the node's element into a
  `foreignObject` produced an empty box at the iframe's visible height, because
  the browser does not run a nested browsing context during that rasterisation.
  `resolveCaptureTarget()` therefore looks for an accessible iframe document and
  captures `frame.contentDocument.body` instead of the host element, threading
  that document through the stylesheet collection and the custom-property copy.
  When the capture source is a document Claude does not share with the page,
  every rule in it is kept rather than token-filtered, since a `srcdoc` exists
  only for that one report. The page background is then sampled from the inner
  body so the export is not transparent.
- **A computed `backgroundColor` is never falsy.** An unpainted element returns
  the STRING `"rgba(0, 0, 0, 0)"`, so `getComputedStyle(el).backgroundColor ||
  "#0a0e14"` never reaches its fallback. Every export was therefore filled with
  a transparent colour and written as an RGBA PNG with alpha 0 — the text and
  panels were present, but there was no page under them, so the files looked
  blank or washed out depending on what viewed them. Alpha is now parsed
  properly (`isTransparent`), including `rgba(255,255,255,0)` and the modern
  `rgb(r g b / a)` form, and the colour is resolved from the report root, which
  is where `background: var(--nti-bg)` lives and where the theme is already
  applied. The hardcoded literal is a last resort, not the usual answer.
- **A view switch does not finish inside one frame.** The exporter sets
  `view_mode`, calls Apply View, and captures. The viewers empty their container
  and refill it, and the refill is not synchronous, so a fixed `await
  nextFrame()` photographed the emptied box: only the view that happened to be
  on screen when the export started came out with anything in it, and the rest
  rasterised to nothing. `waitForRender` now polls until the capture source has
  children and its size and markup have been stable for two frames, with a 2 s
  ceiling per view so a viewer that never settles still exports rather than
  hanging. An empty container is treated as a render in progress, never as a
  finished one.
- **A hard refresh does not reliably evict this file in Opera GX.** v10 was
  deployed, ComfyUI was restarted, the browser was refreshed, and the exports
  that came out were byte-for-byte identical to the previous run — same file
  sizes to the byte across six of nine views, which only happens when the same
  code runs on the same DOM. The browser was still executing v9 from cache. Two
  development sessions have now been lost to this. The script is therefore
  served from a **new filename, `web/nova_report_export.js`**: a URL that has
  never been requested cannot be answered from cache. The old
  `nova_report_capture.js` is retired to `.trash/` rather than reused, because
  that URL still has a poisoned entry in at least one browser. The server-side
  route file keeps its name — nothing caches it. If this file ever has to be
  renamed again for the same reason, rename it; do not spend another session
  trying to defeat the cache in place.
- **The blank exports are the browser's GPU-accelerated 2D canvas failing to
  read back, and nothing in this pack can fix that.** Browsers keep small
  canvases in software and promote large ones to the GPU. On the author's
  machine (AMD RX 9070 XT, Mesa, rolling-release Linux) a 4x4 canvas fills and
  reads back correctly while a 1200x700 one, filled the same way in the same
  click, reads back entirely transparent. `fillRect` followed by `getImageData`
  cannot do that in software; it is a driver-level read-back failure from a GPU
  surface. The user-side fix is `gfx.canvas.accelerated = false` in Firefox's
  `about:config`, or **Accelerated 2D canvas -> Disabled** in `chrome://flags`
  for Chromium and Opera, followed by a restart.
- **Three hypotheses were wrong before that one, and each was killed by a
  measurement rather than an argument.** They are recorded because each one cost
  a round trip and the next person will be tempted by all three. (1) *The
  rasteriser.* Disproved by rebuilding the identical pipeline — iframe `<body>`
  clone, `foreignObject`, CDATA, data URL, `drawImage` — in headless Chromium
  and headless Firefox, both of which returned a fully opaque canvas with the
  exact fill colour. (2) *Firefox's `privacy.resistFingerprinting`.* Disproved
  because it would have blocked the small `getImageData` probe, which passes.
  (3) *A privacy extension hooking `toDataURL`.* Disproved when a probe that
  round-trips through `toDataURL` at 4x4 passed while the real export was still
  empty; `toDataURL` was never the failing call. A non-standard `deBG` chunk in
  the saved PNGs pointed hard at interference and was a red herring — it is
  still unexplained and it was never load-bearing.
- **`v15` works around the driver fault instead of reporting it.** The export
  now measures how tall a canvas this machine can actually read back — trying
  1400, 1024, 768, 512, ... down to 64 device pixels at the export width — and
  uses the first height that survives a fill, a `getImageData` and a `toDataURL`
  round trip. When that height covers the whole report, nothing changes: the
  single-canvas path runs exactly as before. When it does not, the report is
  still rendered once at full size and only the READ BACK is split into bands,
  each drawn from the same full-size image at a different vertical offset
  (`setTransform(scale, 0, 0, scale, 0, -y)`), and `_stitch()` joins them
  server-side with Pillow. Only a browser that can read back nothing at any
  height is refused.
- **The tiled path is pixel-identical to the whole-canvas one, and that was
  measured, not assumed.** In headless Chromium the same `foreignObject` render
  was captured whole and tiled into 8 strips of 97px — a height chosen because
  it does not divide evenly into the 720px image — and the stitched result
  differed from the whole-canvas capture by a maximum channel value of 0. The
  shipped `_stitch()` was then tested directly against a 600x721 source cut into
  uneven strips and rebuilt it exactly, joins a blank strip to a filled one
  without complaint, and leaves `_looks_empty()` reporting correctly on both.
- **Limits and failure modes.** At most 128 strips per view, the existing total
  request ceiling still applies and is checked against the summed strip bytes,
  and a Pillow failure during the join returns a 400 naming the view rather than
  writing anything. A single blank strip is legitimate — a band of empty report —
  so a tiled view is judged blank only when EVERY strip is blank.
- **The lesson worth keeping: a probe must match the real call in BOTH the API
  it uses and the size it uses.** `v11` probed `getImageData` while the export
  wrote through `toDataURL`. `v12` fixed the API and kept a 4x4 canvas, which
  sailed under the size at which the fault appears. `v14` fills the configured
  export width by 700, reads it back, round-trips it through `toDataURL`, and
  reports the failing dimensions in the message, because the size is the
  diagnosis.
- **Every rendered view is verified before it is sent, and again on the
  server.** `pngIsBlank()` decodes each finished PNG and reads its alpha channel
  through a 48x48 downscale, which works because small canvases are the ones
  that still function. `_looks_empty()` then refuses the whole request
  server-side. Verified in headless Chromium: a blank 1800x1323 PNG is caught, a
  filled one passes, and a single 40x40 mark on an otherwise empty 1800x1323
  canvas passes, so a sparse report is never mistaken for a failure. An
  unreadable input answers "not blank" so the check can never block a
  legitimate save. This is why the failure now announces itself in one sentence
  instead of leaving a folder of empty files.
- Verified working in Opera GX (Chromium). Firefox and Safari untested.
- **All three viewers use different conventions**, which is why the prefix
  assumption failed: the Master viewer declares `--nova-*` on `:root` and styles
  `.nova-report-root`; the Track Inspector declares `--nti-*` on `.nti-root`; the
  Lyric Report builds its HTML in Python and emits its CSS as an inline `<style>`
  inside the rendered markup, so its styles travel with the clone regardless.

### Verification status

`web/nova_report_export.js` reports its build in the console on load. The
shipping build is **`v15 tiled fallback`**, served from
`web/nova_report_export.js`. It also now prints one diagnostic line per view —
resolved background, CSS size, SVG size, height, child count — which is what a
failed export should be judged on rather than the picture.

**CONFIRMED by the author on 16 September 2026.** All nine views across the
three viewers — Mastering Report, Source vs Master Comparison, Mastering
Workflow, Track Inspector (Inspector, Timeline, Markers) and Lyric Report
(Dashboard, Transcription, Lyric Report) — exported correctly in full colour, on
a machine whose GPU cannot read back a full-size canvas, via the tiled path.
Waveforms, gradient score bars, marker tables and the coloured lyric diff all
survive the strip-and-stitch intact.

Judge a failed export by measuring the file, not by looking at it: a transparent
PNG renders as white in some viewers and black in others, and neither looks like
the failure it is. Two runs were lost to exactly that confusion.

```
python3 -c "from PIL import Image;im=Image.open(PATH);print(im.mode,im.getchannel('A').getextrema())"
```

An alpha extrema with an opaque minimum is the pass. `(0, 0)` across the whole
canvas means nothing was drawn at all.

---

## 14. `NovaReportsImages` removed

Unregistered from `__init__.py` and the module moved to `_to_delete/`.

**Removing it took the whole pack down once during development**, because there
were *two* imports of the module — a plain class import and a second
parenthesised block importing its mapping dictionaries under aliases. A search
for the class name found only the first. An ImportError in `__init__.py` takes
every node off the menu, which `pyproject.toml`'s own comments warn about.

**Before tagging, verify with the module name, not the class name**, and confirm
the pack actually loads rather than merely parses. A relative-import sweep across
every `.py` in the pack currently reports zero unresolved targets.

**Consequence for users:** a saved workflow containing a Nova Reports Images node
will show it as missing on load. Unavoidable when removing a node; worth a line
in the release description.

---

## 15. Nova Track Inspector — the provisional layer

### The bug it fixes

The Inspector graded **self-consistency, not quality**. Every metric was compared
against the track's own median, so the question it answered was *"is this track
the same as itself throughout?"* Six of eight sub-scores, carrying 72% of the
weight, start at 100 and fall only when something changes.

A uniformly washed-out track is perfectly consistent, so it scored an A. The only
absolute measure, `noise_likelihood`, contributed about 0.9 points at value 75
and then slammed the score to 58 at 76 and 35 at 88 — an unvalidated heuristic
with veto power, which is the same bug in the opposite direction.

### The design

Measures now carry an evidence tier that sets both weight and authority:

| Tier | Weight | May it fail a track? |
|---|---|---|
| Measured — deterministic fact | full | yes |
| Provisional — separates on small n | scaled | no, caps per `provisional_authority` |
| Observational — computed, unproven | zero | no |

Nine controls expose this on the node, each with a tooltip stating direction.
`provisional_authority` (default 0.30) caps what unvalidated measures may do:
comment only at 0.00, REVIEW at 0.30, POOR at 0.70, REJECT at 1.00. Every value
is written into the report JSON with the result, so a saved report records the
dial positions that produced it.

**`noise_likelihood` has NOT yet been brought under this rule.** Its hard
ceilings remain. That is the next change, and it is the reason a good track can
still be slammed to 35 by an unproven number.

### Calibration, and its limits

Thresholds come from six masters the author approved, measured directly:

```
head~tail       0.018 - 0.058      (default set to 0.075 for headroom)
longest_away    0 - 10 s           (default 10 s)
timbre_step_z   1.8 - 8.5          (default 9.0)
```

Verified: none of the six takes a penalty at defaults; four of five known-bad
takes are flagged.

**State this plainly in any release description.** The numbers come from six
*mastered* tracks, not from generated takes. Two hypotheses were tested and
failed before this one — HF contrast and comb filtering both failed to separate
good from bad, and an early comparison was confounded because the good set was
mastered and the bad set was not. The measures that survived are provisional and
the node treats them as such.

**A known false positive:** a deliberately explosive master measures 0.213 on
start-vs-end timbre, higher than takes rejected as broken. No single threshold
separates them. This is why profiles exist.

### Profiles

`weight_profile` lists Madow's profile names; weights live in
`profiles/track_inspector/<name>.json`.

**They are deliberately NOT stored in the Madow preset file.**
`madow/presets.py::save` rebuilds the body from six fixed keys, so any extra
top-level key is dropped the first time a user saves that preset from Madow's UI.
The names are shared; the values are not.

One deviation worth noting: the inspector's name pattern allows `#`, one
character wider than Madow's save pattern, because 80 bulk-generated presets are
named for sharp keys and Madow's dropdown lists them regardless. Without this the
two lists would differ by 80 entries. Path containment, not the character class,
is the actual guard — traversal and absolute paths are refused and were verified.

### New file

| File | Lines | Contains |
|---|---|---|
| `mastering/nova_inspector_profiles.py` | 147 | profile list/load/save, path containment, range clamping |

`mastering/nova_track_inspector.py` grew from 736 to 1091 lines.

---

## 16. Also changed

**`NovaAudioTranscribe` gained a third output on the day of this revision.**
It now returns `("STRING","STRING","AUDIO") -> (text, json, audio)`; the third
is the isolated vocal stem when `vocal_isolation` is on and the input passed
through otherwise, which makes an acapella available to a save node. The help
page written here documents all three, and `transcribe/README.md` was corrected
with it. The author's separate `ADMIN.md`, `USER-GUIDE.md`, `INSTALL.md` and
`RELEASE-NOTES.md` for the transcription track were written before that change
and still describe two outputs — they are not wrong so much as one change
behind, and want a pass before they are published alongside the pack.


**`viewers/nova_master_report_viewer.py`** — `view_mode` reduced from six
entries to four. `Detailed` and `Compact` were in the dropdown but never
implemented: `renderReport` has no branch for either, so both fell through to
`renderDashboard` and produced byte-identical output, which the image export made
visible as three identical files. Removing them means a saved workflow whose
`view_mode` is `"Detailed"` or `"Compact"` will fail combo validation until the
user picks a real view.

**`web/docs/NovaLyricReportViewer/en.md`** — written; the node had no help page.

**Export documented** as the first section on all three viewer help pages, at the
author's explicit request that users should not miss it. Three corrections to
that copy landed in this revision: on the Lyric page the section had drifted
below three others and is now first like the rest; its claim that the export
skips **Technical** was wrong for that viewer specifically, which has no such
view and exports all three of its own; and all three pages said "Two settings"
above a table of three.

**`web/docs/NovaAudioMaster/en.md`** — the `report_json` row no longer points
users at Reports Images, which no longer exists.

---

## 17. Working tree at handoff

Nothing in this change set is committed. As of this revision:

```
 M .gitignore                       _to_delete/ added beside .trash/
 M __init__.py                      route registration, NovaReportsImages removal
 M mastering/nova_track_inspector.py provisional layer
 M pyproject.toml                   version 2.6.0, description corrected
 M training/__init__.py             NovaACESetupCheck registration
 M training/nova_ace_common.py      install_command(), remote-code import check
 M transcribe/nova_audio_transcribe.py
 M viewers/nova_master_report_viewer.py  view_mode 6 -> 4
 M web/nova_console.js              the four slot overrides
 M web/docs/NovaMasterReportViewer/en.md
 M web/docs/NovaTrackInspector/en.md
 M web/docs/NovaTrackInspectorReportViewer/en.md
 D viewers/nova_reports_to_images.py
 D web/docs/NovaReportsImages/en.md
?? install.py
?? mastering/nova_inspector_profiles.py
?? training/{RELEASE_NOTES,USER_GUIDE}.md
?? training/nova_ace_check.py
?? training/nova_ace_setup.py
?? viewers/nova_report_capture.py
?? web/nova_report_export.js
?? web/docs/NovaACESetupCheck/ NovaBatchLoadAudio/ NovaConsole/ NovaLoadAudio/
?? web/docs/NovaLyricReportViewer/ NovaSQLiteReader/ NovaTagReader/ NovaTagWriter/
?? web/docs/images/
```

**Already resolved, so do not go looking for them:** the two unfinished
webcapture files are gone from the tree and from every mapping, and the scratch
directory now lives at `.trash/`, which `.gitignore` already covers. `_to_delete/`
survives only as an empty directory the sandbox could not remove; git does not
track empty directories and `.gitignore` now names it as well, so it cannot
reach the package. Delete it by hand if you want the tree tidy.

**Also modified but NOT part of this change set — SKIP IT:**
`presets/Eb minor 14 gradient_estimation beta aggressive.json` is an author edit
from Madow work, confirmed by the author as out of scope. Do not stage it.

---

## 18. Release checklist

Done in this revision, listed so a reviewer can confirm rather than redo:

1. ~~Remove the two webcapture files and `_to_delete/`.~~ Done; see §17.
2. ~~Re-count nodes and correct the `pyproject.toml` description.~~ Done. The
   count is **28**. The description already said "Twenty-eight nodes" and is now
   accurate for a different reason than it was written for, so two phrases were
   corrected with it: "render reports to images" is gone from Delivery &
   Metadata, and Data Viewers now names the right-click PNG export.
3. ~~Set `version = "2.6.0"`.~~ Done. MINOR: one node added, one removed, no
   breaking change to a surviving node's contract.
4. ~~Confirm `web/docs/images/` is in the published package.~~ **The conclusion
   was right and the method could not prove it.** `git check-ignore` answers
   only "is this path ignored?" — it says nothing about whether the path is
   *tracked*, and an untracked file that no rule ignores is still absent from
   the package. At the time this item was written `web/docs/images/` was
   untracked, so the check passed while the folder would not have shipped. It is
   tracked as of 17 Sep. The correct test is item 10.
5. ~~Remove the orphaned `web/docs/NovaReportsImages/en.md`.~~ Done — the node it
   documented no longer exists.

Still open, and the first one needs a human:

6. **Resolve the subprocess decision in §3 before publishing.** No edit settles
   it; it is a judgement about what the Registry will accept.
7. **Load-test on the real interpreter: start ComfyUI and confirm 28 nodes
   register.** Parsing is not loading, and the last time that distinction was
   skipped an ImportError took the whole pack off the menu. `Claude
   outputs/nova_loadtest.py` does it in one command from the ComfyUI root —
   `.venv/bin/python "Claude outputs/nova_loadtest.py"` — importing the pack the
   way ComfyUI does, with the real torch behind it, and printing the count, the
   names, and any traceback. It stubs `PromptServer` because there is no live
   server in that process; ComfyUI's own startup log already proves the real
   route registration works.
8. ~~Click ❓ on the help pages, and right-click → Export Report Images on each
   of the three viewers.~~ The export is **done and confirmed** — all nine views
   across the three viewers, through the tiled path. The console banner should
   read `[Nova Report Capture] v15 tiled fallback`. The ❓ help pages still want
   a click-through.
9. Commit. Nothing here is committed yet, and
   `presets/Eb minor 14 gradient_estimation beta aggressive.json` must not be
   staged with it.
10. **`git status --porcelain | grep '^??'` must come back empty before
    publishing.** This is the gate item 4 needed. `comfy node publish` packages
    git-tracked files — the `.comfyignore` header says so — so an untracked file
    is an absent file, silently. On 17 Sep this check found **23 untracked
    paths**, six of them Python modules imported by tracked code:

    | Untracked | Imported by |
    |---|---|
    | `install.py` | `__init__.py` and 12 others |
    | `viewers/nova_report_capture.py` | `__init__.py` |
    | `training/nova_ace_check.py` | `__init__.py`, `training/__init__.py` |
    | `training/nova_ace_setup.py` | `install.py`, `nova_ace_check.py` |
    | `mastering/nova_master_archive_index.py` | `nova_final_master_validator.py` |
    | `mastering/nova_inspector_profiles.py` | `nova_track_inspector.py` |

    Two of those are imported by `__init__.py`, so the published pack would have
    failed at import — not a degraded feature, a pack that does not load. Also
    untracked: `web/nova_report_export.js`, the entire rasteriser served by
    `WEB_DIRECTORY`, and eleven `web/docs/<Node>/` folders plus
    `web/docs/images/`. All 27 are staged as of 17 Sep;
    `training/RELEASE_NOTES.md` is deliberately left out as a handoff document.

    A parse test, a load test and a help-page click-through all run against the
    working tree, so none of them can see this. Only the `??` check can.

Documentation is **complete: 28 of 28 nodes have a help page**, and no doc
folder is left pointing at a node that no longer exists. Verified with
`git ls-files 'web/docs/*/en.md' | wc -l` rather than a directory listing —
on disk and in the package are different questions, and item 10 is why.

## 19. True peak was not measuring true peak — `analysis/loudness.py`

`true_peak_db()` oversampled with
`F.interpolate(..., mode="linear", align_corners=False)`. Linear interpolation
returns values between two samples and so can never exceed the larger of them,
which makes an intersample peak invisible by construction. The symptom was in
every report ever written by this pack: true peak reported *below* sample peak
(−1.0000 dBTP against −0.9376 dBFS), which cannot happen to a real waveform.
`align_corners=False` also shifts the output grid off the original sample
positions, so the peak sample itself could be missed.

Measured on a real 48 kHz master:

```
sample peak                          -0.9376 dBFS
old implementation (linear, 4x)      -1.0000 dBTP
exact band-limited reconstruction    -0.9242 dBTP
```

The master was over its −1.00 dBTP target and the report said it had met it.
`target_true_peak_dbtp` is a delivery-compliance figure, so this reached past
validation into what gets shipped.

### The replacement

A Kaiser-windowed sinc polyphase FIR, 24 taps per phase, β = 6.0, generated at
import and cached. Coefficients are built in pure Python (including a short
series for the modified Bessel function) so the module still depends on nothing
but torch. Each phase is normalised to unit DC gain. The original samples are
included in the maximum, which guarantees the physical invariant the old code
violated: **true peak is never below sample peak**.

The first and last `taps` samples are excluded from the oversampled maximum.
Outside the signal the filter sees zeros, and a file that begins or ends
part-way through a waveform reconstructs that step with roughly 1 dB of Gibbs
overshoot — an artefact of where the file was cut, not of its content, which
would otherwise fail a validation on a trimmed excerpt for no musical reason.
Those samples remain covered at sample resolution by the sample-peak floor.

### Verification

| Check | Result |
|---|---|
| Real master vs exact 16× reconstruction | +0.0003 dB |
| Chunk size 0.25 s / 1 s / 5 s | identical to 4 dp |
| DC 0.3 | 0.30000000 exactly |
| Genuine interior step | overshoot preserved |
| Head-trimmed copy vs whole file | identical |
| True peak ≥ sample peak, random signals | holds |
| Coefficients vs `numpy` reference design | bit-identical |

### The residual, and why it is not the filter

For a tone at fs/4 the 4× output grid can land half a step from the true
maximum: `20·log10(cos(2π/32))` = **−0.1685 dB**. Adding taps does not move
this — it is the grid, not the filter, and it is why BS.1770-4 treats 4× as the
*minimum*. Pass `oversample=8` for a tighter bound at twice the cost. On real
programme material the observed error is three orders of magnitude smaller than
this worst case, because music carries little energy near Nyquist.

### Consequence for existing reports

Every report written before this change under-states true peak. Validation
comparisons are unaffected — reference and candidate were always measured with
the same meter — but absolute dBTP figures in archived reports should not be
quoted for delivery compliance. Re-running a master regenerates a correct
figure.

## 20. Known limits of the validator, measured

Recorded so they are not rediscovered. Full evidence in the project document
*Nova Final Master Validator — measured behaviour and known limits*.

1. **`REPRODUCTION_MATCH` cannot exclude a local edit.** A copy with 0.5 s
   spliced in mid-track, length preserved, returned `REPRODUCTION_MATCH` at
   **100.00 confidence** with all twelve metrics inside `MATCH`. Only the PCM
   hash differed. Aggregate statistics over four minutes cannot see half a
   second. `BIT_EXACT` is the only verdict that proves a file was not altered.
   Catching this needs per-segment fingerprinting — a separate feature.
2. **K-weighting changes shape away from 48 kHz.** `_biquad_coefficients()`
   uses the ITU table at exactly 48000 and an RBJ redesign elsewhere; they
   differ by 0.26 dB at 1 kHz and 0.41 dB at 2 kHz. A clean 44.1 kHz resample
   therefore reads `DRIFT_DETECTED` with LUFS moved −0.1344 while RMS moved
   −0.0000. Not addressed in 2.6.0: making the designs agree would shift every
   LUFS reading the pack has ever produced.
3. **Band tolerances are absolute percentage points.** HF holds ~2.2% of total
   energy, so a ±0.500 pp tolerance leaves low-energy bands effectively
   unmonitored. A 128 kbps round trip was caught by the level metrics, not the
   bands.
4. **Drift attribution is a hint.** The same 128 kbps transcode was attributed
   to "a gain or level-processing change", because the codec rule requires HF
   drift *with stable loudness* and loudness had moved.

## 21. First-run onboarding — the database a new user does not have

Nova SQLite Reader requires an existing `.db` with a table shaped a particular
way. A new user has none, and until 17 Sep nothing in the pack could make one:
no sample database shipped, nothing writes a table (Nova SQL Dump writes only
canvas snapshots), and the one affordance that looks like help —
`new_database_folder` / `new_database_name` — creates an **empty file with no
table**, then returns 0 rows with `"Created a new, empty database."` It looks
like it worked and gives nothing.

The node's help page opened with *"Opens a SQLite database read-only"*, which
answers a question the stuck user is not asking. They do not abandon the pack
because a feature is hard; they abandon it because they cannot reach a first
success.

### What shipped

1. **`examples/nova_album_example.db`** — 8 KB, one `albums` table, 39 columns
   carrying both families (the tag names Nova Tag Writer writes and the field
   names Nova Master Identity reads), three deliberately fake rows
   (`Example Artist`, `ZZ-EXA-26-00002`) so it cannot be shipped by accident.
   Verified through the node: `column_set tags` returns 3 × 14, `identity` on
   one row returns the full field set.
2. **The help page now opens with "Start here if you don't have a database"** —
   copy the example, point at it, run, three rows come back, nothing has touched
   your audio. Then DB Browser for SQLite, and the one rule that matters:
   `FileName` must match the file on disk.
3. **A `NO DATABASE YET? START HERE` block** at the top of the Tag Writer note.

The `where` section is now framed as *"Your first line of SQL, whether you meant
to write one or not"*: `Album = 'Example Album'` taught as a sentence rather than
syntax, closing with the fact that makes people experiment — getting it wrong
cannot damage anything, because the database is opened read-only and the node
rejects anything that writes.

### Still on the table

The reader already builds the exact statement it runs (`sql = f"SELECT
{projection} FROM {_quote(table)}"`) and stores it in the payload, then never
shows it. Surfacing that string as an appended output is the cheapest teaching
device available and needs no new node: a user who types a filter and then reads
the full `SELECT` built from their own action has learned SQL without being
taught. Held for 2.7 alongside a small SQLite manager node.

## 22. `column_set` preset picked the wrong column — `nova_sqlite_reader.py`

The presets matched a wanted column name against the table by normalising away
case and punctuation. On a table carrying both families at once — `Track Number`
for the tag and `track_number` for the Identity field — both normalise to
`tracknumber`, the lookup dictionary kept whichever came last, and the `tags`
preset selected the Identity column. Writing that to a file produces a tag
literally named `track_number`.

Exact spelling is now tried before the normalised match, so `tags` takes
`Track Number` and `identity` takes `track_number`. Verified both ways against a
39-column table. The bug only appears on a table carrying both families, which
is exactly the table the mastering flow asks users to build.

## 23. Node colours by role — `web/nova_node_colours.js`

Every node in the pack now carries a default colour chosen by **the role it
plays in a flow**, not by its menu sub-category. Several templates draw every
node from one sub-category — the Tag Writer template is entirely Delivery &
Metadata — so colouring by menu renders those flows one flat colour and tells
the reader nothing. Role is the distinction the eye is looking for.

The full table lives in `docs/node-colours.md`. In short: green input, brown
data, purple generation, blue process, yellow identity, cyan analysis, red
writes-to-disk, pale_blue view, black plumbing. 28 of 28 nodes, cross-checked
against `NODE_CLASS_MAPPINGS` so no node is missed and no colour points at a
node that does not exist.

Two choices that are not obvious. **Nova Tag Writer is red**, with the saves,
not brown with the database nodes: it reads like a data node and is fed by one,
but it edits audio files **in place**, and the colour should say so before the
run rather than after. **Nova Master Identity has yellow to itself** — one node,
but it is the hinge of the provenance chain between the blue master and the
cyan validator.

### Compliance and blast radius

Colours come from `LGraphCanvas.node_colors`, the nine the right-click menu
offers, read out of the installed `comfyui_frontend_package` rather than
recalled — so a node coloured here is indistinguishable from one coloured by
hand, and the palette matches core ComfyUI.

`beforeRegisterNodeDef` returns immediately for any node not in the map, so no
other pack's nodes are read or modified (§6). The values are set on
`nodeType.prototype`, not the instance: LiteGraph serialises a user's colour
onto the node instance, and an instance property shadows the prototype, so a
hand-coloured node survives save and reload. The default only fills in where
the user has not chosen.

A toggle sits at **Settings → Nova Audio → Appearance → "Colour nodes by
role"**, defaulting on, for people running themes. If the settings API ever
changes shape the check falls back to "on" rather than letting an exception
escape into node registration — a cosmetic extension must not be able to stop
nodes registering.

### Browser verification

First browser run, 17 Sep: colours appeared on workflow-loaded nodes but
**not** on nodes added fresh from the menu. That is what exposed the
prototype-versus-static bug below.

**Confirmed after the fix, 17 Sep.** Nodes dragged straight from the menu come
up in their role colour with no stored value behind them: Save Audio WAV red,
Nova Audio Master blue, Madow Unpack purple, Nova Player and Nova Track
Inspector Report pale_blue.

To confirm before tagging:

* the toggle appears under Settings -> Nova Audio -> Appearance
* a hand-coloured node keeps its colour across save and reload
* the console carries no `[Nova Node Colours]` warning

`addSetting` and `beforeRegisterNodeDef` fail independently, so colours working
does not prove the setting registered.

### Template colours were stored, not inherited

Five of the seven shipped templates had no stored colour on any Nova node and
picked up the scheme on reload. Two did not: **Mastering Process** carried its
own colour on NovaAudioMaster, NovaFinalMasterValidator, NovaLoadAudio and
NovaMasterIdentity, and **LoRA Pre-Processor** on NovaConsole and
NovaACESetupCheck. Those six pairs were stripped from the JSON (Notes and core
nodes untouched, timestamped backups alongside).

The menu cannot do this. `setColorOption(null)` on a node assigns
`this.color = undefined` rather than deleting the property, so "No color"
yields plain grey. Groups differ: theirs is a real `delete`.

### The first attempt set the wrong thing

Colours were first applied to `nodeType.prototype`. Nodes loaded from a
workflow appeared to take them; nodes added fresh from the menu did not.

`LGraphNode` declares `color` and `bgcolor` as **class fields**, so every
instance owns an `undefined` for both, and an own property — even one holding
`undefined` — shadows the prototype. A prototype colour is therefore never
read. The renderer resolves colour as

```
this.color || this.constructor.color || LiteGraph.NODE_DEFAULT_COLOR
```

so the supported place for a type default is a **static on the class**:
`nodeType.color`, not `nodeType.prototype.color`. Fixed.

This is better than the prototype would have been even if it had worked. The
instance field stays `undefined` until a user picks a colour, so serialisation
(`this.color && (o.color = this.color)`) writes nothing: saved workflows carry
no colour and pick the scheme up live, and a later change to the scheme reaches
workflows already saved. The six colours stripped from the two templates above
are still the right call — they were real stored values that would have
overridden the scheme forever.

### New files, therefore untracked

`web/nova_node_colours.js` and `docs/node-colours.md` are new and will not
publish until they are staged. This is exactly what checklist item 10 exists to
catch.

