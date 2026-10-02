# Nova Audio 2.7.0 — hand-back for retest

**Build under test:** branch `release/2.7.0`, the commit that adds this file (`git log -1`).
Not pushed and not merged; `pyproject.toml` still reads 2.6.1 (the bump is the release step, §5.9).

**How it was checked.** Python suites, `doccheck` and the template lint on the branch. The frontend items were
run in a real ComfyUI 0.37.0 with frontend 1.53.6 in headless Chromium, with this pack as the only custom
node pack, in both renderers. Not checked: Firefox, the owner's own machine, rgthree installed.

## Changelog, one line per ID

| ID | State | Commit | What changed |
|---|---|---|---|
| B-01 | fixed | `77ac46c` | Nodes 2.0 labels and values take the theme's text colour (they stayed grey). Glass/Frosted over a wallpaper: backdrop defaults to blur 12, dim 0.3 the first time (D7, option b). |
| B-02 | fixed | `03adcf9` | `audio` is optional. An unwired player runs, `panel_info` is empty, the idle view stays. |
| B-03 | fixed | `a731827` | FlowPulse minimum under Nodes 2.0 is 400 × 508 (was 225 × 268). |
| B-04 | fixed | `a731827` | SQLite minimums under Nodes 2.0: Browser 300 × 378, Data Table & Filter 380 × 496, Row Iterator 300 × 404, Single Row 300 × 320 (the last two with two columns selected). |
| B-05 | fixed | `77ac46c` | Theme Studio minimum under Nodes 2.0 is 430 × 372 (was 225 × 110). |
| B-06 | fixed | `31277ba`, `a731827` | Trainer `dry_run` reads "train / dry run". Track Inspector "save / read only". NamePath Manager options shortened (old workflows still load). FlowPulse status line wraps. |
| B-07 | not reproduced | — | The six-node run logs 0 unhandled rejections in both renderers on this build. rgthree, the duplicate Theme Studio and the pad probe were not present. Retest with the live folder cleaned (§3). |
| B-08 | fixed | `31277ba` | `NovaSQLiteReader` sets `DEPRECATED = True`; its description names the replacements. |
| B-09 | fixed | `31277ba` | Descriptions on Nova Player and the four SQLite nodes. |
| B-10 | fixed | `31277ba` | All 245 inputs have a tooltip (checked against `/object_info`). |
| B-11 | fixed | `31277ba` | Display names only: "Nova Final Master Validator ✅", "Nova Save Audio FLAC 24/16-bit ⬇️", "Nova Save Audio WAV PCM16\|PCM24\|FLOAT32 ⬇️". |
| B-12 | fixed | `77ac46c` | Text fields under Glass/Frosted in Nodes 2.0 have a visible box. |
| B-12 follow-up (Retest 1) | fixed | `04aa2b1` | Fields were still boxless on the owner's machine: the palette stores the widget background as `transparent` and the adapter's card-level override was not in effect there. Theme Studio now writes the field background and text colour itself, against `[data-node-id]`, whenever the palette's widget colour is blank. Why the adapter's rule was missing on that page is not established. |
| B-13 | fixed | `a731827` | Load Audio's preview bar is 40 px from the start; the node is the same size before and after a run. |
| B-14 | fixed | `a731827` | Console in Classic: minimum 211 × 238, text area inside the node (was 211 × 160). |
| B-15 | fixed | `a731827` | FlowPulse minimum width 400 in both renderers. |
| B-16 | retest | `a731827` | The row nodes are now fitted to their content under Nodes 2.0 as well. Not measured across a renderer switch. |
| B-17 | fixed | `a731827` | The Browser's hint is in the panel (while no columns are listed) and on the refresh button's tooltip. |
| S-01 | won't fix | — | ComfyUI frontend limitation; hints moved to tooltips. |
| S-02 | fixed | `31277ba` | Examples in the tooltips of `isrc`, `upc_ean`, `catalog_number`, `report_path`, `audio_path`; every text input has a tooltip. |
| S-03a–l | fixed | `31277ba`, `a731827` | All twelve. S-03f: nine is the real count, now named ("the nine scoring controls above"). S-03i: the single-option `format` dropdown stays, because removing a widget shifts saved values. |
| S-04 | fixed | `31277ba` | Versions out of descriptions; the owner's data out of tooltips, placeholders and in-app help; emphasis capitals removed. |
| Deprecated link API | fixed | `a731827` | The pack no longer reads `input.link` / `output.links`. One `input.link` warning remains at load; it comes from the frontend's own `ComfyNode.configure`. |
| L2, L3 | n/a on the branch | — | Neither file is on the branch. They must still be deleted from the live folder (§3). |
| L5 | fixed | `a0efd1e` | Help pages for the six nodes that had none. |
| R2 | fixed | `b6edbc0` | SQLite routes and nodes open databases only inside `input/`. Gate run against a live server: outside paths refused, `input/` works. |
| R4 | fixed | `fdecd84` | `acestep_repo_path`: realpath, must contain `acestep/__init__.py`, not inside input/output/temp. |
| R5 | fixed | `8ee5960` | 26 chained lines split; AST identical. |
| R7 | fixed | `dc55120` | `dev/tests/test_sequence_routes.py`, 48 checks. |
| R8 | fixed | `0fa69cb` | No hook at import (no `Execution hook installed` line at start-up). |
| R9 | fixed | `d82bc1b` | The link-release setting is suggested in the console, not changed. |
| 5.1 | done | `fdecd84` | `install.py`, `training/nova_ace_setup.py` and three working documents are out of the package. |
| 5.7 | done | `8cbf55a` | `dev/tests/test_registry_findings.py` + `dev/registry_findings_expected.txt`: 18 expected findings (2.6.1 had 21). |

