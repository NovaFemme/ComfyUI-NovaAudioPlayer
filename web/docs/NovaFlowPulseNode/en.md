# Nova FlowPulse 💓

A stand-alone dashboard node that shows, live, where a workflow spends its time and its resources. Drop it anywhere on the canvas, run the graph, and every node that executes is timed and sampled. Click any node in the dashboard to open a full-screen view of that one node.

## What it measures, and how honestly

ComfyUI runs **one node at a time in a single process**. The operating system cannot report "how much CPU did this node use" — the process is the smallest unit it accounts for. Any tool claiming otherwise is guessing.

So the profiler samples the ComfyUI process continuously and attributes each sample to whichever node held the execution slot at that moment. Because execution is strictly sequential, that attribution is sound: while a node runs, the process activity *is* that node's activity, plus a small constant baseline from the server.

| Figure | How trustworthy |
|---|---|
| **Time** | Exact. Taken from the execution events, not from sampling. |
| **CPU %** | Process-wide, sampled across the node's window. Reliable for spotting the hot node. 100% means one core fully busy, so a multi-threaded node legitimately reads well above 100% — but never above `cores × 100`. |
| **Peak RAM** | Highest process RSS during the window. The best signal of memory pressure. |
| **Δ RAM** | RSS at the end of the window minus the start. Indicative, not ownership — see below. |
| **Disk read / write** | Bytes moved during the window. Accurate when per-process counters are available. |
| **GPU / VRAM** | Accurate when a backend is present. Hidden entirely when not. |

**On CPU readings.** `cpu_percent` reports CPU time divided by the gap since the previous reading, so a reading taken over a very short gap is noise rather than a measurement. Three rules keep that out of the figures: no sample is taken less than 20 ms after the previous one; a reading only counts towards a node when its whole measurement span sits inside that node's window; and every value is capped at `cores × 100`. A node that finishes in less than one sample interval therefore shows **–** rather than a number — it is not that the node used no CPU, it is that nothing could be measured in the time available. Lower `sample_interval_ms` to 50 ms to measure shorter nodes.

**On Δ RAM.** Tensors are shared between nodes and freed lazily, so a node can show a *negative* delta when it releases more than it takes, and a node can be blamed for memory that a later node actually keeps. Treat Δ RAM as a hint about which node grows the process, and treat **peak RAM** and **duration** as the figures to act on.

CPU percentage is reported the way `top` reports it: 100% means one core fully busy, so a multi-threaded node can legitimately read above 100%.

---

## The dashboard

### Top bar

The status pill reads **○ IDLE**, **● PROFILING** while a run is in progress, or **⏸ PAUSED**. Beside it: the node currently executing, or a summary of the last run.

- **⏸ Pause** stops sampling without touching the workflow. The graph keeps running.
- **⟲ Reset** clears every collected figure and starts fresh.
- **⭳ Save log** writes a profile file immediately, whatever the `log_to_file` setting says.

### System tiles

Four tiles across the top — **CPU**, **MEMORY**, **DISK**, **GPU** — each with its current value and a live sparkline. The value is colour-coded by load: green, amber, orange, then red as it climbs. Hover anywhere on a sparkline to read that moment's value; every tile follows the same point, so you can compare across all four at once.

**The GPU tile hides itself completely when no GPU telemetry is available,** and the remaining three tiles expand to fill the row.

### Node table

Every node that has executed, one row each, with a bar showing its share of the sort metric.

| Column | Meaning |
|---|---|
| **Node** | The node's title on the canvas. A pink ● marks the node running right now. |
| **Calls** | How many times it executed. |
| **Total / Avg** | Time spent inside the node. |
| **CPU** | Average process CPU while it was running. |
| **Peak RAM** | Highest RSS during its windows. |
| **Δ RAM** | Growth across its window; positive values are tinted. |
| **I/O** | Bytes read plus written. |

Sort by total time, average time, CPU, peak RAM, Δ RAM, disk I/O or call count — the control sits above the table and stays put while the dashboard refreshes. **Click any row** to open that node's full view.

### Single-node view

- **← All nodes** returns to the table.
- **◎ Find on canvas** selects and centres that node in the ComfyUI graph — the fastest way to get from "this is the bottleneck" to the node itself in a large workflow.
- A **● RUNNING** badge appears while that node is executing.
- Twelve stat tiles: calls, total, average, slowest, CPU average and peak, peak and Δ RAM, disk read and write, and GPU average and peak VRAM when a GPU is present.
- Live charts for CPU, memory, disk read, disk write, and GPU and VRAM when available. **The stretches of the timeline where this node was running are tinted pink**, so you can see its activity in the context of the whole run. Hover any chart for a crosshair and a readout.

Each chart carries one series on its own axis with its own title, so nothing is ever identified by colour alone and no two different units share a scale.

