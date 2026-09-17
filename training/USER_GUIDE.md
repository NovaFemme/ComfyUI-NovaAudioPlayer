# Nova ACE LoRA Training — user guide

Five nodes take a folder of tagged audio masters and produce a trained
ACE-Step LoRA. They live under **▶️ Nova Audio → 🎓 LoRA Training**.

```
Nova ACE Setup Check 🩺        (run this first — reports, changes nothing)

Nova Batch Load Audio 🎼
        │ files
        ▼
Nova ACE Dataset Builder 🧱 ──▶ Nova ACE Dataset Review 🔍   (optional check)
        │ dataset_json
        ▼
Nova ACE Preprocess 🧮
        │ tensor_dir
        ▼
Nova ACE LoRA Trainer 🎓 ──▶ <output_dir>/final/
```

Every node has a help page behind the **❓** button on its title bar, covering
the same ground as this guide but node by node.

These nodes **install nothing and download nothing**. Everything in section 1
has to be in place first; if something is missing, the node tells you exactly
what and stops before spending any GPU time.

---

## 0. The short way

`training/nova_ace_setup.py` does everything in section 1 and 2 for you. Run it
with any Python 3.10+; it finds ComfyUI's own interpreter itself.

```
python nova_ace_setup.py --dry-run     # show the plan, change nothing
python nova_ace_setup.py               # do it, asking once
```

It works out whether your PyTorch is CUDA, ROCm, XPU or CPU and installs the
matching torchcodec; installs the packages ACE-Step's training path needs;
clones ACE-Step 1.5; builds the checkpoint tree; and finishes by printing the
paths to paste into each node.

Two things it does that are worth knowing:

- **It never touches PyTorch.** Every install runs against a constraints file
  pinning the torch already present, so nothing can decide your ROCm or CPU
  build is wrong and swap it. (Never run `pip install -r requirements.txt` from
  the ACE-Step clone yourself — that pins `torch==2.10.0+cu128`.)
- **It reuses weights you already have.** If ComfyUI holds an ACE-Step
  `.safetensors` for your variant, it compares that file's tensor names against
  the Hugging Face shard index and links it instead of downloading ~20 GB
  again — but only if they match exactly.

Useful flags: `--variant`, `--extras adamw8bit,prodigy,lokr`, `--with-inference`,
`--no-reuse`, `--skip-packages`, `--yes`.

It ends by running the node pack's **own** checks against what it built, so
"setup says OK" and "the nodes say OK" are the same statement.

If you installed the pack through ComfyUI-Manager, `install.py` has already
done the package half for you — only the models are left.

**To check without leaving ComfyUI**, drop in **Nova ACE Setup Check 🩺** and
wire it to a Nova Console. It reports the same things the script does — the
checkpoint tree, the checkpoint's remote-code imports, torchcodec, the training
packages and the optional ones — and outputs a `ready` boolean. It installs
nothing; it tells you the command.

The rest of this guide is what the script automates, for when you'd rather do
it by hand or something goes wrong.

---

## 1. Before you start

### Hardware

A GPU with **12 GB VRAM or more**. A reference run — six tracks, rank 32, 300 s
maximum per track — peaked at **11.3 GiB**. Longer audio needs more: VRAM scales
with the length of the longest track, not with how many tracks you have.

Works on CUDA and on AMD ROCm. On ROCm, set `device` to `cuda` or `auto` — that
is what PyTorch calls the GPU regardless of vendor.

### ACE-Step 1.5

Clone it somewhere. It is not installed by these nodes.

```
git clone https://github.com/ace-step/ACE-Step-1.5
```

You do not need to `pip install` it — you can point the nodes at the clone
instead (path **C** below).

### Python packages

Two commands, run once, into **ComfyUI's own Python**. Substitute your venv
path. If your venv was made with `uv` it will have no `pip` in it, so use the
`uv pip` form:

```bash
# with pip
<venv>/bin/python -m pip install --no-deps \
    vector_quantize_pytorch einx frozendict torch-einops-utils tensorboard

# with uv (no pip in the venv)
<venv>/bin/uv pip install --python <venv>/bin/python --no-deps \
    vector_quantize_pytorch einx frozendict torch-einops-utils tensorboard
```

