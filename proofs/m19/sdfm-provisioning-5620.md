# Task 5620: emote.cheer and emote.laugh

The asset now has exactly the fifteen S19 names, with no duplicates. The thirteen inherited clips,
12-bone rig, weights, costume attachments, geometry, collider and all other asset data are unchanged.
Q7 is applied: laugh uses a head toss, body bounce and flipper shake; the beak follows the head rigidly.

## Registered authoring path

No live `mcp__sdfm__*` tools were exposed. Provisioned the Q5/Q6-authorized isolated runtime under
`/tmp/env`, using git-archive copies of the supplied revisions and their sibling layout. Original
checkouts stayed read-only and clean. Source revisions are in `provisioning-5620/revisions.txt`.
The RAA dist link points at the game's already-built pinned revision, 58837fe97bb3df6cdb61d42208bfed8bb5313875.

- Ran `npm ci --ignore-scripts` in MAMA, CRM_Atoms, NodeGraph, TS_PieMenue and sdfm; no upgrades.
  Built MAMA, CRM_Atoms, NodeGraph and TS_PieMenue successfully. Logs and individual exit codes are
  in `provisioning-5620/build-record.txt`, `mama-install.log` and the numbered logs.
- Applied only `provisioning-5620/display-description.patch` to the temporary sdfm copy, exactly the
  Q6 description shortening. A source-tree diff against the supplied checkout shows only that file.
- Ran `./node_modules/.bin/tsc -p tsconfig.node.json` in that copy: **exit 2, not a passing build**.
  Full diagnostics are in `provisioning-5620/8-sdfm.log`: exactly the two authorized missing
  `Engine.addTexture` / `Engine.removeTexture` diagnostics in `game-display.ts`.
  No source under `src/node` or `src/core` imports that browser module; the animation playback import
  is type-only. These operations never invoke the unavailable texture methods. No renderer shim was added.
- Used the existing `sdfm-mcp-client.mjs` JSON-RPC stdio client and the existing no-recompile shim
  from `provisioning-5619/sdfm-cli.mjs`, copied to `/tmp/env/sdfm-cli.mjs`.
  All authoring went through `tools/call`, registry validation and the existing registered handlers.
- Startup advertised 214 tools. `read.jsonl` records tools/list, game_register, asset_open_game,
  selection of the inherited emote.dance and a successful seek to tick 36 **before authoring**.
  `animation-inventory.jsonl` additionally records all 34 advertised animation operations, including
  rig creation, clip creation and key operations. This listing used the same client with only its
  output-name filter broadened from clip/key/preview/auto to all `anim_` names.
- Initial game_register tried to write `~/.sdfm` and failed; retained in `read-initial-failure.jsonl`.
  Subsequent sessions set `SDFM_GAMES_FILE=/tmp/env/games.json` and
  `SDFM_PREFERENCES_FILE=/tmp/env/preferences.json` without changing HOME.

`cheer-laugh-steps.mjs` computes operation arguments only. `provisioning-5620/author.jsonl` contains
all calls and results: anim_clip_create, anim_clip_settings_set, anim_key_set, select/seek and save.
Both clips use S17 BEZIER quaternion/TRS keys with explicit handles, rootMotion none, no events,
and loop false. Preview looping and auto-key were disabled. No rig authoring or IK was used.

- **emote.cheer:** 108 ticks, 140 keys. Dip, throw both flippers into a broad raised V, two celebratory
  pumps, hold, settle to rest. Both tip pivots at tick 44 are at y=1.522 m, above the head pivot by
  0.922 m, with x=+/-0.823 m. Body bounce range is 0.146 m.
- **emote.laugh:** 96 ticks, 154 keys. Anticipation, head toss back, four chuckles coordinated with
  body compression/extension and opposing forearm/tip shakes, recovery to rest. Body bounce range
  is 0.065 m; the head pitches back 30 degrees. The existing head-bound beak moves with it.

## Saving and preservation

