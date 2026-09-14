# Nova Master Identity

Turns a mastering report into release and archive identity: what source, what
settings, what master and what report belong together.

Feed it `report_json` from **Nova Audio Master**.

## It does not touch the audio

This is the part worth being clear about, because the widgets read like export
settings and are not.

The bit-depth and sample-rate fields describe **publication intent** — what the
release is meant to be — and the node performs no conversion whatsoever. The
actual PCM encoding happens in a save node (`Save Audio WAV PCM16|PCM24|FLOAT32`
or `Save Audio FLAC 24-bit`). Setting 24-bit here and saving PCM16 downstream
produces a 16-bit file with a record claiming 24, and nothing will stop you.

## Outputs

| Output | Is |
|---|---|
| `identity_json` | publication and master identity |
| `fingerprint_json` | provenance and reproduction fingerprint |
| `archive_name` | a generated filename for the downstream save, e.g. `02_GC_Redline-Masters_Master_24-48.wav` |

Identity and fingerprints stay bound to the mastering report they came from, and
parent/source/root report identity is preserved where it was supplied — so a
master derived from a master keeps its lineage rather than starting a new one.

Keep `identity_json` and `fingerprint_json` with the release archive alongside
the mastering JSON. The Final Master Validator is what reads them back.