`--no-deps` is deliberate — it stops the resolver deciding your PyTorch build is
wrong and replacing it. Those four packages are pure Python.

`tensorboard` is optional but strongly recommended; without it you get no loss
curve, and the per-epoch numbers in the console are too noisy to judge by.

**On ROCm, Intel, or CPU-only PyTorch, also fix torchcodec:**

```bash
<venv>/bin/uv pip install --python <venv>/bin/python --no-deps --reinstall \
    --index-url https://download.pytorch.org/whl/cpu torchcodec
```

The torchcodec on PyPI is a CUDA build and cannot load against a non-CUDA
PyTorch, which breaks all audio decoding. The `+cpu` build works everywhere —
decoding is CPU work either way.

### Your audio

FLAC, WAV or any format PyAV reads. What matters is the **tags**:

| Tag | Used for | If missing |
|---|---|---|
| `comment` / `description` / `title` | the caption the model trains against | falls back to the filename — a weak prompt |
| `lyrics` / `unsyncedlyrics` | lyric conditioning | the track is marked **instrumental** |

That second one matters more than it looks. A vocal track with no lyrics tag is
trained as an instrumental, which teaches your trigger word that the style has
no singing. If your tracks have vocals, tag the lyrics.

Six to twelve tracks is a sensible dataset. Three works but overfits fast.

---

## 2. The checkpoint tree

`checkpoint_dir` must point at a **HuggingFace-layout folder tree**. ComfyUI's
single-file `.safetensors` will not work — the loaders use `from_pretrained`,
which needs directories.

Required layout:

```
<checkpoint_dir>/
├── acestep-v15-xl-sft/          ← the variant folder
│   ├── config.json
│   ├── configuration_acestep_v15.py
│   ├── modeling_acestep_v15_xl_base.py
│   ├── apg_guidance.py
│   ├── model.safetensors        ← ~9.3 GB
│   └── silence_latent.pt
├── vae/                          ~322 MB
│   ├── config.json
│   └── diffusion_pytorch_model.safetensors
└── Qwen3-Embedding-0.6B/         ~1.2 GB
    ├── config.json
    ├── model.safetensors
    ├── tokenizer.json
    └── …
```

The variant folder name is chosen by the `variant` dropdown:

| `variant` | folder |
|---|---|
| `xl_sft` | `acestep-v15-xl-sft` |
| `xl_turbo` | `acestep-v15-xl-turbo` |
| `xl_base` | `acestep-v15-xl-base` |
| `sft` | `acestep-v15-sft` |
| `turbo` | `acestep-v15-turbo` |
| `base` | `acestep-v15-base` |

`silence_latent.pt` may sit at the tree root instead of inside the variant
folder; both are found.

### If you already have the weights in ComfyUI

If ComfyUI already holds `acestep_v1.5_xl_sft_bf16.safetensors` in
`models/diffusion_models/`, you do not need to download the ~9.3 GB again.
Symlink it into the variant folder under the name `model.safetensors`:

```bash
cd <checkpoint_dir>/acestep-v15-xl-sft
ln -s ../../diffusion_models/acestep_v1.5_xl_sft_bf16.safetensors model.safetensors
```

Use a **relative** link as shown. An absolute path works too, but a relative one
survives the folder being moved.

You still need the `.py` files, `config.json` and `silence_latent.pt` from the
HuggingFace repo — they are about 110 KB in total.

---

## 3. Paths worksheet

Decide these six once. Everything else follows.

| | What | Example |
|---|---|---|
| **A** | Folder holding your tagged masters | `~/Music/Nova Audio Masters/Albums/High Water Sessions/LORA_MASTER_SET` |
| **B** | Checkpoint tree root | `~/ComfyUI/models/acestep` |
| **C** | ACE-Step clone | `~/ComfyUI/models/acestep/ACE-Step-1.5` |
| **D** | Dataset JSON to write | `~/Datasets/High Water Sessions/dataset.json` |
| **E** | Tensor output folder | `~/Datasets/High Water Sessions/tensors` |
| **F** | Training output folder | `~/Datasets/High Water Sessions/lora_final` |

