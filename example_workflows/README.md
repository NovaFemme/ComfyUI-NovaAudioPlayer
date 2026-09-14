# Example workflows

Three workflows: two that generate music with ACE-Step 1.5 XL SFT, and one that
masters what comes out of them.

Drag any `.json` onto the ComfyUI canvas to load it.

| Workflow | What it is | Needs models? |
|---|---|---|
| **Ace-Step XL SFT - Prompt and Lyrics to Audio.json** | The base generation workflow. Prompt and lyrics in, measured audio out. | yes |
| **Ace-Step XL SFT - Prompt and Lyrics to Audio Incl Lora.json** | The same graph with a LoRA loader in the model chain. | yes, plus the LoRA |
| **Nova Audio Mastering Workflow.json** | Load a finished track, master it, check the master survived the file write, and save it. | no |

---

## The generation workflows

Both are built around **Madow Inputs** and **Nova Player**, and both are
self-contained — three embedded subgraphs each (the model and latent chain, the
prompt and lyrics text, and sampling through to a tiled VAE decode), so nothing
needs importing separately. The Nova Player at the end measures whatever comes
out.

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

The LoRA workflow expects **Southern Blues Rock**, which is published as a
release asset rather than committed here — it is 80 MiB, and a file that size
in the git history would be downloaded by everyone cloning the repository
forever.

**[Download Southern_Blues_Rock.safetensors →](https://github.com/NovaFemme/ComfyUI-NovaAudioPlayer/releases/latest)**

Put it at:

```
ComfyUI/models/loras/Ace-Step 1.5 XL SFT/Southern_Blues_Rock.safetensors
```

The subfolder matters — that is the path saved in the workflow. Drop it
straight into `models/loras/` instead and the loader will not find it until you
repoint the widget.

| | |
|---|---|
| Base model | ACE-Step 1.5 XL SFT |
| Rank | 32 |
| Precision | BF16 |
| Tensors | 512 — cross-attention and self-attention projections |
| Size | 83,952,640 bytes (80.1 MiB) |
| SHA-256 | `e3226f560b781589cd637f984dd791da0fa7dc5dc4fd9bec177bde005faddc30` |

To verify a download:

```bash
sha256sum Southern_Blues_Rock.safetensors
```

---

## The mastering workflow

**Nova Audio Mastering Workflow.json** needs no models and no other custom node
pack — it is fourteen nodes, eight of them from here, plus two ComfyUI core
nodes. Point it at an audio file and run it.

The chain it demonstrates is the one the mastering nodes were built for:

1. **Nova Load Audio** brings the track in.
2. **Nova Audio Master** analyses it and produces a corrected version, with a
   full `report_json`.
3. **Nova Master Report Viewer** renders that report in the canvas, so you can
   read what changed without leaving the graph.
4. **Nova Master Identity** turns the report into release and archive identity —
   what source, what settings, what came out.
5. **Save Audio WAV** writes the file.
6. **Nova Final Master Validator** answers the question that matters after a
   write: *did the file you saved still reproduce the master you approved?*
7. **Nova Player** and **Nova Console** sit across it for listening and logging.

That last step is the point of the workflow. Mastering in memory and saving to
disk are two different operations, and the validator is what catches a file that
no longer matches what you signed off.

**Nova NamePath Manager** is included for output paths. Its widgets ship empty —
fill in your own folders, and consider saving them as a profile so the next
workflow can reuse them.

---

## More to come

Further workflows and LoRAs will be added here and to the releases page.
