# Nova Final Master Validator

Answers one question: **did the file you saved still reproduce the master you
made?**

Put it after the save, on the reloaded file — not on the tensor coming out of
the mastering node. Validating the pre-save tensor tells you nothing about the
delivery path, which is the only thing that ships.

## Inputs

`candidate_audio` is the saved and reloaded file. `reference_report_json` is the
original Nova Audio Master JSON — and it **may be left empty**, in which case the
validator locates the matching archived report from the configured `path` and
`filename`.

`reference_format` (`PCM_16`, `PCM_24`, `FLOAT_32`) picks the reference archive
to compare against; format-specific reports are named `*_PCM16.json`,
`*_PCM24.json`, `*_FLOAT32.json`. `save_reference_json` archives the reference
for that automatic lookup later. `path` defaults to `NovaAudioMasters/Reports`,
relative to ComfyUI's output directory.

Leave `tolerance_multiplier` alone unless you have a reason. It scales every
measurement tolerance at once, which means it can turn a real failure into a
pass as easily as the reverse.

## The two verdicts, and why PCM24 is not a failure

**`BIT_EXACT`** — the candidate's canonical PCM identity matches the reference
exactly. A FLOAT32 save and reload can reach this, because nothing was
quantised.

**`REPRODUCTION_MATCH`** — not byte-identical, but every measurement is inside
tolerance.

**PCM24 normally lands on `REPRODUCTION_MATCH`, and that is the correct
result.** The internal master is float; writing 24-bit integers quantises it, so
the hash cannot match and there is no bug to hunt. A 24-bit file that reproduces
the master within tolerance is an excellent delivery. Expecting `BIT_EXACT` from
an integer format is expecting the arithmetic not to have happened.

## What it compares

PCM hash, sample rate, channels, sample count, integrated LUFS, true peak,
sample peak, RMS, crest, L/R correlation and the tonal-band percentages — format
identity and measured reproduction, not one or the other.

## Outputs

`candidate_audio` (unchanged), `sample_rate`, `validation_report`,
`validation_json`, `verdict`.

The audio passes through untouched, so this node can sit inline on the release
branch rather than off to one side.