**D, E and F should be three different places.** In particular F must not be E —
the trainer writes `final/`, `checkpoints/` and `runs/` into F, and mixing those
into your tensor folder makes both awkward to clear and re-run. The node warns
you if you do it anyway.

### Where each one goes

| Node | Field | Path |
|---|---|---|
| Nova Batch Load Audio | `folder_path` | **A** |
| Nova ACE Dataset Builder | `dataset_json_path` | **D** |
| Nova ACE Preprocess | `output_dir` | **E** |
| | `checkpoint_dir` | **B** |
| | `acestep_repo_path` | **C** |
| Nova ACE LoRA Trainer | `output_dir` | **F** |
| | `checkpoint_dir` | **B** |
| | `acestep_repo_path` | **C** |
| Nova ACE Setup Check | `checkpoint_dir` | **B** |
| | `acestep_repo_path` | **C** |

`dataset_json` on Preprocess and `tensor_dir` on the Trainer are **wired from
the node above**, not typed. Leave them alone.

Fill `acestep_repo_path` on **both** Preprocess and the Trainer. The Trainer can
usually find ACE-Step on its own, but only if Preprocess ran first in the same
ComfyUI session; filling it in makes the Trainer work standalone too.

### One rule above all the others

**`variant` must be identical on Preprocess, the Trainer and the Setup Check.**

The `.pt` tensors are encoded against one specific set of weights. Train them
against a different variant and nothing errors: the run completes, the loss
falls, and the adapter is quietly worthless. There is no check that can catch
this for you after the fact, because both halves are individually valid.

If you change `variant`, delete the tensor folder and re-run Preprocess.

---

## 4. Node by node

### Nova ACE Setup Check 🩺

Queue this before anything expensive. It answers one question — *would a
preprocess or training run start on this machine?* — in about a second, and
never installs, downloads or spawns anything.

| Field | Set to | Notes |
|---|---|---|
| `checkpoint_dir` | **B** | leave empty to check everything except the tree |
| `variant` | `xl_sft` | the variant you intend to train |
| `acestep_repo_path` | **C** | optional here, but see below |

Wire `console` into a **Nova Console**. The `ready` boolean is true only when
nothing would stop a run; advisories such as "no tensorboard" do not clear it.

Two of its checks call the *same functions* Preprocess and the Trainer call, so
a green result means those nodes will not stop on the same grounds. It also asks
questions they never do: which compute backend torch was built for, whether the
GPU is visible, whether the optimizer you chose is installed.

**A NOT READY on the checkpoint tree is usually a variant mismatch**, not a
broken install — check that `variant` here matches Preprocess and the Trainer
before downloading anything.

Anything missing is collected into a single install command using `pip` or `uv`,
whichever your environment actually has. Packages ComfyUI itself ships are never
suggested: if `torch` shows as missing that is a broken ComfyUI or the wrong
interpreter, and `pip install --no-deps torch` would make it considerably worse.

### Nova Batch Load Audio 🎼

| Field | Set to | Notes |
|---|---|---|
| `folder_path` | **A** | |
| `file_filter` | `*.flac` | or `*.wav`, etc. |
| `recursive` | `false` | `true` to include subfolders |
| `sort_by` | `name` | |
| `limit` | `0` | 0 = no cap. A non-zero value silently truncates your dataset |
| `decode_audio` | `false` | leave off — the dataset builder reads tags, not waveforms. Decoding here just wastes time and RAM |

### Nova ACE Dataset Builder 🧱

| Field | Set to | Notes |
|---|---|---|
| `dataset_json_path` | **D** | parent folders are created |
| `trigger_word` | your token | e.g. `crazygecko`. Pick something rare that you will type at inference. Written to every sample |
| `tag_position` | `prepend` | where the trigger sits relative to the caption. `replace` trains on the trigger alone |
| `prompt_source` | `caption` | or `genre`, to train against the genre tag instead |
| `caption_tags` | `comment, description, title` | tried in order; **first one with content wins** |
| `lyrics_tags` | `lyrics, unsyncedlyrics` | empty result ⇒ the sample is marked instrumental |
| `write_sidecars` | `false` | `true` also writes `.lyrics.txt` / `.json` beside each file, the layout ACE-Step's own Gradio UI expects |

