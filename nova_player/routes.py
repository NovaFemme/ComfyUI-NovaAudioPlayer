"""
HTTP routes for the Nova Player.

Split out of the node file so a registration failure is visible.  The original
wrapped every route in one broad `except Exception: print(...)`, which meant a
genuine ImportError inside a handler looked identical to "routes unavailable".
Here the import guard is narrow and each handler fails with a real status code.

Route map (all under the /nova_player/ namespace the node already owns):

    GET  /nova_player/peaks/{filename}          waveform peak data
    GET  /nova_player/audio/{filename}?fmt=...  original or converted audio
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

import folder_paths

from .config_manager import manager
from .peaks_cache import get_cached_peaks, cache_peaks, read_peaks_sidecar

logger = logging.getLogger("NovaAudioPlayer")

# wav, flac and ogg — everything `soundfile` can write, and nothing else.
#
# THE FORMATS THAT ARE NOT HERE. mp3, m4a, opus and webm were produced by
# shelling out to ffmpeg. The call passed an argv list, never a shell string,
# with the format checked against this table first and the filename resolved
# inside the temp directory — but the Comfy registry's scanner flagged 2.2.0
# and 2.2.1, and spawning an external binary was the likeliest objection.
# A node nobody can install exports nothing at all, so the four lossy formats
# went rather than the release.
#
# Anyone who wants an mp3 has ffmpeg one command away from the wav; the node
# does not need to be the thing that runs it.
MIME = {
    "wav":  "audio/wav",
    "flac": "audio/flac",
    "ogg":  "audio/ogg",
}

# (container, subtype). THE SUBTYPE IS NOT INCIDENTAL: an OGG container holds
# Vorbis-encoded data, and asking libsndfile for OGG with PCM_16 is asking for
# raw samples inside a compressed container, which it refuses with "Invalid
# combination of format, subtype and endian" — the error NovaFemme hit. WAV and
# FLAC both take PCM_16 and happened to work, which is why one wrong constant
# covered two of three formats.
SOUNDFILE_FORMAT = {
    "wav":  ("WAV", "PCM_16"),
    "flac": ("FLAC", "PCM_16"),
    "ogg":  ("OGG", "VORBIS"),
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
        # `attachment` only when the download menu asks. The player uses this
        # same route to STREAM, and a browser handed an attachment disposition
        # for an <audio> src is being told two different things.
        want_download = request.rel_url.query.get("download") == "1"
        disposition = ({"Content-Disposition": f'attachment; filename="audio_output.{fmt}"'}
                       if want_download else {})

        # Fast path: already in the requested format.
        #
        # FileResponse, NOT a read into memory. It streams from disk and — the
        # part that matters — it honours Range requests, answering 206 with the
        # slice asked for.
        #
        # WHY THAT MATTERS FOR PLAYBACK. A browser playing a long file does not
        # download it once: it buffers ahead, drops what it has played, and
        # re-requests a later byte range when it needs more. Against a server
        # that ignores Range and returns 200 with the whole body, it must start
        # over from byte zero and wait — which is heard as a short break in the
        # middle of a track, on a file that is perfectly fine. A 50 MB WAV also
        # meant a 50 MB read into memory per request, in the server process
        # ComfyUI is generating on.
        if src_ext == fmt:
            return web.FileResponse(src_path, headers={
                "Content-Type": MIME[fmt],
                "Accept-Ranges": "bytes",
                **disposition,
            })

        try:
            import soundfile as sf
        except ImportError:
            return web.Response(
                status=501,
                text=(f"Converting to {fmt} needs the soundfile package. "
                      f"The original WAV is available with fmt=wav."))

        container, subtype = SOUNDFILE_FORMAT[fmt]
        try:
            # float for the Vorbis encoder, int16 for the PCM containers: the
            # encoder wants headroom, and the PCM paths must not resample the
            # values they were given.
            dtype = "float32" if subtype == "VORBIS" else "int16"
            data, sr = sf.read(src_path, dtype=dtype, always_2d=True)
            buf = io.BytesIO()
            sf.write(buf, data, sr, format=container, subtype=subtype)
        except Exception as e:                                # noqa: BLE001
            logger.warning("[NovaAudioPlayer] soundfile failed for %s: %s", fmt, e)
            return web.Response(status=500, text=f"Could not write {fmt}: {e}")

        # The converted path still builds in memory: it is the download menu's
        # path, one request per click, and there is nothing on disk to stream.
        return web.Response(body=buf.getvalue(),
                            content_type=MIME[fmt], headers=disposition)

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
