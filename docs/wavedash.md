# Wavedash packaging

Ported from V0 M13, on release dependencies: RAA is the `@etcito/raa` release pinned in `apps/web/package.json`,
so there is no RAA build step, no sibling checkout and no alias. The player entry is `game.html` (ARCHITECTURE 1.3).

## Requirements

`docs.wavedash.com` was not reachable from the build sandbox on 2026-10-18 (`CONNECT tunnel failed, response 403`),
so the statements below were not re-fetched live. They were taken from `docs.wavedash.com` on 2026-10-18.

- **R1** A game build is a folder of static files; upload accepts a folder or zip, and an uploaded build can contain up to 1 GB uncompressed. - source: https://docs.wavedash.com/publishing/upload (retrieved 2026-10-18)
- **R2** The default entry point is `index.html`; `wavedash.toml` may set `entrypoint` to an HTML (`.html`/`.htm`) or JavaScript (`.js`) file relative to `upload_dir`. - source: https://docs.wavedash.com/cli/configuration (retrieved 2026-10-18)
- **R3** The host injects the `Wavedash` SDK global; every game must call `Wavedash.init()` once when ready to show, while installing `@wvdsh/sdk-js` is optional. - source: https://docs.wavedash.com/getting-started/quickstart (retrieved 2026-10-18)
- **R4** The uploaded-build limit is 1 GB uncompressed; the public upload documentation gives no per-file or file-count limit. - source: https://docs.wavedash.com/publishing/upload (retrieved 2026-10-18)
- **R5** Developer Portal upload accepts a build folder or zip; CLI flow uses `wavedash build push` then `wavedash publish <BUILD_ID>`, and local SDK testing uses `wavedash dev`; verify the published game at its public game URL. - source: https://docs.wavedash.com/getting-started/quickstart (retrieved 2026-10-18)
- **R6** CLI configuration supports `game_id`, `upload_dir`, and optional `entrypoint` in root `wavedash.toml`; `upload_dir` is relative to the config file. - source: https://docs.wavedash.com/cli/configuration (retrieved 2026-10-18)
- **R7** Wavedash runs games cross-origin isolated and requires external servers contacted by the game to send `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *` on every response; the docs do not specify a `connect-src` CSP policy or enumerate allowed WebSocket/WebRTC destinations. - source: https://docs.wavedash.com/platform/cross-origin-isolation (retrieved 2026-10-18)
- **R8** Published Wavedash games can be embedded in an iframe; the documented embed code uses `https://wavedash.com/embed/games/<slug>` and an `allow` attribute including `autoplay`, `fullscreen`, `gamepad`, `cross-origin-isolated`, `pointer-lock`, and other listed permissions; the embedding page is instructed to keep that attribute. - source: https://docs.wavedash.com/publishing/embed (retrieved 2026-10-18)
- **R9** Wavedash serves the game origin from a subdomain of `builds.wavedashcdn.com`. - source: https://docs.wavedash.com/platform/cross-origin-isolation (retrieved 2026-10-18)
- **R10** The published-game embed example does not document the Wavedash frame's `sandbox` attribute, the frame's response CSP, or a `Permissions-Policy` response header. - source: https://docs.wavedash.com/publishing/embed (retrieved 2026-10-18)

## Build

From a clean clone (README, "Build from a clean clone"):

```
npm ci
npm run wavedash
```

`npm run wavedash` runs `npm run build` (audio bake, then the Vite build into `apps/web/dist`), then packs
`apps/web/dist` with `packWavedash` (tools/wavedash.ts). `-- --skip-build` packs the existing `apps/web/dist`, and
`-- --out <dir>` changes the output folder. Nothing reads or writes a key or token, and nothing is pushed or
published: pushing (R5) is done by the publisher with the Wavedash CLI or the Developer Portal.

## Layout

`npm run wavedash` writes `out/wavedash-build/` (untracked):

- `upload/`: the upload_dir. It is a copy of `apps/web/dist` without `nmc.gpu.json` (the GPU-client declaration)
  and `store/` (a local asset mirror). `game.html` sits at its root next to `assets/`, so its relative `./assets/`
  URLs stay valid. `index.html`, `play.html` and `client.html` stay as built (boot and proof pages).
