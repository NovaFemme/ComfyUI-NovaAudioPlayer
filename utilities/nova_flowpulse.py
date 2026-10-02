"""
nova_flowpulse.py - Nova FlowPulse: live resource dashboard for a ComfyUI workflow.

What it measures, and how honestly
----------------------------------
ComfyUI runs one node at a time in a single process. There is therefore no way to
ask the OS "how much CPU did *this* node use" - the process is the smallest unit
the OS reports on.

What this profiler does instead is sample the ComfyUI process continuously and
attribute each sample to whichever node held the execution slot at that moment.
Because execution is strictly sequential, that attribution is sound: while a node
is running, the process activity IS that node's activity (plus a small, constant
baseline from the server itself).

  - time          exact, taken from the execution events, not from sampling
  - CPU %         process-wide, sampled during the node's window
  - memory        process RSS: peak during the window and the delta across it
  - disk r/w      bytes read / written during the window
  - GPU           utilisation and VRAM, only when a backend is available

A memory delta is not the same as "memory this node owns" - tensors are shared and
freed lazily, so a node can show a negative delta when it releases more than it
takes. Peak RSS during the window is the more reliable signal of pressure, and
duration is the reliable signal of a bottleneck.

Nothing here is on the execution hot path: sampling happens on its own thread, and
the event hook records a timestamp and returns.
"""

import json
import os
import threading
import time
from collections import deque

from aiohttp import web
import folder_paths
from server import PromptServer

import sys
from pathlib import Path

# insert node to root folder into syspath
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Clean absolute imports
from nova_categories import UTILITY_IO

try:
    import psutil
except ImportError:  # ComfyUI normally ships with it; degrade instead of crashing
    psutil = None

LOG = "[Nova FlowPulse]"
FLOWPULSE_VERSION = "1.5"
HISTORY = 900                 # samples kept in the rolling window
MAX_RUN_SAMPLES = 240         # per-node per-run samples kept for the focus view
IDLE_INTERVAL = 1.0           # sampling slows to this when nothing is watching
LOG_FORMATS = ["csv", "json", "markdown"]
LOG_DIR = "nova_flowpulse"
# "auto" uses only out-of-band management libraries, which are safe to call from the
# sampler thread. The torch path talks to the compute runtime and is opt-in: on ROCm
# it has been seen to abort the process with a GPU Hang hardware exception.
GPU_MODES = ["auto (safe)", "off", "torch (unsafe on ROCm)"]
# A CPU figure taken over a very short interval is noise, not a measurement.
MIN_CPU_WINDOW = 0.02
# The boundary sample lands a hair before the next window opens; allow for that.
BOUNDARY_TOLERANCE = 0.01


