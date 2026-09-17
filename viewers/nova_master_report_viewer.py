import json
from typing import Any, Dict

try:
    from ..nova_categories import REPORT
except ImportError:  # direct execution / test harness
    from nova_categories import REPORT


class NovaMasterReportViewer:
    CATEGORY = REPORT
    FUNCTION = "render"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report_json",)
    OUTPUT_NODE = True
    DESCRIPTION = "Nova Master Report Viewer v0.2.3 — rich visual dashboard for Nova Audio Master report_json."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "report_json": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Connect Nova Audio Master report_json here."
                }),
            },
            "optional": {
                "view_mode": (["Dashboard", "Compare", "Mastering Guide", "Technical"], {
                    "default": "Dashboard"
                }),
                "theme": (["Nova Dark", "Studio", "High Contrast"], {
                    "default": "Nova Dark"
                }),
                "font_scale": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.75,
                    "max": 1.75,
                    "step": 0.05
                }),
                "show_source": ("BOOLEAN", {"default": True}),
                "show_processing": ("BOOLEAN", {"default": True}),
                "show_validation": ("BOOLEAN", {"default": True}),
                "show_release": ("BOOLEAN", {"default": True}),
            },
        }

    def render(
        self,
        report_json: str,
        view_mode="Dashboard",
        theme="Nova Dark",
        font_scale=1.0,
        show_source=True,
        show_processing=True,
        show_validation=True,
        show_release=True,
    ):
        raw = str(report_json or "").strip()
        payload: Dict[str, Any] = {}
        error = ""

        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    payload = parsed
                else:
                    error = "report_json must contain a JSON object."
            except Exception as e:
                error = f"Invalid report_json: {e}"
        else:
            error = "No report_json connected."

        ui_payload = {
            "payload": payload,
            "raw": raw,
            "error": error,
            "view_mode": str(view_mode),
            "theme": str(theme),
            "font_scale": float(font_scale),
            "show_source": bool(show_source),
            "show_processing": bool(show_processing),
            "show_validation": bool(show_validation),
            "show_release": bool(show_release),
        }

        return {
            "ui": {"nova_master_report_viewer": [ui_payload]},
            "result": (raw,),
        }


NODE_CLASS_MAPPINGS = {
    "NovaMasterReportViewer": NovaMasterReportViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NovaMasterReportViewer": "Nova Master Report Viewer 📊",
}
