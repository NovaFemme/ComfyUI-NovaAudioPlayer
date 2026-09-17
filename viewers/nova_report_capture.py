"""Save report-viewer captures rasterised in the browser.

WHY THIS EXISTS
---------------
A Nova report viewer draws itself with HTML and CSS in the browser. Any attempt
to redraw that server-side — with PIL, or anything else — is a second
implementation of the same layout in a different technology, and it diverges
from the viewer the moment either side changes. There is no shared source of
truth to keep them honest.

So the picture is taken where the picture already exists: `web/nova_report_export.js`
rasterises the viewer's own live DOM, with the viewer's own stylesheet, and posts
the result here. This module only writes bytes to disk. It does no layout, owns
no styling, and has no opinion about what a report looks like — which is exactly
why the output cannot drift from the viewer.

It is not a node. Nothing imports it at node-registration time except the root
``__init__.py``, which calls ``register_routes()`` the same way the player,
madow and mastering route modules are wired.

SECURITY
--------
The payload is attacker-controllable in the same sense any ComfyUI route is, so
paths are treated as hostile: the subfolder is sanitised segment by segment,
every ``..`` is dropped, absolute paths are rejected, and the resolved
destination must still sit inside ComfyUI's output directory. Anything else is
a 400. Decoded bytes must begin with a PNG signature.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import time
from typing import List, Tuple

logger = logging.getLogger(__name__)

#: PNG magic. Anything that does not start with this is not written.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: Generous, but a report page is tens to low hundreds of KB. 24 MB per image
#: and 96 MB per request stop a runaway client filling the disk.
_MAX_IMAGE_BYTES = 24 * 1024 * 1024
_MAX_TOTAL_BYTES = 96 * 1024 * 1024
_MAX_IMAGES = 32

_SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_segment(part: str) -> str:
    """One path segment, stripped to characters that cannot mean anything else."""
    cleaned = _SAFE_SEGMENT.sub("_", (part or "").strip())
    cleaned = cleaned.strip("._")
    return cleaned[:64]


def _safe_subfolder(raw: str) -> str:
    """A relative subfolder path, or '' when nothing survives sanitising."""
    parts: List[str] = []
    for chunk in re.split(r"[\\/]+", raw or ""):
        if chunk in ("", ".", ".."):
            continue
        seg = _safe_segment(chunk)
        if seg:
            parts.append(seg)
    return os.path.join(*parts) if parts else ""


def _resolve_target(output_root: str, subfolder: str, filename: str) -> str:
    """Absolute destination, guaranteed to be inside ``output_root``.

    Raises ValueError otherwise. The containment test is done on the REALPATH,
    so a symlink inside the output folder cannot be used to escape it.
    """
    root = os.path.realpath(output_root)
    target = os.path.realpath(os.path.join(root, subfolder, filename))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("resolved outside the ComfyUI output directory")
    return target


def _decode(data_url: str) -> bytes:
    """Bytes from a data: URL or a bare base64 string. Verifies the PNG magic."""
    payload = data_url or ""
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception as exc:                       # pragma: no cover - malformed input
        raise ValueError(f"not valid base64: {exc}") from exc
    if not raw.startswith(_PNG_MAGIC):
        raise ValueError("payload is not a PNG")
    if len(raw) > _MAX_IMAGE_BYTES:
        raise ValueError(f"image exceeds {_MAX_IMAGE_BYTES // (1024 * 1024)} MB")
    return raw


_MAX_STRIPS = 128


def _stitch(parts: List[bytes]) -> bytes:
    """Join vertical strips of one view, top to bottom, into a single PNG.

    The browser sends strips only when a canvas the full height of the report
    cannot be read back on that machine - a GPU read-back fault, not anything
    this pack controls. Each strip is rendered from the SAME full-size image at
    a different vertical offset, so stitching reproduces exactly the picture a
    healthy browser would have produced in one piece.
    """
    import io
    from PIL import Image

    images = []
    try:
        for raw in parts:
            images.append(Image.open(io.BytesIO(raw)).convert("RGBA"))
        width = max(im.width for im in images)
        height = sum(im.height for im in images)
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        offset = 0
        for im in images:
            canvas.paste(im, (0, offset))
            offset += im.height
        buffer = io.BytesIO()
        canvas.save(buffer, "PNG")
        canvas.close()
        return buffer.getvalue()
    finally:
        for im in images:
            try:
                im.close()
            except Exception:                       # pragma: no cover
                pass


def _looks_empty(raw: bytes) -> bool:
    """True when a decoded PNG has no visible pixels at all.

    A browser extension that hooks ``toDataURL`` returns a perfectly valid PNG
    of the right dimensions with every pixel transparent. The browser reports
    success, this route sees valid PNG bytes, and the author ends up with a
    folder of blank files and no explanation. Pillow ships with ComfyUI, but a
    missing or unreadable image must never block a legitimate save, so any
    failure here answers "not empty".
    """
    try:
        import io
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            if im.mode in ("RGBA", "LA"):
                alpha = im.getchannel("A").getextrema()
                return alpha == (0, 0)
            return im.convert("L").getextrema() == (0, 0)
    except Exception:                               # pragma: no cover - never fatal
        return False


def register_routes() -> bool:
    """Attach the capture route to the running PromptServer.

    Returns True when the route was registered. An ImportError means this module
    was imported outside a ComfyUI process, which is not an error.
    """
    try:
        from aiohttp import web
        from server import PromptServer
        import folder_paths
    except ImportError as exc:
        logger.info("[NovaAudioPlayer] Not inside ComfyUI, report capture route skipped (%s)", exc)
        return False

    routes = PromptServer.instance.routes

    @routes.post("/nova_report_capture/save")
    async def save_report_images(request):
        """Write browser-rasterised report views into ComfyUI's output folder.

        Body (JSON):
            reference       str   base name, e.g. "nova_report"
            subfolder       str   relative to ComfyUI/output
            overwrite       bool  false (default) appends a timestamp instead
            images          [{ view: str, png: str }]   png is a data: URL

        200: {"ok": true, "saved": [{view, filename, subfolder, path}], "count": n}
        400: {"ok": false, "error": "..."}                 bad input
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "body is not JSON"}, status=400)

        images = body.get("images")
        if not isinstance(images, list) or not images:
            return web.json_response({"ok": False, "error": "no images supplied"}, status=400)
        if len(images) > _MAX_IMAGES:
            return web.json_response(
                {"ok": False, "error": f"more than {_MAX_IMAGES} images in one request"},
                status=400,
            )

        reference = _safe_segment(body.get("reference") or "nova_report") or "nova_report"
        subfolder = _safe_subfolder(body.get("subfolder") or "")
        overwrite = bool(body.get("overwrite"))

        output_root = folder_paths.get_output_directory()
        stamp = time.strftime("%Y%m%d-%H%M%S")

        # Decode and validate EVERYTHING before writing anything, so a bad
        # entry half way down the list cannot leave a partial set on disk.
        pending: List[Tuple[str, str, bytes]] = []
        total = 0
        for index, item in enumerate(images):
            if not isinstance(item, dict):
                return web.json_response(
                    {"ok": False, "error": f"image {index} is not an object"}, status=400)
            view = _safe_segment(item.get("view") or f"view{index + 1}") or f"view{index + 1}"
            strips = item.get("strips")
            try:
                if isinstance(strips, list):
                    if not strips:
                        raise ValueError("no strips supplied")
                    if len(strips) > _MAX_STRIPS:
                        raise ValueError(f"more than {_MAX_STRIPS} strips")
                    decoded = [_decode(part or "") for part in strips]
                    total += sum(len(part) for part in decoded)
                    if total > _MAX_TOTAL_BYTES:
                        raise ValueError(
                            f"request exceeds {_MAX_TOTAL_BYTES // (1024 * 1024)} MB in total")
                    raw = _stitch(decoded)
                else:
                    raw = _decode(item.get("png") or "")
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": f"image {index} ({view}): {exc}"}, status=400)
            except Exception as exc:                # pragma: no cover - Pillow failure
                return web.json_response(
                    {"ok": False,
                     "error": f"image {index} ({view}): strips could not be joined ({exc})"},
                    status=400)

            total += len(raw)
            if total > _MAX_TOTAL_BYTES:
                return web.json_response(
                    {"ok": False,
                     "error": f"request exceeds {_MAX_TOTAL_BYTES // (1024 * 1024)} MB in total"},
                    status=400)

            name = f"{reference}_{view}.png" if overwrite else f"{reference}_{view}_{stamp}.png"
            try:
                target = _resolve_target(output_root, subfolder, name)
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": f"image {index} ({view}): {exc}"}, status=400)
            if _looks_empty(raw):
                return web.json_response(
                    {"ok": False,
                     "error": (
                         f"image {index} ({view}) is completely blank, so nothing was "
                         "written. The browser produced a valid PNG of the right size "
                         "with no pixels in it. The usual cause is the browser's "
                         "GPU-accelerated 2D canvas failing to read back on Linux/AMD "
                         "drivers: set gfx.canvas.accelerated to false in Firefox's "
                         "about:config, or disable \"Accelerated 2D canvas\" in "
                         "chrome://flags, and restart the browser."
                     )}, status=400)
            pending.append((view, target, raw))

        saved = []
        for view, target, raw in pending:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(raw)
            saved.append({
                "view": view,
                "filename": os.path.basename(target),
                "subfolder": subfolder,
                "path": target,
            })
            logger.info("[NovaAudioPlayer] report capture wrote %s", target)

        return web.json_response({"ok": True, "saved": saved, "count": len(saved)})

    logger.info("[NovaAudioPlayer] report capture route registered")
    return True