The inherited face_patch ellipsoid has gameCollision=true, which asset_save_game refuses. As in the
prior tasks, that flag was disabled only in the temporary authoring session for the save. The saved
file also changes layout/bounds. `provisioning-5620/merge.mjs` takes only the two newly authored clip
objects, verifies earlier clip/rig equality, appends those objects to the original asset text and
updates the SDF Modeler document-content hash accepted by the existing game loader (Q3).
It does not author or alter any clip values. The rest of the original text is preserved.
The final asset was copied back into the temporary game; `final-open.jsonl` records successful
asset_open_game and eleven seeks, including both endpoints, against this final file.

## Verification

- `cheer-laugh-check.mjs`: both clips load and sample all ticks through twice their duration in the
  game's pinned @etcito/raa-anim WASM runtime; finite local/model/skin values, zero root delta,
  smooth steps, rest endpoints and clamped completion. Checks raised flipper positions and
  coordinated chuckles. All fifteen clips load and sample. Entire inherited asset equality is
  checked after removing the two additions and restoring only the old hash.
  Results: `cheer-laugh-check.out.json`.
- `npm run typecheck`: exit 0 (`typecheck.log`).
- `npm run build`: exit 0 (`build-game.log`), existing chunk-size/dynamic-import warnings only.
- Single rigged-asset regression probe passed; then contentFiles, gameAsset, courseV1, animBrick,
  assets, shippedAssets and content suites: **56 passed, 0 failed** (`content-tests.log`).
- `git diff --check`: exit 0. No build-output hash comparisons.
- No GPU job or software-render substitute was run. Existing GPU command queue is untouched.
  Full milestone tests and GPU closeout remain with the milestone's existing verification tasks.

To reproduce the preservation check from the task baseline:
`git show d74d5a6f3f5dfd65616f17c1e81d2c8b276f132d:assets/common/penguin.body.asset.json > /tmp/5620-before.json`
then `node --experimental-strip-types proofs/m19/cheer-laugh-check.mjs /tmp/5620-before.json`.

## Media correction (2026-10-29)

The inherited clip authoring is preserved without any asset edits. The new
`penguin-cheer-laugh.glb` is an actual skinned animation file containing both exact clip names,
not a description or placeholder. `cheer-laugh-export.mjs` copies the existing penguin mesh,
materials, weights, skeleton and inverse binds, and exports the already-authored clips sampled
through the game's pinned S17 runtime at every 60 Hz tick. It checks the GLB skeleton against
the asset's protected rig, then reads the exported file back and verifies every animation
channel sample against the runtime. It does not author S17 clips or render any pixels.
One-frame and two-frame export probes passed before the full export.
`cheer-laugh-media.json` records the resulting file, duration and sample counts.

**Visual acceptance is still blocked on the client-GPU executor.** The GLB is animation media,
but does not replace the required rendered videos, reference comparisons, judges or human review.
No model-card GPU job or software-rendered substitute was run.

`cheer-laugh-capture.mjs --build` successfully builds the existing RAA clip-review page with
explicit cheer/laugh selection. The page takes representative stills (cheer tick 44, laugh tick 24)
and records four seconds per clip, replaying the entire gesture for each camera. It returns
real WebM videos plus still/reference comparison PNGs. `--capture` is reserved for the
programmatic executor: blank-page probe, then one frame and two frames **for each clip**, then
the full captures, hardware-adapter checks, remux and ffprobe duration checks. Calls are bounded
to 60 seconds. Original GPU result envelopes and inputs are retained under
`proofs/m19/cheer-laugh-execution/`.

Orchestration must dispatch `.nmc/cheer-laugh.commands.json` as a separate commands_file using
the Q4 executor path. The existing `.nmc/commands.json` already contains ten entries and is
preserved, including its exact mid-waddle judge. The new four-command file builds the bundle,
captures both videos and runs two additional gesture judges with minimum score 6. Captures and
the animation GLB are listed in `.nmc/artifacts.json` for the normal nomorechat commit flow.
No capture result, video or judge outcome is claimed until the executor returns it.

Rechecked: `cheer-laugh-check.mjs` passes against d74d5a6 (all fifteen unique names, full inherited
asset preservation and gesture samples); `npm run typecheck` and `npm run build` pass. The
gameAsset regression probe passes, as do 59 affected content, asset and animation-brick tests,
including contentFiles and courseV1. Only the existing build warnings remain.
