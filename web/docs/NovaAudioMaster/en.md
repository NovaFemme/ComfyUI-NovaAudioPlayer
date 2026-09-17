# Nova Audio Master

Analyses the source and produces a safer mastered version — tonal, stereo,
dynamics, loudness and limiting — plus a human-readable report and a structured
JSON one.

Report schema `nova.audio_master.report`, version 10. Mastering DSP is frozen at
the `v0.2.7.7` line; report and UI work moves independently of it.

## `Off` really is off

`Off` is a true PCM pass-through. The audio is still analysed and still
reported, and the samples come out untouched. It is the mode to use when you
want Nova's measurements of a file without Nova's opinion of it.

`Auto` derives corrections from the analysis. `Assist` keeps the analysis and
the guardrails while taking more direction from you. `Manual` uses the controls
more directly.

In `Auto`, leave the EQ widgets at `0 dB` — they are neutral by design, because
the correction comes from the measurement rather than from the widget.

## `run_count` is a cache control, not a setting

Increment it to force this node and everything downstream to execute again.
It does not change any DSP decision, and it is deliberately excluded from the
settings hash — two runs that differ only in `run_count` are the same master,
and the provenance record says so.

## The targets are references, not commands

`target_lufs`, `target_true_peak_dbtp` and `target_crest_db` describe where the
master should aim. They are not permission to damage the source.

**So `NOT_REACHED` on its own is not a failure**, and a `CONDITIONAL_PASS`
release decision is a normal, intended outcome: the master is technically
release-safe and one or more reference targets were not fully reached, because
reaching them would have meant destructive processing. Nova prefers the safer
master and explains itself in the report.

Read the adaptive status before treating any of it as a problem — the adaptive
crest status, the loudness interpretation, the limiter gain reduction, the tonal
improvement and the release decision are all reported separately for exactly
that reason.

## Limiter gain reduction, interpreted

| Reduction | Reading |
|---|---|
| up to 1.5 dB | preferred |
| up to 2 dB | acceptable |
| up to 3 dB | warning |
| above 3 dB | heavy |

## Profiles

`Metal`, `EDM-Trance`, `K-Pop`, `Balanced`. A profile gives the engine reference
behaviour suited to the material. It does not force every target, and picking
one does not override the safety logic above.

## Outputs

| Output | Is |
|---|---|
| `mastered_audio` | the processed master |
| `original_audio` | the source, retained so a comparison branch needs no second loader |
| `report` | the human-readable report |
| `report_json` | the structured report — feed this to the Report Viewer and Master Identity |

## Provenance

The report carries `source_pcm_sha256`, `master_pcm_sha256`, `settings_sha256`,
`reproduction_fingerprint_sha256` and `report_payload_sha256`, with the
canonical PCM identity taken as **channels-first float32 little-endian**. That
canonical form is what makes the Final Master Validator's comparison meaningful
later; keep the JSON with the release.

## A note for anyone editing this node

New widgets go on the **end**. ComfyUI serialises widget values positionally, so
inserting one in the middle shifts every later value and silently scrambles
workflows people have already saved.
