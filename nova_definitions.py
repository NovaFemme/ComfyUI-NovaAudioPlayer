"""
nova_common.py — shared definistions for the ▶️ Nova Audio nodes.

# common ACE-Step definitions
-----------------------------
They prepare a dataset. They do not train.

The tensor format ACE-Step's trainer consumes is not documented anywhere
stable — it is whatever `acestep/training_v2/preprocess.py` writes today. So
the preprocess node CALLS THAT FUNCTION rather than reimplementing it. A
reimplementation would drift from upstream the first time they touch the
schema, and the failure mode is silent: training runs, loss falls, the LoRA is
subtly wrong. Owning the dataset JSON (where Nova has metadata nobody else
has) and borrowing the tensor writer is the split that stays correct.

# Common custom definitions
---------------------------
Two custom link types travel between nodes e.g. Nova
 SQLite Reader → Nova Tag Writer → Nova Tag Reader → Nova Console:
  * NOVA_TABLE — a dict with schema "nova.authoring.table" and a list of rows
    (dicts) from a database table, plus metadata about the table and its source.
  * NOVA_FILES — a dict with schema "nova.authoring.files" and a list of files
    (dicts) with path, name, stem, extension, size, modified date, etc.
"""
import ast
import importlib.util
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List


# Relative inside ComfyUI, where the pack is a package. Absolute under
# dev/tests, which put the pack root on the path themselves.
try:
    from .nova_categories import TRAINING
except ImportError:
    from nova_categories import TRAINING

# region Ace Common Definitions

# variant -> checkpoint subdirectory, mirroring _VARIANT_DIR in
# acestep/training_v2/model_loader.py. Duplicated rather than imported so the
# dataset nodes stay usable with no acestep install present.
VARIANT_DIRS = {
    "xl_sft": "acestep-v15-xl-sft",
    "xl_turbo": "acestep-v15-xl-turbo",
    "xl_base": "acestep-v15-xl-base",
    "sft": "acestep-v15-sft",
    "turbo": "acestep-v15-turbo",
    "base": "acestep-v15-base",
}

# Everything load_sample_metadata fills in when a field is absent.
SAMPLE_DEFAULTS = {
    "caption": "",
    "lyrics": "[Instrumental]",
    "genre": "",
    "bpm": None,
    "keyscale": "",
    "timesignature": "",
    "duration": 0,
    "is_instrumental": True,
    "custom_tag": "",
    "prompt_override": None,
}

INSTRUMENTAL = "[Instrumental]"
DATASET_TYPE = "NOVA_ACE_DATASET"

def check_checkpoint_tree(checkpoint_dir: str, variant: str) -> List[str]:
    """Return a list of what is missing from an ACE-Step checkpoint directory.

    The trainer loads these with `from_pretrained`, so it needs HuggingFace
    *directories* — a ComfyUI single-file .safetensors will not do, which is
    the most common surprise when you already 'have the models'.
    """
    root = (checkpoint_dir or "").strip()
    if not root:
        return ["checkpoint_dir is empty"]
    if not os.path.isdir(root):
        return [f"{root} is not a directory"]

    missing: List[str] = []
    variant_dir = VARIANT_DIRS.get(variant, variant)
    for name in (variant_dir, "vae", "Qwen3-Embedding-0.6B"):
        if not os.path.isdir(os.path.join(root, name)):
            missing.append(f"{name}/")

    # A directory full of configs is not a checkpoint. from_pretrained needs
    # actual weights, and an earlier version of this check passed a folder that
    # had every .py and .json but no tensors at all — which fails much later,
    # after the loader has already started.
    for name in (variant_dir, "vae", "Qwen3-Embedding-0.6B"):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder):
            continue
        try:
            entries = os.listdir(folder)
        except OSError:
            entries = []
        has_weights = any(
            e.endswith((".safetensors", ".bin", ".pth"))
            and not e.endswith(".index.json")
            for e in entries
        )
        if not has_weights:
            missing.append(f"{name}/ has no weights (.safetensors or .bin)")

    # silence_latent.pt is NOT required at the root. Mirror the search order in
    # acestep.training_v2.model_loader.load_silence_latent exactly: root first,
    # then the variant subdirectory, then any known variant subdirectory. An
    # earlier version of this check only looked at the root and reported a
    # complete upstream checkout as broken, which would have sent you off to
    # re-download a file you already had.
    candidates = [os.path.join(root, "silence_latent.pt"),
                  os.path.join(root, variant_dir, "silence_latent.pt")]
    candidates += [os.path.join(root, d, "silence_latent.pt") for d in VARIANT_DIRS.values()]
    if not any(os.path.isfile(c) for c in candidates):
        missing.append("silence_latent.pt")
    return missing


