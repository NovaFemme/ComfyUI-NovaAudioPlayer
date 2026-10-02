from __future__ import annotations
import json


# Relative inside ComfyUI, where the pack is a package. Absolute under
# dev/tests, which put the pack root on the path themselves.
try:
    from ..nova_categories import REPORT
except ImportError:
    from nova_categories import REPORT

class NovaTrackInspectorReportViewer:
    CATEGORY = REPORT
    FUNCTION = "render"
    RETURN_TYPES = ("NOVA_REPORT",)
    RETURN_NAMES = ("inspection_json",)
    OUTPUT_NODE = True
    DESCRIPTION = "Rich viewer for Nova Track Inspector timeline, markers, subscores and verdict."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "inspection_json": ("NOVA_REPORT", {
                    "forceInput": True,
                    "tooltip": "Connect Nova Track Inspector's inspection_json here."}),
                "view_mode": (["Inspector", "Timeline", "Markers", "Technical"], {
                    "default": "Inspector",
                    "tooltip": "Inspector: score, grade and verdict. Timeline: the graphs over time. "
                               "Markers: the marked events. Technical: the inspection data. "
                               "Changing it redraws from the cached report; the workflow does not run again."}),
                "theme": (["Nova Dark", "High Contrast", "Studio Slate"], {
                    "default": "Nova Dark",
                    "tooltip": "Colours of the report. It also applies to exported images."}),
                "font_scale": ("FLOAT", {
                    "default": 1.0, "min": 0.75, "max": 1.5, "step": 0.05,
                    "tooltip": "Text size of the report, where 1.0 is normal."}),
            }
        }

    def render(self, inspection_json, view_mode="Inspector", theme="Nova Dark", font_scale=1.0):
        try:
            payload = json.loads(inspection_json) if isinstance(inspection_json, str) else inspection_json
            block = {"payload": payload, "view_mode": view_mode, "theme": theme, "font_scale": float(font_scale)}
        except Exception as e:
            block = {"error": f"Invalid inspector JSON: {e}", "payload": None, "view_mode": view_mode, "theme": theme, "font_scale": float(font_scale)}
        return {"ui": {"nova_track_inspector_viewer": [block]}, "result": (inspection_json,)}

NODE_CLASS_MAPPINGS = {"NovaTrackInspectorReportViewer": NovaTrackInspectorReportViewer}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaTrackInspectorReportViewer": "Nova Track Inspector Report 📈"}