# ---------------------------------------------------------------------------
# GPU backends - safe management libraries first, compute runtime only on request
# ---------------------------------------------------------------------------
class _Gpu:
    """
    GPU telemetry, deliberately conservative.

    Reading a GPU from a background thread while the main thread is running
    inference is only safe through a *management* library - NVML on NVIDIA, AMD SMI
    or pyrsmi on AMD. Those are out-of-band monitoring APIs designed to be called
    from anywhere.

    Calling the compute runtime instead (torch.cuda.mem_get_info, which is a
    cuda/HIP driver call) from a sampler thread is NOT safe. On ROCm it can collide
    with work in flight and take the GPU down with a "GPU Hang" HW exception that
    aborts the whole process. That path is therefore opt-in and never the default.

    Nothing here is probed at import time either - initialising the GPU stack before
    ComfyUI has set up its own devices is its own source of trouble.
    """

    SAFE_SOURCES = ("nvml", "amdsmi", "pyrsmi")

    def __init__(self):
        self.mode = GPU_MODES[0]
        self.source = None
        self.name = ""
        self.total = 0
        self.note = ""
        self._probed = False
        self._handle = None
        self._lib = None
        self._fails = 0
        self._disabled = False

    # --- probing ----------------------------------------------------------
    def configure(self, mode):
        mode = mode if mode in GPU_MODES else GPU_MODES[0]
        if mode != self.mode:
            self.mode = mode
            self._probed = False
            self._disabled = False
            self._fails = 0
            self.source = None
            self.name = ""
            self.total = 0
            self.note = ""

    def ensure(self):
        if self._probed:
            return
        self._probed = True
        if self.mode == "off":
            self.note = "GPU telemetry is switched off"
            return
        if self._try_nvml() or self._try_amdsmi() or self._try_pyrsmi():
            return
        if self.mode == "torch (unsafe on ROCm)":
            self._try_torch()
        else:
            self.note = ("No GPU management library found. Install nvidia-ml-py (NVIDIA) "
                         "or amdsmi / pyrsmi (AMD) for safe GPU telemetry.")
            print(f"{LOG} {self.note}")

    def _try_nvml(self):
        try:
            import pynvml
            pynvml.nvmlInit()
            if pynvml.nvmlDeviceGetCount() <= 0:
                return False
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            name = pynvml.nvmlDeviceGetName(self._handle)
            self.name = name.decode() if isinstance(name, bytes) else str(name)
            self.total = int(pynvml.nvmlDeviceGetMemoryInfo(self._handle).total)
            self._lib = pynvml
            self.source = "nvml"
            print(f"{LOG} GPU telemetry via NVML: {self.name}")
            return True
        except Exception:
            return False

    def _try_amdsmi(self):
        try:
            import amdsmi
            amdsmi.amdsmi_init()
            handles = amdsmi.amdsmi_get_processor_handles()
            if not handles:
                return False
            self._handle = handles[0]
            self._lib = amdsmi
            try:
                self.name = str(amdsmi.amdsmi_get_gpu_asic_info(self._handle).get("market_name", "AMD GPU"))
            except Exception:
                self.name = "AMD GPU"
            try:
                self.total = int(amdsmi.amdsmi_get_gpu_memory_total(self._handle, amdsmi.AmdSmiMemoryType.VRAM))
            except Exception:
                self.total = 0
            self.source = "amdsmi"
            print(f"{LOG} GPU telemetry via AMD SMI: {self.name}")
            return True
        except Exception:
            return False

    def _try_pyrsmi(self):
        try:
            from pyrsmi import rocml
            rocml.smi_initialize()
            if rocml.smi_get_device_count() <= 0:
                return False
            self._lib = rocml
            self._handle = 0
            try:
                self.name = str(rocml.smi_get_device_name(0))
            except Exception:
                self.name = "AMD GPU"
            try:
                self.total = int(rocml.smi_get_device_memory_total(0))
            except Exception:
                self.total = 0
            self.source = "pyrsmi"
            print(f"{LOG} GPU telemetry via pyrsmi: {self.name}")
            return True
        except Exception:
            return False

    def _try_torch(self):
        """Opt-in only. Reads the caching allocator's own counters, never the driver."""
        import sys as _sys
        torch = _sys.modules.get("torch")       # never import torch ourselves
        if torch is None:
            self.note = "torch is not loaded yet"
            return False
        try:
            if not torch.cuda.is_initialized():
                self.note = "torch CUDA is not initialised yet - load a model first"
                return False
            props = torch.cuda.get_device_properties(0)
            self.name = props.name
            self.total = int(props.total_memory)
            self._lib = torch
            self.source = "torch"
            self.note = ("torch mode reads PyTorch's allocator counters only. On ROCm any GPU "
                         "polling carries some risk - switch to 'auto (safe)' if the process aborts.")
            print(f"{LOG} GPU memory via torch allocator counters: {self.name}")
            return True
        except Exception as e:
            self.note = f"torch GPU telemetry unavailable: {e}"
            return False

    # --- state ------------------------------------------------------------
    @property
    def available(self):
        return self.source is not None and not self._disabled

    @property
    def has_utilisation(self):
        return self.source in ("nvml", "amdsmi", "pyrsmi") and not self._disabled

    def _fail(self, exc):
        self._fails += 1
        if self._fails >= 3:
            self._disabled = True
            self.note = f"GPU telemetry disabled after repeated errors: {exc}"
            print(f"{LOG} {self.note}")

    # --- reading ----------------------------------------------------------
    def read(self):
        """(utilisation % or None, vram used bytes, temperature C or None)"""
        if not self.available:
            return None, 0, None
        started = time.perf_counter()
        try:
            out = self._read_backend()
        except Exception as e:
            self._fail(e)
            return None, 0, None
        # A monitoring call that blocks is a warning sign; stop rather than risk the run.
        if time.perf_counter() - started > 0.5:
            self._disabled = True
            self.note = "GPU telemetry disabled: the driver took too long to answer"
            print(f"{LOG} {self.note}")
            return None, 0, None
        self._fails = 0
        return out

    def _read_backend(self):
        if self.source == "nvml":
            util = self._lib.nvmlDeviceGetUtilizationRates(self._handle)
            mem = self._lib.nvmlDeviceGetMemoryInfo(self._handle)
            try:
                temp = int(self._lib.nvmlDeviceGetTemperature(self._handle, 0))
            except Exception:
                temp = None
            return float(util.gpu), int(mem.used), temp

        if self.source == "amdsmi":
            util = None
            try:
                util = float(self._lib.amdsmi_get_gpu_activity(self._handle)["gfx_activity"])
            except Exception:
                pass
            used = 0
            try:
                used = int(self._lib.amdsmi_get_gpu_memory_usage(self._handle, self._lib.AmdSmiMemoryType.VRAM))
            except Exception:
                pass
            return util, used, None

        if self.source == "pyrsmi":
            util = None
            try:
                util = float(self._lib.smi_get_device_utilization(0))
            except Exception:
                pass
            used = 0
            try:
                used = int(self._lib.smi_get_device_memory_used(0))
            except Exception:
                pass
            return util, used, None

        if self.source == "torch":
            # Allocator bookkeeping only - no driver call, no synchronisation.
            if not self._lib.cuda.is_initialized():
                return None, 0, None
            return None, int(self._lib.cuda.memory_reserved(0)), None

        return None, 0, None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe_name(text, fallback="nova_profile"):
    cleaned = "".join(c for c in str(text or "") if c.isalnum() or c in "-_ ").strip().replace(" ", "_")
    return cleaned[:64] or fallback


