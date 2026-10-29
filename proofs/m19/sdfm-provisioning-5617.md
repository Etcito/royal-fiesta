# Task 5617 - SDF Modeler provisioning and authoring record (grab, hang)

All files referenced below are in `proofs/m19/provisioning-5617/` unless stated otherwise.

## Source revisions (read-only checkouts copied to /tmp/env, Q5)
- sdfm        ea8cbaeabdbda6ff39b4a8dbdd7028b65c4e718b
- raa         58837fe97bb3df6cdb61d42208bfed8bb5313875
- MAMA        20c454322115b54fae0289234c207d713a10a8e9
- NodeGraph   665cfe0805af87263e74027b52b74da9a9fe91c2
- TS_PieMenue 566250f656ddfaac3a6335d2aa4d429584189ec2

## Build, diagnostics, exact patch (Q6)
- `cd /tmp/env/sdfm && npm ci --ignore-scripts` (lockfile versions, no upgrades).
- Build: `tsc -p tsconfig.node.json` (what `node bin/sdfm.mjs` runs). Result: **exit 2, not passing**; exactly the two diagnostics in
  `tsc-diag.txt`: `src/app/paramesh/game-display.ts(167,48) addTexture` and `(180,56) removeTexture` missing on `Engine`.
  This build is not reported as passing. tsc still emitted `build-node/`, which was used as is.
- `node bin/sdfm.mjs` then refused to start: `BAD_TOOL_DEF display.js: description must be a string of at most 400 chars`
  (`display_set`, 460 chars). Only change made to sdfm in /tmp/env: the `display_set` description in `src/node/ops/display.ts`
  shortened to <=400 chars, see `display-description.patch` (sdfm `git status`: ` M src/node/ops/display.ts` only).
  `build-node` was regenerated from it, again with the same two diagnostics and exit 2.
- Dispatcher: `sdfm-cli.mjs` runs `build-node/node/cli.js main()` without recompiling (so the nonzero tsc result is not re-triggered).

## Startup / list / read (verified before authoring)
- `sdfm-cli.mjs mcp` started: `sdfm mcp: 214 tools, document (new); stdio ready`.
- `tools/list`: 214 tools including anim_clip_create/select/rename/remove/settings_set, anim_key_set/remove/move/
  interpolation_set/handles_set, anim_preview_seek/play/pause/loop_set, anim_auto_key_set (`read.jsonl`, `author.jsonl`).
- Read: `game_register /tmp/env/game`, `asset_open_game royal-fiesta penguin.body` (25 nodes, hash 7837c4de...), `doc_read` (`read.jsonl`).

## Authoring (all through registered operations, `proofs/m19/sdfm-mcp-client.mjs` + `proofs/m19/grab-hang-steps.mjs`)
`author.jsonl` is the transcript: anim_clip_create grab/hang, anim_clip_settings_set, anim_key_set (BEZIER keys, FK only, no IK),
anim_preview_loop_set / anim_auto_key_set, anim_clip_select + anim_preview_seek at every key tick, then asset_save_game.
- grab: 24 ticks, loop false; crouch (tick 6) -> both flippers reach up and forward (14, 18) -> settles into the hang pose (24).
- hang: 48 ticks, loop true; both flippers overhead, body stretched, legs dangling, small sway; ticks 0 = 48 (seamless).
- Endpoints coordinated: grab tick 24 pose == hang tick 0 pose (difference 0 in `grab-hang-check.out.json`).

## Parity finding and how the committed asset was produced
- `asset_save_game` refuses the owner's `face_patch` ellipsoid `gameCollision: true` (COLLISION_UNSUPPORTED), so the session had to set
  `face_patch.gameCollision=false` before saving (`parity.jsonl`: re-saving the unmodified asset gives 390,909 bytes, hash 17eaf920...,
  not the committed 110,480 bytes / 7837c4de...; the saved form also changes bounds and layout).
- The SDF Modeler save was therefore not used as the file. The `grab` and `hang` clip objects were taken verbatim from the
  registered-operation output (saved file, hash f5418005...) by `merge.mjs` after asserting the first eight clips and the rig of the saved
  file equal the committed ones; they were appended to the committed asset text (bounds, collider, face_patch flag and all other bytes untouched).
- `hash` of the merged asset: d70e2086cdf186a90d580fd903c3bd3d5e094ac837fc1ec122652da1e5ae43b, the SDF Modeler document-text hash
  (the same function reproduces SDF Modeler's own hash for its saved file, accepted by `parseGameAsset`: see `text-hash.mjs`).
- Acceptance re-open: the final committed file was copied into /tmp/env/game and opened with `asset_open_game`; `grab` and `hang` were
  selected and `anim_preview_seek` ran at grab 14 and hang 24 without error (`final-open.jsonl`).

## Checks
- `proofs/m19/grab-hang-check.mjs` (output `grab-hang-check.out.json`): both clips load and sample on the existing rig over two
  loop lengths with finite skin and zero root delta; prior rig and eight prior clips are byte-for-byte equal in data; grab reach 0.58,
  grab vs hang pose difference 0.71, hang sway 0.034 (sustained), hang loop seam exact, grab end == hang start.
- `npm run typecheck` pass, `npm run build` pass, gameAsset/animBrick/assets/content/contentFiles tests pass (27).
- No GPU capture or video was produced here (Q4); a review capture of grab/hang belongs to the client-GPU command queue.
