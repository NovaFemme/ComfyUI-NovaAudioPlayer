"""
HTTP routes for the Nova Player.

Split out of the node file so a registration failure is visible.  The original
wrapped every route in one broad `except Exception: print(...)`, which meant a
genuine ImportError inside a handler looked identical to "routes unavailable".
Here the import guard is narrow and each handler fails with a real status code.

Route map (all under the /nova_player/ namespace the node already owns):

    GET  /nova_player/peaks/{filename}          waveform peak data
    GET  /nova_player/audio/{filename}?fmt=...  original or transcoded audio
    GET  /nova_player/flac/{filename}           legacy redirect -> audio?fmt=flac
    GET  /nova_player/config                    full config snapshot
    GET  /nova_player/config/version            cheap change poll
    POST /nova_player/config/theme              create/update a named theme
    POST /nova_player/config/active-theme       switch the active theme
    POST /nova_player/config/renderer/{id}      persist renderer params
    POST /nova_player/config/reload             re-read both files from disk
    DELETE /nova_player/config/theme/{name}     remove a theme
"""

import io
import logging
import os
import subprocess
import tempfile

import folder_paths

from .config_manager import manager
from .peaks_cache import get_cached_peaks, cache_peaks, read_peaks_sidecar

logger = logging.getLogger("NovaAudioPlayer")

MIME = {
    "wav":  "audio/wav",
    "mp3":  "audio/mpeg",
    "m4a":  "audio/mp4",
    "ogg":  "audio/ogg",
    "opus": "audio/ogg; codecs=opus",
    "flac": "audio/flac",
    "webm": "audio/webm",
}

SOUNDFILE_FMTS = {"wav", "flac", "ogg"}

FFMPEG_ARGS = {
    "mp3":  lambda q: ["-c:a", "libmp3lame", "-b:a", f"{q}k"],
    "m4a":  lambda q: ["-c:a", "aac", "-b:a", "256k"],
    "ogg":  lambda q: ["-c:a", "libvorbis", "-q:a", "6"],
    "opus": lambda q: ["-c:a", "libopus", "-b:a", "192k"],
    "flac": lambda q: ["-c:a", "flac"],
    "webm": lambda q: ["-c:a", "libopus", "-b:a", "192k"],
    "wav":  lambda q: ["-c:a", "pcm_s16le"],
}


def _safe_temp_path(filename: str):
    """Resolve `filename` inside the temp directory, or return None.

    The filename arrives from a URL, so it is treated as hostile: basename only,
    and the resolved path must still sit inside the temp directory.  The
    original code interpolated it straight into os.path.join.
    """
    name = os.path.basename(filename or "")
    if not name or name in (".", ".."):
        return None

    temp_dir = os.path.realpath(folder_paths.get_temp_directory())
    candidate = os.path.realpath(os.path.join(temp_dir, name))
    if os.path.commonpath([temp_dir, candidate]) != temp_dir:
        return None
    return candidate


