# Example workflows

Two ACE-Step 1.5 XL SFT workflows for generating music from a prompt and
lyrics, both built around **Madow Inputs** and **Nova Player**.

Drag either `.json` onto the ComfyUI canvas to load it. Both are
self-contained — the subgraphs they use are embedded in the file, so nothing
else needs importing.

| Workflow | What it is |
|---|---|
| **Ace-Step XL SFT - Prompt and Lyrics to Audio.json** | The base workflow. Prompt and lyrics in, measured audio out. |
| **Ace-Step XL SFT - Prompt and Lyrics to Audio Incl Lora.json** | The same graph with a LoRA loader in the model chain. |

Each is organised into three subgraphs — the model/latent chain, the prompt and
lyrics text, and sampling through to a tiled VAE decode — so the top level stays
readable. The Nova Player at the end measures whatever comes out.

## What you need

### This pack

`MadowInputs`, `MadowUnpack` and `NovaPlayerNode`, which you already have if you
are reading this.

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

## The LoRA

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

## More to come

Further workflows and LoRAs will be added here and to the releases page.