def describe_checkpoint_requirement(checkpoint_dir: str, variant: str) -> str:
    variant_dir = VARIANT_DIRS.get(variant, variant)
    return (
        f"ACE-Step's preprocessor loads its models with from_pretrained, so "
        f"checkpoint_dir must be the HuggingFace checkpoint tree, not ComfyUI's "
        f"single-file .safetensors. Expected under {checkpoint_dir or '<unset>'}:\n"
        f"    {variant_dir}/\n"
        f"    vae/\n"
        f"    Qwen3-Embedding-0.6B/\n"
        f"    silence_latent.pt\n"
        "Download it from the ACE-Step HuggingFace repo for this variant."
    )


# Packages the remote-code modeling files need that nothing else in a ComfyUI
# install pulls in. Listed for the error message only — nothing here is
# installed or downloaded by this node.
REMOTE_CODE_HINTS = {
    "vector_quantize_pytorch": "vector_quantize_pytorch",
    "einx": "einx",
    "einops": "einops",
    "torch_einops_utils": "torch-einops-utils",
    "frozendict": "frozendict",
}

# Because the suggested command uses --no-deps (to keep the resolver away from
# a ROCm/Intel torch build), the pure-Python dependencies have to be named
# explicitly or the next run just fails one import further along.
REMOTE_CODE_EXTRAS = {
    "vector_quantize_pytorch": ["einx", "frozendict", "torch-einops-utils"],
    "einx": ["frozendict"],
}


