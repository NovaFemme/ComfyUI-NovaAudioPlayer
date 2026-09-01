"""
Built-in default configuration for the Nova Player node.

These dicts are the bottom of the resolution stack:

    built-in defaults  ->  config/*.json  ->  active theme  ->  per-node overrides

Every value the front end can read has a default here, so a missing, empty or
malformed JSON file can never stop the node from rendering.  The config manager
deep-merges the on-disk files over these, and writes these out verbatim the
first time it runs against a package that has no config/ directory yet.

COLOURS ARE ROLES, NOT LITERALS.  Renderers never contain a hex string; they
ask the resolved token table for a role name.  That indirection is what makes
the settings panel possible, and it is why adding a colour to the UI means
adding a role here rather than editing a draw call.

All colour values accept: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba().
Eight-digit hex is fully supported end to end (see web/core/color.js).
"""

CONFIG_VERSION = 2

# --------------------------------------------------------------------------
# Colour configuration
# --------------------------------------------------------------------------
# "nova-dark" reproduces the palette the widget shipped with, one role per
# distinct colour that used to be a literal inside draw().

DEFAULT_COLOR_CONFIG = {
    "activeTheme": "nova-dark",
    "themes": {
        "nova-dark": {
            "label": "Nova Dark",
            "roles": {
                # -- surface / chrome ------------------------------------
                "surface":               "#00000033",
                "text":                  "#c8c8e8",
                "text.dim":              "#cbcbcb",
                "divider":               "#ffffff14",

                # -- waveform --------------------------------------------
                "wave.idle":             "#610042",
                "wave.idle.right":       "#4d3221",
                "wave.left":             "#6c63ff",
                "wave.left.pulse":       "#d9d6ff",
                "wave.right":            "#cea12f",
                "wave.right.pulse":      "#fff0d6",
                "wave.label":            "#232e74",
                "wave.label.bg":         "#0000008c",
                "playhead":              "#ffffff",

                # -- transport controls ----------------------------------
                "btn.bg":                "#1a1a7e",
                "btn.active":            "#232e74",
                "btn.icon":              "#ffffff",
                "scrub.bg":              "#bab041",
                "scrub.fill":            "#6c63ff",
                "vol.track":             "#702525",
                "vol.fill":              "#efefef",
                "vol.knob":              "#efefef",
                "speaker.muted":         "#e05555",
                "hover.glow":            "#a89fff",

                # -- level meter -----------------------------------------
                "meter.green.lit":       "#3ecf5c",
                "meter.green.dim":       "#1a2e1e",
                "meter.yellow.lit":      "#d4c94a",
                "meter.yellow.dim":      "#2a2a1a",
                "meter.red.lit":         "#e05555",
                "meter.red.dim":         "#2e1a1a",
                "meter.peak":            "#ffffff",
                "clip.led":              "#ff3b3b",
                "clip.highlight":        "#ffb4b4b3",

                # -- spectrum --------------------------------------------
                "spectrum.fill.low":     "#6c63ffaa",
                "spectrum.fill.high":    "#cea12f",
                "spectrum.rim":          "#ffffff",
                "spectrum.rim.glow":     "#ffffff66",
                "spectrum.label.bg":     "#00000080",
                "spectrum.label.rule":   "#ffffff1a",
                "spectrum.label.text":   "#ffffff",

                # -- goniometer ------------------------------------------
                "gonio.bg":              "#00121ceb",
                "gonio.ring":            "#00c8ff1f",
                "gonio.ring.outer":      "#00c8ff40",
                "gonio.border":          "#610042",
                "gonio.grid":            "#00c8ff33",
                "gonio.trace":           "#00dcffd9",
                "gonio.trace.glow":      "#00e6ffb3",
                "gonio.trace.frozen":    "#00b4d273",

                # -- correlation gauge -----------------------------------
                "gauge.box.bg":          "#00000033",
                "gauge.box.border":      "#610042",
                "gauge.needle":          "#bbbbbb",
                "gauge.needle.tip":      "#ffffff",
                "gauge.pivot":           "#ffffff",
                "gauge.title":           "#c8c8dc66",
                "gauge.readout.pos":     "#aaddaa",
                "gauge.readout.neg":     "#ff5555",
                "gauge.seg.green":       "#22aa22",
                "gauge.seg.lime":        "#88cc00",
                "gauge.seg.yellow":      "#cccc00",
                "gauge.seg.orange":      "#cc6600",
                "gauge.seg.red":         "#cc2222",

                # -- spectrogram -----------------------------------------
                "spectrogram.bg":        "#000000",
                "spectrogram.grid":      "#ffffff2e",
                "spectrogram.label":     "#ffffff80",


                # -- level meters (peak_rms, combined_suite) --------------
                "level.bg":              "#1c1c26",
                "level.rms":             "#3ecf5c",
                "level.peak":            "#ff3b3b",

                # -- phase / correlation strip (lr_correlation) ----------
                "phase.in":              "#3ecf5c",
                "phase.out":             "#e05555",
                "phase.center":          "#ffffff40",

                # -- frequency bands (freq_percentages, combined_suite) --
                "band.bass":             "#3498db",
                "band.mid":              "#2ecc71",
                "band.presence":         "#e67e22",
                "band.hf":               "#9b59b6",

                # -- analysis grids / flat spectrum fill -----------------
                "grid.line":             "#ffffff1a",
                "spectrum.fill":         "#6c63ffaa",

                # -- projected guidance ----------------------------------
                "guidance.target":       "#00e67659",
                "guidance.path":         "#29b6f6",
                "guidance.projected":    "#29b6f68c",
                "guidance.over":         "#e0555540",   # measured above target
                "guidance.under":        "#3ecf5c40",   # measured below target
                "guidance.ref":          "#ffd54f",     # frozen reference take
                "guidance.hud.bg":       "#05060ceb",   # near-opaque: the HUD sits over
                                                       # album art, and at 65% black
                                                       # the numbers were unreadable

                # -- bench statistics strip ------------------------------
                "bench.bg":              "#05060cf2",
                "bench.rule":            "#ffffff1f",
                "bench.heading":         "#8a93b8",
                "bench.label":           "#7d84a3",
                "bench.value":           "#dfe4f5",
                "bench.warn":            "#ff8a5c",

                # -- control hints ---------------------------------------
                "tooltip.bg":            "#0b0d18f5",
                "tooltip.border":        "#ffffff26",
                "tooltip.text":          "#e6e9f7",

                # -- view-mode pill --------------------------------------
                "mode.text":             "#ffffff",
                "mode.border":           "#ffffff",
                "mode.waveform":         "#be5504",
                "mode.eq":               "#3a5311",
                "mode.analyzer":         "#017da2",
                "mode.spectrogram":      "#4b0082",
                "mode.combined":         "#1a4a3a",
                "mode.peak_rms":         "#1f6f4a",
                "mode.lr_correlation":   "#6a3d9a",
                "mode.freq_percentages": "#8a5a1f",
                "mode.combined_suite":   "#1a4a6a",
                "mode.fft_analyzer":     "#0f5f6f",
                "mode.rta_analyzer":     "#5a2d6f",
                "mode.projected_guidance": "#1f4f7f",

                # -- settings panel (HTML, styled from these tokens) -----
                "panel.bg":              "#12101acc",
                "panel.surface":         "#1b1723",
                "panel.border":          "#3d3550",
                "panel.text":            "#ede9f2",
                "panel.text.dim":        "#847b96",
                "panel.accent":          "#6c63ff",
            },
            "ramps": {
                # Spectrogram heat LUT.  [position 0-255, colour]
                "spectrogram": [
                    [0,   "#000000"],
                    [40,  "#14003c"],
                    [80,  "#500078"],
                    [120, "#b40028"],
                    [160, "#dc2800"],
                    [200, "#ff8c00"],
                    [230, "#ffdc00"],
                    [255, "#ffffff"],
                ],
            },
        },

        "nova-ice": {
            "label": "Nova Ice",
            "roles": {
                "surface":               "#00060c40",
                "text":                  "#d8ecf6",
                "text.dim":              "#9fb8c4",
                "divider":               "#ffffff14",
                "wave.idle":             "#123a4a",
                "wave.idle.right":       "#134438",
                "wave.left":             "#38bdf8",
                "wave.left.pulse":       "#e0f6ff",
                "wave.right":            "#22d3a7",
                "wave.right.pulse":      "#d8fff4",
                "scrub.fill":            "#38bdf8",
                "btn.bg":                "#0d3b52",
                "btn.active":            "#12586f",
                "vol.track":             "#123444",
                "tooltip.bg":            "#04141df5",
                "tooltip.border":        "#38bdf83d",
                "tooltip.text":          "#d8ecf6",
                "gonio.border":          "#1d5f73",
                "gauge.box.border":      "#1d5f73",
                "mode.waveform":         "#0e5a72",
                "mode.eq":               "#14584a",
                "mode.analyzer":         "#1f4f7a",
                "mode.spectrogram":      "#2b3f7a",
                "mode.combined":         "#155e63",
                "panel.accent":          "#38bdf8",
            },
            "ramps": {
                "spectrogram": [
                    [0,   "#000000"],
                    [50,  "#04203c"],
                    [110, "#0b6d8f"],
                    [170, "#22d3a7"],
                    [215, "#a8f0d8"],
                    [255, "#ffffff"],
                ],
            },
        },
    },
}

