# Nova ACE LoRA Trainer

Runs ACE-Step's LoRA training loop over the tensors from **Nova ACE Preprocess**
and writes a finished adapter. **It trains; it does not preprocess.** Wire
`tensor_dir` from Preprocess rather than typing it.

## It runs as a child process, and that is deliberate

A LoRA run is hours long and owns the GPU. In-process it would block ComfyUI's
execution queue for the whole run, an out-of-memory inside the training loop
would take the server down with it, and fragmented VRAM would never be returned
to the allocator.

As a separate process it is cancellable from the ComfyUI UI, it cannot crash the
server, and all VRAM comes back when it exits. ComfyUI's own models are unloaded
before the child starts.

It re-invokes the same Python interpreter ComfyUI is running under —
`python -m acestep.training_v2.cli.train_fixed` — as an argument list, with no
shell and no external binary. **It installs nothing.** Runtime package
installation is what the Comfy Registry standards prohibit; every `pip install`
you will find in this node's source is inside a message telling you what to run
yourself.

**Per-epoch progress goes to the terminal, not to the node.**

## What you need first

Everything below must already be in place. Nothing here is downloaded or
installed, and each check runs *before* any GPU time is spent.

**Tensors.** From Nova ACE Preprocess, encoded against the same
`checkpoint_dir` and `variant` you train with.

**The ACE-Step source.** Clone `https://github.com/ace-step/ACE-Step-1.5`.
Fill `acestep_repo_path` here even if you filled it on Preprocess — the child
process does not inherit a `sys.path` entry another node added, so leaving it
empty only works when Preprocess ran first in the same session.

**A HuggingFace-layout checkpoint tree**, the same one Preprocess used.

**The XL checkpoints need packages ComfyUI does not ship.** They load through
`trust_remote_code`, and that modeling file imports `vector_quantize_pytorch`
(plus `einx`, `frozendict`, `torch-einops-utils`). The node checks for them
first and prints the exact command; upstream would only discover this in pass 2,
after spending GPU time on every file in your dataset.

**`tensorboard` is optional but worth having.** Without it there are no loss
curves. The banner says so when it is missing.

## Presets, and what `0` means

Pick a `preset`, then override only what you want changed.

**On every numeric widget, `0` is a sentinel meaning "take this from the
preset".** It is not a literal zero — there is no such thing as a run with zero
epochs. The run banner prints an `Overrides` line naming everything you actually
changed, so you can see at a glance what the preset gave you and what you did
not.

`optimizer` and `gradient_checkpointing` use `from preset` for the same purpose.
`adamw8bit` needs `bitsandbytes` and `prodigy` needs `prodigyopt`; both are
checked before the run starts and never installed.

## `warmup_steps` counts optimizer steps, not epochs

This is the setting that most often goes wrong, because epochs are not steps:

    batches per epoch = tracks / batch_size
    steps per epoch   = batches per epoch / gradient_accumulation   (rounded up)
    total steps       = steps per epoch * epochs

Six tracks at `batch_size 1` and `gradient_accumulation 2` is **3 optimizer
steps per epoch** — so 200 epochs is 600 steps, not 200.

Every preset ACE-Step ships sets `warmup_steps` to 100. On a small dataset that
can be longer than the entire run: the learning rate ramps from zero the whole
way, never decays, and you have trained inside your own warmup without anything
saying so.

**Rule of thumb: about 10% of total steps.** The node does the arithmetic and
prints it:

    Steps      : 3/epoch x 200 epochs = 600 optimizer steps, warmup 60

A `Note:` under that line means something looks wrong. **No notes means the
schedule is sane.**

| Tracks | `gradient_accumulation` | `epochs` | `warmup_steps` | Total steps |
|---|---|---|---|---|
| 3–4 | 1 | 150 | 45 | ~450 |
| 6 | 2 | 200 | 60 | 600 |
| 10–12 | 2 | 150 | 75 | ~750–900 |

`rank 32` / `alpha 64` suits fewer than ten tracks. Rank 64 is 83 M trainable
parameters against a handful of songs, and it memorises rather than generalises.
Alpha is conventionally twice rank.

## Run `dry_run` first

`dry_run` performs every pre-flight check and prints the exact command without
starting anything. It costs a second and it is the cheapest insurance available
before an hour of GPU time.

## `exit_code` 0 does not mean it worked

Read this before trusting the output.

`FixedLoRATrainer.train()` upstream is a generator whose whole body sits inside
`except Exception: yield TrainingUpdate(kind="fail")` — so a hard failure is
reported as a line of text and the process still exits **0**. A run that
processed zero batches also exits 0.

So the node does not believe the exit code. Its real success test is *"did an
adapter appear in `output_dir/final/`?"*, and when that fails it prints every
`[FAIL]` and `Traceback` line from the child plus the last 25 lines of output,
whatever the exit code said. `exit_code` is still reported honestly as an
output — it is just not the thing to judge by.

**Training that exits in under a minute with no `final/` folder has failed.**
Read the lines the node printed.

## Outputs

| Output | Is |
|---|---|
| `lora_dir` | the finished adapter folder, `<output_dir>/final` |
| `output_dir` | what you passed in, for chaining |
| `exit_code` | the child's exit status — see above |
| `console` | the full captured output |

On disk:

    <output_dir>/
      final/            the adapter, ~80 MB at rank 32
      checkpoints/      ~241 MB each, they carry optimizer state
      runs/             TensorBoard

**Watch the disk.** Eight checkpoints is about 1.9 GB.

`output_dir` must not be your tensor folder. The node warns you if it is.

## Judging the result

Not by the loss. The diffusion loss is dominated by which random timestep was
drawn, so it is extremely noisy and flattens long before the model stops
improving — in a reference run it fell 0.99 → 0.80 over the first 50 epochs and
then moved 0.02 across the next 150. The numbers in checkpoint folder names are
single noisy epoch averages, **not a ranking**.

Pick by listening: same prompt, same seed, three renders — no LoRA, an early
checkpoint, and `final`, with your trigger word in the prompt. If all three
sound identical the LoRA is not loading. If `final` sounds smeared or
repetitive, step back to an earlier checkpoint.

## Re-running

Tensors are unaffected by anything on this node, so changing `rank`, `epochs`,
`learning_rate` or `warmup_steps` means just queueing the Trainer again. Change
anything upstream — tags, trigger word, `max_duration`, `variant`, `precision` —
and the tensor folder has to be **deleted** and Preprocess re-run, because
existing `.pt` files are skipped rather than rebuilt.

Point `output_dir` at a new folder per run so you can compare them instead of
overwriting.

`IS_CHANGED` returns NaN on purpose: a training run is never served from cache.

## Tested where

Verified end to end on Linux with ROCm — 6 tracks, 22.7 minutes of audio, 200
epochs, 600 steps, 53 minutes, peak 11.3 GiB VRAM. **Windows, macOS and CUDA are
untested**, as are cancellation against a live run and `resume_from`.
