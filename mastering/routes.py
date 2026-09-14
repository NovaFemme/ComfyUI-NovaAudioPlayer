"""HTTP routes for Nova Audio Master v0.2.7.2."""
import logging
logger=logging.getLogger("NovaAudioMaster")
ROUTE_PREFIX="/nova/audio-master"

def register_routes()->bool:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError as e:
        logger.info("[NovaAudioMaster] Not running inside ComfyUI, routes skipped (%s)",e)
        return False

    routes=PromptServer.instance.routes

    @routes.get(f"{ROUTE_PREFIX}/status")
    async def status(request):
        return web.json_response({
            "ok":True,
            "extension":"ComfyUI-NovaAudioPlayer",
            "components":["NovaAudioMaster","NovaMasterIdentity"],
            "master_version":"0.2.7.2",
            "identity_version":"0.2.5",
            "api_version":10,
            "report_schema_version":7,
            "transient_headroom":True,
            "progressive_crest_convergence":True,
            "limiter_budget_validation":True,
            "rejected_candidate_diagnostics":True,
            "adaptive_safe_crest_target":True,
            "crest_convergence_reporting":True
        })

    @routes.get(f"{ROUTE_PREFIX}/dynamics-spec")
    async def dynamics_spec(request):
        return web.json_response({
            "method":"transient-headroom -> body-recovery -> bounded-makeup -> TP safety",
            "candidate_sets_per_pass":3,
            "max_passes":3,
            "incremental_acceptance":True,
            "rollback":True,
            "limiter_budget":{
                "preferred_max_db":1.5,
                "acceptable_max_db":2.0,
                "warning_max_db":3.0,
                "heavy_above_db":3.0
            }
        })

    logger.info("[NovaAudioMaster] v0.2.7.2 routes registered under %s",ROUTE_PREFIX)
    return True

__all__ = ["register_routes", "ROUTE_PREFIX", "PROFILES"]