# nova-ice states only what differs; every role it does not name is inherited
# from the base theme at resolve time (see web/core/color.js resolveTheme).
BASE_THEME = "nova-dark"


# --------------------------------------------------------------------------
# System configuration
# --------------------------------------------------------------------------

DEFAULT_SYSTEM_CONFIG = {
    # How two colours are blended when building a gradient, a pulse ramp or a
    # spectrogram LUT.
    #   "srgb"   reproduces the look the node shipped with (the old lerpColor
    #            interpolated bytes, and the heat ramp's stops were hand-tuned
    #            against that). Default, so nothing shifts under you.
    #   "linear" is physically correct: no chalky grey halfway between a
    #            saturated hue and white. Nicer for new themes; it will visibly
    #            brighten the spectrogram's midtones.
    # An individual ramp can pin its own space with {"space": "...", "stops": [...]}.
    "appearance": {
        "color_mixing": "srgb",
        # Multiplies every font size the node draws. The literals were chosen
        # against a 1080p display; on 1440p and above they are physically tiny,
        # so this is a per-display preference rather than part of a theme.
        "text_scale": 1.0,
        # How strongly bars are lit as cylinders. 0 is a flat fill; the light
        # and shade are derived from each bar's own colour, so this works for
        # any theme and any colour the user picks.
        "bar_relief": 0.55,
        # Hints on the transport controls after the pointer rests on one.
        # A display preference, not theme content: once the controls are
        # learned they are noise, and that is per-person rather than per-theme.
        "show_tooltips": True,
    },
    "audio_engine": {
        "supported_formats": ["wav", "mp3", "flac", "ogg", "opus", "m4a", "webm"],
        "default_format": "wav",
        "default_bitrate_kbps": 192,
        "bitrate_options_kbps": [128, 192, 320],
        "fft_size": 4096,
        "smoothing_time_constant": 0.6,
        "analyser_fps": 30,
        "share_audio_context": True,
    },
    "ui_defaults": {
        "peak_bars": 120,
        "meter_bars": 20,
        "bar_gap": 2,
        "pad_x": 14,
        "meter_gap": 6,
        "time_offset": 24,
        "time_to_scrub_gap": 8,
        "min_node_width": 460,
        "min_node_height": 280,
        "min_widget_height": 203,
        "default_volume": 1.0,
        "default_view_mode": "waveform",
        "peak_hold_ms": 300,
        "settings_button": True,
    },
    # Per-renderer parameter values.  The *schema* for these lives beside each
    # renderer in web/renderers/*.js; this file only carries the values, so a
    # renderer can be added without touching the Python side.
    "renderers": {
        "waveform": {
            "barHeightScale": 0.88,
            "pulseWidth": 0.05,
            "idleAlpha": 0.35,
            "showChannelLabels": True,
        },
        "spectrum": {
            "gain": 1.0,
            "noiseFloor": 2,
            "usableBinFraction": 0.75,
            "rimWidth": 2.0,
            "glow": 4,
            "showLabels": True,
        },
        "analyzer": {
            "gonioGainMax": 3.0,
            "gonioTarget": 0.7,
            "traceAlpha": 0.75,
            "needleSensitivity": 0.25,
            "corrSmoothing": 0.2,
        },
        "spectrogram": {
            "gain": 1.0,
            "noiseFloor": 4,
            "usableBinFraction": 0.75,
            "scrollSpeed": 60,   # pixels per SECOND (time-based, frame-rate independent)
            "showFreqTicks": True,
        },
        "combined": {
            "waveformSplit": 0.55,
            "spectrogramWidth": 0.28,
            "spectrumWidth": 0.52,
        },
    },
    "encoder_settings": {
        "lame_quality": 2,
        "enable_vbr": False,
        "temp_cleanup_on_finish": True,
    },
}
