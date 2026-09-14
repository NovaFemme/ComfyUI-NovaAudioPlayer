# Nova ACE Dataset Builder

Turns a batch of tagged audio into the dataset JSON ACE-Step's preprocessor
reads. Because Nova Tag Writer has already put a description in `comment` and
the words in `lyrics`, the dataset is built by reading the files back — no LLM
captioning, no second source of truth.

## Inputs

| Widget | Purpose |
|---|---|
| `files` | Batch from Nova Batch Load Audio. |
| `dataset_json_path` | Where to write the JSON. Parent folders are created. |
| `trigger_word` | The LoRA trigger, written to every sample as `custom_tag`. |
| `tag_position` | Where ACE-Step puts the trigger: `prepend`, `append`, or `replace`. |
| `prompt_source` | `caption` or `genre` — written as `prompt_override`. |
| `caption_tags` | Tags tried in order for the caption. First non-empty wins. |
| `lyrics_tags` | Tags tried in order for lyrics. Empty means instrumental. |
| `write_sidecars` | Also write `{stem}.lyrics.txt` and `{stem}.json` beside each file. |

### The trigger word

Pick something rare that you can type at inference — `crazygecko`, not `rock`.
With `prepend` the training prompt becomes `crazygecko, <caption>`, so the
model learns to associate the token with the style. `replace` trains against
the trigger alone, which is stronger but discards your captions.

## What gets written

A JSON object with a `samples` list. Each entry carries the fields ACE-Step's
`load_sample_metadata` reads:

    filename, audio_path, caption, lyrics, genre, bpm, keyscale,
    timesignature, duration, is_instrumental, custom_tag, prompt_override

`sample_rate` and `channels` are added for Nova ACE Dataset Review; ACE-Step
ignores fields it does not know.

## Limitations

- **BPM, key and time signature are only populated if those tags exist.** Most
  tagged libraries do not have them, and they show as `N/A` in the training
  prompt. ACE-Step's docs suggest a Key-BPM-Finder CSV to fill this in; if your
  material has consistent tempo, adding a `bpm` tag before building is worth it.
- A file with no caption tag produces an empty caption, which trains against an
  empty prompt. Nova ACE Dataset Review flags this.
