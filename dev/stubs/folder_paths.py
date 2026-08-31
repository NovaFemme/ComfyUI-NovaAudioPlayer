import tempfile, os
_TMP = os.path.join(tempfile.gettempdir(), "comfy_temp_stub")
os.makedirs(_TMP, exist_ok=True)
def get_temp_directory(): return _TMP
