"""Revalidation headers for this pack's front-end files.

ComfyUI serves WEB_DIRECTORY through an aiohttp static route that sets
Last-Modified but no Cache-Control.  A response with no freshness information
is not "do not cache" to a browser: it is an invitation to guess, and the
heuristic Chrome uses (a tenth of the file's age) means a module edited today
can be served from disk cache tomorrow without ever asking the server.

That is invisible and it lies convincingly.  The Python half of a change takes
effect on restart while the JavaScript half does not, so the node looks like it
half-loaded a change it actually loaded in full.  A whole debugging session can
go into it -- and did.

`no-cache` does not mean "do not store".  It means "ask before reusing", so the
browser still keeps the file and still gets a 304 with an empty body when
nothing changed.  The cost is one conditional request per module per page load
against a server on localhost; the saving is never again reasoning about a
renderer the browser quietly pinned.
"""

import logging

logger = logging.getLogger("NovaAudioPlayer")

# The static route is mounted under the custom-node directory name, which the
# user can rename when they clone.  Matching on the distinctive part of the
# name survives that; matching on "/extensions/" alone would touch every other
# pack's files, which is not ours to decide.
_MARK = "novaaudioplayer"

_installed = False


def _wants_revalidation(path: str) -> bool:
    p = path.lower()
    return "/extensions/" in p and _MARK in p


async def _on_response_prepare(request, response):
    try:
        if _wants_revalidation(request.path):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
    except Exception:                                   # pragma: no cover
        # A header is never worth a failed response.
        pass


def install() -> bool:
    """Attach the hook to ComfyUI's aiohttp app.  Idempotent; safe to call
    when the server is not importable (tests, tooling)."""
    global _installed
    if _installed:
        return True
    try:
        from server import PromptServer
        app = PromptServer.instance.app
    except Exception as exc:                            # pragma: no cover
        logger.debug("web cache headers not installed: %s", exc)
        return False
    app.on_response_prepare.append(_on_response_prepare)
    _installed = True
    return True
