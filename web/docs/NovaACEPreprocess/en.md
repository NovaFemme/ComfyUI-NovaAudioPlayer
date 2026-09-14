# Nova ACE Preprocess

Runs ACE-Step's own two-pass tensor generation over a Nova dataset, producing
the `.pt` files its LoRA trainer consumes. **This prepares training data; it
does not train.**

## Why it wraps rather than reimplements

The `.pt` schema is not a published contract — it is whatever
`acestep/training_v2/preprocess.py` writes today (currently `target_latents`,
`attention_mask`, `encoder_hidden_states`, `encoder_attention_mask`,
`context_latents`, `metadata`). A reimplementation would drift the first time
upstream changes a key, and the failure would be silent: training runs, the
loss falls, the LoRA is quietly wrong. Calling their writer stays correct for
free.

## What you need first

**The ACE-Step source.** This node never installs or downloads anything —
runtime package installation is prohibited by the Comfy Registry standards.
Clone `https://github.com/ace-step/ACE-Step-1.5` and either install it into
ComfyUI's Python environment, or point `acestep_repo_path` at the clone.

**A HuggingFace-format checkpoint tree.** This is the part that surprises
people who already "have the models": the preprocessor loads with
`from_pretrained`, so it needs *directories*, and ComfyUI's single-file
`.safetensors` will not work. Expected layout:

    <checkpoint_dir>/
      acestep-v15-xl-sft/        <- the variant you select
      vae/
      Qwen3-Embedding-0.6B/
      silence_latent.pt

Variants map as: `xl_sft` → `acestep-v15-xl-sft`, `xl_turbo` →
`acestep-v15-xl-turbo`, `xl_base` → `acestep-v15-xl-base`, and the non-XL
`sft` / `turbo` / `base` likewise.

The tree is validated **before** any model loads, so a wrong path costs a
second rather than a multi-gigabyte load followed by a traceback.

## Inputs

| Widget | Purpose |
|---|---|
| `dataset_json` | From Nova ACE Dataset Builder. Its `audio_path` fields locate the audio. |
| `output_dir` | Where the `.pt` tensors go. |
| `checkpoint_dir` | The HuggingFace checkpoint tree above. |
| `variant` | Which checkpoint to encode against — match the model you will train. |
| `max_duration` | Longer audio is truncated. More seconds means more VRAM. |
| `device` / `precision` | `auto` detects. On ROCm the device is still called `cuda`; `bf16` matches the bf16 checkpoints. |
| `acestep_repo_path` | Optional. Prepended to `sys.path` when the package is not installed. |

## Outputs

`tensor_dir`, `processed`, `failed`, `console`.

## Notes

- **Resumable.** Existing `.pt` files are skipped, so a cancelled run continues
  where it stopped.
- **Two passes.** Pass 1 loads the VAE and text encoder (~3 GB); pass 2 loads
  the DIT encoder (~6 GB). They are loaded and unloaded separately, which is
  why peak VRAM is lower than loading everything at once.
- ACE-Step's guidance: 16 GB VRAM is workable, 20 GB+ comfortable for
  full-length songs.
- Per-file Pass 1 / Pass 2 errors go to the ComfyUI console, not the node.
