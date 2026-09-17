# Nova Memory Probe (RAM/VRAM)

Reports host RAM and device VRAM at the exact point it sits in a workflow, plus
the change since the last time the same probe ran.

**It measures and never mutates.** Nothing here unloads models, empties caches
or calls the garbage collector, so it is safe to leave wired into a production
workflow permanently.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `label` | `probe` | Names this probe point. History is kept per label, so deltas compare like with like. |
| `detail` | `normal` | `compact`, `normal` or `full`. See below. |
| `log_to_console` | on | Also print to the terminal, so the reading survives a browser reload. |
| `write_jsonl` | off | Append each sample to `output/nova_memory.jsonl` for plotting. |
| `passthrough` | — | Optional. Wire anything through to pin the probe to a point in the graph. Returned unchanged. |

## Outputs

| Output | Notes |
|---|---|
| `passthrough` | Whatever you fed in, untouched. This is how you place the probe *between* two nodes. |
| `report` | The formatted report as text. Wire it to Nova Console to read it on canvas. |

It is an `OUTPUT_NODE`, so it runs even with nothing downstream.

## It always re-runs

`IS_CHANGED` returns `NaN`, so ComfyUI never serves a cached result. A cached
probe measures nothing — it would report the memory state of some earlier run.

## What each detail level shows

All three show host RAM (process RSS split into anonymous and file-backed, peak
RSS, swap, system available and total), VRAM (torch allocated and reserved,
reserved-but-unused, driver used and free, peak allocated), and the list of
models ComfyUI currently has resident.

- **normal** adds the glibc allocator block: arena, in use, **free but still
  held**, and releasable. That "free, still held" figure is the one that matters
  when RSS climbs and never comes back.
- **full** adds torch allocator retries and OOM counts, and the sampled config.

Every run after the first also prints a drift block: elapsed time and the change
in RSS since sample #1 for that label.

## Using it to find a leak

Put two probes with different labels either side of the node you suspect, run
the graph several times, and read the drift block rather than the absolute
numbers. Absolute RSS is noisy; monotonic growth in *RSS anonymous* or in glibc
*free, still held* across repeated runs is the signal. The failure this was
written for is the classic one where host RAM creeps up over a session until
ComfyUI wedges.

## It degrades rather than fails

No torch, no CUDA/ROCm device, or a non-glibc system: the affected section is
replaced with a note and the rest still reports. Verified on ROCm and CUDA under
Linux.