**Check its output before going further:**

```
instrumental     : 0
without a caption: 0
```

Both should be `0` for vocal music. If `instrumental` equals your track count,
the lyrics tags are missing — fix the files, don't train around it.

### Nova ACE Dataset Review 🔍 (optional)

Wire `dataset` from the builder. Flags samples shorter than `min_duration`,
longer than `max_duration`, or missing a caption. Purely a report; it changes
nothing.

### Nova ACE Preprocess 🧮

Encodes each track into a `.pt` tensor. Two passes — VAE plus text encoder,
then the DIT encoder — with models loaded and unloaded around each, so peak
VRAM is one model rather than three.

| Field | Set to | Notes |
|---|---|---|
| `dataset_json` | *wired* | from the Dataset Builder |
| `output_dir` | **E** | |
| `checkpoint_dir` | **B** | |
| `variant` | `xl_sft` | must match what you train against |
| `max_duration` | `300` | **see below** |
| `device` | `auto` | |
| `precision` | `bf16` | matches the bf16 checkpoints |
| `acestep_repo_path` | **C** | |

**`max_duration` silently truncates.** Anything longer than this is cut, and
nothing in the log says which tracks lost their ending. Set it above your
longest track. 300 s covers most songs; check the durations the Dataset Builder
printed.

**Existing `.pt` files are skipped.** That makes a cancelled run resumable — but
it also means that if you change your tags or `max_duration` and re-run, the old
tensors are kept. **Delete the tensor folder when you change anything upstream.**

Expect roughly 25–30 seconds for a handful of tracks; it is dominated by loading
the models, not by the audio.

### Nova ACE LoRA Trainer 🎓

Runs as a **separate process**. You can cancel it from the ComfyUI UI, it cannot
crash the server, and all VRAM comes back when it exits. Per-epoch progress goes
to the **terminal**, not the node.

| Field | Set to | Notes |
|---|---|---|
| `tensor_dir` | *wired* | from Preprocess |
| `output_dir` | **F** | not E |
| `checkpoint_dir` | **B** | must be the same tree the tensors were encoded against |
| `variant` | `xl_sft` | same as Preprocess |
| `preset` | `recommended` | see §5 |
| `rank` / `alpha` | `32` / `64` | `0` = take from preset |
| `learning_rate` | `0` | `0` = from preset (1e-4) |
| `epochs` | see §5 | |
| `batch_size` | `0` | = 1 from preset |
| `gradient_accumulation` | see §5 | |
| `save_every` | `25` | checkpoint every N epochs |
| `optimizer` | `from preset` | `adamw8bit` needs `bitsandbytes`; `prodigy` needs `prodigyopt` |
| `gradient_checkpointing` | `from preset` | on = ~40–60% less VRAM, ~10–30% slower |
| `device` / `precision` | `auto` / `bf16` | |
| `dry_run` | `false` | **set `true` for the first queue** |
| `warmup_steps` | see §5 | in **optimizer steps**, not epochs |
| `acestep_repo_path` | **C** | |
| `resume_from` | empty | a checkpoint folder, to continue a run |

**On every numeric field, `0` means "use the preset's value".** It is not a
literal zero. The run banner prints an `Overrides` line naming everything you
actually changed.

**Run once with `dry_run` on.** It performs every check and prints the exact
command without starting anything. Cheap insurance before an hour of GPU time.

---

## 5. Choosing epochs, accumulation and warmup

This is the part that most often goes wrong, because **epochs are not steps**.

```
batches per epoch = number of tracks ÷ batch_size
steps per epoch   = batches per epoch ÷ gradient_accumulation   (rounded up)
total steps       = steps per epoch × epochs
```

With 6 tracks, `batch_size 1` and `gradient_accumulation 2`, that is 3 optimizer
steps per epoch — so 200 epochs is 600 steps, not 200.

This matters because **`warmup_steps` counts optimizer steps**, and every shipped
preset sets it to 100. On a small dataset that can be longer than the entire
run: the learning rate then ramps from zero the whole way and never decays, and
you have trained inside your own warmup.