- `upload/rf-build.json`: the build manifest (below).
- `wavedash.toml`: the CLI configuration (R6):

  ```toml
  upload_dir = "./upload"
  entrypoint = "game.html"
  ```

  It has no `game_id` and no token: the push run sets `game_id` in its own configuration.

`packWavedash` replaces `upload/` on every run and returns the sorted list of files under `upload/` (forward
slashes, `rf-build.json` included) and `entry: 'game.html'`. A dist without `game.html` is refused with
`[bricks] <dist>/game.html: the built game page is missing; run npm run build so apps/web/game.html is built`.

## Build manifest (`upload/rf-build.json`)

```json
{
  "format": "royal-fiesta.build",
  "version": 1,
  "commit": "<40 hex, or null outside a git checkout>",
  "entry": "game.html",
  "raa": "<installed @etcito/raa version, or null>",
  "mama": { "source": "sibling | cloned | absent", "commit": "<40 hex, or null>" }
}
```

`mama` comes from `mamaSource()` (tools/bricks.ts) and keeps only the kind and the commit: never a local path or
a reason that may name one. A public clone without MAMA records `"source": "absent"`; the bundle then refuses only
the SDF content path at runtime (ARCHITECTURE 1.2).

## Networking, iframe embedding, and isolation

The cross-origin-isolation guidance gives required response headers for external servers but does not state a CSP
`connect-src` value, a host allowlist, or whether game-initiated WebSocket connections/WebRTC to third-party hosts
are permitted. Treat those behaviours as **unverified** pending a Wavedash test. The GameSaloon server URL is never
committed: the page takes it from `?server=` (ARCHITECTURE 1.6). Source:
https://docs.wavedash.com/platform/cross-origin-isolation (retrieved 2026-10-18).

The documented iframe example uses a Wavedash embed URL and an `allow` permission list. The documented game-frame
isolation headers are COEP `require-corp` and COOP `same-origin`. Source: https://docs.wavedash.com/publishing/embed
and https://docs.wavedash.com/platform/cross-origin-isolation (retrieved 2026-10-18).

Any other Wavedash requirement not stated in the sourced statements above is **unverified**.

## Loader contract (R3)

Sources: https://docs.wavedash.com/sdk/setup, https://docs.wavedash.com/engines/custom and
https://docs.wavedash.com/cli/configuration (retrieved 2026-10-30).

- The Wavedash shell injects the `Wavedash` global into the frame before the page's code runs, and it keeps the
  frame hidden behind its own loading screen ("Still Loading 0%") until the game calls `Wavedash.init(config)`.
  `init()` is synchronous, returns a boolean, and also calls `loadComplete()`. Without it the game never appears.
- `Wavedash.updateLoadProgressZeroToOne(p)` (0..1, any number of calls) drives the shell's bar.
- A plain HTML build has no engine section in `wavedash.toml` (the frame URL then says `engine=CUSTOM`).
  `entrypoint` may name any `.html` file in `upload_dir`, so `game.html` is valid.

The game page implements the contract in `apps/web/src/platform/wavedash.ts`. `App.load` (apps/web/src/game/main.ts)
reports progress per boot stage and per content phase (`bootFraction`). It calls `init()` once, when the title is
up, or when the error screen or the boot-failure message is up, so a refusal is never hidden behind the shell.
Off Wavedash there is no global and every call is a no-op. A throwing SDK is logged and never stops the game.

Observed on the real frame (2026-10-30, Chrome, playtest pages of build bc44ed8a and of a working V0 build): the
game runs inside the shell's `/embed?entrypoint=<entry>&engine=CUSTOM&pk=...&sdkconfig=...&gameSlug=...`
document itself, so `location.search` is that embed query. Every file of the bundle was served 200, and the 15d9352
build reached its title screen when that frame URL was opened at top level, but `Wavedash._initialized` stayed
`false`, so the playtest page stayed on 0%. The working V0 build (commit 2950b88, `platform/wavedash.ts`) calls
`init()` and shows the game. The V0 M13 port (abdd4a6) took over the packager but not that adapter.

Each boot stage is logged as `[boot] +<s>s <stage>`. A stage that lasts more than 10 s is named under the page's
loading bar (`Still on: <stage> (<n> s)`), so a stuck boot says where it is.

## Frame probe