---

## Colours and fonts

The **🎨** button in the top bar opens a panel on the node with six presets and four colour pickers:

| Slot | Where it shows |
|---|---|
| **Accent** | Buttons, the node border, the running marker, the share bars, the focus-view tint |
| **Surface** | The node background |
| **Panel** | The metric tiles and stat cards |
| **Labels** | Text — the dimmer shades are derived from it |

Below those, a font stack (System, Monospace, Humanist, Condensed) and a base size from 9 to 14 px. Every label and button scales from that one number.

Changes are live as you drag, and **Save** stores them on the server so new FlowPulse nodes come up the same way. Cancel restores, Reset returns to the defaults. The theme lives in `nova_flowpulse_theme.json` in ComfyUI's user directory, so updating the pack doesn't wipe it.

**The chart colours are deliberately not themeable.** The CPU, memory, disk and GPU hues were validated for contrast against the dark surface and for separation under colour-blind simulation, and the green-amber-orange-red load ramp carries meaning. Recolouring those would quietly break the thing the dashboard is for. Only the chrome around them changes.

For safety, the server accepts plain hex colours only, the font must be one of the four known stacks, and the size is clamped — these values are written into a stylesheet.

---

## Node settings

| Setting | What it does |
|---|---|
| `log_to_file` | When on, a profile file is written **when each run finishes**. |
| `log_format` | `csv`, `json` or `markdown`. |
| `log_name` | File name prefix. A timestamp is always appended, so nothing is overwritten. |
| `sample_interval_ms` | How often the process is sampled during a run. 250 ms is a good default; drop to 50–100 ms for short nodes. |
| `gpu_telemetry` | `auto (safe)`, `off`, or `torch (unsafe on ROCm)`. See **GPU support** below. |
| `reset_each_run` | On: every run starts from zero. Off: figures accumulate, so averages settle over repeated runs. |

### Output

The single `report` output is a text summary of the last completed run, ready for **Nova Console 🖥️**: sampling settings, GPU status, run duration, and a ranked bar chart of the slowest nodes. When logging is on, the report also names the folder the file goes to.

```
Nova FlowPulse v1.0
Sampling   : every 250 ms · disk counters: process
GPU        : NVIDIA GeForce RTX 4090
Last run   : finished in 42.18 s over 37 node(s)

Slowest nodes (share of 41.02 s spent inside nodes):
   61.2%  ████████████         KSampler                       25.10 s  x1   cpu  94.2%  peak    9.4 GB  Δ    2.1 GB
   18.4%  ████                 VAE Decode                      7.55 s  x1   cpu  88.1%  peak    9.4 GB  Δ  -812.0 MB
```

### Where the log goes

`ComfyUI/output/nova_flowpulse/<log_name>-<timestamp>.<ext>`

Each row carries the node id, title, type, call count, total / average / last / max seconds, CPU average and peak, peak and Δ RSS, bytes read and written, and the GPU columns when a GPU is present.

**A note on timing.** ComfyUI has no concept of a node that runs last, so the file for a run is written when the *run* finishes, not when the profiler node executes. The `report` output therefore describes the **last completed run**, which is the one with complete figures. Press **⭳ Save log** if you want a file for the run that just finished, right now.

---

## Working scenarios

### 1. Find the bottleneck in a large workflow

Drop the node on the canvas, run the graph once, and read the top of the table with the default **Total time** sort. The first row is where the time goes. Click it, then **◎ Find on canvas** to jump straight to the node.

### 2. Track down a memory spike

Sort by **Peak RAM**, or by **Δ RAM** to find which node grows the process. Open it and watch the memory chart: a step that never comes back down is a node holding onto something.

### 3. Tell a slow node from a starved one

Open the node and compare its charts. High CPU with a long duration is genuine compute. **Low** CPU with a long duration means it is waiting — on disk, on the network, or on the GPU. The disk charts usually say which.

### 4. Compare runs

Leave `reset_each_run` off and run the workflow several times. Averages settle and the **Calls** column shows how often each node actually re-executed rather than being served from cache.

### 5. Keep a record before publishing

Set `log_to_file` on with `markdown`, run the finished workflow once, and the file is written to `output/nova_flowpulse` ready to paste into release notes.

---

## GPU support

GPU figures come from a **management library**, never from the compute runtime. That distinction matters: NVML and AMD SMI are out-of-band monitoring APIs, designed to be called from any thread at any time. Asking the compute runtime instead — `torch.cuda.mem_get_info()`, which is a CUDA/HIP driver call — from a sampler thread while inference is in flight is a real hazard, and on ROCm it has been seen to take the GPU down with a `GPU Hang` hardware exception that aborts ComfyUI outright.

