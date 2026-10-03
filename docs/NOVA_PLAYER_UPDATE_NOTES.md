# Nova Player — update notes and release-agent handoff

**Written 2 October 2026.** Covers the Nova Player work done 29 September to
2 October 2026: twelve commits on top of `1d7a4c1` (GitHub `main` on 29 Sep).
Current `pyproject.toml` version is **2.6.1**; this work is not yet versioned
(see [Decisions for a human](#decisions-for-a-human)).

| Part | For |
|---|---|
| [1. What is new](#1-what-is-new) | everyone |
| [2. How to use the new features](#2-how-to-use-the-new-features) | testers, doc writers |
| [3. Release-agent notes](#3-release-agent-notes) | the release/build agent |

The end-user guide is separate: `docs/NOVA_PLAYER_USER_GUIDE.md`.

---

## 1. What is new

| Change | Summary |
|---|---|
| **Halo view** | A 13th view. A ring of spectrum-driven spikes with drifting bubbles. Decorative only, never a measurement |
| **Halo settings** | 24 settings: reaction, spikes, ring shape and tilt, motion (Spin / Rotate (3D) / Spin + rotate / Off, separate speeds), 3D depth, pulse, bubbles. Colour pickers for spikes, tips, ring and bubbles |
| **Recorded sequences** | Record yourself changing a decorative view's settings, replay it once, N times or looped. A standard feature any renderer opts into with one line |
| **Decorative renderer template** | `web/renderers/_template_decorative.js` |
| **Nodes 2.0 fixes** | The player now fills its node at any zoom, and a freshly placed node gets the whole player |
| **Settings drawer restyle** | Larger modern controls, visible scrollbar, new "Display" section, double-click a slider to reset |
| **`select` setting type** | Renderer params can be dropdowns, with `aliases` for renamed options |

Nothing was removed. No setting key, colour role or saved-workflow field was
renamed in a way that breaks an existing workflow (details in 3.5).

---

## 2. How to use the new features

### 2.1 Halo

Click the view pill until it reads **HALO**. Open the drawer (gear) for the
settings. Groups, in drawer order:

| Group | Settings |
|---|---|
| Reaction | Intensity, Noise floor, High boost, Even out, Release |
| Spikes | Streaks, Streak length, Spike width, Softness, Gradient |
| Ring | Ring size, Ellipse width, Fit to view width, Tilt (° to vertical) |
| Motion | Motion, Spin speed, Rotate speed, 3D depth (Rotate), Beat pulse, Pulse intensity, Core glow |
| Bubbles | Bubbles, Bubble size, Bubble softness |

- **Even out** is automatic gain per spike. It is why Halo cannot be read as a
  meter, and it is what makes the whole ring move on bass-heavy material.
- **Motion → Spin** moves the spikes around the ring. **Rotate (3D)** turns the
  ring in space; **3D depth** 0 gives a flat disc, the default 0.8 a solid burst.
- Colours: **Halo · Colours** has `Spikes, quiet / mid / loud`, `Spike tips
  (gradient)`, `Ring core`, `Background` and four bubble colours.

### 2.2 Recorded sequences

Only on views that opt in. Today: Halo.

**Record**

1. Drawer → **Halo · Sequences** → **● Record new…**
2. Type a name. **Start** enables once the name is not empty.
3. Click **Start**, then change settings in **Halo · Settings**.
4. **■ Stop & save**. The list refreshes and selects the new sequence.

**Play:** pick it, set **loop** or **Play ⟨n⟩ time(s)**, click **▶ Play**.
**Delete:** **🗑**, then **Delete** or **Keep** at "Are you sure?".

Behaviour worth knowing when testing:

| Behaviour | Detail |
|---|---|
| The clock follows the song | Recording and playback time advance only while the song plays (always, when no audio is connected). Pausing the music pauses both. Paused time is not recorded |
| Playback is a temporary layer | Nothing is written to the node. When playback ends or is stopped, the node's own settings are back |
| A manual edit stops playback | Changing any setting of that view during playback hands control back |
| Switching view | Mid-recording: what was recorded is saved. Mid-playback: playback stops |
| What is recorded | Changes made through the Settings section. Colour changes are not recorded |
| Fast changes merge | Changes to the same setting under 30 ms apart become one step |
| Names never overwrite | A clash is saved as `Name (2)` |
| Bad files are tolerated | Unknown setting, wrong type or out-of-range value: that step is skipped, the rest plays, the drawer reports the count |

**Files:** `ComfyUI/user/nova_player/sequences/<renderer>/<name>.json`. One
folder per renderer. Users may copy files in and out; the list re-reads the
folder each time the view is chosen and after every save or delete.

### 2.3 The restyled drawer

- Top block: theme picker, **New / Save as / ✕**, and the **Edits: This node /
  Theme** switch.
- Sections: `⟨View⟩ · Settings`, `⟨View⟩ · Sequences` (if supported),
  `⟨View⟩ · Colours`, `Player chrome · Colours`, **Display**.
- **Display** holds Text size, Bar relief and Control hints. These moved out of
  the top block.
- **Double-click a setting's slider** to reset it to its default.
- Everything scales with **Text size**.

### 2.4 Adding a decorative renderer

Copy `web/renderers/_template_decorative.js`, import it in `registry.js`, add
it to `RENDERERS`, add a `mode.<id>` role to `nova_player/defaults.py`.
`sequences: true` is the whole opt-in. The template header lists what that
commits the author to (stable param keys, only widen ranges, `aliases` for
renamed select options, accumulate motion phase).

---

## 3. Release-agent notes

### 3.1 Commits, in order

Base: `1d7a4c1`. Apply in this order (each was delivered as a `git am` patch).

| # | Commit subject | Area |
|---|---|---|
| 1 | Add Halo: a decorative burst-ring view | renderer, defaults, docs counts |
| 2 | Halo: fit wide strips, ring-anchored bubbles, soft edge knee | renderer |
| 3 | Halo: float spectrum, spike width/softness/gradient, high boost | renderer |
| 4 | Host: fill the node under Nodes 2.0 at any zoom | `host.js` |
| 5 | Halo: tilt, spin modes, pulse intensity, bubble size/softness, spike colours | renderer, defaults, panel |
| 6 | Halo: sideways spin projects the spikes with the ring | renderer |
| 7 | Host: a fresh Nodes 2.0 node gets the whole player | `host.js`, `index.js` |
| 8 | Halo: 3D depth for Sideways spin | renderer |
| 9 | Halo: Motion = Spin / Rotate / Spin + rotate / Off, with separate speeds | renderer, panel |
| 10 | Recorded sequences for decorative renderers | new Python module, routes, host, panel |
| 11 | Sequences: clock follows the song; drawer keeps its dragged width | host, panel |
| 12 | Settings drawer: modern controls, visible scrollbar, Display section | panel |

A thirteenth commit adds the two documents, the guide images and the in-app
help section (this file's commit).

### 3.2 Files

**New**

| File | Ships to registry? |
|---|---|
| `nova_player/sequences.py` | yes |
| `web/core/sequences.js` | yes |
| `web/renderers/halo.js` | yes |
| `web/renderers/_template_decorative.js` | yes (reference file, not imported) |
| `dev/tests/halotest.mjs`, `vuenodetest.mjs`, `seqtest.mjs`, `test_sequences.py` | no (`dev/` is in `.comfyignore`) |
| `dev/harness-vuenode.html` | no |
| `docs/NOVA_PLAYER_USER_GUIDE.md`, `docs/NOVA_PLAYER_UPDATE_NOTES.md`, `docs/images/guide/*` | no (`docs/` is in `.comfyignore`) |

**Changed:** `nova_player/routes.py`, `nova_player/defaults.py`,
`web/core/host.js`, `web/index.js`, `web/renderers/registry.js`,
`web/renderers/_template.js`, `web/ui/settings-panel.js`,
`web/docs/NovaPlayerNode/en.md`, `dev/devserver.py`, `dev/tests/doccheck.mjs`,
`dev/tests/paneltest.mjs`, `dev/tests/README.md`, `docs/TECHNICAL.md`,
`README.md`, `HANDOVER.md`, `__init__.py`, `.gitignore`,
`docs/images/nodes/NovaPlayerNode-halo.png`.

### 3.3 Things that will bite

1. **A ComfyUI restart is required**, not only a browser refresh. Commit 10
   adds HTTP routes (`/nova_player/sequences/...`). Without a restart the
   Sequences section shows an error.
2. **The user guide is GitHub-only.** `docs/` is excluded from the registry
   package. What installed users see in-app is `web/docs/NovaPlayerNode/en.md`,
   which now has a short Sequences section. Keep the two in step.
3. **Sequence files are user data outside the package**, in ComfyUI's `user`
   folder. Nothing in the package may assume they exist, and an update must not
   touch them. The package-root fallback folder `/sequences/` is in `.gitignore`.
4. **Visualiser count is thirteen.** `dev/tests/doccheck.mjs` enforces it
   against `registry.js` across README, `__init__.py`, `pyproject.toml`,
   `web/docs/NovaPlayerNode/en.md` and `HANDOVER.md`. It passes.
5. **`doccheck.mjs` was already failing before this work.** Its README-table
   check expected an older table header. It is fixed in commit 1; do not revert.
6. **Stale `config/*.json` hides problems.** The config files are generated on
   first run and merged over defaults. Delete them before `paneltest`,
   `scopetest` and any test that removes a default colour.
7. **`zoomtest.mjs` prints four FAIL lines by design** (its "before the fix"
   block). They are not failures.
8. **`benchtest.mjs` failed once** straight after a dev-server restart and
   passed on every rerun and on the previous commit. Treat a single failure
   there as timing; rerun before investigating.

### 3.4 Registry compliance

| Check | State |
|---|---|
| `dev/tests/test_standards.py` | 10 passed |
| Subprocess, `eval`, `exec`, runtime installs in new code | none |
| New Python dependency | none (`sequences.py` uses the standard library) |
| New JavaScript dependency or bundle | none |
| File writes | only under the sequences folder; names cleaned to a safe set; every path resolved and checked to stay inside the folder; saves are atomic and never overwrite |
| Request size | a sequence is capped at 2 MB and 50 000 steps server-side |

### 3.5 Compatibility

| Item | Effect on existing users |
|---|---|
| Saved workflows | Unaffected. New state is additive |
| Existing `config/color_config.json` | New Halo roles arrive through the defaults merge. No file needs deleting |
| Old `halo` colour ramp in a user's config | Unused now (spike colours are roles). Harmless |
| Halo `spinMode` values `circle`, `sideways` (from this week's builds only) | Mapped to `spin`, `rotate`. A node saved as "sideways" turns at the default Rotate speed |
| Text size, Bar relief, Control hints | Same settings, moved to the Display section |
| Drawer default width | Still 248 px. Controls are larger; users can drag it wider |

### 3.6 Tests

Browser suites need the dev server: `python3 dev/devserver.py --port 8731`.
The dev server writes sequences to a temp folder, never a real user folder.

| Suite | Expected |
|---|---|
| `dev/tests/test_sequences.py` | 27 passed |
| `dev/tests/seqtest.mjs` | 30 passed |
| `dev/tests/halotest.mjs` | 26 passed |
| `dev/tests/vuenodetest.mjs` | 34 passed |
| `dev/tests/doccheck.mjs` | 11 passed |
| `dev/tests/test_standards.py` | 10 passed |
| `node dev/lint-templates.mjs` | `OK: 48 modules clean` |
| `paneltest`, `scopetest`, `allcontrols`, `cliptest`, `scrolltest` | no FAIL lines (they print no total) |
| `colorlive` 4, `invariants` 13, `tooltiptest` 17, `bartest` 21, `hinttest` 14, `apgtest` 33, `tiertest` 26, `e2e` 8, `benchtest` 22, `scaletest` 23, `freqtest` 9, `enginetest` 6 | all passed |

The sequence routes in `routes.py` were also exercised directly under aiohttp
(save, list, read, path-traversal rejected with 400, delete, 404 after delete).
That was a one-off script, not a committed test.

### 3.7 What has and has not been verified

**Confirmed by the author in his ComfyUI (Nodes 2.0):** Halo and all its
settings, both Nodes 2.0 fixes, recording and playing sequences, the restyled
drawer.

**Not verified:**

- `dev/tests/perfprobe.mjs` was never run for Halo. Halo measured 1.69 ms per
  frame on the author's machine early on; later builds draw more and were only
  timed in a software-rendered sandbox (about 8 ms at 900×300).
- Firefox. The drawer has Firefox rules for sliders and scrollbars, untested.
- The legacy (non-Nodes 2.0) frontend was not re-tested after the two host fixes.
- Commit 11 (song-following clock) was tested in the harness; the author has
  not explicitly confirmed it.
- Which page stylesheet on the author's install overrides the player's inline
  styles was never identified. Both fixes work without knowing.

### 3.8 Known gaps

- `docs/images/nodes/NovaPlayerNode-themes.png` and
  `docs/images/settings-panel.png` show the old drawer.
- The Halo image and the guide's screenshots are renders from the test
  harness, not captures from ComfyUI.
- Sequences record settings only, not colours.
- Looped playback snaps back to the start snapshot at each pass; there is no
  crossfade.
- Not built: autoplay a sequence when audio starts; remembering the selected
  sequence per node.

### Decisions for a human

1. **Version number.** This adds features, so 2.7.0 fits better than 2.6.2.
2. **README screenshots.** Replace the two old-drawer images and the harness
   renders with real captures before publishing, or ship as is.
3. **Drawer default width.** Keep 248 px or raise it for the larger controls.

### Release checklist

- [ ] All commits applied in order; `git status` clean
- [ ] Version bumped in `pyproject.toml`
- [ ] Config deleted, dev server started, suites in 3.6 green
- [ ] ComfyUI **restarted**; node count registers as expected
- [ ] Click through: HALO view; change Motion to each option; open each drawer
      section; double-click a slider
- [ ] Record a sequence, play it looped, pause the song (sequence pauses),
      touch a slider (playback stops), delete it (asks first)
- [ ] Confirm the file appears in `ComfyUI/user/nova_player/sequences/halo/`
- [ ] Place a brand-new Nova Player under Nodes 2.0: it has a full-height
      player; zoom in and out: it fills the node
- [ ] `docs/` and `dev/` absent from the published archive; `web/docs/` present
