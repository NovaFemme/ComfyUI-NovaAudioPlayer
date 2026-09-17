# Release handoff — comfyui-novaaudioplayer 2.6.0

**Bundle revision v16, 17 September 2026.** Supersedes v15: release notes gain
§19–§24, help-page coverage is now complete, three nodes are held back (§24),
and the 2.5.0 post-mortem is included.

Three documents, for three different readers.

| File | For | Contents |
|---|---|---|
| `RELEASE_NOTES.md` | the release/build agent | compliance review, blockers, packaging traps, working-tree state, checklist, held-back nodes |
| `USER_GUIDE.md` | the end user | LoRA training: setup, paths, node-by-node, training tiers, troubleshooting |
| `2.5.0-POSTMORTEM.md` | anyone asking what went wrong last time | the 14 faults found in the 2.5.0 tree, each citing its commit |

Both replace the copies at `training/RELEASE_NOTES.md` and
`training/USER_GUIDE.md`. Drop them in place.

## What 2.6.0 contains

**LoRA training group** — five nodes plus `install.py`. Fully documented; the
§12 documentation blocker is resolved.

**Report capture (§13)** — right-click a report viewer, export every view as an
image. Replaces `NovaReportsImages`, which redrew the report in PIL and could
never match the viewer it was copying. The shipping build is
`v9 iframe-aware`; it logs that string to the console on load, which is the
fastest way to confirm the browser is not serving a cached older file.

**`NovaReportsImages` removed (§14)** — read that section before staging. There
were two imports of it, and missing one took the entire pack down.

**Track Inspector provisional layer (§15)** — the node used to grade
self-consistency, so a uniformly broken track scored an A. Measures now carry
evidence tiers, and unvalidated ones cannot fail a track.

**Documentation** — **28 of 28** nodes have help pages, up from 8 of 28.
Verified structurally, not claimed: 28 keys in `NODE_CLASS_MAPPINGS`, 28 in
`NODE_DISPLAY_NAME_MAPPINGS`, 28 `web/docs/<node>/en.md` folders, the three sets
identical with no orphans in either direction.

**Held back (§24)** — Nova Audio Transcribe, Nova Lyric Score and Nova Lyric
Report still register, but are excluded from everything the release notes vouch
for. Transcribe exhausts VRAM on a 16 GB card and freezes the desktop; a
third-party node running the same models at a heavier load on the same machine
sits at 45%, so the ceiling is not the hardware. Fixes are in the tree and are
unverified. Read §24 before writing any release text that mentions them.

## Already applied — confirm, don't redo

These were open in the previous revision of this handoff and are now done in the
working tree. Each is marked in the release notes where it lives.

1. **`pyproject.toml`** — `version = "2.6.0"`. The description's "Twenty-eight
   nodes" is now correct for the shipping build; two phrases describing the
   removed node were corrected with it.
2. **The unfinished test node is gone** — `utilities/nova_webcapture_image.py`
   and `web/nova_webcapture_image.js` are out of the tree and out of every
   mapping. The registered count is **28**.
3. **Scratch moved to `.trash/`**, which `.gitignore` already covered;
   `_to_delete/` is now ignored too and survives only as an empty directory the
   sandbox could not remove.
4. **`web/docs/images/` ships.** `[tool.comfy] includes = []` adds nothing, so
   the package is what git tracks, and `git check-ignore` clears the folder and
   all five files.
5. **The orphaned `web/docs/NovaReportsImages/en.md` is removed**, along with the
   reference to that node in the Nova Audio Master help page.

## Still open, in priority order

1. **The subprocess decision** (§3). Needs a human. Publish the trainer and be
   ready to justify it, or hold that one node back. It is the only item in the
   release notes that no edit can settle. Unchanged since v15.

   For the argument, see §7 of `2.5.0-POSTMORTEM.md`: the published rule bans
   *runtime package installation* through subprocess, not subprocess. Reading it
   as a ban on subprocess has already cost this pack four export formats once.

2. **The three held nodes** (§24). Also needs a human, and it is a narrower
   question: ship them registered with the fault documented, as the notes
   currently assume, or cut them from the mappings. Cutting breaks every saved
   workflow containing one.
3. **Load-test before tagging.** Start ComfyUI and confirm **28** nodes register.
   Parsing is not loading — that distinction cost a working session during
   development. A static pass finds 28 mapping keys and no unresolved relative
   imports, which is necessary and not sufficient.
4. **Click through.** ❓ on Nova Console, Nova ACE LoRA Trainer and Nova Track
   Inspector; right-click → Export Report Images on each of the three viewers.
   Confirm the colour toggle appears under Settings → Nova Audio → Appearance,
   and that a hand-coloured node survives save and reload.
5. **Stage the new files.** `web/nova_node_colours.js` and
   `docs/node-colours.md` are untracked and will not publish until staged.
   `git status --porcelain | grep '^??'` must come back empty.

6. **Commit.** Nothing in this change set is committed yet. Skip
   `presets/Eb minor 14 gradient_estimation beta aggressive.json`.

## Two things not to "fix"

**Images live in one shared `web/docs/images/` folder**, referenced as
`images/name.png`. That is required by how the frontend resolves relative paths
against the docs root. Moving them into per-node folders is what breaks them.

**Track Inspector weights are not stored in Madow preset files.** Madow rebuilds
a preset from six fixed keys on save, so anything extra there is silently lost.
The names are shared; the values live in `profiles/track_inspector/`.

## One file to skip

`presets/Eb minor 14 gradient_estimation beta aggressive.json` shows as modified.
It is an author edit from Madow work, confirmed out of scope. Do not stage it.

## Closed since v15

**The help-page gap is gone.** v15 recorded five nodes without a page —
`NovaAudioSaveFLAC24`, `NovaAudioTranscribe`, `NovaLyricScore`,
`NovaMemoryProbe`, `NovaSQLDump`. All five now have one, and coverage is
one-to-one across all 28 registered nodes. Do not carry that gap forward into
release text; it is no longer true.