def register_routes() -> bool:
    """Attach every route to the running PromptServer.

    Returns True when routes were registered.  Import failures are caught (the
    module is importable outside a ComfyUI process, e.g. for tests) but the
    handler bodies are not wrapped in blanket try/except.
    """
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError as e:
        logger.info("[NovaAudioPlayer] Not running inside ComfyUI, routes skipped (%s)", e)
        return False

    routes = PromptServer.instance.routes

    # ------------------------------------------------------------------
    # Peaks
    # ------------------------------------------------------------------

    @routes.get("/nova_player/peaks/{filename}")
    async def serve_peaks(request):
        filename = request.match_info["filename"]
        peaks = get_cached_peaks(filename)

        if peaks is None:
            path = _safe_temp_path(filename)
            if path is None:
                return web.Response(status=400, text="Invalid filename")
            peaks = read_peaks_sidecar(path)
            if peaks is not None:
                cache_peaks(filename, peaks)   # re-warm the memory cache

        if peaks is None:
            return web.Response(status=404, text="Peaks not found — re-run the node")
        return web.json_response(peaks)

    # ------------------------------------------------------------------
    # Audio — original file, or transcoded on demand
    # ------------------------------------------------------------------

    @routes.get("/nova_player/audio/{filename}")
    async def serve_audio(request):
        filename = request.match_info["filename"]
        fmt = request.rel_url.query.get("fmt", "wav").lower().lstrip(".")

        if fmt not in MIME:
            return web.Response(status=400, text=f"Unsupported format: {fmt}")

        src_path = _safe_temp_path(filename)
        if src_path is None:
            return web.Response(status=400, text="Invalid filename")
        if not os.path.exists(src_path):
            return web.Response(status=404, text="Audio file not found — re-run the node")

        src_ext = os.path.splitext(src_path)[1].lower().lstrip(".")
        disposition = {"Content-Disposition": f'attachment; filename="audio_output.{fmt}"'}

        # Fast path: already in the requested format.
        if src_ext == fmt:
            with open(src_path, "rb") as f:
                return web.Response(body=f.read(), content_type=MIME[fmt], headers=disposition)

        # Lossless formats go through soundfile when it is available — no
        # subprocess, no ffmpeg dependency for the common cases.
        if fmt in SOUNDFILE_FMTS:
            try:
                import soundfile as sf

                data, sr = sf.read(src_path, dtype="int16", always_2d=True)
                buf = io.BytesIO()
                sf.write(buf, data, sr,
                         format={"wav": "WAV", "flac": "FLAC", "ogg": "OGG"}[fmt],
                         subtype="PCM_16")
                return web.Response(body=buf.getvalue(),
                                    content_type=MIME[fmt], headers=disposition)
            except ImportError:
                pass                     # soundfile absent — fall through to ffmpeg
            except Exception as e:       # bad data, unsupported subtype, ...
                logger.warning("[NovaAudioPlayer] soundfile failed for %s: %s", fmt, e)

        # Everything else needs ffmpeg.
        bitrate = request.rel_url.query.get("bitrate", "192")
        if not bitrate.isdigit():
            bitrate = "192"

        with tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", src_path] + FFMPEG_ARGS[fmt](bitrate) + [tmp_path],
                capture_output=True, check=True,
            )
            with open(tmp_path, "rb") as f:
                audio_bytes = f.read()
        except FileNotFoundError:
            return web.Response(status=501, text="ffmpeg is not installed on the server")
        except subprocess.CalledProcessError as e:
            detail = (e.stderr or b"").decode("utf-8", "replace")[-400:]
            logger.error("[NovaAudioPlayer] ffmpeg failed: %s", detail)
            return web.Response(status=500, text=f"Transcode failed: {detail}")
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        return web.Response(body=audio_bytes, content_type=MIME[fmt], headers=disposition)

    @routes.get("/nova_player/flac/{filename}")
    async def serve_flac_legacy(request):
        filename = request.match_info["filename"]
        raise web.HTTPFound(f"/nova_player/audio/{filename}?fmt=flac")

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    @routes.get("/nova_player/config")
    async def get_config(request):
        return web.json_response(manager.snapshot())

    @routes.get("/nova_player/config/version")
    async def get_config_version(request):
        # Deliberately tiny: the front end polls this, not the whole snapshot.
        return web.json_response({"version": manager.version})

    @routes.post("/nova_player/config/reload")
    async def reload_config(request):
        manager.reload_all()
        return web.json_response({"status": "success", "version": manager.version})

    @routes.post("/nova_player/config/theme")
    async def save_theme(request):
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"status": "error", "message": "Invalid JSON body"},
                                     status=400)
        if not isinstance(payload, dict):
            return web.json_response({"status": "error", "message": "Payload must be an object"},
                                     status=400)

        name = payload.get("name")
        theme = payload.get("theme", {})
        make_active = bool(payload.get("makeActive", False))

        ok, message = manager.save_theme(name, theme, make_active=make_active)
        return web.json_response(
            {"status": "success" if ok else "error",
             "message": message,
             "version": manager.version},
            status=200 if ok else 400,
        )

    @routes.post("/nova_player/config/active-theme")
    async def set_active_theme(request):
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"status": "error", "message": "Invalid JSON body"},
                                     status=400)
        ok, message = manager.set_active_theme((payload or {}).get("name"))
        return web.json_response(
            {"status": "success" if ok else "error",
             "message": message,
             "version": manager.version},
            status=200 if ok else 400,
        )

    @routes.delete("/nova_player/config/theme/{name}")
    async def delete_theme(request):
        ok, message = manager.delete_theme(request.match_info["name"])
        return web.json_response(
            {"status": "success" if ok else "error",
             "message": message,
             "version": manager.version},
            status=200 if ok else 400,
        )

    @routes.post("/nova_player/config/appearance")
    async def save_appearance(request):
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"status": "error", "message": "Invalid JSON body"},
                                     status=400)
        ok, message = manager.save_appearance(payload or {})
        return web.json_response(
            {"status": "success" if ok else "error",
             "message": message,
             "version": manager.version},
            status=200 if ok else 400,
        )

    @routes.post("/nova_player/config/renderer/{renderer_id}")
    async def save_renderer(request):
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"status": "error", "message": "Invalid JSON body"},
                                     status=400)
        ok, message = manager.save_renderer_params(
            request.match_info["renderer_id"], payload or {}
        )
        return web.json_response(
            {"status": "success" if ok else "error",
             "message": message,
             "version": manager.version},
            status=200 if ok else 400,
        )

    logger.info("[NovaAudioPlayer] Routes registered")
    return True