## Decisions taken, for the owner to confirm or reverse

| # | Taken | To reverse |
|---|---|---|
| D4 | Reader kept, marked deprecated, confined to `input/`. | — |
| D6 | Player `audio` optional. | revert `03adcf9` |
| D7 | (b): body stays transparent; wallpaper gets blur 12 / dim 0.3 once. | `LEGIBLE_BLUR`, `LEGIBLE_DIM` in `web/js/nova_theme_studio.js` |
| D9 | All three display names changed. | the three strings in `__init__.py` and the node files |
| D10 | (a): routes strict, audio and tag nodes still accept any path. **Not checked node by node** that they return no raw file contents. | — |
| D14 | Own colours hold under Nodes 2.0 already (checked with a coloured KSampler). No code change. | — |

## Things found on the way

- **The live copy had damaged three messages**, restored here: Setup Check's description, the Trainer's banner
  ("TRAINE"), and two "checkpoint needs …" errors that had lost the list of missing packages.
- **`training/nova_ace_setup.py` looked for `training/nova_ace_common.py`**, which the sync merged into
  `nova_definitions.py`. Its final verification step would have been skipped. Fixed.
- **Nova Master Identity now maps database column names itself**, so `single_row_json` from Nova SQLite
  Single Row Filter replaces the Reader's `identity_json`. This is what lets the Reader be removed later.
- **Under Nodes 2.0 the panels did not follow the node at all** unless a Theme Studio theme was applied.
  `web/core/vue-size.js` makes that independent of the studio.
- **Nova Save Audio WAV in "exact" mode writes `file_path` as given**, so the default `NovaAudio` produces a
  file with no extension. The tooltip now says so; the behaviour is unchanged.
- `web/nova_lyric_report_viewer.js` still loads for anyone who installs by `git clone` (handover §3). Undecided.

## Still to do before release

1. **Copy these changes into the live folder**, or the next live → repo sync undoes them (§3).
2. Clean the live folder (§3) and re-run the gates there.
3. The browser suites under `dev/tests/*.mjs` were not run.
4. §5.8 file-by-file read of the shipped tree; §5.9 version bump and merge, after the retest passes.
5. `vuenodetest.mjs` is still missing; `halotest.mjs` was recovered from `backup/repo-2026-10-02`.
