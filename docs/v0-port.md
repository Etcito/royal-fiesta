# V0 port inventory (M9..M14)

This is the inventory every V0 port task follows. It lists each path that the V0 bundle adds, modifies or
deletes between `abd630f` (V0 before M9) and `c77a5bd` (V0 after M14). For each path it gives the module
that ports it, what happens to it on this repository's main, and why.

Range facts, read from the bundle:

- 98 commits in `abd630f..c77a5bd`.
- **179 paths** (`git diff --name-only abd630f c77a5bd`): 148 added, 31 modified, 0 deleted, no renames
  (`--no-renames` gives the same list).
- Tree size: 181 files at `abd630f`, 329 at `c77a5bd`.
- Against main:
  - none of the 148 added paths exists on main;
  - 27 of the 31 modified paths exist on main;
  - the other 4 modified paths were deleted from main by the public clean-up, and they are marked keep-base or
    drop below.

Each range path appears exactly once in this doc, as the first cell of a table row. Elsewhere, files are named by
a short path relative to the directory given in the text.

## Reading the bundle

Read the bundle outside the repository, in a scratch clone. Never run git in a port worktree. The bundle is the
V0 bundle named in the milestone brief. Below it is written `"$B"`: set `B` to that file before you start.

1. List the heads. This works outside any repository:

   ```sh
   git bundle list-heads "$B"
   # c77a5bd... refs/heads/nmc/67-royal-fiesta-the-game-result   (one head, no HEAD)
   ```

2. Clone it into the scratch directory. Because the bundle has no HEAD, pass the head with `--branch`; a plain
   clone ends with an unborn HEAD.

   ```sh
   rm -rf "$TMPDIR/rf-v0"
   git clone -q --no-checkout --branch nmc/67-royal-fiesta-the-game-result "$B" "$TMPDIR/rf-v0"
   ```

3. Verify the bundle. `git bundle verify` needs a repository, so run it inside the scratch clone. It reports a
   sha1 bundle that "records a complete history", which means it has no prerequisite commits.

   ```sh
   git -C "$TMPDIR/rf-v0" bundle verify "$B"
   ```

4. Read the range and the files:

   ```sh
   git -C "$TMPDIR/rf-v0" diff --no-renames --name-status abd630f c77a5bd   # the 179 rows below
   git -C "$TMPDIR/rf-v0" log --reverse --format='%h %s' --name-status abd630f..c77a5bd
   git -C "$TMPDIR/rf-v0" show c77a5bd:<path>                               # one file at V0 M14
   git -C "$TMPDIR/rf-v0" diff abd630f c77a5bd -- <path>                    # what M9..M14 changed in it
   git -C "$TMPDIR/rf-v0" checkout -q --detach c77a5bd                      # only for grep across the tree
   ```

5. To compare a file with main, run a plain `diff` against the worktree file. It needs no git in the worktree:
   `diff <(git -C "$TMPDIR/rf-v0" show c77a5bd:<path>) <path>`.

If a later bundle is incremental, `verify` lists the prerequisite commits ("requires") and the clone fails. In
that case, index the pack yourself and read the objects by id. The bundle header ends at the first empty line,
and the pack follows it. Run this in a scratch repository; to resolve thin deltas, that repository must already
hold the prerequisite commits, for example a clone of the earlier bundle.

```sh
git init -q "$TMPDIR/rf-v0"
off=$(LC_ALL=C grep -a -b -m1 -x '' "$B" | cut -d: -f1)        # byte offset of the empty header line
tail -c +$((off + 2)) "$B" | git -C "$TMPDIR/rf-v0" index-pack --stdin --fix-thin
git -C "$TMPDIR/rf-v0" cat-file -t c77a5bd                      # commit
git -C "$TMPDIR/rf-v0" show c77a5bd:<path>
git -C "$TMPDIR/rf-v0" diff --name-status abd630f c77a5bd
```

The current bundle was checked both ways: it clones, and the index-pack route gives the same `c77a5bd` tree.

Remove the scratch clone when the port is done: `rm -rf "$TMPDIR/rf-v0"`.

## Dispositions