**Rule of thumb: `warmup_steps` ≈ 10% of total steps.**

The node computes this for you and prints it:

```
Steps      : 3/epoch x 200 epochs = 600 optimizer steps, warmup 60
```

If anything is wrong it adds a `Note:` under that line. **No notes means the
schedule is sane.** Starting points:

| Tracks | `gradient_accumulation` | `epochs` | `warmup_steps` | Total steps | Rough time |
|---|---|---|---|---|---|
| 3–4 | 1 | 150 | 45 | ~450 | ~35 min |
| 6 | 2 | 200 | 60 | 600 | ~55 min |
| 10–12 | 2 | 150 | 75 | ~750–900 | ~1.5–2 h |

### Tiers, fastest to longest

For a **6-track** set, `batch_size` 1 and `gradient_accumulation` 2 unless noted.

| Tier | `preset` | rank/alpha | `epochs` | ga | `warmup_steps` | `save_every` | Steps | Time |
|---|---|---|---|---|---|---|---|---|
| 1 smoke test | `quick_test` | 16 / 32 | 10 | 4 | 2 | 5 | 20 | ~2 min |
| 2 fast draft | `recommended` | 16 / 32 | 60 | 2 | 18 | 15 | 180 | ~16 min |
| 3 balanced | `recommended` | 32 / 64 | 200 | 2 | 60 | 25 | 600 | 53 min |
| 4 strong | `recommended` | 64 / 128 | 400 | 2 | 120 | 50 | 1200 | ~1 h 45 |
| 5 maximum | `high_quality` | 128 / 256 | 800 | 2 | 240 | 100 | 2400 | ~3 h 30 |

**Tier 3 is measured**, not estimated: 6 FLAC masters, 22.7 min of audio,
`xl_sft`, bf16, gradient checkpointing on, AMD RX 9070 XT — 53 m 06 s, peak
11.3 GiB, 80.1 MiB adapter. Every other time is that run scaled by step count
(~5.3 s/step).

**Step time is set by the base model, not by rank.** Rank 16 and rank 128 cost
about the same per step; rank buys capacity, VRAM and file size, not minutes.
Adapter size runs about 2.5 MiB per rank point (80 MiB at rank 32). Expect
roughly +1.5 GiB of VRAM going from rank 32 to 128 — estimated, not measured.

Tier 1 is a pipeline test, not a LoRA: it proves the paths, the checkpoint and
the tensors before you commit an afternoon. Start real work at tier 3, and only
go higher when tier 3 clearly underfits — the style does not come through even
with the trigger word.

### If your GPU is smaller

The `vram_*` presets are starting points. All four still ship `epochs: 100` and
`warmup_steps: 100`, so override both using the arithmetic above.

| `preset` | VRAM | rank/alpha | bs | ga | optimizer | offload encoder |
|---|---|---|---|---|---|---|
| `vram_8gb` | < 10 GB | 16 / 32 | 1 | 8 | `adamw8bit` | yes |
| `vram_12gb` | 10–16 GB | 32 / 64 | 1 | 4 | `adamw8bit` | yes |
| `vram_16gb` | 16–24 GB | 64 / 128 | 1 | 4 | `adamw` | no |
| `vram_24gb_plus` | 24 GB + | 128 / 256 | 2 | 2 | `adamw` | no |

`adamw8bit` needs `bitsandbytes`; `prodigy` needs `prodigyopt`. Both are checked
before the run starts.

Epoch time scales with total audio, not track count — about **0.7 seconds per
second of audio per epoch** on a 9070 XT.

**Rank.** `32` / alpha `64` is a good default for under ten tracks. Rank 64 is
83 M trainable parameters against a handful of songs and memorises rather than
generalises. Alpha is conventionally twice rank.

---

## 6. What a good run looks like

```
Steps      : 3/epoch x 200 epochs = 600 optimizer steps, warmup 60
…
[OK] Epoch 1/200 in 27.0s, Loss: 1.1471
[OK] Epoch 2/200 in 15.7s, Loss: 1.0729
…
[OK] Checkpoint saved at epoch 25
…
[OK] Training complete! LoRA saved to …/lora_final/final
```

