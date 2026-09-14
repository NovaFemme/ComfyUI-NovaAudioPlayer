"""
Nova Audio Mastering - Memory Probe
===================================

A pass-through diagnostic node that reports host RAM and device VRAM state at
the exact point it sits in a workflow, plus the delta since the last time the
same probe ran. Built for tracking down host-RAM growth across repeated
generations (the classic "RAM creeps up, dual-CLIP encode pegs at 99%, ComfyUI
wedges" failure) on ROCm and CUDA alike.

It measures, it does not mutate. Nothing here unloads models, empties caches or
calls gc -- so it is safe to leave wired into a production workflow.

Target: ComfyUI 0.25.x, torch 2.x (CUDA or ROCm/HIP), Linux.
Degrades gracefully everywhere else.
"""

from __future__ import annotations

import ctypes
import json
import os
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------
# optional imports -- never hard-fail the node on these
# --------------------------------------------------------------------------


try:
    from ..nova_categories import UTILITY_IO
except ImportError:  # direct execution / test harness
    from nova_categories import UTILITY_IO

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore

try:
    import comfy.model_management as mm
except Exception:  # pragma: no cover
    mm = None  # type: ignore

try:
    from comfy.cli_args import args as comfy_args
except Exception:  # pragma: no cover
    comfy_args = None  # type: ignore


MB = 1024.0 * 1024.0
GB = 1024.0 * 1024.0 * 1024.0

_HISTORY_LOCK = threading.Lock()
_HISTORY: Dict[str, deque] = {}
_HISTORY_MAX = 256


# --------------------------------------------------------------------------
# wildcard type so the node can sit in any chain without breaking it
# --------------------------------------------------------------------------

class _AnyType(str):
    """A type that compares equal to every other ComfyUI type."""

    def __ne__(self, other):  # noqa: D105
        return False

    def __eq__(self, other):  # noqa: D105
        return True

    def __hash__(self):  # noqa: D105
        return hash(str(self))


ANY = _AnyType("*")


# --------------------------------------------------------------------------
# host memory
# --------------------------------------------------------------------------