- **take**: copy the `c77a5bd` content as is. The only allowed change is a path move named in the reason.
- **take+rewrite**: port the content, but rewrite the parts that main replaced or that must not be public:
  - **raaBuild** (the bundle's out-of-tree RAA build tool): main uses the published `@etcito/raa` release, so
    there is no build step;
  - **a sibling alias** (`@raa/engine` through the aliases file, or the vite alias table): use the `@etcito/raa`
    import that main's render port already uses;
  - **the bundle's tools/bricks.ts**: main's tools/bricks.ts keeps `repoRoot`, `brickDir` and `checkBricks`
    for `gamesaloon-public` and `raa-assets-tools` only, so `brickDir('raa')`, `brickDir('gamesaloon-rollback')`
    and `linkBricks` have no target;
  - **createRaaPorts** (the bundle's multi-port RAA API): use one `createRaaPort()` per canvas, as main's
    client/canvases.ts does;
  - **a committed private value** (relay host, internal tool or brief, operator wording): move it to the env or
    the query, or delete the line;
  - **a manifest**: merge additively into main's version.
- **keep-base**: main's version stays and the bundle's change is not ported. This covers:
  - the audio module: packages/game/src/audio/, apps/web/src/audio/, apps/web/src/client/sound.ts,
    apps/web/src/play/sound.ts;
  - anything that would undo the public clean-up: sibling paths, the aliases file, `file:` dependencies, the
    vendored rollback copy, raaBuild users in main's own files.
- **drop**: not ported at all. This covers raaBuild itself and its test, and any file that is private or holds
  absolute-path content (local machine paths, private hosts, the owner approval and playtest records, the
  private publish route).

Modules: orbit-controls, screens, podium-stage, local-play, wavedash and v0-port-records are the port modules.
The other names are the base modules from ARCHITECTURE.md that own the file on main (1.4 port exception):
workspace, guard, bricks, assets, bots, match-rules, scene-view, web-client, raa-port, web-play, m7-proof and
m8-proof.

## The 179 paths

Status: A = added in the range, M = modified in the range. The tables follow the bundle's path order.

### Root, headless and web (51 paths)

| Path | St | Module | Disposition | Reason |
|---|---|---|---|---|
| `.gitignore` | M | workspace | take+rewrite | Add only the `apps/web/public/store/` line (store mirror). The other added line is already on main; keep main's `node_modules/`. |
| `.nmc/commands.json` | M | workspace | drop | Local runner config. Main ignores `.nmc/` and does not track it. |
| `README.md` | M | workspace | take+rewrite | Port the local, game and online page sections. Delete the sibling-checkout, raaBuild and private build-tool steps. |
| `apps/headless/proofs/m11-playable.ts` | A | v0-port-records | take+rewrite | It runs raaBuild before the GPU run: drop that step and use the `@etcito/raa` release. `repoRoot` still comes from main's tools/bricks.ts. |
| `apps/headless/proofs/m12-screens.ts` | A | v0-port-records | take+rewrite | Same raaBuild step as m11: replace it with the `@etcito/raa` release. |
| `apps/headless/proofs/m13-wavedash.ts` | A | v0-port-records | take+rewrite | raaBuild step: use `@etcito/raa`. Its playtest and owner gates read dropped records through the dropped publish tool, so keep the local mode only. |
| `apps/headless/proofs/m14-controls.ts` | A | v0-port-records | take | Imports only `repoRoot`, controlsRecord, controlsProbe, packageWavedash and proofkit. Each is on main or ported below. |
| `apps/headless/proofs/m7-web.ts` | M | v0-port-records | keep-base | The bundle finds RAA through `brickDir('raa')` and the aliases file. Main's m7 reads `@etcito/raa` (base owner m7-proof). |
| `apps/headless/proofs/m8-hub.ts` | M | v0-port-records | keep-base | Same sibling RAA detection as m7-web (base owner m8-proof). |
| `apps/headless/src/gpuClient.ts` | A | v0-port-records | take | GPU client harness (`publishDist`, `renderOp`) for the m11..m13 proofs. No private value. |
| `apps/headless/src/gpuRecord.ts` | A | v0-port-records | take | Record helpers (`buildCapturesRecord`, `unwrapOp`, `decodePng`) for the m11..m13 proofs. |
| `apps/headless/src/wavedashProof.ts` | A | v0-port-records | take+rewrite | It imports the approval reader of the dropped private publish tool and names the private playtest host. Keep the local judges and the relay-url item. |
| `apps/headless/test/gpuRecord.test.ts` | A | v0-port-records | take | Unit test of gpuRecord. |
| `apps/headless/test/harnessOp.test.ts` | A | wavedash | take | Unit test of the online harness op. |
| `apps/headless/test/pairOp.test.ts` | A | wavedash | take | Unit test of the in-page pair op. |
| `apps/headless/test/wavedashPlatform.test.ts` | A | wavedash | take | Unit test of the Wavedash platform adapter. |
| `apps/headless/test/wavedashProof.test.ts` | A | v0-port-records | take+rewrite | Follows wavedashProof: drop the owner-approval and published-gate cases. |
| `apps/web/aliases.json` | M | raa-port | keep-base | The public clean-up deleted it from main. It mapped `@raa/engine` to a sibling checkout; `@etcito/raa` replaces it. |
| `apps/web/game.html` | A | screens | take | Game page (menus, hub, match, podium). Main's vite config already picks up every root page. |
| `apps/web/local.html` | A | local-play | take | Local match page; also the page of the GPU ops. |
| `apps/web/online.html` | A | wavedash | take | Online room page. |
| `apps/web/public/nmc.gpu.json` | M | web-client | take+rewrite | Merge the `local.html` page and the ops array (probe, roundCapture, frameTiming, hubLoopCapture, localMatchCapture, screensTour, publishedClient, onlinePairCapture) into main's file. Add each op once its page is ported. |
| `apps/web/src/client/main.ts` | M | web-client | keep-base | The bundle's change gives one port per client through createRaaPorts. Main already does this with client/canvases.ts, and it also has ClientSound and query.ts. |
| `apps/web/src/game/app.ts` | A | screens | take | Game app: nav, session, stage, UI, input and UI cues. The M14 orbit lines come with it; orbit-controls reviews them. |
| `apps/web/src/game/input.ts` | A | orbit-controls | take | Keys, gamepad and look input. Screens created it (M12) and M14 finished it. Moves to `apps/web/src/input/` (see below). |
| `apps/web/src/game/look.ts` | A | orbit-controls | take | PointerLook: pointer lock on the canvas and mouse deltas. Moves to `apps/web/src/input/`. |
| `apps/web/src/game/main.ts` | A | screens | take | Page boot: query, deploy config, store and `mountGame`. The server comes from `?server=` or the deploy config. |
| `apps/web/src/game/sfx.ts` | A | screens | take | Oscillator UI cues at the volume setting. Separate from main's audio module (keep-base), which plays the gameplay sounds. |
| `apps/web/src/game/sfxRender.ts` | A | screens | take | Renders the UI cues offline for the m12 sfx record. |
| `apps/web/src/game/stage.ts` | A | screens | take | Plaza, match and podium staging on one `createRaaPort()` (on main). |
| `apps/web/src/game/tour.ts` | A | screens | take | screensTour GPU op: a scripted visit of every screen. |
| `apps/web/src/game/ui.ts` | A | screens | take | DOM rendering of the screen models. |
| `apps/web/src/local/hud.ts` | A | local-play | take | Canvas HUD of the local match; the online page reuses it. |
| `apps/web/src/local/main.ts` | A | local-play | take | Local match page. It imports play/ops and online/pairCapture, so port it after those rewrites. |
| `apps/web/src/local/ops.ts` | A | local-play | take | localMatchCapture GPU op on one `createRaaPort()`. |
| `apps/web/src/nmc/ops.ts` | M | web-client | take+rewrite | Port the op envelope `{json, files}`, the high-performance adapter request and the timer-based frame wait. Replace createRaaPorts with one `createRaaPort()` per canvas. |
| `apps/web/src/nmc/probe.ts` | A | web-client | take | probe GPU op on `createRaaPort()` and raaStatus, both on main. |
| `apps/web/src/online/harnessOp.ts` | A | wavedash | take | publishedClient op and the `PlayOutput` shape. |
| `apps/web/src/online/main.ts` | A | wavedash | take | Online room page. Its M14 orbit, pointer lock and right-stick lines come with it. The relay URL comes from `resolveRelayUrl` (see the deploy row). |
| `apps/web/src/online/pairCapture.ts` | A | wavedash | take+rewrite | onlinePairCapture op: rewrite its createRaaPorts call for two viewports as two `createRaaPort()` canvases. |
| `apps/web/src/online/pairOp.ts` | A | wavedash | take | Two OnlineSessions over the in-page LoopbackRelay. No render. |
| `apps/web/src/online/report.ts` | A | wavedash | take | Run report posted to the embedding page. |
| `apps/web/src/platform/wavedash.ts` | A | wavedash | take | Wavedash platform adapter (report channel, relay protocol). |
| `apps/web/src/play/main.ts` | M | web-play | take+rewrite | The bundle moves the in-page grid to createRaaPorts: use main's per-canvas ports instead. Keep main's SoundDriver lines. |
| `apps/web/src/play/ops.ts` | M | web-play | take+rewrite | Same createRaaPorts change in the play GPU ops. Main's file equals `abd630f`, so everything else applies cleanly. |
| `apps/web/src/render/raaAbsent.ts` | M | raa-port | keep-base | Deleted from main. It was the stand-in for a missing `@raa/engine` alias. |
| `apps/web/src/render/raaEngine.d.ts` | M | raa-port | keep-base | Deleted from main. It typed the aliased engine; `@etcito/raa` ships its own types. |
| `apps/web/src/render/raaPort.ts` | M | raa-port | keep-base | Main's port runs on `@etcito/raa` 0.1.1, one viewport per port. The bundle's runs on the alias. |
| `apps/web/src/render/raaRenderer.ts` | A | raa-port | keep-base | createRaaPorts over the aliased engine. Main's raaPort plus client/canvases.ts cover the same need. |
| `apps/web/src/render/raaStatus.ts` | M | raa-port | keep-base | Main checks `navigator.gpu` and the release's `RAA_API_VERSION`; the bundle probes the alias. |
| `apps/web/vite.config.ts` | M | web-client | keep-base | Adds raaBuild and the sibling alias roots. Main's config has no aliases and already picks up every root page. |

### Docs and manifests (15 paths)

| Path | St | Module | Disposition | Reason |
|---|---|---|---|---|
| `docs/brick-gaps.md` | M | bricks | keep-base | The bundle's version records local absolute paths and the sibling-alias gaps. Main's version describes the releases. |
| `docs/controls.md` | A | orbit-controls | take | Controls reference: keys and ZQSD, mouse with pointer lock, right stick, settings, rollback note. |
| `docs/etcito-gameserver.md` | A | wavedash | drop | Notes on the internal publish route, with internal tool names and hosts. |
| `docs/gamesaloon-gaps.md` | M | wavedash | take+rewrite | Port the added gap "No published endpoint for the hosted relay and rooms" without the host names (base owner m6-proof). |
| `docs/private-assets.md` | M | guard | take | The manifest example renames `type` to `contentType`, as the published store and the assets row below do. |
| `docs/screens.md` | A | screens | take | Every screen and its transitions. |
| `docs/store-assets.md` | A | local-play | take+rewrite | The store object list and the fetch rule. Reword the line that names the operator who fetched them. |
| `docs/wavedash-submit.md` | A | wavedash | drop | Operator-only submission steps that name internal tools and hosts. |
| `docs/wavedash.md` | A | wavedash | take+rewrite | Wavedash requirements, the build and the pointer-lock finding. Replace the private build-tool steps with the npm scripts; delete the internal brief path and the private publish lines. |
| `docs/wavedash/cover.svg` | A | wavedash | take | Store cover (title only), a text SVG. |
| `docs/wavedash/description.md` | A | wavedash | take | Store description. |
| `docs/wavedash/listing.json` | A | wavedash | take+rewrite | Store metadata. Reword the `unverified` note that names the operator. |
| `package-lock.json` | M | workspace | keep-base | Lock for the vendored and `file:` layout. Main's lock pins the release tarballs; regenerate it only from main's manifests. |
| `package.json` | M | workspace | take+rewrite | Add the scripts additively (list below). Drop `raa:build`, `publish:etcito` and the vendor workspace. |
| `packages/game/package.json` | M | workspace | keep-base | Sets the rollback dependency to `*` for the vendored copy. Main pins the release tarball. |

### packages/game and packages/sim (49 paths)

| Path | St | Module | Disposition | Reason |
|---|---|---|---|---|
| `packages/game/src/assets.ts` | M | assets | take | Manifest entry field `type` becomes `contentType`, the published store's name (3 lines). Main's file equals `abd630f`. See the follow-up on S4. |
| `packages/game/src/client/gameSession.ts` | A | screens | take | One session object for hub, match and podium, behind the game app. |
| `packages/game/src/client/hudModel.ts` | A | local-play | take | HUD model (qualified, alive, timer) for the local and online pages. |
| `packages/game/src/client/localMatch.ts` | A | local-play | take | Local match against bots, with a difficulty. |
| `packages/game/src/client/padMap.ts` | A | orbit-controls | take | Standard-mapping gamepad to move, look and buttons (dead zone 0.15). See Left/right findings. |
| `packages/game/src/deploy.ts` | A | wavedash | take+rewrite | It commits the production relay host and an infra comment. Under contract 1.6 the server URL comes from the env or `?server=`: keep `resolveRelayUrl` and the asset store base, with a null relay default. |
| `packages/game/src/hub/hubBots.ts` | A | screens | take | Attract-mode hub bots that walk loops. |
| `packages/game/src/net/onlineSession.ts` | A | wavedash | take | Online session: quick match, private room, relay and report. |
| `packages/game/src/net/privateRoom.ts` | A | wavedash | take | Private room codes over the relay. |
| `packages/game/src/net/quickMatch.ts` | A | wavedash | take | Quick match over the GameSaloon relay, with bots filling to 8. |
| `packages/game/src/net/reportFormat.ts` | A | wavedash | take | Run report shape, shared by the pages and the proofs. |
| `packages/game/src/render/courseDressing.ts` | A | local-play | take | Render-only dressing around a course (start gate, posts). |
| `packages/game/src/render/orbitCamera.ts` | A | orbit-controls | take | Mouse and stick orbit with clamped pitch. Check its yaw sign against cameraBasis before the port (Left/right findings). |
| `packages/game/src/render/podiumStage.ts` | A | podium-stage | take | Top 3 beans on a 3D podium, with screen-space name anchors. |
| `packages/game/src/render/sceneView.ts` | M | scene-view | take | Optional `camera(focus, frameDtS)` hook for the orbit camera, plus podium framing. Main's file equals `abd630f`. |
| `packages/game/src/render/spectator.ts` | A | local-play | take | Spectator follow camera after elimination. |
| `packages/game/src/screens/matchScreen.ts` | A | screens | take | Match screen mapping and round result rows. |
| `packages/game/src/screens/menuModel.ts` | A | screens | take | Menu model. Its pause screen lists the controls (M14 rows included). |
| `packages/game/src/screens/nav.ts` | A | screens | take | Screen navigation state machine. |
| `packages/game/src/screens/online.ts` | A | screens | take | Relay reachability as a UI message. |
| `packages/game/src/screens/settings.ts` | A | screens | take | Settings model: keys, volume and quality, plus the M14 sensitivities, invert-Y and ZQSD alternates. |
| `packages/game/src/storeAssets.ts` | A | local-play | take | Loads store objects and verifies them (sha256, size). |
| `packages/game/src/storeManifest.ts` | A | local-play | take | Recorded store manifest of the Royal Fiesta primitive assets. |
| `packages/game/test/assets.test.ts` | M | assets | take+rewrite | Main's test moved to the published raa.prims fixtures. Port only the `contentType` cases onto it. |
| `packages/game/test/courseDressing.test.ts` | A | local-play | take | Unit test of courseDressing. |
| `packages/game/test/deploy.test.ts` | A | wavedash | take+rewrite | Follows deploy: drop the assertions on the committed relay host. |
| `packages/game/test/gameSession.test.ts` | A | screens | take | Unit test of gameSession. |
| `packages/game/test/hubBots.test.ts` | A | screens | take | Unit test of hubBots. |
| `packages/game/test/hudModel.test.ts` | A | local-play | take | Unit test of hudModel. |
| `packages/game/test/localMatch.test.ts` | A | local-play | take | Unit test of localMatch. |
| `packages/game/test/matchScreen.test.ts` | A | screens | take | Unit test of screens/matchScreen. |
| `packages/game/test/menuModel.test.ts` | A | screens | take | Unit test of screens/menuModel. |
| `packages/game/test/nav.test.ts` | A | screens | take | Unit test of screens/nav. |
| `packages/game/test/online.test.ts` | A | screens | take | Unit test of screens/online. |
| `packages/game/test/onlineSession.test.ts` | A | wavedash | take | Unit test of net/onlineSession. |
| `packages/game/test/orbitCamera.test.ts` | A | orbit-controls | take | It pins the camera-relative maths; see Left/right findings. |
| `packages/game/test/padMap.test.ts` | A | orbit-controls | take | Unit test of padMap. |
| `packages/game/test/podiumStage.test.ts` | A | podium-stage | take | Unit test of podiumStage. |
| `packages/game/test/privateRoom.test.ts` | A | wavedash | take | Unit test of net/privateRoom. |
| `packages/game/test/quickMatch.test.ts` | A | wavedash | take | Unit test of net/quickMatch. |
| `packages/game/test/reportFormat.test.ts` | A | wavedash | take | Unit test of net/reportFormat. |
| `packages/game/test/sceneView.test.ts` | M | scene-view | take | Tests for the camera hook and the podium framing. Main's file equals `abd630f`. |
| `packages/game/test/settings.test.ts` | A | screens | take | Unit test of screens/settings. |
| `packages/game/test/storeAssets.test.ts` | A | local-play | take | Unit test of storeAssets. |
| `packages/sim/package.json` | M | workspace | keep-base | Same `*` rollback dependencies for the vendored copy. Main pins the release tarballs. |
| `packages/sim/src/bots/botSystem.ts` | M | bots | take | `applyDifficulty(rollSkill(rng), setup.botDifficulty)`. Main's file equals `abd630f`. |
| `packages/sim/src/bots/difficulty.ts` | A | local-play | take | Bot difficulty (easy, normal, hard) applied to the rolled skills. |
| `packages/sim/src/match/setup.ts` | M | match-rules | take | Optional `botDifficulty`, hashed only when it is not `normal`, so existing setup hashes do not change. Main's file equals `abd630f`. |
| `packages/sim/test/difficulty.test.ts` | A | local-play | take | Unit test of bots/difficulty. |

### Proofs, scripts, tools and vendor (64 paths)

| Path | St | Module | Disposition | Reason |
|---|---|---|---|---|
| `proofs/m11/captures.json` | A | v0-port-records | take | M11 GPU captures record (sizes, sha256, timing). No private value. The ported m11 proof rewrites it on its next run. |
| `proofs/m11/play.md` | A | v0-port-records | take | How to play locally (`npm run play`, a loopback URL). |
| `proofs/m11/round-log.json` | A | v0-port-records | take | Headless round log of the M11 matches. |
| `proofs/m12/screens/screens.json` | A | v0-port-records | take | The M12 screens tour record. |
| `proofs/m12/sfx-cues.json` | A | v0-port-records | take | The M12 UI cue render record. |
| `proofs/m13/assets-headers.json` | A | v0-port-records | drop | Store header record. Its regenerate command is the dropped store probe, run through a sandbox proxy. |
| `proofs/m13/build-alone.json` | A | v0-port-records | drop | Clean-clone build record of the private build tool; it names the relay host. |
| `proofs/m13/etcito-build.json` | A | v0-port-records | drop | Record of the private build route. |
| `proofs/m13/local-pair.json` | A | v0-port-records | take | In-page two-client pair record over the LoopbackRelay. No private value. |
| `proofs/m13/local-relay.json` | A | v0-port-records | drop | Holds a local absolute path. |
| `proofs/m13/local/frame-probes.json` | A | v0-port-records | drop | Holds a local absolute path. |
| `proofs/m13/owner-approval.json` | A | v0-port-records | drop | The owner's personal approval record (name, internal recorder). |
| `proofs/m13/playtest.json` | A | v0-port-records | drop | Private playtest URL. |
| `proofs/m13/published-pair.json` | A | v0-port-records | drop | A run on the private playtest URL. |
| `proofs/m13/raa-store-register.json` | A | v0-port-records | take | RAA store registration record of the primitive assets. |
| `proofs/m13/relay-check.json` | A | v0-port-records | drop | Names the relay host and the private build tool. |
| `proofs/m13/solo-play.json` | A | v0-port-records | take | Solo play record. |
| `proofs/m13/wavedash-check.json` | A | v0-port-records | take+rewrite | wavedashCheck record. Its sources cite an internal brief path: cite the Wavedash doc (its own row above) instead, and regenerate it after the pin rewrite. |
| `proofs/m13/wavedash-probes.json` | A | v0-port-records | drop | Every probe gives the private publish route as its reason. |
| `proofs/m14/controls-cdp.json` | A | v0-port-records | take | CDP controls record (loopback URL only). |
| `proofs/m14/frame-pointer-lock.json` | A | v0-port-records | take+rewrite | Frame pointer-lock record. Reword the note that names the operator. |
| `proofs/m7/captures.json` | A | m7-proof | keep-base | V0 captures from the alias renderer. Main's m7 proof reads only captures from a run on `@etcito/raa`. |
| `proofs/m7/raa-status.json` | M | m7-proof | keep-base | Main's record comes from the release; the bundle's names a local absolute path. |
| `proofs/m8/captures.json` | A | m8-proof | keep-base | V0 captures from the alias renderer. Main's m8 proof reads only captures from a run on `@etcito/raa`. |
| `proofs/m8/raa-status.json` | M | m8-proof | keep-base | Main's record comes from the release; the bundle's names a local absolute path. |
| `scripts/fresh-clone-build.sh` | A | wavedash | drop | Clean-clone build through the private build tool and raaBuild. On main a clean clone needs only `npm ci` and `npm run build`. |
| `tools/controlsProbe.ts` | A | orbit-controls | take | Drives the production build in CDP Chrome with real key and mouse events. Uses `repoRoot` only. |
| `tools/controlsRecord.ts` | A | orbit-controls | take | Pure judges and record shapes of the controls probe. |
| `tools/packageWavedash.ts` | A | wavedash | take+rewrite | Builds the Wavedash upload dir. Drop its raaBuild step: the build uses the `@etcito/raa` release. |
| `tools/play.ts` | A | local-play | take+rewrite | `npm run play`: fetch the store, build, serve. Drop the raaBuild step. |
| `tools/previewWavedash.ts` | A | wavedash | take | Serves the upload dir the way the Wavedash frame does (headers, sandbox). Uses `repoRoot` only. |
| `tools/probeEtcito.ts` | A | wavedash | drop | Probes the private build and store route. |
| `tools/publishEtcito.ts` | A | wavedash | drop | Private push route with an internal branch constant. |
| `tools/raaBuild.ts` | A | raa-port | drop | Builds RAA out of tree from a sibling checkout and holds an absolute path. `@etcito/raa` replaces it. |
| `tools/storeCache.ts` | A | local-play | take | `npm run store:fetch`: mirrors the store objects into the ignored public store dir. Uses `repoRoot` only. |
| `tools/test/controlsRecord.test.ts` | A | orbit-controls | take | Unit test of controlsRecord. |
| `tools/test/packageWavedash.test.ts` | A | wavedash | take+rewrite | Follows packageWavedash: no raaBuild step. |
| `tools/test/previewWavedash.test.ts` | A | wavedash | take | Unit test of previewWavedash. |
| `tools/test/publishEtcito.test.ts` | A | wavedash | drop | Test of the dropped publish tool; it also holds absolute test paths. |
| `tools/test/raaBuild.test.ts` | A | raa-port | drop | Test of the dropped raaBuild. |
| `tools/test/storeCache.test.ts` | A | local-play | take | Unit test of storeCache. |
| `tools/test/wavedashCheck.test.ts` | A | wavedash | take+rewrite | It imports raaBuild for `RAA_PIN`: use the `@etcito/raa` version. |
| `tools/wavedashCheck.ts` | A | wavedash | take+rewrite | Checks a build against the Wavedash doc. Its `RAA_PIN` (a raaBuild commit) becomes the `@etcito/raa` release version. |
| `vendor/gamesaloon-rollback/README.md` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/LICENSE` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/README.md` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/package.json` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/desync.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/index.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/inputBuffer.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/netsim.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/rng.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/rollback.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/smoothing.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/snap.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/timing.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/types.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/core/src/wire.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/NOTICE` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/package.json` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/src/hash.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/src/index.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/src/init.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |
| `vendor/gamesaloon-rollback/packages/rapier/src/world-sim.ts` | A | wavedash | keep-base | Vendored copy of the rollback packages for the clean-clone build. Main installs the published release tarballs. |

### Tally

- Total: 179 = 51 + 15 + 49 + 64 rows, which is the `--name-only abd630f c77a5bd` count.
- By disposition:
  - take: 94
  - take+rewrite: 27
  - keep-base: 39 (21 of them vendor files)
  - drop: 19
- By module:
  - wavedash: 58
  - v0-port-records: 32
  - screens: 23
  - local-play: 20
  - orbit-controls: 10
  - raa-port: 8
  - workspace: 7
  - web-client: 5
  - podium-stage, web-play, scene-view, assets, m7-proof, m8-proof: 2 each
  - bots, match-rules, guard, bricks: 1 each

## New tests per module

The bundle adds or changes 34 test files. The repository's test command already globs the tools, packages,
headless and web test directories, so every test it takes needs no script change. Names are relative to:
packages/game/test (game), packages/sim/test (sim), apps/headless/test (headless) and tools/test (tools).

| Module | Tests |
|---|---|
| orbit-controls | game: `orbitCamera.test.ts`, `padMap.test.ts`; tools: `controlsRecord.test.ts` |
| screens | game: `gameSession.test.ts`, `hubBots.test.ts`, `matchScreen.test.ts`, `menuModel.test.ts`, `nav.test.ts`, `online.test.ts`, `settings.test.ts` |
| podium-stage | game: `podiumStage.test.ts` |
| local-play | game: `courseDressing.test.ts`, `hudModel.test.ts`, `localMatch.test.ts`, `storeAssets.test.ts`; sim: `difficulty.test.ts`; tools: `storeCache.test.ts` |
| wavedash | game: `deploy.test.ts` (rewrite), `onlineSession.test.ts`, `privateRoom.test.ts`, `quickMatch.test.ts`, `reportFormat.test.ts`; headless: `harnessOp.test.ts`, `pairOp.test.ts`, `wavedashPlatform.test.ts`; tools: `packageWavedash.test.ts` (rewrite), `previewWavedash.test.ts`, `wavedashCheck.test.ts` (rewrite); dropped: `publishEtcito.test.ts` |
| v0-port-records | headless: `gpuRecord.test.ts`, `wavedashProof.test.ts` (rewrite) |
| scene-view | game: `sceneView.test.ts` (modified: camera hook and podium framing cases) |
| assets | game: `assets.test.ts` (modified: port only the `contentType` cases) |
| raa-port | dropped: tools `raaBuild.test.ts` |

## Manifest, tsconfig and ignore-file changes

All of these are additive only. They belong to the local-play and wavedash tasks.

- **Root manifest scripts** (each runs its tool with `node --experimental-strip-types`, as main's scripts do):
  - local-play adds `store:fetch` (the store cache tool) and `play` (the play tool);
  - wavedash adds `package:wavedash`, `preview:wavedash` and `controls:probe`. The controls probe drives the
    `preview:wavedash` build, so the wavedash task adds its script with that build; orbit-controls uses it.
  - Not ported:
    - `raa:build` (raaBuild is dropped);
    - `publish:etcito` (the publish tool is dropped);
    - the `vendor/gamesaloon-rollback/packages/*` workspace (keep-base).
- **Root manifest dependencies:** unchanged in the range. The range files import no new external package: only
  `@gamesaloon/rollback`, `@gamesaloon/rollback-rapier`, `vite`, and `@raa/engine` in the keep-base renderer.
  So the lock file needs no change.
- **Game and sim manifests:** the bundle moves `@gamesaloon/rollback` and `@gamesaloon/rollback-rapier` from
  `file:` sibling paths to `*` (the vendored copy). Not ported: main pins the release tarballs.
- **tsconfig:** no tsconfig file changes in the range. Main's root tsconfig already includes tools,
  `packages/*/src|test`, `apps/*/src|test|proofs` and the vite config.
- **Ignore file:**
  - local-play adds `apps/web/public/store/` (written by the store cache tool);
  - the bundle's other two changes are not ported: its new tool rules line is already on main, and `node_modules/` → `node_modules` is not needed.

## Headless helpers for the M9..M14 proofs (v0-port-records)

Names are relative to apps/headless/src.

- Added in the range and owned by the v0-port-records tasks:
  - `gpuClient.ts`: `publishDist` and `renderOp`, for the m11, m12 and m13 proofs. Take.
  - `gpuRecord.ts`: `buildCapturesRecord`, `unwrapOp`, `OpResult` and `decodePng`, for the m11, m12 and m13
    proofs. Take.
  - `wavedashProof.ts`: the m13 judges (`judgeLocalPair`, `judgeTwoClient`, `relayUrlItem` and others). Port it
    with take+rewrite: without the publish tool's approval reader and without the playtest host.
- Imported from main unchanged (the range does not touch them):
  - `proofkit.ts`: `parseProofArgs`, `cpuBudget`, `printCheck`, `report`, `outDir`, `hex8`, `percentile`,
    `spawnCases`, `runProof`;
  - `files.ts`: `repoPath`, `readRepoText`, `nodeFixtureResolver`, `loadCourseFile`, `loadAllCourses`;
  - `gamesaloon.ts`: `LocalServer`, `startGameSaloon`, `helloHandshake`.
- What each proof imports:
  - **m11:** localMatch, net/pilot, assets, storeManifest, `repoRoot`, raaBuild (rewrite), storeCache,
    files, gpuClient, gpuRecord, proofkit.
  - **m12:** screens/nav, storeManifest, raaBuild (rewrite), storeCache, gpuClient, gpuRecord, proofkit.
  - **m13:** courseSet, deploy, net/ws, storeManifest, packageWavedash, raaBuild (rewrite), storeCache,
    wavedashCheck, the web harnessOp and pairOp, files, gamesaloon, gpuClient, gpuRecord, proofkit,
    wavedashProof.
  - **m14:** `repoRoot`, controlsRecord, controlsProbe, packageWavedash, proofkit.
- The bundle has no m9 or m10 proof script and no proofs/m9 or proofs/m10 directory. M9 changed the m7 and m8
  proofs instead (both keep-base). The v0-port-records tasks have nothing to port into those two directories.

## M14 file list for apps/web/src/input/

The bundle has no apps/web/src/input/ directory: M14's web input code lives in apps/web/src/game/. The exact
list that moves into apps/web/src/input/ has two files, both A in the range and both orbit-controls:

| File in apps/web/src/input/ | From (apps/web/src/) | Commits | Exports |
|---|---|---|---|
| `input.ts` | game/input.ts | 1a0ad17 (M12, created), 53bd8b3 (M14: pointer look, right stick, padMap) | `GameInput`, `UiEvent`, `STICK_DEADZONE`, `PAD_JUMP`, `PAD_DIVE`, `PAD_GRAB`, `PAD_START` |
| `look.ts` | game/look.ts | 53bd8b3 (M14) | `PointerLook` |

After the move, update the importers: game/app.ts (`GameInput`, `UiEvent`) and online/main.ts (`PointerLook`).
M14 also changed these web files, but they stay where they are: online/main.ts (bc19436), and game/app.ts,
game/main.ts and game/stage.ts (0c72f3c).

## Test files for packages/game/src/screens/

The bundle tests the five screens models in packages/game/test, one file per model:

- `matchScreen.test.ts`
- `menuModel.test.ts`
- `nav.test.ts`
- `online.test.ts`
- `settings.test.ts`

All five are A in the range and owned by screens. M14 also changed `menuModel.test.ts` and `settings.test.ts`
(commit 3d3bdb1: sensitivities, invert-Y, ZQSD alternates).

## Left/right findings

This section lists every place in the bundle tree at `c77a5bd` that computes a screen-right vector, a yaw sign
or a mirrored stick axis. It covers range files and also the older files they call. Lines are at `c77a5bd`.
"Range" marks a file changed in M9..M14; "pre-range" marks a file identical on main.

The reference is contract 1.6: only cameraBasis computes the right vector. For a camera forward f:

- r = f × up = (-fz, 0, fx), right-handed, as in look_at_rh.
- For f = +Z, this gives r = -X.
- The sim's yaw convention is `yawFacing`: forward = (sin yaw, cos yaw), so yaw 0 faces +Z.
- A growing yaw turns the forward by df/dyaw = (cos yaw, 0, -sin yaw) = -r, toward the camera's screen-left.

### Screen-right vectors

| Where | Range | Formula | Under 1.6 |
|---|---|---|---|
| `packages/game/src/client/inputMap.ts:39-43` (`controlsToInput`) | pre-range | right = (fz, 0, -fx), with the comment "+X is right when looking along +Z"; moveX = fz·x + fx·y, moveZ = -fx·x + fz·y | **Mirrored** (= -r). Replace it with cameraBasis' r. |
| web `src/play/main.ts:138-144` (`cameraRelative`; main has the same at 139-145) | range M | mx = cz·x + cx·y, mz = -cx·x + cz·y ("right = (f.z, -f.x), as in controlsToInput"), then into the character frame: stickX = fz·mx - fx·mz, stickY = fx·mx + fz·mz | **Mirrored**, a copy of controlsToInput. Use cameraBasis. |
| game `src/render/podiumStage.ts:118-126` (`labels`) | range A | r = (-fz, 0, fx) normalised; up' = r × f = (-rz·fy, rz·fx - rx·fz, rx·fy); screen x = (d·r) / (depth·tan(fov/2)·aspect) (line 136) | **Matches 1.6.** Line 65 places 2nd (x < 0) on the frame's left with the camera on +Z. Move this formula into cameraBasis. |

### Yaw signs

| Where | Range | Formula | Under 1.6 |
|---|---|---|---|
| game `src/render/orbitCamera.ts:46` (`ground`) | range A | forward = (sin yaw, cos yaw) | Matches yawFacing. |
| game `src/render/orbitCamera.ts:49-53` (`mouse`) | range A | yaw += dx·k ("dx > 0 turns right"); pitch += (invertY ? -dy : dy)·k | **Mirrored**: a mouse move to the right turns the view toward -r, screen-left. Under 1.6, yaw -= dx·k (or yaw defined toward r). |
| game `src/render/orbitCamera.ts:56-63` (`stick`) | range A | yaw += rx·k; pitch += (invertY ? -ry : ry)·k | **Mirrored**, as for the mouse. |
| game `src/render/orbitCamera.ts:67-75` (`pose`) | range A | eye = focus + (0, TARGET_HEIGHT, 0) - (fx·h, -v, fz·h), with h = cos(pitch)·D, v = sin(pitch)·D | Forward only, so it holds under 1.6. |
| game `test/orbitCamera.test.ts:23-47` and `:98-104` | range A | It pins yaw 0: right → (1, 0); yaw 90: forward (1, 0), right (0, -1); mouse +dx quarter turn → ground (1, 0) | Pins the mirrored convention. The expectations flip with the port. |
| tools `controlsRecord.ts:64-73` (`angleDeg`) and `:87-100` (`judgeTop`) | range A | angle = atan2(a.z·b.x - a.x·b.z, a.x·b.x + a.z·b.z), "positive = clockwise seen from above (+Z turning toward +X)"; it checks the move turn against the yaw turn | It only checks that the movement agrees with the camera. It cannot see a mirror shared by both, so the M14 proof passed with both mirrored. |
| tools `controlsProbe.ts:220-240` (`turn`) | range A | It moves the mouse +x until the read yaw grows by TURN_DEG = 90 (turned += wrap(yaw - prev)) | It expects mouse right → yaw +, the mirrored sign. |
| game `src/render/sceneView.ts:130-131` | range M (also on main at 124) | half = atan2(fx, fz) / 2, bean rotation q = (0, sin half, 0, cos half) about +Y | Consistent: R_y(θ) maps +Z onto the facing. No change. |
| game `src/hub/hubBots.ts:88` and `:103-106` | range A | yaw = atan2(dx, dz); loop tangent yaw = atan2(cos θ, -sin θ) for pos = c + R·(sin θ, cos θ) | Consistent with yawFacing. |
| `packages/sim/src/vec.ts:150-153` (`yawFacing`) | pre-range | x = sin yaw, z = cos yaw; "positive yaw turns toward +X" | The sim convention. It stays (the sim never sees the camera). |
| `packages/sim/src/character/controller.ts:30-44` (`turnFacing`) | pre-range | angle = atan2(fz·tx - fx·tz, fx·tx + fz·tz), positive toward +X | Consistent with yawFacing. |
| `packages/sim/src/bots/brain.ts:89-91` | pre-range | aim error rotation: rx = dx·c + dz·s, rz = dz·c - dx·s | A yaw rotation by +a, consistent. |
| `packages/game/src/hub/protocol.ts:23` and `:69` | pre-range | f = round(atan2(fx, fz) / TAU · 256) & 255; yaw = f / 256 · TAU | Consistent. |
| `packages/game/src/hub/remotes.ts:28-32` and `:109` | pre-range | signed shortest arc d = wrap(b - a) in (-π, π]; yaw = a + d·t | Sign-neutral. |
| `packages/game/src/course.ts:100-101` | pre-range | facing = yawFacing(degToRad(yawDeg)) | Consistent. |
| `packages/game/src/render/camera.ts:17` (`followCamera`) | pre-range | eye = player - 7·f + (0, 4, 0) | Forward only. |
| `apps/headless/src/scripts.ts:23-26` | pre-range | LEFT = moveX -1, RIGHT = moveX +1 (world axes) | The names assume "+X is right", which is mirrored for a camera looking along +Z. The values are world moves, so the proofs stay valid. |

### Camera-forward consumers (they feed the formulas above)

These compute only f = normalise(target - eye) on XZ, or pass the orbit's ground forward. They are correct under
1.6 once controlsToInput uses cameraBasis:

- web `src/client/main.ts:111-118`, with calls at `:173` and `:194`;
- web `src/local/main.ts:105`, with a call at `:316`;
- web `src/game/stage.ts:91-98`;
- web `src/game/app.ts:405-411`;
- web `src/online/main.ts:469` and `:483-487`;
- game `src/client/gameSession.ts:97`;
- `packages/game/src/hub/flow.ts:163` and `:174` (these pass the character facing).

### Mirrored stick axes

| Where | Range | Formula | Under 1.6 |
|---|---|---|---|
| game `src/client/padMap.ts:17-22` (`padMove`) | range A | stickX = axes[0], stickY = -axes[1] (gamepad up is negative) | Correct: Y only, no X flip. |
| game `src/client/padMap.ts:30-35` (`padLook`) | range A | x = axes[2], y = axes[3], unflipped; the orbit treats y < 0 as look up | Correct. The yaw sign is in `stick`, above. |
| web `src/client/main.ts:93-98`, web `src/local/main.ts:87-92`, web `src/play/main.ts:91-96` (main: client 75-76, play 96-97) | range M/A | stickX = axes[0], stickY = -axes[1], inline copies of padMove | Correct. Under the port they become padMove calls. |
| web `src/game/look.ts:26-27` | range A | dx += movementX, dy += movementY, unflipped | Correct. |
| game `src/render/orbitCamera.ts:53` and `:63`, game `src/screens/settings.ts:16` | range A | invertY negates the pitch delta only, default off | Correct: no setting mirrors X. |
| `packages/game/src/client/inputMap.ts:15-16` | pre-range | x = right - left, y = forward - back | Correct. The mirror is in the basis at 39-43, not in the keys. |

Here "game" means packages/game, "web" means apps/web and "tools" means the tools directory; for example, game
`src/render/orbitCamera.ts` is that file under packages/game.

## Follow-ups for the port tasks

- **S4 field name:** contract S4 writes manifest entries as `{sha256, size, type, version}`, but the published
  store and the bundle's assets reader use `contentType`. Settle S4 before the local-play task ports the assets
  rows.
- **createRaaPorts:** five web files call it (client/main.ts, play/main.ts, play/ops.ts, nmc/ops.ts,
  online/pairCapture.ts). Main has no such API. Each port uses one `createRaaPort()` per canvas, as
  client/canvases.ts does.
- **Relay URL:** the bundle commits the production relay host in deploy.ts and in its test. The port reads the
  server from the env or `?server=` only (contract 1.6).
- **UI cues and audio:** the bundle's oscillator UI cues (game/sfx.ts) are separate from main's audio module,
  which stays keep-base. The screens task wires the cues to the volume setting without touching that module.
- **Left/right:** the orbit-controls task replaces the right vector in controlsToInput and play's
  cameraRelative with cameraBasis. It also fixes the orbit yaw increment sign, then updates
  orbitCamera.test and the controls probe's expected turn sign.