def _fmt_bytes(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "-"
    sign = "-" if n < 0 else ""
    n = abs(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{sign}{n:.0f} {unit}" if unit == "B" else f"{sign}{n:.1f} {unit}"
        n /= 1024
    return f"{sign}{n:.1f} TB"


def _fmt_secs(s):
    try:
        s = float(s)
    except (TypeError, ValueError):
        return "-"
    if s < 1:
        return f"{s * 1000:.0f} ms"
    if s < 60:
        return f"{s:.2f} s"
    return f"{int(s // 60)}m {s % 60:.1f}s"


# ---------------------------------------------------------------------------
# The monitor - one instance per ComfyUI process
# ---------------------------------------------------------------------------
class _Monitor:
    def __init__(self):
        self.lock = threading.RLock()
        self.gpu = _Gpu()
        self.interval = 0.25
        self.history = deque(maxlen=HISTORY)
        self.seq = 0
        self.nodes = {}
        self.names = {}
        self.current = None           # window of the node executing right now
        self.run = None               # the run in progress
        self.last_run = None          # the last completed run
        self.paused = False
        self.reset_each_run = False
        self.last_poll = 0.0
        self.last_log = ""
        self.log_cfg = {"enabled": False, "format": "csv", "name": "nova_profile"}
        self.io_source = "none"
        self.error = ""
        self._thread = None
        self._stop = threading.Event()
        self._wake = threading.Event()        # breaks the idle sleep the moment work starts
        self._sample_lock = threading.Lock()  # one sampler at a time across threads
        self._proc = None
        self._t0 = time.perf_counter()
        self._prev_io = None
        self._prev_t = None
        self._cpu_ceiling = ((psutil.cpu_count() or 1) * 100) if psutil else 0

        if psutil is None:
            self.error = "psutil is not installed - run: pip install psutil"
        else:
            try:
                self._proc = psutil.Process(os.getpid())
                self._proc.cpu_percent(None)   # prime the counter
                try:
                    self._proc.io_counters()
                    self.io_source = "process"
                except Exception:
                    self.io_source = "system" if psutil.disk_io_counters() else "none"
            except Exception as e:
                self.error = f"psutil could not read this process: {e}"

    # --- lifecycle --------------------------------------------------------
    def start(self):
        with self.lock:
            if self._thread and self._thread.is_alive():
                return
            if psutil is None or self._proc is None:
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="NovaFlowPulse", daemon=True)
            self._thread.start()
            print(f"{LOG} Sampling started at {self.interval * 1000:.0f} ms")

    def stop(self):
        self._stop.set()
        self._wake.set()

    def set_interval(self, seconds):
        with self.lock:
            self.interval = max(0.05, min(2.0, float(seconds)))

    def reset(self):
        with self.lock:
            self.nodes.clear()
            self.history.clear()
            self.current = None
            self.run = None
            self.last_run = None
            self.seq = 0
            self._t0 = time.perf_counter()
            self._prev_io = None
            self._prev_t = None
        print(f"{LOG} Statistics reset")

    # --- sampling ---------------------------------------------------------
    def _io_counters(self):
        try:
            if self.io_source == "process":
                io = self._proc.io_counters()
                return int(getattr(io, "read_bytes", 0)), int(getattr(io, "write_bytes", 0))
            if self.io_source == "system":
                io = psutil.disk_io_counters()
                return int(io.read_bytes), int(io.write_bytes)
        except Exception:
            pass
        return 0, 0

    def _loop(self):
        while not self._stop.is_set():
            try:
                self._sample()
            except Exception as e:      # never let the sampler die
                print(f"{LOG} sampler error: {e}")
            watching = (time.time() - self.last_poll) < 5.0
            busy = self.current is not None
            self._wake.wait(self.interval if (watching or busy) else IDLE_INTERVAL)
            self._wake.clear()

    def _sample(self):
        """
        psutil reports CPU over the interval BETWEEN calls, so a sample describes the
        stretch of time ending at it. Node boundaries therefore take a sample before
        the window closes (see _close_node), which is what keeps a busy node's CPU from
        being credited to whichever node happens to run next.
        """
        if self.paused or self._proc is None:
            return
        # Waking the sampler at a node boundary can land it microseconds after the
        # boundary sample. cpu_percent divides CPU time by that gap, which is how a
        # 24-core box reports 3200%. Such a reading is an artefact, not a spike.
        if self._prev_t is not None and (time.perf_counter() - self._prev_t) < MIN_CPU_WINDOW:
            return
        if not self._sample_lock.acquire(blocking=False):
            return                      # a boundary sample is already in flight
        try:
            now = time.perf_counter()
            cpu = self._proc.cpu_percent(None)
            # Belt and braces: the process cannot use more CPU than the box has.
            if self._cpu_ceiling and cpu > self._cpu_ceiling:
                cpu = float(self._cpu_ceiling)
            mem = self._proc.memory_info()
            rss = int(mem.rss)
            vm = psutil.virtual_memory()
            read, write = self._io_counters()
            self.gpu.ensure()
            gpu_util, vram, gpu_temp = self.gpu.read() if self.gpu.available else (None, 0, None)

            span = (now - self._prev_t) if self._prev_t is not None else 0.0
            sample_start = self._prev_t
            if self._prev_io is not None and self._prev_t is not None:
                denom = max(1e-6, span)
                rd_rate = max(0.0, (read - self._prev_io[0]) / denom)
                wr_rate = max(0.0, (write - self._prev_io[1]) / denom)
            else:
                rd_rate = wr_rate = 0.0
            self._prev_io = (read, write)
            self._prev_t = now
            scpu = psutil.cpu_percent(None)
        finally:
            self._sample_lock.release()

        # cpu_percent covers the gap since the previous call. Over a gap of a millisecond
        # the result is meaningless (a 1 ms node "using 497%"), so it is recorded but not
        # counted towards any node's CPU figure.
        cpu_trusted = span >= max(MIN_CPU_WINDOW, self.interval * 0.5)

        with self.lock:
            self.seq += 1
            sample = {
                "s": self.seq,
                "t": round((now - self._t0) * 1000),
                "cpu": round(cpu, 1),
                "scpu": round(scpu, 1),
                "rss": rss,
                "ram": round(vm.percent, 1),
                "rd": round(rd_rate),
                "wr": round(wr_rate),
                "gpu": None if gpu_util is None else round(gpu_util, 1),
                "vram": vram if self.gpu.available else None,
                "n": self.current["id"] if self.current else None,
            }
            self.history.append(sample)

            win = self.current
            if win is not None:
                # The reading must also have been taken entirely inside this node's
                # window. Otherwise a 125 ms measurement gets credited to a 93 ms node
                # and reports activity that happened before the node even started.
                inside = sample_start is not None and sample_start >= win["t0"] - BOUNDARY_TOLERANCE
                if cpu_trusted and inside:
                    win["cpu"].append(cpu)
                win["rss_peak"] = max(win["rss_peak"], rss)
                win["rss_last"] = rss
                win["read"] = read
                win["write"] = write
                if gpu_util is not None and cpu_trusted and inside:
                    win["gpu"].append(gpu_util)
                if self.gpu.available:
                    win["vram_peak"] = max(win["vram_peak"], vram)
                    win["vram_last"] = vram
                if len(win["trace"]) < MAX_RUN_SAMPLES:
                    win["trace"].append(sample)

    # --- execution events -------------------------------------------------
    def on_event(self, event, data):
        """Called from the patched PromptServer.send_sync. Must stay cheap."""
        if event == "execution_start":
            self._run_start(data)
        elif event == "executing":
            node = (data or {}).get("node") if isinstance(data, dict) else None
            if node is None:
                self._close_node()
                self._run_end("finished")
            else:
                self._open_node(str(node))
        elif event in ("execution_success", "execution_error", "execution_interrupted"):
            self._close_node()
            self._run_end(event.replace("execution_", ""))

    def _run_start(self, data):
        with self.lock:
            if self.reset_each_run:
                self.nodes.clear()
            self.run = {
                "id": (data or {}).get("prompt_id", "") if isinstance(data, dict) else "",
                "t0": time.perf_counter(),
                "started": time.time(),
                "nodes": 0,
            }
        self.start()

    def _run_end(self, status):
        with self.lock:
            if self.run is None:
                return
            run = self.run
            run["status"] = status
            run["duration"] = time.perf_counter() - run["t0"]
            run["finished"] = time.time()
            self.last_run = run
            self.run = None
            armed = bool(self.log_cfg.get("enabled"))
        print(f"{LOG} Run {status} in {_fmt_secs(run['duration'])} over {run['nodes']} node(s)")
        if armed:
            try:
                path = self.write_log()
                if path:
                    print(f"{LOG} Log written: {path}")
            except Exception as e:
                print(f"{LOG} Could not write the log: {e}")

    def _open_node(self, node_id):
        self._close_node()
        self.start()
        self._wake.set()            # leave the idle cadence immediately
        read, write = self._io_counters()
        self.gpu.ensure()
        _, vram, _ = self.gpu.read() if self.gpu.available else (None, 0, None)
        rss = int(self._proc.memory_info().rss) if self._proc else 0
        with self.lock:
            self.current = {
                "id": node_id,
                "t0": time.perf_counter(),
                "cpu": [],
                "gpu": [],
                "trace": [],
                "rss0": rss,
                "rss_peak": rss,
                "rss_last": rss,
                "read0": read,
                "write0": write,
                "read": read,
                "write": write,
                "vram0": vram,
                "vram_peak": vram,
                "vram_last": vram,
            }

    def _close_node(self):
        if self.current is None:
            return
        # Take one last sample while this node still owns the slot, so the CPU and
        # memory measured over the final stretch land on it rather than on the next node.
        try:
            self._sample()
        except Exception:
            pass
        with self.lock:
            win = self.current
            self.current = None
            if win is None:
                return
            duration = time.perf_counter() - win["t0"]
            stat = self.nodes.setdefault(win["id"], {
                "id": win["id"], "calls": 0, "total": 0.0, "last": 0.0, "max": 0.0,
                "cpu_avg": 0.0, "cpu_max": 0.0, "gpu_avg": 0.0,
                "rss_peak": 0, "rss_delta": 0, "read": 0, "write": 0,
                "vram_peak": 0, "vram_delta": 0, "samples": 0, "trace": [],
            })
            cpu = win["cpu"]
            gpu = win["gpu"]
            stat["calls"] += 1
            stat["total"] += duration
            stat["last"] = duration
            stat["max"] = max(stat["max"], duration)
            stat["samples"] += len(cpu)
            if cpu:
                # running mean across every sample ever attributed to this node
                prev = stat["cpu_avg"] * max(0, stat["samples"] - len(cpu))
                stat["cpu_avg"] = (prev + sum(cpu)) / max(1, stat["samples"])
                stat["cpu_max"] = max(stat["cpu_max"], max(cpu))
            if gpu:
                stat["gpu_avg"] = (stat["gpu_avg"] * (stat["calls"] - 1) + (sum(gpu) / len(gpu))) / stat["calls"]
            stat["rss_peak"] = max(stat["rss_peak"], win["rss_peak"])
            stat["rss_delta"] = win["rss_last"] - win["rss0"]
            stat["read"] += max(0, win["read"] - win["read0"])
            stat["write"] += max(0, win["write"] - win["write0"])
            if self.gpu.available:
                stat["vram_peak"] = max(stat["vram_peak"], win["vram_peak"])
                stat["vram_delta"] = win["vram_last"] - win["vram0"]
            stat["trace"] = win["trace"]
            if self.run:
                self.run["nodes"] += 1

    # --- reporting --------------------------------------------------------
    def snapshot(self, since=0, trace_for=None):
        self.last_poll = time.time()
        self._wake.set()            # a watcher wants the faster cadence now
        with self.lock:
            samples = [s for s in self.history if s["s"] > since] if since else list(self.history)
            nodes = []
            for stat in self.nodes.values():
                row = {k: v for k, v in stat.items() if k != "trace"}
                row["avg"] = stat["total"] / max(1, stat["calls"])
                nodes.append(row)
            trace = []
            if trace_for is not None:
                stat = self.nodes.get(str(trace_for))
                if stat:
                    trace = stat.get("trace", [])
                if self.current and self.current["id"] == str(trace_for):
                    trace = self.current["trace"]
            vm = psutil.virtual_memory() if psutil else None
            return {
                "version": FLOWPULSE_VERSION,
                "ok": psutil is not None and self._proc is not None,
                "error": self.error,
                "seq": self.seq,
                "interval": self.interval,
                "paused": self.paused,
                "running": self.run is not None,
                "current": self.current["id"] if self.current else None,
                "io_source": self.io_source,
                "cpu_count": (psutil.cpu_count() or 1) if psutil else 1,
                "ram_total": int(vm.total) if vm else 0,
                "gpu": {
                    "available": self.gpu.available,
                    "utilisation": self.gpu.has_utilisation,
                    "name": self.gpu.name,
                    "total": self.gpu.total,
                    "source": self.gpu.source or "",
                    "mode": self.gpu.mode,
                    "note": self.gpu.note,
                    "risky": self.gpu.source == "torch",
                },
                "samples": samples,
                "nodes": nodes,
                "trace": trace,
                "last_run": self._run_summary(self.last_run),
                "last_log": self.last_log,
                "log": dict(self.log_cfg),
            }

    @staticmethod
    def _run_summary(run):
        if not run:
            return None
        return {
            "id": run.get("id", ""),
            "status": run.get("status", ""),
            "duration": run.get("duration", 0.0),
            "nodes": run.get("nodes", 0),
            "finished": run.get("finished", 0),
        }

    def set_names(self, names):
        if isinstance(names, dict):
            with self.lock:
                for k, v in names.items():
                    if isinstance(v, dict):
                        self.names[str(k)] = {"title": str(v.get("title", "")), "type": str(v.get("type", ""))}

    def label(self, node_id):
        info = self.names.get(str(node_id), {})
        return info.get("title") or info.get("type") or f"node {node_id}"

    # --- log file ---------------------------------------------------------
    def write_log(self, fmt=None, name=None):
        fmt = (fmt or self.log_cfg.get("format") or "csv").lower()
        if fmt not in LOG_FORMATS:
            fmt = "csv"
        name = _safe_name(name or self.log_cfg.get("name") or "nova_profile")

        folder = os.path.join(folder_paths.get_output_directory(), LOG_DIR)
        os.makedirs(folder, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        ext = {"csv": "csv", "json": "json", "markdown": "md"}[fmt]
        path = os.path.join(folder, f"{name}-{stamp}.{ext}")

        with self.lock:
            rows = []
            for stat in sorted(self.nodes.values(), key=lambda s: s["total"], reverse=True):
                info = self.names.get(stat["id"], {})
                rows.append({
                    "node_id": stat["id"],
                    "title": info.get("title", ""),
                    "type": info.get("type", ""),
                    "calls": stat["calls"],
                    "total_s": round(stat["total"], 4),
                    "avg_s": round(stat["total"] / max(1, stat["calls"]), 4),
                    "last_s": round(stat["last"], 4),
                    "max_s": round(stat["max"], 4),
                    "cpu_avg_pct": round(stat["cpu_avg"], 1),
                    "cpu_max_pct": round(stat["cpu_max"], 1),
                    "rss_peak_bytes": stat["rss_peak"],
                    "rss_delta_bytes": stat["rss_delta"],
                    "disk_read_bytes": stat["read"],
                    "disk_write_bytes": stat["write"],
                    "gpu_avg_pct": round(stat["gpu_avg"], 1) if self.gpu.has_utilisation else "",
                    "vram_peak_bytes": stat["vram_peak"] if self.gpu.available else "",
                    "vram_delta_bytes": stat["vram_delta"] if self.gpu.available else "",
                })
            run = self._run_summary(self.last_run)
            meta = {
                "profiler": f"Nova FlowPulse v{FLOWPULSE_VERSION}",
                "written": time.strftime("%Y-%m-%d %H:%M:%S"),
                "sample_interval_ms": round(self.interval * 1000),
                "io_source": self.io_source,
                "cpu_count": (psutil.cpu_count() or 1) if psutil else 1,
                "gpu": self.gpu.name if self.gpu.available else "(none)",
                "run": run,
            }

        if not rows:
            return ""

        if fmt == "json":
            payload = {"meta": meta, "nodes": rows}
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, ensure_ascii=False)
        elif fmt == "csv":
            import csv
            with open(path, "w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
                writer.writeheader()
                writer.writerows(rows)
        else:
            lines = [
                f"# {meta['profiler']}", "",
                f"- Written: {meta['written']}",
                f"- Sample interval: {meta['sample_interval_ms']} ms",
                f"- Disk counters: {meta['io_source']}",
                f"- GPU: {meta['gpu']}",
            ]
            if run:
                lines.append(f"- Last run: {run['status']} in {_fmt_secs(run['duration'])} over {run['nodes']} node(s)")
            lines += ["", "| Node | Type | Calls | Total | Avg | Max | CPU avg | CPU max | Peak RAM | ΔRAM | Read | Write |",
                      "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|"]
            for r in rows:
                lines.append(
                    f"| {r['title'] or r['node_id']} | {r['type']} | {r['calls']} | "
                    f"{_fmt_secs(r['total_s'])} | {_fmt_secs(r['avg_s'])} | {_fmt_secs(r['max_s'])} | "
                    f"{r['cpu_avg_pct']}% | {r['cpu_max_pct']}% | {_fmt_bytes(r['rss_peak_bytes'])} | "
                    f"{_fmt_bytes(r['rss_delta_bytes'])} | {_fmt_bytes(r['disk_read_bytes'])} | "
                    f"{_fmt_bytes(r['disk_write_bytes'])} |")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")

        with self.lock:
            self.last_log = path
        return path

    def report_text(self, limit=12):
        with self.lock:
            stats = sorted(self.nodes.values(), key=lambda s: s["total"], reverse=True)
            run = self._run_summary(self.last_run)
            gpu_on = self.gpu.available
            gpu_name = self.gpu.name
        lines = [f"Nova FlowPulse v{FLOWPULSE_VERSION}"]
        if self.error:
            lines.append(f"! {self.error}")
        lines.append(f"Sampling   : every {self.interval * 1000:.0f} ms · disk counters: {self.io_source}")
        lines.append(f"GPU        : {gpu_name if gpu_on else '(not available - panel hidden)'}")
        if run:
            lines.append(f"Last run   : {run['status']} in {_fmt_secs(run['duration'])} over {run['nodes']} node(s)")
        else:
            lines.append("Last run   : none recorded yet")
        if not stats:
            lines.append("")
            lines.append("No node timings yet. Run the workflow once with this node present.")
            return "\n".join(lines)

        total = sum(s["total"] for s in stats) or 1.0
        lines += ["", f"Slowest nodes (share of {_fmt_secs(total)} spent inside nodes):"]
        for stat in stats[:limit]:
            share = stat["total"] / total * 100
            bar = "█" * max(1, int(round(share / 5))) if share >= 2.5 else "▏"
            lines.append(
                f"  {share:5.1f}%  {bar:<20} {self.label(stat['id'])[:34]:<34} "
                f"{_fmt_secs(stat['total']):>9}  x{stat['calls']:<3} "
                f"cpu {stat['cpu_avg']:5.1f}%  peak {_fmt_bytes(stat['rss_peak']):>9}  "
                f"Δ {_fmt_bytes(stat['rss_delta']):>9}")
        if len(stats) > limit:
            lines.append(f"  ... and {len(stats) - limit} more node(s)")
        return "\n".join(lines)


_monitor = _Monitor()


# ---------------------------------------------------------------------------
# Execution hook - wraps send_sync so node boundaries are timed exactly
# ---------------------------------------------------------------------------
def _install_hook():
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_nova_flowpulse_hooked", False):
        return
    original = server.send_sync

    def patched(event, data=None, sid=None):
        try:
            _monitor.on_event(event, data)
        except Exception:
            pass          # the profiler must never break execution
        return original(event, data, sid)

    server.send_sync = patched
    server._nova_flowpulse_hooked = True
    print(f"{LOG} Execution hook installed")


_install_hook()


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------
class NovaFlowPulseNode:
    """A dashboard, not a processing step: drop it anywhere in a workflow."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "log_to_file": ("BOOLEAN", {"default": False,
                                            "tooltip": "Write a profile file to output/nova_flowpulse when each run finishes."}),
                "log_format": (LOG_FORMATS, {"default": "csv"}),
                "log_name": ("STRING", {"default": "nova_profile", "multiline": False,
                                        "tooltip": "File name prefix. A timestamp is always appended."}),
                "sample_interval_ms": ("INT", {"default": 250, "min": 50, "max": 2000, "step": 50,
                                               "tooltip": "How often the process is sampled while a run is active."}),
                "gpu_telemetry": (GPU_MODES, {"default": GPU_MODES[0],
                                              "tooltip": "auto: NVML / AMD SMI only, safe to poll during a run. "
                                                         "torch: reads PyTorch's allocator and is opt-in - polling the "
                                                         "compute runtime has aborted ComfyUI on ROCm."}),
                "reset_each_run": ("BOOLEAN", {"default": False,
                                               "tooltip": "On: every run starts from zero. Off: figures accumulate so averages settle."}),
                # Hidden in the UI, driven by the dashboard (view mode, focused node, sort)
                "view_state": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    OUTPUT_TOOLTIPS = ("Summary of the last completed run, and the path of the log file when logging is on.",)
    FUNCTION = "profile"
    CATEGORY = UTILITY_IO
    OUTPUT_NODE = True
    DESCRIPTION = (f"Nova FlowPulse v{FLOWPULSE_VERSION} - live CPU, memory, disk and GPU per node, "
                   "with an interactive dashboard for finding bottlenecks in large workflows.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # always re-run: it reports on the run it is part of

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        """
        Accept whatever arrives and sort it out in profile().

        A browser holding an older copy of this node sends its widget values by
        position, so adding a widget shifts every value after it by one slot - which
        is how a boolean ends up in gpu_telemetry. Strict validation turns that into
        "Output will be ignored" and the node silently stops working. A monitoring
        node that disappears from the run when the browser is a version behind is
        worse than one that falls back to its defaults and says so.
        """
        return True

    @staticmethod
    def _choice(value, options, default, label):
        if value in options:
            return value
        print(f"{LOG} {label} came through as {value!r}; using {default!r} "
              f"(hard-refresh the browser if this persists)")
        return default

    def profile(self, log_to_file=False, log_format="csv", log_name="nova_profile",
                sample_interval_ms=250, gpu_telemetry=GPU_MODES[0], reset_each_run=False, view_state=""):
        _install_hook()

        log_format = self._choice(log_format, LOG_FORMATS, "csv", "log_format")
        gpu_telemetry = self._choice(gpu_telemetry, GPU_MODES, GPU_MODES[0], "gpu_telemetry")
        try:
            interval = int(sample_interval_ms)
        except (TypeError, ValueError):
            print(f"{LOG} sample_interval_ms came through as {sample_interval_ms!r}; using 250")
            interval = 250

        _monitor.gpu.configure(gpu_telemetry)
        _monitor.set_interval(max(50, min(2000, interval)) / 1000.0)
        _monitor.reset_each_run = bool(reset_each_run)
        _monitor.log_cfg = {
            "enabled": bool(log_to_file),
            "format": log_format,
            "name": _safe_name(log_name),
        }
        _monitor.start()

        report = _monitor.report_text()
        if log_to_file:
            folder = os.path.join(folder_paths.get_output_directory(), LOG_DIR)
            report = (f"Logging is on - a {_monitor.log_cfg['format']} file for THIS run is written to\n"
                      f"  {folder}\nwhen the run finishes.\n\n" + report)
        elif _monitor.last_log:
            report = f"Last log written: {_monitor.last_log}\n\n" + report

        print(f"{LOG} " + report.splitlines()[0])
        return {"ui": {"armed": [bool(log_to_file)]}, "result": (report,)}


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@PromptServer.instance.routes.post("/nova_flowpulse/poll")
async def nova_flowpulse_poll(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    _install_hook()
    _monitor.start()
    if isinstance(body.get("names"), dict):
        _monitor.set_names(body["names"])
    try:
        since = int(body.get("since") or 0)
    except (TypeError, ValueError):
        since = 0
    focus = body.get("focus")
    return web.json_response(_monitor.snapshot(since=since, trace_for=focus))


@PromptServer.instance.routes.post("/nova_flowpulse/control")
async def nova_flowpulse_control(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    action = str(body.get("action", ""))

    if action == "reset":
        _monitor.reset()
        return web.json_response({"ok": True, "message": "Statistics cleared"})
    if action == "pause":
        _monitor.paused = True
        return web.json_response({"ok": True, "message": "Sampling paused"})
    if action == "resume":
        _monitor.paused = False
        _monitor.start()
        return web.json_response({"ok": True, "message": "Sampling resumed"})
    if action == "gpu_mode":
        _monitor.gpu.configure(str(body.get("value", GPU_MODES[0])))
        _monitor.gpu.ensure()
        return web.json_response({"ok": True, "message": f"GPU telemetry: {_monitor.gpu.source or 'none'}"})
    if action == "interval":
        try:
            _monitor.set_interval(float(body.get("value", 250)) / 1000.0)
        except (TypeError, ValueError):
            return web.json_response({"ok": False, "message": "Invalid interval"})
        return web.json_response({"ok": True, "message": f"Interval {_monitor.interval * 1000:.0f} ms"})
    if action == "save":
        try:
            path = _monitor.write_log(body.get("format"), body.get("name"))
        except Exception as e:
            return web.json_response({"ok": False, "message": f"Could not write the log: {e}"})
        if not path:
            return web.json_response({"ok": False, "message": "Nothing to save yet - run the workflow first"})
        return web.json_response({"ok": True, "message": f"Saved {os.path.basename(path)}", "path": path})

    return web.json_response({"ok": False, "message": f"Unknown action '{action}'"})


# ---------------------------------------------------------------------------
# Theme storage - the colour picker on the toolbar
#
# Chrome only. The chart series colours and the status ramp are not stored here
# because they are not themeable: those hues are validated for contrast and
# colour-blind separation, and they carry meaning.
# ---------------------------------------------------------------------------
THEME_DEFAULTS = {
    "accent": "#ff94c2",
    "surface": "#15151a",
    "panel": "#1b1b21",
    "ink": "#e9e9ee",
    "font": '-apple-system, "Segoe UI", sans-serif',
    "size": 11,
}
# Must match FONT_CHOICES in nova_flowpulse.js - only these font stacks are stored,
# because the value ends up inside a stylesheet.
FONT_CHOICES = [
    '-apple-system, "Segoe UI", sans-serif',
    'ui-monospace, "Cascadia Code", "Fira Code", monospace',
    '"Noto Sans", "Segoe UI", Roboto, sans-serif',
    '"Roboto Condensed", "Segoe UI", sans-serif',
]


def _theme_path():
    for getter in ("get_user_directory", "get_output_directory"):
        try:
            base = getattr(folder_paths, getter)()
            if base and os.path.isdir(base):
                return os.path.join(base, "nova_flowpulse_theme.json")
        except Exception:
            continue
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova_flowpulse_theme.json")


def _clean_colour(value, fallback):
    text = str(value or "").strip()
    if (text.startswith("#") and 4 <= len(text) <= 9
            and all(c in "0123456789abcdefABCDEF" for c in text[1:])):
        return text
    return fallback


def _clean_theme(raw):
    raw = raw if isinstance(raw, dict) else {}
    theme = dict(THEME_DEFAULTS)
    for key in ("accent", "surface", "panel", "ink"):
        theme[key] = _clean_colour(raw.get(key), THEME_DEFAULTS[key])
    font = str(raw.get("font", "") or "")
    theme["font"] = font if font in FONT_CHOICES else THEME_DEFAULTS["font"]
    try:
        theme["size"] = max(9, min(16, int(raw.get("size", THEME_DEFAULTS["size"]))))
    except (TypeError, ValueError):
        theme["size"] = THEME_DEFAULTS["size"]
    return theme


@PromptServer.instance.routes.get("/nova_flowpulse/theme")
async def flowpulse_get_theme(request):
    path = _theme_path()
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                return web.json_response({"theme": _clean_theme(json.load(fh))})
    except (OSError, json.JSONDecodeError) as e:
        print(f"{LOG} Could not read the saved theme ({e}); using the defaults")
    return web.json_response({"theme": dict(THEME_DEFAULTS)})


@PromptServer.instance.routes.post("/nova_flowpulse/theme")
async def flowpulse_set_theme(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    theme = _clean_theme(body)
    path = _theme_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(theme, fh, indent=2)
    except OSError as e:
        print(f"{LOG} Could not save the theme: {e}")
        return web.json_response({"ok": False, "error": str(e), "theme": theme})
    print(f"{LOG} Theme saved to {path}")
    return web.json_response({"ok": True, "theme": theme})


NODE_CLASS_MAPPINGS = {"NovaFlowPulseNode": NovaFlowPulseNode}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaFlowPulseNode": "Nova FlowPulse 💓"}
