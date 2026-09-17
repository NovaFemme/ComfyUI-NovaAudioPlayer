"""HTTP routes for Nova Final Master Validator v0.3.0."""
import logging
logger = logging.getLogger("NovaFinalMasterValidator")
ROUTE_PREFIX = "/nova/final-master-validator"

def register_routes() -> bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError as e:
        logger.info("[NovaFinalMasterValidator] Not running inside ComfyUI, routes skipped (%s)", e)
        return False

    routes = PromptServer.instance.routes

    @routes.get(f"{ROUTE_PREFIX}/status")
    async def status(request):
        return web.json_response({
            "ok": True,
            "extension": "ComfyUI-NovaAudioPlayer",
            "component": "NovaFinalMasterValidator",
            "validator_version": "0.3.1",
            "validation_schema_version": 1,
            "reference_report_schema_min": 5,
            "reference_report_schema_tested": 10,
            "verdicts": ["BIT_EXACT","REPRODUCTION_MATCH","ACCEPTABLE_DERIVATIVE","DRIFT_DETECTED","VALIDATION_FAIL"],
            "metric_statuses": ["MATCH","WITHIN_TOLERANCE","DRIFT","FAIL"],
        })

    @routes.get(f"{ROUTE_PREFIX}/spec")
    async def spec(request):
        return web.json_response({
            "identity": "canonical channels-first float32 little-endian PCM SHA-256",
            "comparison": ["format","LUFS","true_peak","sample_peak","RMS","crest","correlation","tonal_bands"],
            "tolerance_source": "reference report validation_reference/reproduction_fingerprint",
            "drift_attribution": True,
            "audio_passthrough": True,
        })

    logger.info("[NovaFinalMasterValidator] v0.3.1 routes registered under %s", ROUTE_PREFIX)
    return True

__all__ = ["register_routes", "ROUTE_PREFIX", "PROFILES"]
