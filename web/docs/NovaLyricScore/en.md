# Nova Lyric Score

Measures how faithfully a vocal sings the lyrics you wrote. Give it a transcript
and your reference lyrics; it returns a score out of 100, a letter grade, and a
word-by-word diff showing exactly where the two parted company.

Pure Python standard library — nothing to install.

## Inputs

| Widget | Default | Purpose |
|---|---|---|
| `reference_lyrics` | empty | The lyrics you actually wrote. Paste them in. |
| `transcript` | — | Wire Nova Audio Transcribe's `text` output here. |
| `primary_metric` | `word_accuracy` | Which metric drives the headline score and grade. |

Optional, all about making the comparison fair:

| Widget | Default | Effect |
|---|---|---|
| `lowercase` | on | Case-insensitive. |
| `strip_punctuation` | on | Ignores punctuation, but keeps apostrophes inside words like *don't*. |
| `remove_section_tags` | on | Drops `[Chorus]`, `[Verse 1]`, `[x2]` from the reference. |
| `ignore_parentheticals` | off | Also drops `(ad-libs)` before scoring. |

## Outputs

`score` (FLOAT), `grade` (STRING), `report_json` and `report_text`.

Send `report_json` to **Nova Lyric Report** for the visual dashboard, or
`report_text` to **Nova Console** to read it as text.

## Grades

| Grade | Score |
|---|---|
| A+ | 95–100 |
| A | 90–94 |
| B | 80–89 |
| C | 70–79 |
| D | 55–69 |
| F | below 55 |

## Which metric to judge by

- **word_accuracy** (1 − WER) is strict. It penalises wrong words, missing words
  and extra words equally. Use it when you want the honest number.
- **similarity** is order-tolerant and forgiving — "is basically the right text
  there". Use it when a take is musically right but the transcript is messy.
- **char_accuracy** (1 − CER) scores per character, so a near-miss spelling
  costs less than a whole wrong word.

All three are always calculated and reported. `primary_metric` only chooses
which one becomes the headline.

## The breakdown

**Correct**, **substituted** (a different word in place of the reference),
**missing** (in the lyrics, not heard) and **extra** (heard, not in the lyrics).

Two derived figures do most of the interpretive work:

- **Coverage** — how much of the lyric was attempted at all. Low coverage means
  words never arrived, which is a different problem from words arriving wrong.
- **Extra-words rate** — ad-libs, or Whisper inventing text over instrumental
  passages.

## The diff

    word          correct
    {ref>hyp}     substitution — expected ref, heard hyp
    -word-        missing
    +word+        extra

The Lyric Report viewer shows the same diff colour-coded.

## A low score on a take that sounds right

The usual cause on music is a Whisper **repetition loop** over an instrumental
section: it invents a line and repeats it, the extra-words count climbs, and
strict word accuracy collapses even though every sung word was correct.

Check the extra count against the correct count. Many correct *and* many extra
is the signature. The fix is `vocal_isolation` on the Transcribe node; the
honest reading in the meantime is `similarity`. The Lyric Report's Dashboard
flags this pattern explicitly and its Transcription view marks the offending
segments.

## Keep `remove_section_tags` on

Your reference almost certainly has `[Chorus]` markers in it. Nobody sings them.
With this off they count as missing words and quietly depress every score you
take. `ignore_parentheticals` is the same argument for `(ad-lib)` notes — turn
it on if your lyrics carry them.

## Where it sits in the chain

    Nova Audio Transcribe ──text──> Nova Lyric Score ──report_json──> Nova Lyric Report
                                                     └─report_text──> Nova Console