def _read_kv_file(path: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    try:
        with open(path, "r") as fh:
            for line in fh:
                key, _, val = line.partition(":")
                val = val.strip()
                if val.endswith(" kB"):
                    try:
                        out[key.strip()] = int(val[:-3]) * 1024
                    except ValueError:
                        pass
                else:
                    try:
                        out[key.strip()] = int(val.split()[0])
                    except (ValueError, IndexError):
                        pass
    except OSError:
        pass
    return out


def _proc_status() -> Dict[str, int]:
    return _read_kv_file("/proc/self/status")


def _meminfo() -> Dict[str, int]:
    return _read_kv_file("/proc/meminfo")


class _MallInfo2(ctypes.Structure):
    _fields_ = [
        ("arena", ctypes.c_size_t),     # bytes obtained from sbrk
        ("ordblks", ctypes.c_size_t),   # number of free chunks
        ("smblks", ctypes.c_size_t),
        ("hblks", ctypes.c_size_t),     # number of mmapped regions
        ("hblkhd", ctypes.c_size_t),    # bytes in mmapped regions
        ("usmblks", ctypes.c_size_t),
        ("fsmblks", ctypes.c_size_t),
        ("uordblks", ctypes.c_size_t),  # bytes in use
        ("fordblks", ctypes.c_size_t),  # free bytes still held by glibc
        ("keepcost", ctypes.c_size_t),  # releasable top-of-heap
    ]


_LIBC: Optional[ctypes.CDLL] = None
_MALLINFO_OK: Optional[bool] = None


def _libc() -> Optional[ctypes.CDLL]:
    global _LIBC
    if _LIBC is None:
        try:
            _LIBC = ctypes.CDLL("libc.so.6", use_errno=True)
        except OSError:
            _LIBC = False  # type: ignore
    return _LIBC or None


def _mallinfo() -> Optional[Dict[str, int]]:
    """glibc arena accounting: how much the allocator holds but is not using."""
    global _MALLINFO_OK
    if _MALLINFO_OK is False:
        return None
    lib = _libc()
    if lib is None:
        _MALLINFO_OK = False
        return None
    try:
        fn = lib.mallinfo2
        fn.restype = _MallInfo2
        fn.argtypes = []
        info = fn()
        _MALLINFO_OK = True
        return {f[0]: getattr(info, f[0]) for f in _MallInfo2._fields_}
    except (AttributeError, OSError):
        _MALLINFO_OK = False
        return None


def sample_host() -> Dict[str, Any]:
    st = _proc_status()
    mi = _meminfo()
    out: Dict[str, Any] = {
        "rss": st.get("VmRSS", 0),
        "rss_anon": st.get("RssAnon", 0),
        "rss_file": st.get("RssFile", 0),
        "rss_shmem": st.get("RssShmem", 0),
        "vm_size": st.get("VmSize", 0),
        "vm_hwm": st.get("VmHWM", 0),
        "vm_swap": st.get("VmSwap", 0),
        "threads": st.get("Threads", 0),
        "mem_total": mi.get("MemTotal", 0),
        "mem_available": mi.get("MemAvailable", 0),
        "mem_free": mi.get("MemFree", 0),
        "cached": mi.get("Cached", 0),
        "swap_total": mi.get("SwapTotal", 0),
        "swap_free": mi.get("SwapFree", 0),
    }
    mall = _mallinfo()
    if mall:
        out["glibc_arena"] = mall["arena"]
        out["glibc_mmap"] = mall["hblkhd"]
        out["glibc_in_use"] = mall["uordblks"]
        out["glibc_free_held"] = mall["fordblks"]
        out["glibc_releasable"] = mall["keepcost"]
    return out


# --------------------------------------------------------------------------
# device memory
# --------------------------------------------------------------------------

def _torch_device():
    if mm is not None:
        try:
            return mm.get_torch_device()
        except Exception:
            pass
    if torch is not None and torch.cuda.is_available():
        return torch.device("cuda", torch.cuda.current_device())
    return None


def sample_device() -> Dict[str, Any]:
    out: Dict[str, Any] = {"available": False}
    if torch is None:
        out["note"] = "torch not importable"
        return out
    dev = _torch_device()
    if dev is None or getattr(dev, "type", "cpu") != "cuda":
        out["note"] = "no cuda/hip device"
        return out

    out["available"] = True
    out["device"] = str(dev)
    try:
        out["name"] = torch.cuda.get_device_name(dev)
    except Exception:
        pass

    for key, fn in (
        ("allocated", torch.cuda.memory_allocated),
        ("reserved", torch.cuda.memory_reserved),
        ("max_allocated", torch.cuda.max_memory_allocated),
        ("max_reserved", torch.cuda.max_memory_reserved),
    ):
        try:
            out[key] = int(fn(dev))
        except Exception:
            out[key] = 0

    try:
        free_b, total_b = torch.cuda.mem_get_info(dev)
        out["driver_free"] = int(free_b)
        out["driver_total"] = int(total_b)
        out["driver_used"] = int(total_b) - int(free_b)
    except Exception:
        pass

    try:
        stats = torch.cuda.memory_stats(dev)
        out["num_alloc_retries"] = int(stats.get("num_alloc_retries", 0))
        out["num_ooms"] = int(stats.get("num_ooms", 0))
        out["inactive_split_bytes"] = int(
            stats.get("inactive_split_bytes.all.current", 0)
        )
    except Exception:
        pass

    if mm is not None:
        try:
            out["comfy_free"] = int(mm.get_free_memory(dev))
        except Exception:
            pass

    return out


def sample_comfy_models() -> List[Dict[str, Any]]:
    """ComfyUI's own loaded-model registry, with per-model resident size."""
    models: List[Dict[str, Any]] = []
    if mm is None:
        return models
    try:
        loaded = list(getattr(mm, "current_loaded_models", []) or [])
    except Exception:
        return models

    for entry in loaded:
        patcher = getattr(entry, "model", None)
        inner = getattr(patcher, "model", patcher)
        rec: Dict[str, Any] = {
            "class": type(inner).__name__ if inner is not None else "?",
            "device": str(getattr(entry, "device", "?")),
        }
        for attr in ("loaded_size", "model_loaded_memory", "model_memory",
                     "model_offloaded_memory"):
            holder = entry if hasattr(entry, attr) else patcher
            fn = getattr(holder, attr, None)
            if callable(fn):
                try:
                    rec[attr] = int(fn())
                except Exception:
                    pass
        models.append(rec)
    return models


def sample_config() -> Dict[str, Any]:
    """The ComfyUI knobs that actually govern host-RAM behaviour."""
    cfg: Dict[str, Any] = {}
    if mm is not None:
        for attr in ("vram_state", "cpu_state", "DISABLE_SMART_MEMORY",
                     "ALWAYS_VRAM_OFFLOAD", "PIN_SHARED_MEMORY"):
            if hasattr(mm, attr):
                try:
                    cfg[attr] = str(getattr(mm, attr))
                except Exception:
                    pass
    if comfy_args is not None:
        for attr in ("disable_smart_memory", "async_offload", "cache_none",
                     "cache_lru", "reserve_vram", "lowvram", "novram",
                     "highvram", "normalvram", "cache_classic",
                     "disable_mmap", "force_channels_last"):
            if hasattr(comfy_args, attr):
                try:
                    cfg[attr] = getattr(comfy_args, attr)
                except Exception:
                    pass
    for env in ("PYTORCH_HIP_ALLOC_CONF", "PYTORCH_CUDA_ALLOC_CONF",
                "MALLOC_TRIM_THRESHOLD_", "MALLOC_ARENA_MAX",
                "HSA_OVERRIDE_GFX_VERSION", "MIOPEN_FIND_MODE"):
        if env in os.environ:
            cfg[env] = os.environ[env]
    return cfg


# --------------------------------------------------------------------------
# formatting
# --------------------------------------------------------------------------

def _gb(n: Any) -> str:
    try:
        return "{:>8.3f} GB".format(float(n) / GB)
    except (TypeError, ValueError):
        return "       n/a"


def _delta(cur: Any, prev: Any) -> str:
    if prev is None or cur is None:
        return ""
    try:
        d = (float(cur) - float(prev)) / MB
    except (TypeError, ValueError):
        return ""
    if abs(d) < 1.0:
        return "  (  +0 MB)"
    return "  ({:+6.0f} MB)".format(d)


def _pct(part: Any, whole: Any) -> str:
    try:
        if not whole:
            return ""
        return " [{:.1f}%]".format(100.0 * float(part) / float(whole))
    except (TypeError, ValueError):
        return ""


def _verdict(cur: Dict[str, Any], first: Optional[Dict[str, Any]]) -> List[str]:
    """Plain-language reading of the numbers. Heuristic, deliberately cautious."""
    notes: List[str] = []
    host, dev = cur["host"], cur["device"]

    avail = host.get("mem_available", 0)
    total = host.get("mem_total", 0)
    if total and avail / total < 0.08:
        notes.append(
            "CRITICAL: only {:.1f} GB host RAM available ({:.0f}% of total). "
            "The next big allocation will swap or OOM.".format(
                avail / GB, 100.0 * avail / total))
    elif total and avail / total < 0.18:
        notes.append(
            "LOW: {:.1f} GB host RAM available. Headroom is thin for a "
            "text-encoder load.".format(avail / GB))

    if host.get("vm_swap", 0) > 256 * MB:
        notes.append(
            "This process has {:.2f} GB swapped out -- already thrashing; "
            "encode steps will appear to hang at high CPU.".format(
                host["vm_swap"] / GB))

    held = host.get("glibc_free_held")
    if held and held > 1.5 * GB:
        notes.append(
            "glibc is holding {:.2f} GB of freed-but-unreturned heap "
            "(fordblks). This counts against RSS and is exactly what "
            "malloc_trim(0) reclaims.".format(held / GB))

    if first is not None:
        fh = first["host"]
        d_anon = host.get("rss_anon", 0) - fh.get("rss_anon", 0)
        d_file = host.get("rss_file", 0) - fh.get("rss_file", 0)
        if d_anon > 1.0 * GB:
            notes.append(
                "Anonymous RSS grew {:.2f} GB since the first sample at this "
                "probe -- genuine host-side retention, not page cache."
                .format(d_anon / GB))
        if d_file > 2.0 * GB and d_anon < 512 * MB:
            notes.append(
                "Growth is mostly file-backed ({:.2f} GB, mmapped weights). "
                "The kernel can reclaim this under pressure; it is not a leak."
                .format(d_file / GB))

    if dev.get("available"):
        alloc = dev.get("allocated", 0)
        res = dev.get("reserved", 0)
        frag = res - alloc
        if frag > 2.0 * GB:
            notes.append(
                "{:.2f} GB of VRAM is reserved by the caching allocator but "
                "not allocated -- fragmentation. expandable_segments:True in "
                "PYTORCH_HIP_ALLOC_CONF usually flattens this."
                .format(frag / GB))
        if dev.get("num_alloc_retries", 0):
            notes.append(
                "torch has hit {} allocator retries and {} OOM events this "
                "session.".format(dev.get("num_alloc_retries", 0),
                                  dev.get("num_ooms", 0)))

    cfg = cur.get("config", {})
    if str(cfg.get("DISABLE_SMART_MEMORY", "")).lower() in ("true", "1"):
        notes.append(
            "Smart memory management is DISABLED. Models are evicted from VRAM "
            "back into host RAM rather than dropped, so host RSS climbs with "
            "every model swap.")
    if cfg.get("async_offload"):
        notes.append(
            "Async weight offloading is on. Offload buffers are pinned host "
            "pages -- they are never swappable and are slow to return.")
    if not any(k in cfg for k in ("PYTORCH_HIP_ALLOC_CONF",
                                  "PYTORCH_CUDA_ALLOC_CONF")):
        notes.append(
            "No PYTORCH_HIP_ALLOC_CONF set; the allocator is on defaults.")

    if not notes:
        notes.append("Nothing anomalous at this sample.")
    return notes


def render(cur: Dict[str, Any],
           prev: Optional[Dict[str, Any]],
           first: Optional[Dict[str, Any]],
           label: str,
           detail: str) -> str:
    host, dev = cur["host"], cur["device"]
    ph = prev["host"] if prev else {}
    pd = prev["device"] if prev else {}

    L: List[str] = []
    L.append("=" * 68)
    L.append("  NOVA MEMORY PROBE  |  {}  |  sample #{}  |  {}".format(
        label, cur["seq"], time.strftime("%H:%M:%S", time.localtime(cur["t"]))))
    L.append("=" * 68)

    L.append("-- HOST RAM " + "-" * 55)
    L.append("  process RSS        {}{}".format(
        _gb(host.get("rss")), _delta(host.get("rss"), ph.get("rss"))))
    L.append("    anonymous        {}{}".format(
        _gb(host.get("rss_anon")), _delta(host.get("rss_anon"), ph.get("rss_anon"))))
    L.append("    file-backed      {}{}".format(
        _gb(host.get("rss_file")), _delta(host.get("rss_file"), ph.get("rss_file"))))
    L.append("  peak RSS (HWM)     {}".format(_gb(host.get("vm_hwm"))))
    L.append("  swapped out        {}".format(_gb(host.get("vm_swap"))))
    L.append("  system available   {}{}".format(
        _gb(host.get("mem_available")),
        _pct(host.get("mem_available"), host.get("mem_total"))))
    L.append("  system total       {}".format(_gb(host.get("mem_total"))))

    if detail != "compact" and "glibc_arena" in host:
        L.append("-- ALLOCATOR (glibc) " + "-" * 46)
        L.append("  arena              {}".format(_gb(host.get("glibc_arena"))))
        L.append("  in use             {}".format(_gb(host.get("glibc_in_use"))))
        L.append("  free, still held   {}{}".format(
            _gb(host.get("glibc_free_held")),
            _delta(host.get("glibc_free_held"), ph.get("glibc_free_held"))))
        L.append("  releasable now     {}".format(_gb(host.get("glibc_releasable"))))

    L.append("-- VRAM " + "-" * 59)
    if dev.get("available"):
        L.append("  device             {} ({})".format(
            dev.get("device", "?"), dev.get("name", "?")))
        L.append("  torch allocated    {}{}".format(
            _gb(dev.get("allocated")), _delta(dev.get("allocated"), pd.get("allocated"))))
        L.append("  torch reserved     {}{}".format(
            _gb(dev.get("reserved")), _delta(dev.get("reserved"), pd.get("reserved"))))
        L.append("  reserved unused    {}".format(
            _gb(dev.get("reserved", 0) - dev.get("allocated", 0))))
        L.append("  driver used        {}{}".format(
            _gb(dev.get("driver_used")),
            _pct(dev.get("driver_used"), dev.get("driver_total"))))
        L.append("  driver free        {}".format(_gb(dev.get("driver_free"))))
        L.append("  peak allocated     {}".format(_gb(dev.get("max_allocated"))))
        if detail == "full":
            L.append("  alloc retries      {}".format(dev.get("num_alloc_retries", 0)))
            L.append("  torch OOM events   {}".format(dev.get("num_ooms", 0)))
    else:
        L.append("  {}".format(dev.get("note", "unavailable")))

    models = cur.get("models", [])
    L.append("-- COMFY LOADED MODELS ({}) {}".format(len(models), "-" * 38))
    if models:
        for m in models:
            size = m.get("loaded_size", m.get("model_loaded_memory",
                                              m.get("model_memory")))
            L.append("  {:<34} {} on {}".format(
                m.get("class", "?")[:34], _gb(size), m.get("device", "?")))
    else:
        L.append("  (none resident)")

    if detail == "full":
        cfg = cur.get("config", {})
        L.append("-- CONFIG " + "-" * 57)
        for k in sorted(cfg):
            L.append("  {:<28} {}".format(k, cfg[k]))

    if first is not None and first is not cur:
        fh, fd = first["host"], first["device"]
        L.append("-- DRIFT SINCE SAMPLE #1 " + "-" * 42)
        L.append("  elapsed            {:>8.1f} s".format(cur["t"] - first["t"]))
        L.append("  RSS                {:>+8.0f} MB".format(
            (host.get("rss", 0) - fh.get("rss", 0)) / MB))
        L.append("  RSS anonymous      {:>+8.0f} MB".format(
            (host.get("rss_anon", 0) - fh.get("rss_anon", 0)) / MB))
        if dev.get("available") and fd.get("available"):
            L.append("  VRAM reserved      {:>+8.0f} MB".format(
                (dev.get("reserved", 0) - fd.get("reserved", 0)) / MB))

    L.append("-- READING " + "-" * 56)
    for note in _verdict(cur, first):
        L.append("  * " + note)
    L.append("=" * 68)
    return "\n".join(L)


# --------------------------------------------------------------------------
# the node
# --------------------------------------------------------------------------

class NovaMemoryProbe:
    """Pass-through RAM/VRAM probe. Measures only; never frees."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "label": ("STRING", {
                    "default": "probe",
                    "tooltip": "Names this probe point. History is tracked "
                               "per-label, so deltas compare like with like.",
                }),
                "detail": (["compact", "normal", "full"], {"default": "normal"}),
                "log_to_console": ("BOOLEAN", {"default": True}),
                "write_jsonl": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Append each sample to "
                               "ComfyUI/output/nova_memory.jsonl for plotting.",
                }),
            },
            "optional": {
                "passthrough": (ANY, {
                    "tooltip": "Wire anything through here to pin the probe to "
                               "a point in the graph. Returned unchanged.",
                }),
            },
        }

    RETURN_TYPES = (ANY, "STRING")
    RETURN_NAMES = ("passthrough", "report")
    OUTPUT_TOOLTIPS = ("Whatever you fed in, unchanged.",
                       "The formatted report as text.")
    FUNCTION = "probe"
    CATEGORY = UTILITY_IO
    OUTPUT_NODE = True
    DESCRIPTION = ("Reports host RAM and device VRAM at this point in the "
                   "graph, with deltas since the previous run of the same "
                   "probe. Read-only: it never unloads or frees anything.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-execute -- a cached probe measures nothing.
        return float("nan")

    def probe(self, label, detail, log_to_console, write_jsonl,
              passthrough=None):
        cur: Dict[str, Any] = {
            "t": time.time(),
            "label": label,
            "host": sample_host(),
            "device": sample_device(),
            "models": sample_comfy_models(),
            "config": sample_config(),
        }

        with _HISTORY_LOCK:
            hist = _HISTORY.setdefault(label, deque(maxlen=_HISTORY_MAX))
            prev = hist[-1] if hist else None
            first = hist[0] if hist else None
            cur["seq"] = (prev["seq"] + 1) if prev else 1
            hist.append(cur)
            if first is None:
                first = cur

        report = render(cur, prev, first, label, detail)

        if log_to_console:
            print("\n" + report, flush=True)

        if write_jsonl:
            self._append_jsonl(cur)

        return {"ui": {"text": [report]},
                "result": (passthrough, report)}

    @staticmethod
    def _append_jsonl(sample: Dict[str, Any]) -> None:
        try:
            try:
                import folder_paths
                out_dir = folder_paths.get_output_directory()
            except Exception:
                out_dir = os.getcwd()
            path = os.path.join(out_dir, "nova_memory.jsonl")
            flat = {
                "t": sample["t"],
                "seq": sample["seq"],
                "label": sample["label"],
                "models": len(sample.get("models", [])),
            }
            for k, v in sample["host"].items():
                flat["host." + k] = v
            for k, v in sample["device"].items():
                if isinstance(v, (int, float, bool, str)):
                    flat["dev." + k] = v
            with open(path, "a") as fh:
                fh.write(json.dumps(flat) + "\n")
        except Exception as exc:  # never break a workflow over telemetry
            print("[NovaMemoryProbe] jsonl write failed: {}".format(exc))


NODE_CLASS_MAPPINGS = {"NovaMemoryProbe": NovaMemoryProbe,}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaMemoryProbe": "Nova Memory Probe (RAM/VRAM) 🧠",}
