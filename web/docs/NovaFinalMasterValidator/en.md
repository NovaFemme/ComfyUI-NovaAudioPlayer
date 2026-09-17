# Nova Final Master Validator

Answers one question: **did the file you saved still reproduce the master you
made?**

Put it after the save, on the reloaded file — not on the tensor coming out of
the mastering node. Validating the pre-save tensor tells you nothing about the
delivery path, which is the only thing that ships.

## Inputs

`candidate_audio` is the saved and reloaded file. Whether `reference_report_json`
is connected decides which of the node's two jobs it does:

**Connected — the mastering pass.** Wire `identity_json` from Nova Master
Identity, not `report_json` from Nova Audio Master. Both parse, but only the
Identity output carries the catalogue and publication block, and whatever
arrives here is exactly what gets archived. Turn `save_reference_json` on and
wire `archive_name` from Identity as well. The report is filed in `report_path`
under the archive name: `01_J_Nine-Hours-North_1.0_24-48.json`, alongside
`01_J_Nine-Hours-North_1.0_24-48.wav` in `audio_path`. One name, two folders.

**Empty — the validation pass.** Drop a suspect file in and run. How the
archive is found is set by `lookup_mode`, and **no mode trusts the suspect
file's name or its embedded metadata**.

## Finding the right archive when names cannot be trusted

Working file names lie. A render engine suggests a name, you pick between an A
and a B take, the licence fixes the release title afterwards — so the file
called `Northbound A.wav` is the song *Nine Hours North*, and one real archive
folder here holds thirty reports that are only twenty-one distinct masters,
with one master filed under five different names and two unrelated names
pointing at identical audio. A name cannot answer "which master is this?".

The report can. Every Nova mastering report carries the canonical PCM SHA-256
of the master it describes plus the full measurement set taken at the time.
`lookup_mode` decides which of those handles is used:

| Mode | How it finds the archive |
|---|---|
| `auto` | `identity_selector` if set, else `archive_name` if wired, else content scan. |
| `identity` | `identity_selector` only. |
| `content scan` | Ignores every name. Measures the candidate and finds the archive it *is*. |
| `archive name` | The old file-name lookup, for graphs that depend on it. |

`identity_selector` accepts a release title, ISRC, catalog number, identity ID,
report ID or master PCM SHA-256, matched against the identity recorded inside
each archived report. Punctuation and case are ignored, so `nine-hours-north`
finds `Nine Hours North`. If it matches more than one archive the node stops
and lists them rather than guessing.

**Content scan** measures the candidate, then scores it against every archive in
`report_path`. An exact PCM hash match is definitive and returned immediately.
Otherwise archives are ranked on duration and the full measurement set, and the
node reports the winner, the runner-up and the margin between them. If the top
two are within four points it **refuses to choose** and lists the closest
archives instead — two renders of one master measure identically to four
decimals and differ only in PCM hash, and the node says so when the tied
archives share a `source_pcm_sha256`. Set `identity_selector` to break the tie
deliberately. Across a real 21-master archive this refused seven and got
fourteen right with zero wrong answers; a wrong answer is the one outcome a
forensic tool must not produce.

Content scan only works on archives that are on disk, but it does **not** need
them to carry an identity — your existing reports are indexed as they are, and
nothing is renamed or rewritten. The identity picker does need one, which is why
`identity_json` belongs on `reference_report_json` when you archive.

The report names the archive it chose under **REFERENCE FOUND BY**, and names
the master by identity under **ARCHIVE IDENTITY**, so a validation report always
says which master it validated against and how it decided.

`reference_format` records the delivery format in the validation report. It no
longer takes part in naming: archives written by v0.3.0 and earlier used a
`_PCM16` / `_PCM24` / `_FLOAT32` suffix and are still found whatever this is set
to. `report_path` and `audio_path` default to `NovaAudioMasters/Reports` and
`NovaAudioMasters/Audio`, relative to ComfyUI's output directory.

This node writes the report only. `archive_audio_path` is a planned path for you
to wire into a Save Audio node's `file_path` with `filename_mode` set to
`exact (overwrite)`, so the audio lands beside its report under the same name.

Leave `tolerance_multiplier` alone unless you have a reason. It scales every
measurement tolerance at once, which means it can turn a real failure into a
pass as easily as the reverse.

## A reference from a bypassed master proves nothing

If the reference report was produced with Nova Audio Master in `Off` mode, it
describes the *unprocessed* audio. Comparing a file against it can only confirm
the file is unaltered — it says nothing about whether the file reproduces a
master, and it will happily return `BIT_EXACT` at 100.00 confidence. Such a
report also carries no `validation_reference` block, so the validator falls back
to default tolerances instead of the ones recorded at mastering time. Both
conditions are now called out under **REFERENCE WARNINGS** in the report and in
`reference.reference_warnings` in the JSON. Take the warning seriously: archive
the report from the mastering run you actually want to defend.

## What `REPRODUCTION_MATCH` does not prove

Only `BIT_EXACT` proves a file was not altered. `REPRODUCTION_MATCH` means
*consistent with the master, re-encoded* — and it cannot exclude a local edit.

This was measured, not theorised. A copy of a 3:54 master had 0.5 s at the two
minute mark overwritten with audio lifted from one minute in — 24,000 frames of
genuinely different content — with the length left untouched:

```
IDENTITY: PCM SHA-256 DIFFERENT
FORMAT:   48000->48000 [MATCH] | 2->2 [MATCH] | 11249928->11249928 [MATCH]
          every metric and every tonal band [MATCH]
RESULT:   REPRODUCTION_MATCH | Confidence 100.00/100
```

Every measurement here is an aggregate over the whole track, so half a second
of changed content moves RMS by 0.002 dB and correlation by 0.0004 — orders of
magnitude inside tolerance. The format check catches an edit only when it
changes the length; this one deliberately did not. The PCM hash was the single
signal that anything had happened at all.

Read the verdicts accordingly:

| Verdict | Proves |
|---|---|
| `BIT_EXACT` | the samples are identical — nothing was altered |
| `REPRODUCTION_MATCH` | consistent with the master, re-encoded — **a local edit is not excluded** |
| `ACCEPTABLE_DERIVATIVE` | derived from the master; the format differs |
| `DRIFT_DETECTED` / `VALIDATION_FAIL` | something changed, see the attribution |

Catching a length-preserving edit would need per-segment fingerprinting — a hash
or metric vector per window, stored in the reference — which is a different and
much larger feature. Until that exists, `REPRODUCTION_MATCH` is not a statement
about tampering.

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
