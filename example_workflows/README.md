# Example workflows

Seven workflows, grouped the way the node menu is. Each ships twice — a `.json`
and a `.png` template. **Drag either onto the ComfyUI canvas and it loads**; the
PNG carries the whole graph in its metadata, it is not just a picture.

| Group | Workflow | Needs |
|---|---|---|
| **Mastering Process** | Nova Audio Mastering Process | this pack only |
| | Nova Audio Master Comparison Validation | this pack only |
| **Delivery & Metadata** | Nova Audio Tag Reader | this pack only |
| | Nova Audio Tag Writer | this pack only |
| **LoRA Training** | Nova Ace-Step 1.5 LoRA Pre-Processor And Training | this pack + ACE-Step 1.5 |
| **Generation & Synthesis** | Ace-Step XL SFT — Prompt and Lyrics to Audio | ACE-Step models + `easy seed` |
| | Ace-Step XL SFT — …Using Lora | the above + the LoRA |

**Paths in these workflows are written as `~/…` placeholders.** They are
examples of shape, not real locations — point them at your own folders before
running. Nothing is read or written until you do.

---

## Start here: the mastering chain

**Nova Audio Mastering Process** needs no models and no other custom node pack.
Point it at an audio file and run it. It demonstrates the chain the mastering
nodes exist for:

1. **Nova Load Audio** brings the track in.
2. **Nova Audio Master** analyses it and produces a corrected version with a full
   `report_json`.
3. **Nova Master Report Viewer** renders that report in the canvas — and every
   view exports as a PNG from its right-click menu.
4. **Nova Master Identity** turns the report into release and archive identity.
5. **Save Audio WAV** writes the file.
6. **Nova Final Master Validator** answers the question that matters after a
   write: *did the file you saved still reproduce the master you approved?*

That last step is the point. Mastering in memory and writing to disk are two
different operations, and the validator is what catches a file that no longer
matches what you signed off.

**Nova Audio Master Comparison Validation** is the same question asked about a
file you already have — load, compare, validate, listen. Five nodes.

## Delivery & Metadata

**Nova Audio Tag Reader** walks a folder and prints what is actually written on
those files. **Nova Audio Tag Writer** goes the other way: it reads a table out
of SQLite and writes it onto a batch of files, with a dry-run mode that reports
every change without touching anything. Run the reader afterwards to verify.

An example database ships at `examples/nova_album_example.db` so the tag
workflows have something real to read before you point them at your own.

## LoRA Training

**Nova Ace-Step 1.5 LoRA Pre-Processor And Training** runs the full pipeline:
setup check, batch load, dataset build, tensor preprocess, then training.

Run **Nova ACE Setup Check 🩺** first. It answers whether the machine is ready
before you queue anything expensive, and it only reports — it never installs,
downloads or spawns a process. This pack installs nothing at runtime; the
trainer drives a separate ACE-Step 1.5 install.

## Generation & Synthesis

Both generation workflows are built around **Madow Inputs** and **Nova Player**,
with their subgraphs embedded so nothing needs importing separately.

### One other custom node

**`easy seed`** from [ComfyUI-Easy-Use](https://github.com/yolain/ComfyUI-Easy-Use).
Swap it for any seed node — or a plain primitive — if you would rather not
install it.

### ACE-Step 1.5 models

The workflows carry these download URLs, so ComfyUI offers to fetch what is
missing. Placed by hand, they go here:

| File | Folder |
|---|---|
| [`acestep_v1.5_xl_sft_bf16.safetensors`](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_xl_sft_bf16.safetensors) | `models/diffusion_models/` |
| [`qwen_0.6b_ace15.safetensors`](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors) | `models/text_encoders/` |
| [`qwen_4b_ace15.safetensors`](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_4b_ace15.safetensors) | `models/text_encoders/` |
| [`ace_1.5_vae.safetensors`](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors) | `models/vae/` |

### The LoRA

**Southern Blues Rock** is published as a release asset rather than committed
here — it is 80 MiB, and a file that size in the git history would be downloaded
by everyone cloning the repository forever.

**[Download Southern_Blues_Rock.safetensors →](https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer/releases/download/assets-v1/Southern_Blues_Rock.safetensors)**

Put it at:

```
ComfyUI/models/loras/Ace-Step 1.5 XL SFT/Southern_Blues_Rock.safetensors
```

The subfolder matters — that is the path saved in the workflow. Drop it straight
into `models/loras/` instead and the loader will not find it until you repoint
the widget.

| | |
|---|---|
| Base model | ACE-Step 1.5 XL SFT |
| Rank | 32 |
| Precision | BF16 |
| Tensors | 512 — cross-attention and self-attention projections |
| Size | 83,952,640 bytes (80.1 MiB) |
| SHA-256 | `e3226f560b781589cd637f984dd791da0fa7dc5dc4fd9bec177bde005faddc30` |

Verify a download with `sha256sum Southern_Blues_Rock.safetensors`.

---

## A note on the PNGs

The `.png` templates are not published to the Comfy Registry — each one embeds
the same graph its `.json` sibling holds, so shipping both would send every
workflow twice and add 4.8 MB to the archive. An installed pack has every
workflow as `.json`; the PNGs live here on GitHub for previewing.

## More to come

Further workflows and LoRAs will be added here and to the releases page.
