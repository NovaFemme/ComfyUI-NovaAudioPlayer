# Nova Audio 2.7.0 — hand-back for retest

**Build under test:** branch `release/2.7.0` at `a2c3317` plus this file's own commit (`git log -1`).
Pushed to GitHub; not merged. `pyproject.toml` still reads 2.6.1 (the bump is the release step, §5.9).

**Updated 3 Oct after the test agent's Retests 1 to 3.** The rows below carry the later commits; the section
"After Retests 1 to 3" says what changed and why.

**How it was checked.** Python suites, `doccheck` and the template lint on the branch. The frontend items were
run in a real ComfyUI 0.37.0 with frontend 1.53.6 in headless Chromium, with this pack as the only custom
node pack, in both renderers. Not checked: Firefox, the owner's own machine, rgthree installed.

## Changelog, one line per ID

| ID | State | Commit | What changed |
|---|---|---|---|
| B-01 | fixed | `77ac46c`, `09eb58e`, `a2c3317` | Nodes 2.0 labels and values take the theme's text colour (they stayed grey). Glass body tint under Nodes 2.0 is 0.32 (Frosted 0.45, Tinted 0.60). Over a wallpaper with blur and dim both at 0, the backdrop is set to blur 12, dim 0.3 the first time. Seen working on the owner's machine after `a2c3317`. |
| B-02 | fixed | `03adcf9` | `audio` is optional. An unwired player runs, `panel_info` is empty, the idle view stays. |
| B-03 | fixed | `a731827` | FlowPulse minimum under Nodes 2.0 is 400 × 508 (was 225 × 268). |
| B-04 | fixed | `a731827` | SQLite minimums under Nodes 2.0: Browser 300 × 378, Data Table & Filter 380 × 496, Row Iterator 300 × 404, Single Row 300 × 320 (the last two with two columns selected). |
| B-05 | fixed | `77ac46c` | Theme Studio minimum under Nodes 2.0 is 430 × 372 (was 225 × 110). |
| B-06 | fixed | `31277ba`, `a731827`, `09eb58e` | Trainer `dry_run` reads "train / dry run". Track Inspector "save / read only". NamePath Manager options shortened; a workflow saved with the old text is updated as it loads (confirmed in Retest 3). FlowPulse status line wraps. |
| B-07 | not reproduced | — | The six-node run logs 0 unhandled rejections in both renderers here, and the test agent saw none in two runs on the owner's machine (Retest 1). |
| B-08 | fixed | `31277ba` | `NovaSQLiteReader` sets `DEPRECATED = True`; its description names the replacements. |
| B-09 | fixed | `31277ba` | Descriptions on Nova Player and the four SQLite nodes. |
| B-10 | fixed | `31277ba` | All 245 inputs have a tooltip (checked against `/object_info`). |
| B-11 | fixed | `31277ba` | Display names only: "Nova Final Master Validator ✅", "Nova Save Audio FLAC 24/16-bit ⬇️", "Nova Save Audio WAV PCM16\|PCM24\|FLOAT32 ⬇️". |
| B-12 | fixed | `77ac46c`, `04aa2b1`, `a2c3317` | Text fields under Glass/Frosted in Nodes 2.0 have a visible box. Seen on the owner's machine after `a2c3317` (Nova Master Identity). |
| B-13 | fixed in code; layout needs one edit | `a731827` | Load Audio's preview bar is 40 px from the start, so the node no longer grows after a run. It is 40 px taller than in a layout saved before this build, so in "All Nodes - Layout" it overlaps NamePath Manager until that node is moved down and the workflow saved. |
| B-14 | fixed | `a731827` | Console in Classic: minimum 211 × 238, text area inside the node (was 211 × 160). |
| B-15 | fixed | `a731827`, `09eb58e` | FlowPulse minimum width 400 in both renderers. Nodes 2.0 needed the width written on pointerover as well as pointerdown (confirmed in Retest 3: stops at 400 wide). |
| B-16 | fixed | `a731827` | The row nodes are now fitted to their content under Nodes 2.0 as well. Retest 1: no node changed size on switching to Classic and back. |
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

## After Retests 1 to 3

Four commits followed the first hand-back, each from a finding in the test agent's report.

| Commit | Finding | Change |
|---|---|---|
| `04aa2b1` | B-12 follow-up: fields still boxless. The palette stores the widget background as `transparent`, and the frontend copies that to `--component-node-widget-background` on the page root. | Theme Studio writes the field background and the text colour itself, against `[data-node-id]`, whenever the palette's widget colour is blank. |
| `09eb58e` | Retest 1: body still too transparent (B-01); Nodes 2.0 width still 225 (B-15); NamePath Manager still showed the old option (B-06). | Glass body tint 0.32. Minimum width also written on pointerover. Old `profile_action` text replaced on load. The adapter pairs nodes with cards by `data-node-id`. `window.novaVueSize()` reports what the size module last did. |
| `a2c3317` | Retest 3: the adapter's stylesheet was removed on every load. Auto mode answered `v1` with `Comfy.VueNodes.Enabled` on, because the canvas had painted a node 142 ms earlier. On frontend 1.53.6 the canvas keeps calling `drawNode` under Nodes 2.0, so that test cannot tell the renderers apart. | The renderer is decided from the `Comfy.VueNodes.Enabled` setting, then from the presence of `[data-node-id]` cards. The canvas-paint test is only reached when neither answers. |

