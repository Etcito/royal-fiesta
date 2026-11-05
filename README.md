# Royal Fiesta

A Fall Guys-style party game with a 3D lobby, built on the GameSaloon rollback packages, the HAA sound engine, the RAA WebGPU renderer and GameSaloon. Open-source example game. MIT licence.

Assets are not stored in git: they live in the content-addressed asset store (https://assets.etcito.com).

## What Royal Fiesta is

Royal Fiesta is a networked, real-time 3D party game for the browser: Fall Guys-style rounds and eliminations plus a walkable 3D hub lobby. Matches run on deterministic rollback netcode over GameSaloon, the simulation is a pure TypeScript package, and headless Node clients plus proof scripts exercise every layer without needing a GPU or a browser.

The repository is an npm workspace:
- `packages/sim`: the deterministic simulation only (world, systems, characters, obstacles, rounds, bots).
- `packages/game`: data loading, network transports, the render port and the client core shared by the apps.
- `apps/headless`: Node CLIs, proof scripts and Node-only adapters.
- `apps/web`: the Vite pages of the browser client.

## Build from a clean clone

You need Node.js 22.18 or newer and git. The RAA renderer (raa), the MAMA mesher (mama) and the HAA sound engine (haa) are sibling checkout `file:` dependencies: clone those three repositories next to royal-fiesta before installing. The GameSaloon rollback packages and `@etcito/raa-assets-tools` come from their GitHub releases.

`@etcito/haa` has two sources during step 2: the game pack and the root devDependency use the 0.1.1 release tarball, while apps/web uses the haa sibling checkout until the v0.2.0 release is published.

```
git clone https://github.com/Etcito/royal-fiesta.git
cd royal-fiesta
npm install            # sibling raa/mama/haa file: dependencies plus the release tarballs
npm run typecheck
npm test
npm run web:build      # apps/web/dist/
npm run play           # audio:bake, build, then serves http://localhost:5173/game.html
```

`npm run play` serves apps/web/dist on 127.0.0.1:5173 and refuses to start when that port is in use (`-- --port N` picks another). `npm run play -- --check` boots the server, checks that game.html, play.html and a built asset answer 200, then exits; it does not need MAMA.

With Kong instead of npm, run `kong rules` and then `kong use kong.rules` in the repository root. `kong.rules` records each release URL and its integrity hash.

`npm run bricks -- check` verifies that the packages resolve and that the Rapier WASM starts.

The browser client draws with RAA (WebGPU). A browser without `navigator.gpu` shows the null render port with a banner. One optional local checkout is never required: the GameSaloon server test runs only when `GAMESALOON_DIR` points at a checkout of gamesaloon-public; otherwise it is skipped.

Never use `--preserve-symlinks`: Node refuses to strip types under `node_modules`.

## Sound

The Royal Fiesta sound pack lives in `packages/game/src/audio/pack`. It registers its one-shot families, the crowd bed and the `fiesta` mix on `@etcito/haa` through the public API. `packages/game/src/audio/gameAudio.ts` plays `fiesta.jump`, `fiesta.dive`, `fiesta.grab`, `fiesta.eliminate` and `fiesta.wobble` from the match state, and keeps the crowd bed on while a round runs. `packages/game/src/audio/context.ts` is the only module that creates an AudioContext; a repo test enforces that.

The browser plays server-baked MP3/Ogg media: `npm run audio:bake` (`tools/bake-audio.ts`) renders all sound banks, music and loops through HAA on the build machine, compresses them and writes `manifest.json` to `apps/web/public/audio` (gitignored). `npm run web:build` runs it first. The play page opens native browser audio on the first gesture and feeds match frames to `GameAudio`. Course emitters share decoded buffers and retain positional gain/pan. Controlled loops blend baked snapshots; no HAA wasm or worklet runs in the browser. Compressed seams and control transitions still need listening checks (see `docs/audio.md`).

## Commands

| command | what it does |
| --- | --- |
| `npm test` | node:test suites under `tools/test`, `packages/*/test` and `apps/headless/test` |
| `npm run typecheck` | one `tsc --noEmit` pass over the whole workspace |
| `npm run audio:bake` | bake the Royal Fiesta sound pack to MP3 strips and `manifest.json` in `apps/web/public/audio` (also run by `web:build`) |
| `npm run guard` | tracked-file guard: no binary or asset in git |
| `npm run bricks -- check` | verify the installed GameSaloon packages; `where <name>` locates a local brick checkout (gamesaloon-public, raa-assets-tools) |
| `npm run smoke` | end-to-end smoke run over the workspace |
| `npm run web:build` | Vite build of every `apps/web/*.html` page into `apps/web/dist/` |

## Cards

Local runner cards and their commands live in `.nmc/commands.json`; judge inputs live under `.nmc/judge/`.

Card commands never pass `--software` and never render on the CPU: a check op, a level thumbnail or a
view render always goes to the Windows GPU client. The local SwiftShader route of `tools/chromeCheck.ts`
is a manual debugging aid only, never a card command or proof; `m13-lobby-unload` (GPU) is the only
lobby-unload command.

A card that adds or changes a GPU check op (`apps/web/src/game/checks/`, registered in `entry.ts`) is not done
when its unit tests pass: it is done when one run of that op on the GPU client against the real saved assets
passes, or when it names the programmatic card whose `.nmc/commands.json` command runs it. Unit tests of
generated WGSL use the real shapes the saved meshes carry (an `SdfmCompiledMaterial`, its RAA registry name
`sdfm.buffer_<hash>`), never a hand-picked identifier: no local WGSL compiler exists, so a fake input hides
text the GPU will refuse.

Every RAA material function stays under RAA's 64 KB source limit (`MATERIAL_FUNCTION_MAX_BYTES`) for every saved
asset, so per-part data never becomes WGSL text: a field program is material data (`addMaterialData`) read by the one
fixed evaluator (`PMF_INTERPRETER_WGSL`), never its saved straight-line `wgsl` (25 KB to over 1 MB on the candy set).
A generator of material WGSL is tested over all `assets/**/*.mesh` (as `fieldShading.test.ts` does), not on a fixture.

`tools/fieldPreflight.ts` lists, in about a second and with no browser, what the `fieldShading` GPU op will report for
every saved part of its world (field, MAMA refusal, atlas demotion, scaled frame, invalid program, material over 64 KB),
through the same pure decisions as `SdfRenderPort`; it exits 1 on a part the GPU op would fail on and runs before the
GPU job in `.nmc/commands.json` `field-render`. A card that adds a GPU check op gives it such a static preflight over
the real saved world, and runs the op once on the GPU client over that world before it is marked done.

## Proofs

Each milestone proof is a Node script run with `--experimental-strip-types`. Proof records are committed under `proofs/mN/`; captures and logs go to the untracked `out/`.

| milestone | proof |
| --- | --- |
| M1 foundations | `node --experimental-strip-types apps/headless/proofs/m1-foundations.ts` |
| M2 obstacles | `node --experimental-strip-types apps/headless/proofs/m2-obstacles.ts` |
| M3 character | `node --experimental-strip-types apps/headless/proofs/m3-character.ts` |
| M4 rounds | `node --experimental-strip-types apps/headless/proofs/m4-rounds.ts` |
| M5 netsim | `node --experimental-strip-types apps/headless/proofs/m5-netsim.ts` |
| M6 transports | `node --experimental-strip-types apps/headless/proofs/m6-transports.ts` |
| M7 web | `node --experimental-strip-types apps/headless/proofs/m7-web.ts` |
| M8 hub | `node --experimental-strip-types apps/headless/proofs/m8-hub.ts` |
| C1 content checks | `node --experimental-strip-types apps/headless/proofs/c1-content-checks.ts` |
| C4 candy courses | `node --experimental-strip-types apps/headless/proofs/c4-candy-courses.ts` — 4 dressed courses, sims kept, race/survival play in sprint |

## Web client (M7)

`npm run web:build` writes `apps/web/dist/`. Serve that folder over http and open `client.html` with these query parameters:

- `mode`: `inpage` (default, N clients on an in-page NetSim), `relay` or `webrtc` (both need `server`), or `ops` (installs `window.nmcGpu.ops` only).
- `clients`: 1..4 (default 4).
- `seed`: match seed (default 1).
- `profile`: `sprint` (default) or `standard`.
- `server`: `ws://host:port/...`, required for `relay` and `webrtc`.
- `pilot`: `1` lets a bot drive the local bean, `0` (default) uses the keyboard.

The `proofs/m7` and `proofs/m8` status records were taken in Node, which has no WebGPU, so RAA reads as absent there and no browser captures exist yet (`proofs/m7/raa-status.json`). A browser run of the same pages replaces the records.

## Play the hub

After `npm run web:build`, open `play.html` from `apps/web/dist/` with these query parameters:

- `server`: `ws://host:port/...` of a GameSaloon relay, required unless `mode=inpage`.
- `hub`: `new` (default, creates a hub and shows its code) or a 4-digit hub code to join.
- `name`: 1..24 characters (default `Bean`).
- `colour`: palette index 0..7 (default random).
- `party`: match size 2..4 (default 4).
- `mode`: `inpage` runs `clients` (2..4, default 4) piloted beans over an in-page loopback relay in a 2x2 grid; `ops` installs `window.nmcGpu.ops` only.

Keys: WASD/arrows move, Space jump, Shift dive, E grab, 1-4 emote. Walk onto the green pad to queue.

## Assets

Assets are never stored in git. They live in the content-addressed asset store (https://assets.etcito.com); the repository keeps only small JSON fixtures. The policy, the store layout and the write-access rules are in [docs/private-assets.md](docs/private-assets.md).

## UI

The menus and the round HUD are drawn by uaa on a WebGPU canvas from `ui/*.ui.json` and `ui/screens.ui-doc.json`. How the assets are authored, previewed and wired, the Fredoka font, and the proof command are in [docs/ui.md](docs/ui.md).

### Runtime game content

The web build contains code and fixture stand-ins. Game assets and courses are fetched
at runtime with revalidation, so reloading after a Modeler save needs no rebuild.
The default content URL is `content/` next to the page. Set `VITE_RF_CONTENT_URL`
when building for another origin, or use `?content=<root URL>` on the page for a
runtime override. Roots may include a trailing slash; CDN origins must allow CORS.

`RF_CONTENT_DIR` selects the disk directory containing `assets/` and `courses/`;
it defaults to the repository root. It can point at a separate content checkout.
Local play serves that directory live under `/content/`, including a fresh index
on every request. Node readers use the same setting. Fixture stand-ins stay in
the game repository.

The content root contains `index.json` with
`{assets: [{id, world, path, hash}], courses: [{id, path}]}`, plus
`assets/<world>/<id>.asset.json` and `courses/<id>.course.json`.
The index hash is the asset file's own hash; mesh caches use that hash so changed
documents mesh again. The Modeler must save a valid document hash.

Run `npm run content:pack -- <out dir>` to copy every indexed file and write the
index for a CDN upload. A plain `npm run build` does not copy content into dist.
Wavedash, Etcito builds and GPU proof publication currently pack content beside
the page; this packaging goes away when the CDN serves it.

Saved game meshes are shipped alongside every `assets/<world>/<id>.asset.json` as
`<id>.mesh` and must be committed together. SDF Modeler's `asset_save_game` writes
both through its Node `writeAssetMesh` path. The web build runs
`node --experimental-strip-types tools/savedMeshes.ts` and lists all missing,
stale, invalid, or incomplete meshes by asset id. Re-save the listed assets in
SDF Modeler before building.

Mesh identity uses the validated document hash, canonical mesher parameters, and
`format:1;algorithm:2`, matching MAMA's `MESH_COMPATIBILITY`. Repository commits
and package releases do not invalidate meshes. Bump the algorithm version when
geometry, normals, skinning, physics part splitting, or compiled material output
changes; bump format for wire encoding or RAA payload schema changes. Update both
contracts and re-save all assets in that change. The loader reports
`browserMeshingJobs`; a complete shipped content set must report zero on a cold
load. Missing saved meshes retain the existing authoring compatibility path.
