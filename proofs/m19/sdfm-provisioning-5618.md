# Task 5618 - SDF Modeler provisioning and authoring record (climbUp)

Files referenced below are in `proofs/m19/provisioning-5618/` unless stated otherwise. The isolated `/tmp/env` environment was provisioned for this task
under the Q5/Q6 authorization (it is not committed).

## Source revisions (copies of clean read-only checkouts in /tmp/env, sibling layout: sdfm, MAMA, NodeGraph, TS_PieMenue, op-1197-raa)
- sdfm        ea8cbaeabdbda6ff39b4a8dbdd7028b65c4e718b (worktree 5618-ro-sdfm)
- raa         58837fe97bb3df6cdb61d42208bfed8bb5313875 (worktree 5618-ro-raa; the copy is named `op-1197-raa`)
- MAMA        20c454322115b54fae0289234c207d713a10a8e9 (worktree 5618-ro-mama)
- NodeGraph   665cfe0805af87263e74027b52b74da9a9fe91c2
- TS_PieMenue 566250f656ddfaac3a6335d2aa4d429584189ec2
The sources had no local changes (`git status` clean) and were not modified. A `diff -r` of the sdfm copy against its source shows only
`src/node/ops/display.ts` (the patch below); the MAMA copy is identical to its source, and the raa copy only adds build outputs (`packages/raa/pkg`, `release`).

## Build, diagnostics, exact patch (Q6)
- `cd /tmp/env/sdfm && npm ci --ignore-scripts` (lockfile versions, no upgrades): 118 packages.
- Only source change, in the /tmp/env/sdfm copy: the `display_set` description in `src/node/ops/display.ts` shortened to <= 400 chars,
  `display-description.patch` (byte-identical to the patch recorded by 5617). No registry validation, tool name, schema or handler change.
- Build: `npx tsc -p tsconfig.node.json` -> **exit 2, not passing**; exactly the two diagnostics of `tsc-diag.txt`
  (`src/app/paramesh/game-display.ts(167,48) addTexture`, `(180,56) removeTexture` missing on `Engine`). Output was emitted to `build-node/` and used
  solely to run the registered animation operations. Not reported as a passing build.
- Both unavailable calls are in `src/app/paramesh/game-display.ts` (browser GameDisplay baked-material path). A grep of the copy finds that file referenced only
  by `src/app/gpu-page/scenarios/*` (browser GPU page) and a type-only import in `src/app/anim/playback.ts`; nothing under `src/node` or `src/core` imports it,
  and every operation used here returned `isError:false`.
- `sdfm-cli.mjs` runs `build-node/node/cli.js` `main()` without recompiling (so the nonzero tsc result is not re-triggered).
- The server prints a vite `git rev-parse HEAD` error on stderr (the copy is not a git repository); it does not affect any operation (all calls returned `isError:false`).

## Startup / list / read (before authoring) - `read.jsonl`
- `sdfm-mcp-client.mjs` (stdio MCP client, dispatcher only) spawned `sdfm-cli.mjs mcp`: `214 tools, document (new); stdio ready`.
- `tools/list` includes anim_clip_create/select/rename/remove/settings_set, anim_key_set/remove/move/interpolation_set/handles_set,
  anim_preview_seek/play/pause/loop_set, anim_auto_key_set.
- Read: `game_register /tmp/env/game` (copy of the royal-fiesta game folder), `asset_open_game royal-fiesta penguin.body` (25 nodes),
  `doc_read`, `anim_clip_select` hang + `anim_preview_seek` tick 0 + `anim_clip_select clear`.

## Authoring - `author.jsonl` (all through registered operations; `proofs/m19/climb-up-steps.mjs` only computes their arguments)
anim_clip_create `climbUp`; anim_clip_settings_set (72 ticks = 1.2 s at the 60 Hz sim tick, loop false, rootMotion none, no events); anim_key_set insert
(98 BEZIER keys, FK only: root = hips scale/rotation/translation, head, both flippers upper/lower/tip, both legs upperLeg/foot); anim_preview_loop_set off;
anim_auto_key_set off; anim_clip_select + anim_preview_seek at every key tick; asset_save_game.
- Pose story (keys at ticks 0, 8, 22, 34, 46, 58, 72): 0 hang (identical numbers to grab tick 24 / hang tick 0) -> 8 brace (arms lock straight, body arches back,
  legs kick behind) -> 22 pull (elbows fold, flippers come down, hips curl) -> 34 chest over the ledge (body pitched 24 deg, elbows low, left knee drives forward)
  -> 46 push up (flippers straighten down/back, feet reach forward) -> 58 rise (torso straightens, flippers out for balance, small crouch) -> 72 recovery = rest
  pose = idle tick 0 (difference 0 in `climb-up-check.out.json`).
- World displacement stays with the simulation: rootMotion none, no root travel; root translation is only a pose offset (max 0.13 m). No IK was used or added
  (ikChains in the rig are unchanged).

## How the committed asset was produced (same parity rule as 5617)
`asset_save_game` refuses the owner's `face_patch` ellipsoid `gameCollision: true`, so the session sets it false for the save, and the saved file is laid out
differently from the committed one (550,931 bytes saved, hash 5a3f9244a7c5..., vs 131,123 bytes at HEAD). The SDF Modeler save is therefore not the committed file: `merge.mjs` asserts the rig and the ten
earlier clips of the saved file equal the committed ones, then appends only the new `climbUp` clip object, verbatim, to the committed text (every other byte
kept) and recomputes `hash` as the SDF Modeler document-text hash accepted by `parseGameAsset` (Q3): `d70e2086...` -> `b5eea860cf11...`. Rig, idle..hang and the
bounds/collider are untouched (`git diff --stat`: 129 insertions, 1 deletion; the only removed line is the old hash; the committed file is now 145,997 bytes).
- Acceptance re-open: the final committed file was copied into /tmp/env/game and opened with `asset_open_game`; `climbUp` was selected and `anim_preview_seek`
  ran at 0, 34 and 72 without error (`final-open.jsonl`; that session had preview looping at its default ON, so tick 72 is reported as 0 there; the first
  authoring session, with looping off, reports tick 72).

## Checks
- `proofs/m19/climb-up-check.mjs` (output `climb-up-check.out.json`): climbUp loads and samples on the game animation runtime (`@etcito/raa-anim`) over
  ticks 0..144, finite skin and local poses, zero root delta; start == hang tick 0 (difference 0, skin too); recovery == idle tick 0 (difference 0) and clamped after the end;
  flippers, hips and feet all move (0.62 / 0.21 / 0.54); root translation max 0.13; max per-tick pose step 0.054; rig and all earlier clips equal to HEAD.
- `npm run typecheck` exit 0; `npm run build` exit 0 (this is the game repo's build, unrelated to the sdfm tsc result above);
  gameAsset/animBrick (17 tests) and assets/courseV1/shippedAssets/contentFiles (33 tests) suites pass. No hash of a build output is used as a gate.

## Media (addendum)
`proofs/m19/penguin-climb-up.mp4` (960x540, 264 frames, half speed): hang once, then climbUp three times, face and profile, phase caption and tick counter.
Rendered by `climb-up-media.mjs` from the committed asset with real S17 sampling and S18 linear-blend skinning on a flat-lit CPU raster (same method as the
earlier 5617 clip previews). It is a CPU preview, not client-GPU evidence; a GPU review capture belongs to the client-GPU command queue (Q4).
