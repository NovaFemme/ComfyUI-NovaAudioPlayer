# Nova Audio Master v0.2 — integration

This package is designed to merge into the existing `comfyui-novaaudioplayer`
repository rather than install as a separate custom node.

## Copy

From the extracted package, copy:

```text
analysis/
mastering/nova_audio_master.py
mastering/routes.py
```

into:

```text
custom_nodes/comfyui-novaaudioplayer/
```

Final relevant tree:

```text
comfyui-novaaudioplayer/
├── analysis/
│   ├── __init__.py
│   ├── dynamics.py
│   ├── loudness.py
│   └── spectrum.py
├── mastering/
│   ├── nova_audio_master.py
│   └── routes.py
└── __init__.py
```

## Root `__init__.py`

Keep your existing Nova Player and Madow registrations.

Add/import the master node and master routes using the same style already used
by the project, for example:

```python
from .mastering.nova_audio_master import NovaAudioMaster
from .mastering.routes import register_routes as register_master_routes

NODE_CLASS_MAPPINGS["NovaAudioMaster"] = NovaAudioMaster
NODE_DISPLAY_NAME_MAPPINGS["NovaAudioMaster"] = "Nova Audio Master 🎚️"

register_master_routes()
```

Do not replace the rest of the existing root `__init__.py` with this snippet.

## First test

Use:

- mode: Auto
- profile: Metal
- strength: 70
- target_lufs: -11.5
- target_true_peak_dbtp: -1.0
- target_crest_db: 9.5
- high_pass_hz: 30
- stereo_width_percent: 100
- mono_below_hz: 120

Run `The Break.wav` through:

```text
Load Audio -> Nova Audio Master -> Nova Player
```

Please capture:

- Nova Audio Master report
- Nova Player bench metrics
- whole-take spectral footer
- whether the result audibly pumps, distorts, loses kick transient, or becomes harsh

## v0.2 scope

- corrected stereo programme-energy handling for integrated LUFS
- BS.1770 absolute + relative gating
- stereo-linked envelope compression
- iterative compression/loudness correction
- 4x oversampled practical true-peak estimate
- true-peak-aware final limiter
- before/after validation report

The 4x true-peak estimator is deliberately isolated. Its current interpolation
is practical rather than a final certification-grade reconstruction filter.
