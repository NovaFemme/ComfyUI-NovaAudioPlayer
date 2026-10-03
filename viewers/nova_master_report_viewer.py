import json
from typing import Any, Dict


# Relative inside ComfyUI, where the pack is a package. Absolute under
# dev/tests, which put the pack root on the path themselves.
try:
    from ..nova_categories import REPORT
except ImportError:
    from nova_categories import REPORT


class NovaMasterReportViewer:
    CATEGORY = REPORT
    FUNCTION = "render"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report_json",)
    OUTPUT_NODE = True
    DESCRIPTION = "Nova Master Report Viewer — a visual dashboard for Nova Audio Master's report_json."

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
                    "default": "Dashboard",
                    "tooltip": "Dashboard: release grade and headline measurements. Compare: source against master. "
                               "Mastering Guide: the process in phases. Technical: the report data. "
                               "Changing it redraws from the cached report; the workflow does not run again."
                }),
                "theme": (["Nova Dark", "Studio", "High Contrast"], {
                    "default": "Nova Dark",
                    "tooltip": "Colours of the report. It also applies to exported images."
                }),
                "font_scale": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.75,
                    "max": 1.75,
                    "step": 0.05,
                    "tooltip": "Text size of the report, where 1.0 is normal."
                }),
                "show_source": ("BOOLEAN", {"default": True, "tooltip": "Show the section on the source audio as it came in."}),
                "show_processing": ("BOOLEAN", {"default": True, "tooltip": "Show the section on what the mastering stages did."}),
                "show_validation": ("BOOLEAN", {"default": True, "tooltip": "Show the section that checks the master against its targets."}),
                "show_release": ("BOOLEAN", {"default": True, "tooltip": "Show the release decision and its reasons."}),
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