Off by default. `?probe=1`, or a build made with `VITE_RF_PROBE=1` (the Wavedash page cannot carry a query into its
frame; `?probe=0` still turns it off), runs `apps/web/src/platform/probe.ts` next to the game. It calls
`Wavedash.init()` at once so its panel is visible even if the boot stalls, then reports to the console
(`[probe] <item> <json>`) and to a panel in the top-left corner:

- `env`: origin, query keys, framed or not, `crossOriginIsolated`, `SharedArrayBuffer`, WebGPU, the SDK's launch
  parameter keys;
- `headers`: the page's own CSP, COEP, COOP, CORP and Permissions-Policy response headers;
- `storage`: localStorage and indexedDB.open;
- `websocket-1`, `websocket-2`: `wss://echo.websocket.events` and `wss://ws.postman-echo.com/raw` (open, echo, or
  error). The first did not answer anywhere on 2026-10-30, so only the second tells whether the frame allows sockets;
- `webrtc`: ICE gathering with `stun:stun.l.google.com:19302` (an `srflx` candidate means STUN is reachable);
- `fetch-cors` (`https://api.github.com/zen`) and `fetch-no-cors` (`https://www.google.com/favicon.ico`, which COEP
  blocks unless the host sends CORP);
- `csp-violation`: every `securitypolicyviolation` event.

On the real frame, the probe runs either from a build made with `VITE_RF_PROBE=1` inside the playtest page, or
from any build by opening the frame URL at top level with `&probe=1` appended.

## Relay URL in the frame

The GameSaloon server URL is never committed, and the Wavedash page cannot carry `?server=` into its frame. What
the frame can carry:

- The frame URL opened at top level: the game reads the embed query, so `&server=wss://...` appended to the frame
  URL reaches `parseQuery` (useful for tests only, since players open the Wavedash page).
- A build-time default, like `VITE_RF_CONTENT_URL`: `VITE_RF_SERVER=wss://host/ws`, set in the ENVIRONMENT of the
  build that is pushed (`npm run wavedash` and `npm run etcito:build` pass their environment down to `vite build`;
  Vite injects it and apps/web/src/platform/relay.ts reads it). Never put it in a file of the repository. The value
  ends up in the built JavaScript, so it is a public relay URL and no token belongs in it. A malformed value (not
  ws:// or wss://) is refused when Play online is chosen.
  - Order: an explicit `?server=` first, then the build default. An explicit `?server=` keeps its behaviour (the
    whole page is online: `parseQuery` then `OnlineMode`). The build default feeds ONLY the title's Play online (the
    online lobby flow, PlayFlow with `matchmaking: 'lobby'`): the page still boots in-page, Play stays offline with
    bots, and leaving the online hub returns to the title where Play is offline again.
  - With neither, Play online shows the refusal "Play online needs a relay; pass ?server=wss://host/... or choose
    Play to play with bots" and does not hang.
  - `rf-build.json` records only `defaultServer` (a boolean: a default relay was set), never the URL.
  - Example, placeholder host: `VITE_RF_SERVER=wss://relay.example.invalid/ws npm run wavedash`.
- `Wavedash.getLaunchParams()` exists in the frame and returned no keys for the playtest build; the docs read on
  2026-10-30 do not say how launch parameters are set.

## Pointer lock in the frame

V0 M14 emulated the Wavedash frame locally (the game inside an iframe of an embedder on another origin, with the
documented COEP/COOP headers) for two sandbox variants, `allow-scripts allow-same-origin allow-pointer-lock` and
`allow-scripts allow-same-origin`. Neither variant produced a result: the probe could not reach the iframe target
through CDP, so the local emulation says nothing about pointer lock in a sandboxed frame. The same build at top
level (not framed) did get the lock.

The real Wavedash frame has not been probed. If pointer lock does not work in the Wavedash frame, the mouse camera
does not work in the frame and there is NO fallback (owner decision: no drag-to-orbit); the right stick still turns
the camera. See [controls.md](controls.md).

Game data is not part of the web build. The packager adds `upload/content/` using
the shared content packer: `index.json`, `assets/<world>/<id>.asset.json` and
`courses/<id>.course.json`. `RF_CONTENT_DIR` chooses the source directory and
defaults to the repository root. This bundle copy goes away when the CDN serves
content. Use `VITE_RF_CONTENT_URL` at build time for that CDN, or the page's
`content` query parameter for a runtime root override. See README for the layout.