def check_remote_code_imports(checkpoint_dir: str, variant: str) -> List[str]:
    """Return the third-party modules the variant's remote code imports but
    that are not installed here.

    ACE-Step's XL checkpoints load through ``trust_remote_code``: transformers
    executes ``modeling_*.py`` straight out of the checkpoint folder, and
    refuses with an ImportError if any of that file's imports are missing. That
    check happens inside Pass 2 — i.e. only after Pass 1 has spent real GPU
    time on every file in the dataset. Doing the same check here costs a few
    milliseconds and fails before a single model loads.

    Deliberately NOT using ``transformers.dynamic_module_utils.check_imports``:
    it is an internal, undocumented API. This reads the same information from
    the same files with the stdlib ``ast`` module.

    Only module-level imports are inspected, and imports guarded by ``try`` or
    ``if`` are skipped — those are optional by construction, so flagging them
    would refuse to run a graph that works.
    """
    root = (checkpoint_dir or "").strip()
    if not root:
        return []
    folder = os.path.join(root, VARIANT_DIRS.get(variant, variant))
    if not os.path.isdir(folder):
        return []

    try:
        names = sorted(f for f in os.listdir(folder) if f.endswith(".py"))
    except OSError:
        return []

    wanted: List[str] = []
    for name in names:
        try:
            with open(os.path.join(folder, name), "r", encoding="utf-8") as handle:
                tree = ast.parse(handle.read())
        except (OSError, SyntaxError):
            continue
        for node in tree.body:                     # module level only
            if isinstance(node, ast.Import):
                wanted += [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if not node.level and node.module:  # skip relative imports
                    wanted.append(node.module.split(".")[0])

    missing: List[str] = []
    for module in dict.fromkeys(wanted):
        if module in sys.stdlib_module_names or module in missing:
            continue
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(module)
    return missing


def install_command(packages: List[str], *, no_deps: bool = True,
                    index_url: str = "", force: bool = False) -> str:
    """The right install incantation for THIS environment, as a printable line.

    Nothing here runs anything — the string is for the user to copy. pip is
    used when the environment has it, and uv otherwise, because a uv-made venv
    (the common ComfyUI layout now) has no pip inside it at all.
    """
    exe = sys.executable
    uv_venv = importlib.util.find_spec("pip") is None
    if uv_venv:
        uv = os.path.join(os.path.dirname(exe), "uv")
        uv = uv if os.path.exists(uv) else "uv"
        parts = [uv, "pip", "install", "--python", exe]
    else:
        parts = [exe, "-m", "pip", "install"]
    if no_deps:
        parts.append("--no-deps")
    if force:
        parts.append("--reinstall" if uv_venv else "--force-reinstall")
    if index_url:
        parts += ["--index-url", index_url]
    parts += list(packages)

    # Wrapped to a narrow column: this lands in Nova Console, which does not
    # wrap, so a long single line just runs off the edge.
    lines: List[str] = []
    current = "    "
    for part in parts:
        if len(current) + len(part) + 1 > 70 and current.strip():
            lines.append(current.rstrip() + " \\")
            current = "        "
        current += part + " "
    lines.append(current.rstrip())
    return "\n".join(lines)


def describe_remote_code_requirement(missing: List[str]) -> str:
    """Say exactly what to install, without installing it."""
    packages: List[str] = []
    for module in missing:
        for package in [REMOTE_CODE_HINTS.get(module, module)] + REMOTE_CODE_EXTRAS.get(module, []):
            if package not in packages:
                packages.append(package)
    command = install_command(packages)
    return (
        "This checkpoint loads through trust_remote_code — transformers runs "
        "the modeling_*.py shipped inside the checkpoint folder, and that file "
        "imports packages ComfyUI does not install.\n"
        "Install them yourself, then restart ComfyUI (this node installs "
        "nothing — Comfy Registry standards prohibit runtime installation):\n"
        + command + "\n"
        "  --no-deps is deliberate: it keeps the resolver from deciding your "
        "torch build is wrong and replacing it. Re-run the node afterwards — "
        "it names whatever is still missing."
    )


def normalise_sample(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Fill defaults so every emitted sample has the full field set."""
    out = dict(SAMPLE_DEFAULTS)
    out.update({k: v for k, v in entry.items() if v is not None or k == "prompt_override"})
    return out

# endregion


# region Common types mapped to custom types.
TABLE_TYPE = "NOVA_TABLE"
FILES_TYPE = "NOVA_FILES"

class AnyType(str):
    """A slot type that ComfyUI's validator accepts from any link.

    ComfyUI compares slot types with `!=`; a str subclass that always reports
    "equal" therefore matches every producer. This is the long-standing
    community idiom for a wildcard input.
    """

    def __ne__(self, other) -> bool:  # noqa: D105
        return False

    def __eq__(self, other) -> bool:  # noqa: D105
        return True

    def __hash__(self):  # noqa: D105
        return hash(str(self))


ANY_TYPE = AnyType("*")


# ---------------------------------------------------------------------------
# Payload builders
# ---------------------------------------------------------------------------

def make_table(
    database_path: str,
    table: str,
    columns: List[str],
    rows: List[Dict[str, Any]],
    sql: str = "",
    where: str = "",
    source: str = "sqlite",
) -> Dict[str, Any]:
    return {
        "schema": "nova.authoring.table",
        "schema_version": 1,
        "source": source,
        "database_path": str(database_path),
        "table": str(table),
        "columns": list(columns),
        "rows": list(rows),
        "record_count": len(rows),
        "column_count": len(columns),
        "sql": str(sql),
        "where": str(where),
    }


def empty_table(database_path: str = "", table: str = "", note: str = "") -> Dict[str, Any]:
    payload = make_table(database_path, table, [], [])
    payload["note"] = note
    return payload


def describe_file(path: str, extra: Dict[str, Any] | None = None) -> Dict[str, Any]:
    name = os.path.basename(path)
    stem, ext = os.path.splitext(name)
    entry: Dict[str, Any] = {
        "path": os.path.abspath(path),
        "name": name,
        "stem": stem,
        "extension": ext[1:].lower(),
    }
    try:
        stat = os.stat(path)
        entry["size_bytes"] = int(stat.st_size)
        entry["modified_utc"] = (
            datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except OSError:
        entry["size_bytes"] = 0
        entry["modified_utc"] = ""
    if extra:
        entry.update(extra)
    return entry


def make_files(root: str, files: List[Dict[str, Any]], decoded: bool = False) -> Dict[str, Any]:
    return {
        "schema": "nova.authoring.files",
        "schema_version": 1,
        "root": str(root),
        "count": len(files),
        "decoded": bool(decoded),
        "files": list(files),
    }


def file_paths(payload: Any) -> List[str]:
    """Accept a NOVA_FILES payload, a bare list, or a single path string."""
    if payload is None:
        return []
    if isinstance(payload, str):
        return [payload] if payload.strip() else []
    if isinstance(payload, dict):
        entries = payload.get("files") or []
        return [str(e.get("path")) for e in entries if isinstance(e, dict) and e.get("path")]
    if isinstance(payload, (list, tuple)):
        out: List[str] = []
        for item in payload:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict) and item.get("path"):
                out.append(str(item["path"]))
        return out
    return []


# ---------------------------------------------------------------------------
# Console text
# ---------------------------------------------------------------------------

def banner(title: str, width: int = 72) -> str:
    title = f" {title} "
    pad = max(0, width - len(title))
    left = pad // 2
    return "=" * left + title + "=" * (pad - left)


def render_value(value: Any, limit: int = 0) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        text = ", ".join(render_value(v) for v in value)
    else:
        text = str(value)
    text = text.replace("\r\n", "\n")
    if limit and len(text) > limit:
        text = text[:limit] + f"… <+{len(text) - limit} chars>"
    return text
# endregion