So the `gpu_telemetry` setting has three positions:

| Mode | What it does |
|---|---|
| **auto (safe)** — default | Tries NVML, then AMD SMI, then pyrsmi. Gives utilisation %, VRAM used and total, and the device name. If none is installed, the GPU panel is hidden and the footer says so. No driver call is ever made. |
| **off** | No GPU telemetry at all. The panel is hidden. |
| **torch (unsafe on ROCm)** | Opt-in. Reads PyTorch's *allocator counters* only — `memory_reserved`, which is bookkeeping rather than a driver call — so it reports reserved VRAM with no utilisation figure. A ⚠ badge appears in the footer while it is active. |

To get full GPU telemetry, install the management library for your card:

```bash
pip install nvidia-ml-py      # NVIDIA
pip install amdsmi            # AMD (ships with ROCm)
pip install pyrsmi            # AMD, lighter alternative
```

The server console prints which backend was chosen the first time a run is sampled.

**Safety rails.** The GPU stack is never touched at import time, so it cannot disturb ComfyUI's own device setup. Three consecutive read errors disable GPU telemetry for the session, and so does a single read that takes longer than half a second — a monitoring call that blocks is treated as a warning sign rather than something to retry.

---

## If ComfyUI aborts during a run

A crash that ends with `Fatal Python error: Aborted` and a line like

```
HW Exception by GPU node-1 (Agent handle: 0x...) reason :GPU Hang
```

is the GPU driver giving up, not a Python exception. On ROCm this can happen on its own during heavy VAE work, but GPU polling can provoke it.

1. Set `gpu_telemetry` to **auto (safe)** — the default since v1.1 — or to **off**.
2. Run the workflow again. FlowPulse still reports CPU, memory, disk and per-node timing; only the GPU panel goes away.
3. If it still aborts with FlowPulse set to **off**, the hang is independent of this node.

The clearest signal that FlowPulse is not involved is the startup line
`No GPU management library found` — with no backend it makes **no GPU calls at all**, so a hang that still happens is the driver's. Worth trying, in order: a non-fp16 VAE (`--fp32-vae` or `--bf16-vae` — a fp16 VAE is a common trouble spot on AMD), a tiled VAE decode, `PYTORCH_HIP_ALLOC_CONF=expandable_segments:True`, `--disable-smart-memory`, and confirming your ROCm build properly supports your card. These are ROCm matters rather than FlowPulse ones, so check current advice for your card and ROCm version.

---

## If the node is dropped from a run

```
[ERROR] Value not in list: gpu_telemetry: False not in ['auto (safe)', ...]
[ERROR] Output will be ignored
```

This means the browser was holding an older copy of the node. ComfyUI restores widget values **by position**, so adding a widget shifts every later value by one slot and a boolean lands in a dropdown.

Since v1.2 this can no longer stop the node: values are also stored by name and restored by name, each one is checked against its own options before being sent, and the Python side accepts whatever arrives and falls back to defaults, printing what it corrected. A hard-refresh (Ctrl + F5) after updating the files still puts everything straight in one step.

---

## Cost of running it

- Sampling happens on its own thread and never touches the execution path.
- The execution hook records a timestamp and returns.
- While idle and unwatched, sampling drops to once a second; it speeds up the moment a run starts or the dashboard is on screen.
- The dashboard stops polling when the browser tab is hidden. The backend keeps sampling, so nothing is lost.

At a 250 ms interval the overhead is far below the noise floor of the run it is measuring.

---

## Requirements and limits

- **psutil** is required, and ComfyUI normally ships with it. If it is missing, the node says so in the status bar and the rest of the pack is unaffected: `pip install psutil`.
- Per-process disk counters are unavailable on some platforms, notably macOS. The profiler falls back to system-wide counters and the footer says which is in use (`disk counters: process` or `system`).
- Nodes served from ComfyUI's cache do not execute, so they do not appear for that run. That is correct — they cost nothing.
- Figures cover the whole process, so another heavy application on the same machine will show up in the numbers.

---

## Naming

The node is registered as `NovaFlowPulseNode`, displayed as **Nova FlowPulse 💓**.

If another name suits the pack better, it is a two-line change — the class name and the display name in `nova_flowpulse.py`, plus the `PROFILER` constant at the top of `nova_flowpulse.js`:

| Alternative | Leans toward |
|---|---|
| **Nova FlowPulse 💓** | the current name; neutral and descriptive |
| **Nova Performance Monitor 📈** | the live-monitoring side |
| **Nova Workflow Vitals 💓** | at-a-glance health of a running graph |
| **Nova Bottleneck Finder 🔍** | the job it does rather than what it shows |
| **Nova Resource Scope 🔬** | inspection and drill-down |
| **Nova System Pulse 📡** | the live telemetry feel |
