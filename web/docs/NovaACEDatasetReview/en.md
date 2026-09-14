# Nova ACE Dataset Review

Checks a dataset before you spend GPU hours on it. ACE-Step's own
documentation makes manual review mandatory; this is that pass, automated.

## Checks

**Problems** (block: `ready` comes back false)

- `audio_path` does not exist
- duration is 0 — the file is likely unreadable
- duration below `min_duration`
- no caption, when `require_caption` is on
- marked as having lyrics but none present
- the same filename appears twice — later entries overwrite earlier ones in
  ACE-Step's filename-keyed index

**Notes** (informational)

- duration above `max_duration` — the preprocessor truncates it
- no trigger word, so you will have no reliable way to invoke the LoRA
- fewer than 10 samples — ACE-Step suggests around 800 epochs for 10–20 songs
- mixed sample rates or channel counts

## Inputs

`dataset` from the builder, plus `max_duration` (match your preprocess node),
`min_duration`, and `require_caption`.

## Outputs

`console`, `ready` (BOOLEAN), `sample_count`, `problem_count`.

`ready` is a real boolean output, so it can gate what follows.
