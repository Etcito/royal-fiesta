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

You need Node.js 22.18 or newer and git. No sibling folder is needed: the GameSaloon rollback packages, the HAA sound engine and the RAA renderer are installed from their GitHub releases.

```
git clone https://github.com/Etcito/royal-fiesta.git
cd royal-fiesta
npm install            # the release tarballs of @gamesaloon/rollback, @gamesaloon/rollback-rapier, @etcito/haa and @etcito/raa
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

The browser plays it from a bake made at build time: `npm run audio:bake` (`tools/bake-audio.ts`, HAA's `bake` API) writes the MP3 strips, `manifest.json` and HAA's worklet into `apps/web/public/audio` (gitignored); `npm run web:build` runs it first. The online play page (`apps/web/src/play/sound.ts`) opens the engine on the first click or key press and feeds each match frame to `GameAudio`. The crowd bed is not a HAA bed (HAA's prebuilt worklet does not know it): it is the pack's `CrowdModel` in its own worklet (`apps/web/src/audio/fiestaWorklet.ts`), which `openBrowserAudio` (`packages/game/src/audio/context.ts`) loads. Nobody has heard the result yet: the checks are the bake, the manifest coverage, the bed rendering and the scripted-match tests.

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
