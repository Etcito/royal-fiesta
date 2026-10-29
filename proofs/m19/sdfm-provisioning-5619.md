# Task 5619 - SDF Modeler provisioning and authoring record (emote.wave, emote.dance)

Files referenced below are in `proofs/m19/provisioning-5619/` unless stated otherwise. The isolated `/tmp/env` environment was provisioned again for this task
under the Q5/Q6 authorization (it is not committed). No `mcp__sdfm__*` tools were exposed in this run, so the CLI's stdio MCP server was driven by
`proofs/m19/sdfm-mcp-client.mjs` (dispatcher only: tools/list + tools/call, the operations' own validation and handlers).

## Source revisions (git archive copies of the clean read-only checkouts, sibling layout under /tmp/env)
- sdfm        ea8cbaeabdbda6ff39b4a8dbdd7028b65c4e718b (5619-ro-sdfm)
- MAMA        20c454322115b54fae0289234c207d713a10a8e9 (5619-ro-mama)
- raa         58837fe97bb3df6cdb61d42208bfed8bb5313875: the already built `dist/bricks` of the worktree 78/raa (same revision) is linked as `op-1197-raa/dist`
- NodeGraph   665cfe0805af87263e74027b52b74da9a9fe91c2, TS_PieMenue 566250f656ddfaac3a6335d2aa4d429584189ec2, CRM_Atoms 1364877dd90f798cb25b3c93e29da069f8df7887 (clean worktrees)
No source was modified except the one sdfm line below.

## Build, diagnostics, exact patch (Q6)
- `npm ci --ignore-scripts` in sdfm, MAMA, NodeGraph, TS_PieMenue, CRM_Atoms (lockfile versions, no upgrades); then `npm run build` in MAMA, CRM_Atoms, NodeGraph, TS_PieMenue
  (their builds are needed for sdfm's tsc to resolve `mama/*`, `@real3d/nodegraph`, `@real3d/pie-menu`; each exit 0).
- Only source change, in the /tmp/env/sdfm copy: the `display_set` description shortened to <= 400 chars, `display-description.patch` (identical to the 5617/5618 patch).
- `npx tsc -p tsconfig.node.json` -> **exit 2, not passing**; exactly the two diagnostics of `tsc-diag.txt`
  (`src/app/paramesh/game-display.ts(167,48) addTexture`, `(180,56) removeTexture` missing on Engine). `build-node/` was emitted and used solely to run the registered
  animation operations; the build is not reported as passing. `game-display.ts` is only used by the browser GPU page scenarios; nothing under src/node or src/core imports it,
  and every operation used here returned isError:false. `sdfm-cli.mjs` runs `build-node/node/cli.js` main() without recompiling.
- The server prints a vite `git rev-parse HEAD` error on stderr (the copy is not a git repository); it has no effect on any operation.

## Startup / list / read (before authoring) - `read.jsonl`
`sdfm mcp: 214 tools, document (new); stdio ready`; tools/list includes anim_clip_create/select/rename/remove/settings_set, anim_key_set/remove/move/interpolation_set/handles_set,
anim_preview_seek/play/pause/loop_set, anim_auto_key_set; `game_register /tmp/env/game` (copy of this repo without node_modules/.git), `asset_open_game royal-fiesta penguin.body` (25 nodes),
anim_clip_select hang + anim_preview_seek tick 0 + anim_clip_select clear.

## Authoring - `author.jsonl` (all through registered operations; `proofs/m19/emote-steps.mjs` only computes their arguments)
anim_clip_create `emote.wave` and `emote.dance`; anim_clip_settings_set (96 ticks = 1.6 s at the 60 Hz sim tick, rootMotion none, no events; wave loop false, dance loop true);
anim_key_set insert (126 BEZIER keys each, FK only on root(=hips) scale/rotation/translation, head, both flippers upper/lower/tip, both legs upperLeg/foot);
anim_preview_loop_set off; anim_auto_key_set off; anim_clip_select + anim_preview_seek at every key tick; asset_save_game.
- emote.wave (keys 0, 8, 20, 32, 44, 56, 68, 80, 96): rest -> small dip -> right flipper rises while the head turns toward the viewer and the body leans away; the forearm and
  tip swing side to side (five half swings), then the flipper lowers back to the rest pose (end == idle tick 0). The left flipper stays at rest.
- emote.dance (a key every half beat, 12 ticks, 4 beats at 150 bpm; key 96 == key 0, handles periodic so the seam has a continuous tangent): hip twist +/-26 deg about the vertical axis,
  hip sway, squash-and-stretch bounce on every beat, head bob/turn counter to the hips, flippers pump in alternation (first two beats) then both rise (last two beats), knees lift in turn with
  the foot pointing. It has no forward stride or waddle leg cycle, so it reads differently from waddle/run.
- World displacement stays with the simulation: rootMotion none, root translation is only a pose offset (0.1 m). No IK was used or added (the rig's ikChains are unchanged).

## How the committed asset was produced (same parity rule as 5617/5618)
`asset_save_game` refuses the owner's `face_patch` ellipsoid `gameCollision: true`, so the session sets it false for the save, and the saved file is laid out differently from the committed one
(715,669 bytes saved vs the committed layout). `merge.mjs` asserts the rig and the eleven earlier clips of the saved file equal the committed ones, then appends only the two new clip objects,
verbatim, to the committed text (every other byte kept) and recomputes `hash` as the SDF Modeler document-text hash accepted by `parseGameAsset` (Q3). The earlier `penguin.body` hash
b5eea860cf11... became ab2b80dd7883 180301... Rig, idle..climbUp, bounds and collider are untouched.
- Acceptance re-open: the final committed file was copied into /tmp/env/game and opened with `asset_open_game`; `emote.wave` and `emote.dance` were selected and `anim_preview_seek` ran at
  20/96 and 36/84 without error (`final-open.jsonl`).

## Checks
- `proofs/m19/emote-check.mjs` (output `emote-check.out.json`): both exact names load and sample on the game animation runtime (`@etcito/raa-anim`) over ticks 0..192, finite skin/local poses,
  zero root delta. Wave: starts and ends at the idle rest pose, right flipper lifts (0.48) while the left stays (0.05), forearm reverses direction 7 times (swing 0.50), head turns (0.16), max tick step 0.063.
  Dance: loop seam exact, root yaw range 0.45 (waddle/run are about 0.1 or less, asserted >2.5x), bounce 0.10 m, squash 0.13, both flippers 0.85, knees 0.41, head 0.47, mean pose distance to
  waddle/run/idle ~0.02-0.03 (asserted >0.02), max tick step 0.083; wave vs dance differ; rig and all earlier clips equal to HEAD.
- `npm run typecheck` exit 0; `npm run build` exit 0; gameAsset/animBrick/assets/courseV1/shippedAssets/content/contentFiles suites pass (52 tests). No hash of a build output is used as a gate.

## Media
`proofs/m19/penguin-emotes.mp4` (960x540, 480 frames, half speed): wave x2 then dance x3, face and profile, phase captions and tick counter. Rendered by `emote-media.mjs` from the committed asset
with real S17 sampling and S18 linear-blend skinning on a flat-lit CPU raster (same method as earlier clip previews); a CPU preview, not client-GPU evidence.

## Full test run (inherited failures, none touched by this task)
`npm test` stalls for more than 10 minutes in `apps/headless/test/meshNode.test.ts` (the checkpoint-gate quad-refusal case, an asset this task does not touch), so the suite was run without that file:
754 tests, 750 pass, 3 fail, all inherited: `tools/test/placeholders.test.ts` "buildContent equals the files on disk" (`assets/common/penguin.animgraph.json` is on disk but neither built nor authored),
`apps/web/test/mamaMaterials.test.ts` "shared shader dependencies" (1 !== 2; fails identically with the HEAD penguin asset swapped in) and the guard test (`.mp4` files already tracked under proofs/m19 and docs/media).