**Fixed node colours removed (owner's decision, 3 Oct; test report R-3).** `web/config/nova_node_colours.js` coloured 25 of the 31 node types by role, as class-level colours, on by default. In Classic those 25 kept green, purple, olive, teal or brown bodies whatever the theme, while the six newer nodes followed it. Theme Studio's "Theme colours" did not clear them, because it clears the colour on each node and these sat on the node class. The file, its "Colour nodes by role" setting and `docs/node-colours.md` are gone, so the theme governs all 31 nodes in both renderers. A colour a user picks by hand on a node is untouched. Classic label legibility (R-2) should be rechecked on this build.

**Regression pass findings R-1 and R-2 (`7e56214`).** R-1: with `Comfy.VueNodes.Enabled` off the renderer now reads `v1`, and Theme Studio re-applies when the setting is switched on an open page, so the Nodes 2.0 stylesheet no longer stays behind in Classic. R-2: in Classic under Glass or Frosted, widgets get the same field wash as Nodes 2.0 fields and widget names take the primary text colour, so the name on an empty text field or a switched-off toggle can be read over the wallpaper. Checked by the developer in Classic on frontend 1.53.6; to be retested on the owner's machine.

**R-4, fixed:** the "Theme colours" / "Own colours" buttons are gone. In their place Theme Studio has one **Enabled / Disabled** switch (row "theme studio", also `novaTheme.enabled(false)` in the console). Disabled applies nothing: wallpaper, Nodes 2.0 stylesheet, field wash and node transparency are removed, and ComfyUI is asked to re-apply the palette chosen in its own Settings. The stored theme is kept and can be edited while disabled; Enabled puts it back without a reload. The state survives a reload. Checked in a real browser in both renderers: with Disabled and Dark (Default), the palette variables, the LiteGraph colours and `editor_alpha` are identical to a page where the studio never applied a theme, after the click and again after a reload.

To retest: apply Midnight / Glass with a wallpaper, click Disabled, compare with stock ComfyUI Dark (Default) in Nodes 2.0 and in Classic; reload and compare again; click Enabled and confirm the look returns without a reload.

**Retest on `ad9caa3` (test agent):** R-1 and R-2 confirmed fixed on the owner's machine; the switch passes in both renderers. Not yet checked there: the switch position after a reload.

**R-5, fixed:** a palette with a solid body colour and "node opacity" below 1 was see-through in Classic and solid in Nodes 2.0, because the opacity slider is the canvas's `editor_alpha` and the Nodes 2.0 cards never read it. The owner hit this by saving over "Midnight Glass" with a solid body and opacity 0.6. Under Nodes 2.0 the slider is now applied to a body colour the palette declares (body only, text stays crisp). A stored solid colour is still respected rather than replaced by the Glass tint: with opacity at 1 it is solid in both renderers, which is what the palette says. To retest: Midnight / Glass, set NODE_DEFAULT_BGCOLOR to a solid colour, set node opacity to 0.6; the body should be 60% in Nodes 2.0 and follow the slider as it moves.

**R-6, fixed:** the fold button was drawn and did nothing. Two causes, both from finding cards by id (09eb58e). (1) The panel wrapper and the boxes to fold were read off the first three cards; these used to be nodes on screen and became the first three nodes in the graph, so a workflow that opens with three nodes without a panel gave "no box beside the panel could be named". They are now read off nodes that have a panel. (2) The button remembered the card it was made on; after the renderer replaced the card the fold was recorded but marked nothing, and never toggled back. The card is now looked up at the click. Reproduced and checked in a real browser with three KSamplers ahead of Theme Studio, FlowPulse, Console and SQLite Browser: rows fold, the panel takes the room, a second click unfolds. Follow-up from the owner: the bottom edge must stay put when the top folds. A node drawn taller than its stored height (its content needs more room) dropped back to the stored height when folded. The stored height is now raised to what is on screen just before folding, so the card height is identical before, during and after a fold. The fold also no longer depends on the panel-stretch rules surviving; when those were rolled back the button marked the node and nothing folded. To retest: Top panel "Collapsible", fold and unfold FlowPulse in the owner's workflow; also check after a reload that a folded node stays folded.

**Seen on the owner's machine after `a2c3317`:** `novaTheme.renderer()` returns `{"mode":"v2","how":"setting Comfy.VueNodes.Enabled"}`, the `nova-theme-studio-v2` stylesheet is present, and Nova Master Identity shows a box on every text field with readable labels.

**Not explained:** the misdetection never happened on the developer's test server, on the same frontend version.

**Still to be re-run by the test agent on `a2c3317`:** B-01 and B-12 for its log, and the Classic checks (B-14, B-16, B-17) and minimum sizes, which were last measured before the two detection changes.

**Left for the next release, by agreement:** output tooltips (74 of 130). Theme Studio's "Theme colours" still does not override a colour another pack sets on a node class; not changed here.

**Minor remainders, not changed:** the Save WAV option still reads "appends number e.g. 00001" (it is a stored option value); the `stop_at_row` tooltip is terse.

## Decisions taken, for the owner to confirm or reverse

| # | Taken | To reverse |
|---|---|---|
| D4 | Reader kept, marked deprecated, confined to `input/`. | — |
| D6 | Player `audio` optional. | revert `03adcf9` |
| D7 | Both, after Retest 1: body tint 0.32 under Nodes 2.0, and the wallpaper gets blur 12 / dim 0.3 once when both sliders are at 0. | `bodyColour()` in `web/js/nova_theme_studio_v2.js`; `LEGIBLE_BLUR`, `LEGIBLE_DIM` in `web/js/nova_theme_studio.js` |
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

1. Done 3 Oct: the live folder was already clean, and every changed file was copied into it. It matches the branch.
2. The test agent's regression pass on `a2c3317`.
3. The browser suites under `dev/tests/*.mjs` were not run.
4. §5.8 file-by-file read of the shipped tree; §5.9 version bump and merge, after the retest passes.
5. `vuenodetest.mjs` is still missing; `halotest.mjs` was recovered from `backup/repo-2026-10-02`.