The first epoch is always slower — that is model loading.

Output layout:

```
<F>/
├── final/                        ← the finished adapter, ~80 MB at rank 32
│   ├── adapter_config.json
│   └── adapter_model.safetensors
├── checkpoints/
│   └── epoch_25_loss_0.8500/     ← ~241 MB each; they carry optimizer state
└── runs/                         ← TensorBoard
```

**Watch the disk.** Eight checkpoints is about 1.9 GB. Delete the ones you don't
keep.

### Judging it

Don't. Not from the loss, anyway. The diffusion loss is dominated by which
random timestep was drawn, so it is extremely noisy and usually flattens long
before the model stops improving. In the reference run it dropped 0.99 → 0.80
over the first 50 epochs and then moved 0.02 across the next 150.

The numbers in checkpoint folder names — `epoch_150_loss_0.7362` versus
`epoch_175_loss_0.8163` — are single noisy epoch averages, **not a ranking**.

Pick by listening. Same prompt, same seed, three renders: no LoRA, an early
checkpoint, and `final`. Include your trigger word in the prompt. If they all
sound identical the LoRA isn't loading; if `final` sounds smeared or repetitive,
step back to an earlier checkpoint.

---

## 7. Troubleshooting

**`Could not load this library: …/torchcodec/libtorchcodec_image.so`**
The CUDA torchcodec on a non-CUDA PyTorch. Install the `+cpu` build (§1). The
node can work around it automatically, and says so in its banner when it does.

**`the acestep-v15-xl-sft checkpoint needs vector_quantize_pytorch`**
Run the package install from §1, then restart ComfyUI.

**`the checkpoint directory is missing vae/, Qwen3-Embedding-0.6B/`**
`checkpoint_dir` is pointing at a single `.safetensors` file or the wrong
folder. It needs the tree in §2.

**`cannot find ACE-Step's training code`**
Fill `acestep_repo_path` (**C**) on the Trainer. The Trainer runs as a separate
process and does not inherit paths that another node added.

**`no tensor directory` / `holds no .pt tensors`**
Preprocess hasn't run, or reported `processed: 0`. Check its output.

**Training exits in under a minute with no `final/` folder**
ACE-Step catches its own exceptions and still exits 0, so the exit code cannot
be trusted. The node knows this and prints the child's `[FAIL]` lines and the
last 25 lines of output whenever no adapter appears. Read those.

**`instrumental : 6` when your tracks have vocals**
No lyrics tags. Fix the files, then delete the tensor folder and re-run
Preprocess — old tensors are skipped, not rebuilt.

**Out of memory**
Lower `max_duration` and re-preprocess (delete the tensors first), or lower
`rank`, or set `gradient_checkpointing` to `on`. VRAM is driven by your longest
track. Or drop a `vram_*` tier (§5).

**Setup Check says NOT READY — the checkpoint tree is incomplete**
Nine times out of ten its `variant` is set to something other than the one you
downloaded. Check that before fetching another 20 GB.

**The LoRA trains fine but does nothing at generation time**
Three candidates, in order of likelihood. You did not include the trigger word
in the prompt. The `variant` you trained differs from the one you are generating
with — a LoRA is not portable across variants. Or `trigger_word` was left empty
in the Dataset Builder, in which case there is no token to invoke and the log's
`Trigger :` line said `(none — the LoRA will have no trigger word)`.

**The style does not come through**
Raise `rank` first (32 → 64), then `epochs`. Raising `learning_rate` is the last
resort, not the first.

**Everything it generates sounds the same**
Overfit. Fewer epochs, or drop `learning_rate` to 5e-5 and keep the epochs.

---

## 8. Changing something and re-running

The order matters, because two stages cache:

| Changed | Do this |
|---|---|
| tags, trigger word, caption source | re-run Dataset Builder → **delete the tensor folder** → re-run Preprocess → train |
| `max_duration`, `variant`, `precision` | **delete the tensor folder** → re-run Preprocess → train |
| rank, epochs, learning rate, warmup | just re-run the Trainer — tensors are unaffected |

Point `output_dir` (**F**) at a new folder for each training run, so you can
compare them rather than overwrite.
