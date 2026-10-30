I have what I need. One file in the final code wasn't in the contract, `packages/game/src/hub/hubPilot.ts` (used by `PlayFlow`), so I've added it to the `play-flow` module. In the repo, `proofs/m7/` and `proofs/m8/` hold only `raa-status.json` (RAA absent).

```markdown
# Royal Fiesta architecture

Royal Fiesta is an open-source, networked, real-time 3D party game for the browser: Fall Guys-style rounds and eliminations, and a walkable 3D hub in the style of Fortnite. It also ships headless Node clients and proofs. The repository `royal-fiesta` holds the deterministic simulation, the shared game layer, the Node apps and the Vite web pages. It consumes the GameSaloon rollback packages, `@etcito/haa` and `@etcito/raa` as built release tarballs, installed like any dependency. gamesaloon-public is an optional local checkout (1.2).

## 1. Conventions (every module follows these)

### 1.1 Runtime and language
- Node >= 22.18. TypeScript `.ts` source runs directly with `node --experimental-strip-types <file.ts>`.
- Erasable syntax only (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties, no `import =`. Enumerations are `as const` objects plus a derived union type.
- Imports carry the `.ts` extension. ESM only (`"type": "module"`).
- Typecheck: `npm run typecheck` is ONE pass of `tsc --noEmit -p tsconfig.json` over the whole repo.
  - The root tsconfig includes `tools`, `packages/*/src`, `packages/*/test`, `apps/*/src`, `apps/*/test`, `apps/*/proofs` and `apps/web/vite.config.ts`.
  - Compiler options: target ES2022, module ESNext, moduleResolution Bundler, strict, noEmit, allowImportingTsExtensions, verbatimModuleSyntax, erasableSyntaxOnly, skipLibCheck, lib [ES2022, DOM, DOM.Iterable], types [node].
  - Each workspace package also has a `typecheck` script (`tsc --noEmit -p .`).
- Tests: `npm test` runs `node --experimental-strip-types --test "tools/test/*.test.ts" "packages/*/test/*.test.ts" "apps/headless/test/*.test.ts"` with node:test and node:assert/strict.
  - A test file is `<subject>.test.ts` in the `test/` folder of the package it tests.
  - Tests never need network, a GPU, a browser or a running GameSaloon server. Those belong in proofs.
- Style:
  - 2-space indent, single quotes, no semicolons, named exports only.
  - The only default export is `apps/web/vite.config.ts`.
  - Comments are short and say why.
- Web: Vite, with the exact version pinned in package-lock. `npm run web:build` builds every `apps/web/*.html` page into `apps/web/dist/`.

### 1.2 Dependencies and bricks
- Bricks are never patched in this repository. A gap goes to `docs/brick-gaps.md` (rollback, raa, raa-assets-tools) or `docs/gamesaloon-gaps.md` (GameSaloon).
- Released bricks are installed from GitHub release tarballs, pinned in `package.json` and `kong.rules`:
  - `@gamesaloon/rollback` = `https://github.com/Etcito/gamesaloon-rollback/releases/download/v0.1.0/gamesaloon-rollback-0.1.0.tgz`;
  - `@gamesaloon/rollback-rapier` = `.../gamesaloon-rollback-rapier-0.1.0.tgz`, with `@dimforge/rapier3d-deterministic-compat` 0.21.0 declared explicitly in every workspace that uses Rapier;
  - `@etcito/haa` = `https://github.com/Etcito/haa/releases/download/v0.1.1/etcito-haa-0.1.1.tgz` (the generic sound engine; the Royal Fiesta pack is game content in `packages/game/src/audio/pack`);
  - `@etcito/raa` = `https://github.com/Etcito/raa/releases/download/v0.1.1/etcito-raa-0.1.1.tgz` (apps/web only: the WebGPU renderer with its WASM; the browser client imports it directly).
- The release packages ship built JavaScript in `dist/` with declarations, so no brick needs `.ts` stripping under `node_modules`.
- gamesaloon-public (the GameSaloon server) is the only brick located by directory (`GAMESALOON_DIR`, `$RF_BRICKS_DIR/gamesaloon-public`, or a sibling folder) for the optional local-server test, which is skipped when it is absent.
- `tools/bricks.ts` has two commands: `check` verifies that the released packages resolve and that the Rapier WASM initialises; `where <name>` prints a local brick directory.
- Install from the repository root: `npm install`, or `kong rules` then `kong use kong.rules` (README, "Build from a clean clone").

- Brick facts the code relies on:
  - `SnapWriter`/`SnapReader` have no blob method; `SnapWriter.bytes()` returns the written view. The game writes blobs as a u32 length plus u32 words (`writeBlob`/`readBlob` in sim/world).
  - `RollbackSession.frame(frameDt, sampleLocal)` returns the interpolation alpha.
  - `confirmedHash(tick)` reads a 128-entry ring.
  - `smoother` exists only when the Simulation has `view`.
  - The session ignores `RegionHints`.
  - The GameSaloon relay caps rooms at 4 seats (`MAX_PLAYERS = 4` in src/relay/protocol.ts) and accepts JSON text only, at most 4 KiB per message.
  - Relay rates are 20 msg/s per socket, or 90/s and 4000/min for cadence seats after `matched`. Every client frame (create, join, act, ping, bye) counts, over a sliding 60 s window, with a cap of 400/min for non-cadence sockets. Private create/join rooms never get cadence.
  - The rooms protocol (8 peers) only forwards WebRTC signaling and never relays game data.

### 1.3 Layout
- `packages/sim` (`@royal-fiesta/sim`): the deterministic simulation only, i.e. everything inside the rollback snapshot (world, systems, characters, obstacles, rounds, bots).
  - It is pure: no DOM, no Node API, no clock, no I/O, no async.
- `packages/game` (`@royal-fiesta/game`): everything outside the snapshot that the apps share.
  - Contents: data loading (prims, assets, courses); network (session wiring, transports, GameSaloon clients, loopback relay); the render port and scene view; the client core; the hub.
  - No Node-only module (`node:fs`, `node:child_process`, `node:net`).
  - Browser and Node globals (WebSocket, fetch, crypto.subtle, RTCPeerConnection) are reached only through injected factories or at call time, never at import time.
- `apps/headless` (`@royal-fiesta/headless`): Node CLIs (`src/`), proof scripts (`proofs/mN-<name>.ts`), and Node-only adapters (fs sources, node-datachannel, spawning GameSaloon).
- `apps/web` (`@royal-fiesta/web`): Vite pages. The `*.html` files sit at the apps/web root, the code in `src/`, plus `public/nmc.gpu.json`.
- `fixtures/`: small JSON only.
  - `assets/<name>.prims.json`;
  - `courses/<id>.course.json`, with `courses/invalid/` for refusal tests;
  - `golden/<name>.json`.
- `docs/`: markdown.
- `proofs/mN/`: committed proof records (JSON only).
- `out/`: untracked proof outputs such as logs and PNG captures (gitignored, like `*.png`).
- Packages export subpaths through one wildcard: `"exports": { "./*": "./src/*.ts" }`.
  - Imports look like `import { FiestaWorld } from '@royal-fiesta/sim/world'`.
  - There are no barrel/index files.
- Dependency direction is sim <- game <- apps. sim never imports game, and game never imports apps.

### 1.4 Module ownership and shared files
- A module's files belong to its owner milestone. A later milestone adds new modules that consume earlier ones and never rewrites another milestone's module. The only exception is a minimal defect fix that the milestone lead explicitly authorizes.
- Shared manifests are additive. Any milestone may ADD entries to:
  - package.json scripts and dependencies;
  - tsconfig include lists;
  - `.gitignore` lines;
  - README sections;
  Existing entries are never removed or changed.

### 1.5 Determinism (sim scope = packages/sim/src)
- Allowed float operations: `+ - * /`, Math.sqrt, Math.abs, Math.floor, Math.ceil, Math.round, Math.trunc, Math.min, Math.max, Math.sign, Math.imul, Math.clz32.
- Trig, exp, log and pow come only from `@royal-fiesta/sim/detmath`.
- Forbidden in sim: Math.sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/pow/exp/expm1/log/log2/log10/log1p/hypot/cbrt/fround/random, Date, performance, setTimeout/setInterval, crypto, `for...in`. The purity test enforces this list.
- Never iterate a Map/Set built from unordered data: iterate arrays by index.
- RNG: only `Rng` from `@gamesaloon/rollback`, with its `state` in the snapshot. Each consumer (match course picks, each bot) gets its own stream, derived once with `rng.fork(salt)`.
- Everything that `step()` reads or writes is in the snapshot (S5).
- Rapier rules (docs/RAPIER.md):
  - create and remove bodies only in `init` or inside a step, in a fixed order;
  - apply inputs in ascending player index before the physics step;
  - never keep RigidBody/Collider objects across ticks, keep BodyIds;
  - read collision queries inside the tick that uses them;
  - no EventQueue.
- State is organised by entity and by region.
  - Per-player and per-obstacle structure-of-arrays are indexed by player or obstacle index.
  - Course regions are exposed as `RegionHints`, so an interest-managed (zone/proximity) rollback can come later.
- Obstacle motion is a deterministic function of the round-local tick. The see-saw is the one exception: it follows its own snapshotted 1-DOF state. There is no per-frame randomness anywhere.
- View, render, hub and network code may use any Math, but never writes sim state and never uses the sim RNG.

### 1.6 Units and fixed values
- Sim units are metres, seconds and radians.
  - Degrees appear only in JSON and are converted at load with detmath (`degToRad`).
  - Y is up. Courses run along +Z, from a start near z = 0 to a finish at larger z.
  - +X is to the right when looking along +Z.
- TICK_RATE = 60 and FIXED_DT = 1/60, both from `@gamesaloon/rollback-rapier`. Gravity is (0, -20, 0) m/s² (`GRAVITY_Y`).
- Players per match:
  - 1..8 characters per match (`MAX_PLAYERS = 8`).
  - Networked matches always use playerCount 8.
  - Humans are players 0..humanPeers-1 (player index = peer rank). The rest are bots.
- Rollback tuning is `FIESTA_TUNING` (game/net/tuning): tickRate 60, maxSubsteps 8, maxPrediction 16, snapshotRing 40, minDelay 2, maxDelay 2, delayHiddenTicks 6, lostAfterMs 3000, dropWaitMs 1500.
  - Input-to-screen latency = input delay + 1 rendered tick = 3 ticks.
- Collision groups (sim/groups): STATIC 0x0001, MOVING 0x0002, CHAR 0x0004, DEBRIS 0x0008, PROBE 0x0010. Group word = (membership << 16) | filter.
- Character palette (game/render/palette): player i uses PALETTE[i].

  | i | name | RGB |
  |---|---|---|
  | 0 | pink | [1, 0.42, 0.62] |
  | 1 | sky | [0.33, 0.73, 1] |
  | 2 | yellow | [1, 0.82, 0.25] |
  | 3 | green | [0.45, 0.85, 0.4] |
  | 4 | purple | [0.7, 0.5, 1] |
  | 5 | orange | [1, 0.55, 0.25] |
  | 6 | teal | [0.3, 0.9, 0.85] |
  | 7 | white | [0.95, 0.95, 0.95] |

- Render framing:
  - Captures are 1920x1080.
  - A 4-client capture is a 2x2 grid of 960x540 viewports, with client k at column k%2 and row floor(k/2).
- Camera:
  - vertical FOV 60°, near 0.1, far 500;
  - eye = player + facing*(-7) + (0,4,0), target = player + (0,1.2,0);
  - view-side exponential follow at rate 8/s.
- Hub:
  - state broadcast at 5 Hz in the hub and 1 Hz during a match, hello every 5 s;
  - at most 360 hub-socket frames per sliding minute and 10 per second;
  - remote render delay 300 ms, extrapolation at most 200 ms;
  - queue-pad dwell 90 frames;
  - party size defaults to 4 (the relay maximum), configurable 2..4.
- Match profiles are `standard` and `sprint` (values in sim/match/setup). Networked proofs and in-page captures use `sprint`.
- GameSaloon ids:
  - rooms `game` = `royal-fiesta-1`;
  - relay queue payload = `{ "g": "royal-fiesta", "v": 1, "name": <string>, "c": <colour index> }`.

### 1.7 Errors and refusals
- Invalid data or an impossible request throws `RefusalError` (sim/refusal).
  - Message format: `[area] path: what is wrong; the fix`.
  - The path is the file and the JSON path, e.g. `fixtures/courses/race-sprint.course.json#/obstacles/3/motion/periodS`.
- Never NaN, never a silent default for a required field, never a silent skip.
- CLIs and proofs print the message and exit 1.

### 1.8 Data on disk
- JSON is UTF-8, 2-space indented, with a trailing newline.
- Numbers are written with JSON.stringify: shortest round-trip, exact for f64.
- Golden files carry their exact regeneration command in a `"regenerate"` field. Courses and assets follow the formats in section 2.

### 1.9 Git guard (no binary or asset in git)
- `tools/guard.ts` holds the rules.
- `.githooks/pre-commit` runs it on staged files. The `prepare` script sets `core.hooksPath`.
- `npm run guard` checks tracked files, and the project smoke runs it.
- `docs/private-assets.md` explains the policy: assets live in the content-addressed store, and fixtures are small JSON only.

### 1.10 Proofs
- Each milestone proof is `apps/headless/proofs/mN-<name>.ts`, built on `@royal-fiesta/headless/proofkit`.
- Flags:
  - `--only <regex>` runs only the checks whose label matches.
  - `--quick` is the default: the cheap subset that still guards the milestone.
  - `--full` runs everything.
  - `--write-golden` regenerates a golden, where the proof has one.
- Output:
  - Each check prints `[label] value=<measured> threshold=<threshold> PASS|FAIL`.
  - The proof exits non-zero at the first failure of the selected set.
  - Numbers reported without a threshold print as `[report:<label>] k=v ...`.
- At most 5 checks per proof. Never split one behaviour into several checks, and never add a check to reach a number.
- Independent cases run in parallel child processes, up to `NMC_CPUS` (1 when unset) and never above.
- A timing check exists only for the 16.7 ms frame (60 fps). It runs first and alone.
- Wall budget: a proof's default mode runs in at most 3 minutes. Pay one Rapier init per process and cache course loads. Never lower a threshold to meet the budget.
- A milestone closeout runs its build, its OWN proof and the project smoke. Earlier proofs stay runnable on demand only.
- Captures are review artefacts. The only check is "it rendered, it is not empty".
- GPU: the project GPU is off, so there is never a Node WebGPU proof. Browser captures go through the client GPU:
  - `apps/web/public/nmc.gpu.json` is copied into `apps/web/dist`, and the page exposes `window.nmcGpu.ops`;
  - the card runs `node "$NMC_GPU_CLIENT" publish apps/web/dist/`, then `node "$NMC_GPU_CLIENT" render <input.json> --page-ref REF -o out/mN/`;
  - the JSON results are committed under `proofs/mN/`, and the PNGs stay in `out/`;
  - never launch Linux Chrome in the sandbox and never print tokens;
  - no GPU client means a visible wait, not a substitute.
- The GPU browser cannot reach a server in the sandbox.
  - In-browser multi-client runs use in-page NetSim (match) or LoopbackRelay (hub).
  - Runs against the real GameSaloon are headless Node clients talking to a local server started from `brickDir('gamesaloon-public')`.

### 1.11 Quality bar
Each criterion is controlled by a command or reviewed by the owner on a capture.

- **QB1 Determinism.**
  - Criterion:
    - two simulations fed the same inputs produce bit-identical snapshot bytes;
    - restore + resimulation equals the uninterrupted run;
    - every networked peer has identical confirmed hashes at every confirmed tick.
  - Command: M1 (5000 ticks, 8 characters), M2, M3, M4 (two runs + forced rollback), M5 (NetSim 2/4/8), M6 (relay 4, WebRTC 4 and 8) and M8 (hub loop match). Mismatches must be 0.
- **QB2 Steady 60 fps at 1080p with 8 characters and 40 obstacles.**
  - Sim side (M5, timing check run alone): p99 of `stats.lastFrameSimMs` <= 16.7 ms for 8 peers at 100 ms RTT.
  - Render side (M7, only when RAA API v0 exists): browser frame time p95 <= 16.7 ms over 600 frames at 1920x1080 in the GPU browser.
- **QB3 Smoothed corrections, no visible snapping under 100 ms RTT.**
  - Command (M5): the displayed (smoothed) position of any character moves at most 0.5 m in one rendered frame, excluding teleports (`teleportTick` within 2 ticks). Visible snaps must be 0.
  - Review (M7, M8): "do remote beans move without pops or jitter?"
- **QB4 Input-to-screen latency <= 3 ticks.** Command (M5): max session input delay + 1 <= 3 in every NetSim case.
- **QB5 Every round type plays through to the podium.** Command:
  - M4: 8 bots, race and survival rounds, final, podium, winner;
  - M5/M6: networked sprint matches reach `done` with the same winner on every peer;
  - M8: the hub -> match -> podium -> hub loop for 4 clients.
- **QB6 Party look and feel.** Review on the M7/M8 captures, yes/no for each item:
  - jelly-bean characters with faces;
  - obstacles visibly move;
  - the HUD shows round type, timer and qualified count;
  - the podium shows the winner on top;
  - the hub shows the other players walking and emoting.
- **QB7 Refusals are messages.** Command (M2: invalid courses/assets; M6: an 8-seat relay request): each yields a `RefusalError` naming the file/field and the fix.
- **QB8 No asset in git.** Command (smoke, every milestone): `tools/guard.ts` reports 0 violations over tracked files.
- **QB9 Honest numbers.** Command (M3, M5, M6): cost per tick, snapshot bytes, rollback ms per frame and resim counts are printed as `[report:...]` lines from real measurements, with machine and mode.

## 2. Shared data shapes and formats

### S1. PlayerInput wire code (u32), sim/input
Bit layout:
- bits 0-7: moveX, quantised q = round(clamp(x,-1,1)*127)+127 (range 0..254, 127 = centre). Decode: (min(q,254)-127)/127.
- bits 8-15: moveZ, same quantisation (+Z = forward along the course).
- bit 16: jump held. bit 17: dive held. bit 18: grab held.
- bits 19-31: 0 on encode, ignored on decode.

Rules:
- `NEUTRAL_CODE = 127 | (127 << 8) = 32639`.
- Direction is world-space: the client rotates its stick by the camera before encoding.
- The controller normalises (x,z) when its length is above 1.
- Button presses are detected in the sim against the previous tick's held bits, which are stored in the snapshot.

### S2. Course JSON v0 (`fixtures/courses/<id>.course.json`), game/course
```
{ "format": "royal-fiesta.course", "version": 0,
  "id": "race-sprint",            // ^[a-z0-9-]{1,40}$, equals the file stem
  "name": "Sprint Dash",
  "kind": "race",                 // race | survival | hub | gallery
  "profiles": ["standard", "sprint"],   // match profiles that may pick it (race/survival)
  "assetsManifest": null,         // null = fixtures/assets; or the sha256 hex of a store manifest
  "timeLimitS": 120,              // round cap before the profile cap
  "killPlaneY": -12,
  "spawns": [ { "t": [x,y,z], "yawDeg": 0 } ],   // >= 8 for race/survival/gallery, >= 1 for hub; yaw 0 faces +Z
  "checkpoints": [ { "center": [x,y,z], "half": [x,y,z], "respawn": { "t": [x,y,z], "yawDeg": 0 } } ],  // ordered
  "finish": { "center": [x,y,z], "half": [x,y,z] },  // required for race, null otherwise
  "path": [ { "p": [x,y,z], "jump": false, "dive": false } ],   // bot waypoints (race: spawn->finish; survival: safe spots)
  "regions": [ { "id": 0, "center": [x,y,z], "half": [x,y,z], "adjacent": [1] } ],
  "queuePad": null,               // hub only: { "center", "half" }
  "obstacles": [ { "id": "spin-1", "asset": "spinner-bar", "t": [x,y,z], "r": [x,y,z,w], "s": [1,1,1],
                   "friction": 0, "motion": { "kind": "spinner", ... }, "colliders": null } ] }
```

Motion objects. Angles are in degrees and times in seconds. The loader converts them to radians and to integer ticks (round(s*60), >= 1).
- `{"kind":"static"}`
- `{"kind":"spinner","axis":[0,1,0],"speedDegS":90,"phaseDeg":0}`
- `{"kind":"pendulum","pivot":[x,y,z],"axis":[1,0,0],"ampDeg":60,"periodS":3,"phaseDeg":0}`
- `{"kind":"seesaw","axis":[1,0,0],"maxDeg":20,"spring":800,"damping":300,"inertia":900}`
- `{"kind":"rotatingDoor","axis":[0,1,0],"stepDeg":90,"periodS":2,"moveS":0.5,"phaseS":0}`
- `{"kind":"conveyor","velocity":[0,0,-3]}`
- `{"kind":"bouncePad","speed":14}`
- `{"kind":"movingPlatform","offset":[4,0,0],"periodS":4,"phaseDeg":0,"wave":"sine"}` (`sine` or `pingpong`)

Validation:
- Axes must be unit length within 1e-6. Quaternions must have norm within 1e-6 of 1.
- Scale:
  - `s` applies to the colliders.
  - Non-uniform `s` is allowed only when every collider is cuboid or roundCuboid. Otherwise `s` must be uniform, or the course is refused.
- `colliders` (when not null) overrides the asset's collision list and uses the course collider JSON (flat shape fields, see S3 "Course colliders").
- Caps: <= 96 obstacles and <= 8 colliders per obstacle. Obstacle ids are unique. Asset names match ^[a-z0-9-]{1,48}$.
- Refused with a message:
  - an unknown kind;
  - a trimesh/convexHull/heightfield/polyline shape ("primitive colliders only: the kart study measured 1.25 MB / 12 ms per snapshot for a trimesh track");
  - a race without finish;
  - too few spawns;
  - non-finite numbers.

### S3. Primitive asset subset (raa.prims v0), game/prims
Fields read:
- `format` ("raa.prims"), `version` (0), `id`, `name`;
- `nodes[]` with `id`, `kind`, `params`, `transform {t,r,s}`, `material`, `op`, `children`;
- `materials`, `anchors`, optional `budget` (default 1500), and `collision`.

Validator caps: <= 64 nodes in total, depth <= 8, finite numbers.

Param names: the published raa.prims v0 names (raa-assets-tools 0.1.0 schema, read by @etcito/raa 0.1.1):
- sphere {radius}
- box {size:[x,y,z]}
- roundBox {size, radius}
- capsule {radius, height} (height = cylinder part, Y axis)
- cylinder {radius, height}
- cone {height, radiusBottom, radiusTop} (apex up when radiusTop is 0)
- torus {majorRadius, minorRadius}
- ellipsoid {radii:[x,y,z]}

`collision` = `{ "mode": "override" | "derived", "colliders": [ColliderJson] }`. ColliderJson is `{"node": null | nodeId, "shape", "params", "t", "r"}` with one of:
- `{"shape":"cuboid","params":{"halfExtents":[x,y,z]}}`
- `{"shape":"roundCuboid","params":{"halfExtents":[...],"borderRadius":b}}`
- `{"shape":"ball","params":{"radius":r}}`
- `{"shape":"capsule","params":{"halfHeight":h,"radius":r}}`
- `{"shape":"cylinder","params":{"halfHeight":h,"radius":r}}`
- `{"shape":"cone","params":{"halfHeight":h,"radius":r}}`

Each has a local `"t":[x,y,z]` and `"r":[x,y,z,w]`. Y-axis shapes follow Rapier's conventions.

Course colliders (a course's `obstacles[].colliders`, the sim's own form, not raa.prims): flat fields, `{"shape":"cuboid","half":[x,y,z]}`, `roundCuboid` with `half` and `border`, `ball`/`capsule`/`cylinder`/`cone` with `radius` and `halfHeight`, each with optional `t` and `r`.

Derivation when `collision` is absent. Every `op: union` node, including descendants (transforms composed), maps as:
- box -> cuboid(size/2 * s)
- roundBox -> roundCuboid(size/2 * s - radius, border = radius)
- sphere -> ball
- capsule -> capsule(halfHeight = height/2)
- cylinder -> cylinder
- cone -> cone

Refusals:
- subtract/intersect nodes are ignored for collision;
- torus or ellipsoid without an override is refused ("no Rapier primitive for <kind>: add collision.colliders");
- non-uniform node scale on ball/capsule/cylinder/cone is refused.

### S4. Asset store manifest and URLs
- Object URL: `https://assets.etcito.com/objects/<first 2 hex of sha256>/<sha256>`.
- Manifest (itself an object, fetched by its hash): `{ "format": "raa.manifest", "version": 0, "entries": { "<logical name>": { "sha256": "<64 hex>", "size": <bytes>, "type": "application/vnd.raa.prims+json", "version": <int> } } }`. This shape is assumed until raa-assets-tools publishes it.
- Every fetched object is verified (sha256 and size) and refused on mismatch.
- Until assets exist, courses use `"assetsManifest": null` and the resolver reads `fixtures/assets/<name>.prims.json`.
- The game never writes to the store. Write access belongs to the raa-assets-tools CLI.

### S5. FiestaWorld snapshot layout (sim/world)
`u32 magic 0x52465731 ('RFW1') | u32 version 1 | u32 playerCount | u32 systemCount | system sections in registration order | blob(RapierWorldSim.takeSnapshot())`

- blob = `u32 byteLength | ceil(len/4) u32 little-endian words` (the last word is zero-padded).
- The tick lives in the Rapier snapshot header.
- The desync hash is fnv1a32 of the full snapshot bytes. FiestaWorld does not implement `Simulation.hash`, so the session hashes the snapshot.
- System order of a match (pre and post): `match`, `bots`, `obstacles`, `characters`, `round`.

### S6. Match log JSON (sim/match/log; CLIs write it to out/)
```
{ "format": "royal-fiesta.matchlog", "version": 0, "seed": 123, "profile": "sprint", "playerCount": 8,
  "humans": [true,false,...], "setupHash": "0a1b2c3d",
  "rounds": [ { "index": 0, "kind": "race", "final": false, "course": "race-sprint", "startTick": 60, "endTick": 1260,
                "participants": [0,1,2,3,4,5,6,7], "target": 5, "qualified": [3,0,6,1,2], "eliminated": [4,5,7],
                "reason": "target" } ],     // target | timeCap | lastStanding | allFell
  "winner": 3, "podium": [3,0,6], "finalTick": 4321, "finalHash": "89abcdef" }
```
- `qualified` is in finish (race) or survival order. `eliminated` is in elimination order.
- `finalHash` = hex8 of the snapshot hash at `finalTick`, the tick at which phase `done` is entered.

### S7. RB1: rollback packets over the GameSaloon relay (game/net/relayTransport)
One relay `act` carries `a = { "k": "rb", "m": [ [toMask, ch, "<base64>"], ... ] }`:
- `toMask` is a bitmask of destination seats (bit = seat index = rollback peer id);
- `ch` is 0 for `fast` and 1 for `reliable`;
- the base64 string is one NetTransport packet.

Sender rules:
- Entries with identical (ch, bytes) to several peers merge into one mask.
- Each act stays <= 3800 bytes of JSON and <= 500 entries.
- A packet that does not fit in one act on its own is sent alone as `{ "k": "rbf", "id": u32, "i": part, "n": parts, "to": mask, "ch": c, "d": "<base64 chunk>" }` fragments.
- Flushes happen every 2 rendered frames (30 Hz).
- Rate budget per socket: <= 60 acts per rolling second and <= 3900 per rolling minute. Over budget, the oldest fast packets are dropped (counted) and reliable packets wait.

Receiver rules:
- The relay sends to every other seat, so the receiver keeps only entries whose mask has its own bit.
- A peer is closed after `player_left`/`opp_left` for its seat, or when the socket closes.

### S8. GameSaloon usage by the game
- **Relay match (2..4 humans).**
  - Every client sends `{t:'queue', players:N, cadence:true, payload:{g:'royal-fiesta', v:1, name, c}}` on a dedicated socket.
  - On `matched`: seat = `youAre` = rollback peer = player index, and seed = `matched.seed`.
  - If any `opps[i]` payload is not `{g:'royal-fiesta', v:1}`, the client refuses ("matched with a non-Royal-Fiesta client"), sends `bye` and re-queues.
  - N > 4 is refused client-side, because the server would silently ignore it.
- **WebRTC match (2..8 humans).**
  - Rooms protocol on `/ws` with `hello {v:1, game:'royal-fiesta-1', name}`.
  - Then `create`/`join` by code, with players `[{name, build:{characterId:'bean', bodyId:'c<colour>', wheelId:'none', gliderId:'none'}}]`.
  - The owner sends `start`. On `started`, the members sorted by peer give player index = rank, and rollback peer = rooms peer id.
- **WebRTC mesh.**
  - The lower peer id makes the offer.
  - Its two data channels carry binary messages: `fast` {ordered:false, maxRetransmits:0} and `reliable` {ordered:true}.
  - Signaling uses `signal` data `{kind:'offer'|'answer', sdp}` / `{kind:'ice', candidate, sdpMid, sdpMLineIndex}` / `{kind:'ice-end'}`.
  - ICE servers come from `welcome.iceServers` unless overridden; loopback proofs pass `[]`.
- **Hub.**
  - A relay private room, `create {players:4}` / `join {code}`. Acts flow to the occupied seats before the room is full.
  - The hub socket stays open while its player is in a match. It is non-cadence, so it obeys the hub frame budget (1.6).

### S9. Hub act payloads (game/hub/protocol)
- `{ "k": "hi", "v": 1, "name": "Bean", "c": 2 }`: sent on join, to newly seen seats, and every 5 s.
- `{ "k": "st", "s": seq, "p": [xcm, ycm, zcm], "f": facing 0..255, "m": CharMode, "e": emote 0..4, "q": 0|1, "x": 0|1 }`:
  - sent at 5 Hz in the hub and at 1 Hz during a match (`x` = 1);
  - integers only.

Encoding and validation:
- Facing byte = `round(atan2(fx,fz)/TAU*256) & 255`, computed view-side.
- Emotes: 0 none, 1 wave, 2 dance, 3 cheer, 4 laugh. Each lasts 2 s.
- Malformed acts are dropped and counted.

### S10. Proof records (committed, JSON)
- `proofs/mN/raa-status.json`: `{ "available": bool, "raaDir": string|null, "reason": string, "apiVersion": string|null, "checkedAt": ISO date }`.
- `proofs/mN/captures.json` (only when RAA is available): `{ "renderer": "raa", "adapter": string, "software": bool, "pageRef": string, "captures": [ { "name", "width", "height", "sha256", "bytes", "nonEmpty": bool } ], "frameTiming": { "width":1920, "height":1080, "frames":600, "p50Ms", "p95Ms" } | null }`.
- PNGs live in out/mN/ (untracked). SwiftShader/software results set `software: true` and are labelled as such.

### S11. Golden files (`fixtures/golden/*.json`)
`{ "format": "royal-fiesta.golden", "version": 0, "name": string, "regenerate": "<exact command>", "ticks": [int], "rows": [ { "tick", "entity", "values": [numbers] } ], "hash": "<hex8 of final snapshot>" }`

Comparison is exact (===), with no tolerance.

## Module ownership

| Module | Owner | Package | Files root |
|---|---|---|---|
| workspace | M1 | root | package.json, tsconfigs, README |
| guard | M1 | tools | tools/guard.ts |
| bricks | M1 | tools | tools/bricks.ts |
| refusal | M1 | sim | packages/sim/src/refusal.ts |
| detmath | M1 | sim | packages/sim/src/detmath.ts, vec.ts |
| world | M1 | sim | packages/sim/src/world.ts, groups.ts |
| flat-floor | M1 | sim | packages/sim/src/scenarios/ |
| proofkit | M1 | headless | apps/headless/src/proofkit.ts |
| m1-proof | M1 | headless | smoke.ts, proofs/m1-foundations.ts |
| web-boot | M1 | web | vite.config.ts, index.html, src/boot.ts |
| course-model | M2 | sim | packages/sim/src/course.ts |
| motion | M2 | sim | packages/sim/src/obstacles/motion.ts |
| obstacles | M2 | sim | packages/sim/src/obstacles/ |
| prims | M2 | game | packages/game/src/prims.ts |
| assets | M2 | game | packages/game/src/assets.ts, fixtures/assets/ |
| course-loader | M2 | game | packages/game/src/course.ts, gallery + invalid fixtures |
| node-files | M2 | headless | apps/headless/src/files.ts |
| m2-proof | M2 | headless | proofs/m2-obstacles.ts, golden |
| input | M3 | sim | packages/sim/src/input.ts |
| character | M3 | sim | packages/sim/src/character/ |
| input-scripts | M3 | headless | apps/headless/src/scripts.ts |
| m3-proof | M3 | headless | proofs/m3-character.ts, golden |
| match-rules | M4 | sim | packages/sim/src/match/setup.ts, rules.ts |
| round-system | M4 | sim | packages/sim/src/match/roundSystem.ts |
| bots | M4 | sim | packages/sim/src/bots/ |
| match-sim | M4 | sim | packages/sim/src/match/matchSim.ts, log.ts, offline.ts |
| course-set | M4 | game | packages/game/src/courseSet.ts, playlist fixtures |
| m4-proof | M4 | headless | src/cli.ts, proofs/m4-rounds.ts |
| net-match | M5 | game | packages/game/src/net/tuning.ts, netMatch.ts, pilot.ts |
| net-metrics | M5 | game | packages/game/src/net/metrics.ts |
| m5-proof | M5 | headless | src/netsimMatch.ts, proofs/m5-netsim.ts |
| relay-client | M6 | game | packages/game/src/net/ws.ts, relay*.ts |
| loopback-relay | M6 | game | packages/game/src/net/loopbackRelay.ts |
| rooms-client | M6 | game | packages/game/src/net/rooms*.ts |
| webrtc | M6 | game | packages/game/src/net/rtcBackend.ts, webrtcTransport.ts |
| rtc-node | M6 | headless | apps/headless/src/rtcNode.ts |
| gamesaloon-local | M6 | headless | apps/headless/src/gamesaloon.ts |
| m6-proof | M6 | headless | src/realMatch.ts, proofs/m6-transports.ts, docs |
| render-port | M7 | game | packages/game/src/render/port.ts, nullPort.ts |
| scene-view | M7 | game | packages/game/src/render/palette.ts, camera.ts, sceneView.ts |
| client-core | M7 | game | packages/game/src/client/ |
| web-client | M7 | web | client.html, src/client/, src/nmc/, public/nmc.gpu.json |
| raa-port | M7 | web | src/render/ |
| m7-proof | M7 | headless | proofs/m7-web.ts, proofs/m7/ |
| hub-protocol | M8 | game | packages/game/src/hub/protocol.ts |
| hub-world | M8 | game | packages/game/src/hub/hubWorld.ts, remotes.ts, queuePad.ts |
| play-flow | M8 | game | packages/game/src/hub/flow.ts, hubPilot.ts |
| web-play | M8 | web | play.html, src/play/ |
| m8-proof | M8 | headless | src/hubLoop.ts, proofs/m8-hub.ts, proofs/m8/ |

## Module: workspace
Owner: M1. Consumes: none.

Files: `package.json`, `tsconfig.json`, `tsconfig.base.json`, `.gitignore`, `README.md`, `packages/sim/package.json`, `packages/sim/tsconfig.json`, `packages/game/package.json`, `packages/game/tsconfig.json`, `apps/headless/package.json`, `apps/headless/tsconfig.json`, `apps/web/package.json`, `apps/web/tsconfig.json`.

This module holds files only, with no code exports.

Root package.json:
- name `royal-fiesta`, private, MIT, type module, engines node >= 22.18;
- workspaces `["packages/*", "apps/*"]`;
- devDependencies typescript ^5.9.3 and @types/node ^24.
- Scripts:
  - `test`: the node --test glob command from 1.1;
  - `typecheck`: `tsc --noEmit -p tsconfig.json`;
  - `guard`: `node --experimental-strip-types tools/guard.ts`;
  - `bricks`: `node --experimental-strip-types tools/bricks.ts`;
  - `smoke`: `node --experimental-strip-types apps/headless/src/smoke.ts`;
  - `web:build`: `npm run build -w @royal-fiesta/web`;
  - `prepare`: `git config core.hooksPath .githooks || true`.

Workspace packages:
- `@royal-fiesta/sim`: deps @gamesaloon/rollback and @gamesaloon/rollback-rapier as release tarball URLs (1.2).
- `@royal-fiesta/game`: deps @royal-fiesta/sim `*` and @gamesaloon/rollback.
- `@royal-fiesta/headless`: deps sim, game and node-datachannel (exact version).
- `@royal-fiesta/web`: deps sim and game, devDependency vite (exact), script `build` = `vite build`.
- Each one has `"exports": {"./*": "./src/*.ts"}`, `typecheck` = `tsc --noEmit -p .`, and `test` where it has tests.

Other files:
- tsconfig.base.json holds the compiler options of 1.1, and the tsconfig.json files extend it.
- .gitignore includes `out/`, `.vite/` and `*.png`.
- README sections:
  - what Royal Fiesta is;
  - setup: `npm install` (or kong rules + kong use), `npm run bricks -- check`;
  - commands;
  - a proofs table with one line per milestone proof;
  - the assets policy (link to docs/private-assets.md).

## Module: guard
Owner: M1. Consumes: workspace.

Files: `tools/guard.ts`, `tools/test/guard.test.ts`, `.githooks/pre-commit`, `docs/private-assets.md`.

```ts
export type GuardRule = 'binary-ext' | 'nul-byte' | 'not-utf8' | 'too-large' | 'asset-outside-fixtures' | 'fixture-not-json' | 'fixture-too-large'
export interface GuardViolation { path: string; rule: GuardRule; detail: string }
export const BINARY_EXTS: readonly string[]
export const MAX_FILE_BYTES = 262144
export const MAX_FIXTURE_BYTES = 65536
export function checkFile(path: string, bytes: Uint8Array): GuardViolation[]
export function checkPaths(root: string, paths: readonly string[]): GuardViolation[]
export function trackedFiles(root: string): string[]
export function stagedFiles(root: string): string[]
export function main(argv: string[]): number
```

`BINARY_EXTS` (lower-cased): .glb .gltf .png .jpg .jpeg .webp .avif .gif .bmp .tga .ico .ktx2 .dds .basis .exr .hdr .bin .wasm .zip .gz .tgz .7z .tar .rar .mp3 .ogg .wav .flac .mp4 .webm .mov .fbx .obj .blend .psd .ttf .otf .woff .woff2 .pdf.

`checkFile` applies all of these rules:
- the extension is in BINARY_EXTS;
- a NUL byte appears in the first 8000 bytes;
- the bytes are not valid UTF-8 (TextDecoder fatal);
- the file is larger than MAX_FILE_BYTES (package-lock.json exempt);
- the name ends in .prims.json, .course.json or .manifest.json outside `fixtures/`;
- a file under `fixtures/` is not .json, or is larger than MAX_FIXTURE_BYTES.

File lists:
- `trackedFiles` runs `git ls-files -z`.
- `stagedFiles` runs `git diff --cached --name-only -z --diff-filter=ACMR`.

CLI and hook:
- `tools/guard.ts [--staged]` prints `guard: <n> files checked, <m> violations`, then one `<path>: <rule>: <detail>` line per violation. It exits 1 when m > 0.
- `.githooks/pre-commit` is `#!/bin/sh` + `exec node --experimental-strip-types tools/guard.ts --staged`.

Tests cover each rule on in-memory bytes and a clean pass of the current tree.

## Module: bricks
Owner: M1. Consumes: workspace.

Files: `tools/bricks.ts`, `tools/test/bricks.test.ts`.

```ts
export type BrickName = 'gamesaloon-public' | 'raa-assets-tools'
export function repoRoot(): string
export function brickDir(name: BrickName): string | null
export interface BrickCheck { ok: boolean; lines: string[] }
export async function checkBricks(): Promise<BrickCheck>
export async function main(argv: string[]): Promise<number>
```

- `repoRoot` is the directory of the root package.json named `royal-fiesta`, found by walking up from import.meta.url.
- `brickDir` lookup order:
  1. `GAMESALOON_DIR` for gamesaloon-public;
  2. `$RF_BRICKS_DIR/<name>`;
  3. `<parent of repoRoot>/<name>`.
  The first existing directory wins. It returns null when none exists; `brickDir` refuses there and names the variable to set.
- `checkBricks` prints one PASS/FAIL line per check. A failure line is a refusal message with the fix. It checks that `@gamesaloon/rollback`, `@gamesaloon/rollback-rapier` and `@dimforge/rapier3d-deterministic-compat` resolve from the repository root, and that `initRapier()` resolves.
- CLI: `tools/bricks.ts check | where <name>`.



## Module: refusal
Owner: M1. Consumes: workspace.

Files: `packages/sim/src/refusal.ts`, `packages/sim/test/refusal.test.ts`.

```ts
export class RefusalError extends Error {
  readonly area: string
  readonly path: string
  readonly reason: string
  constructor(area: string, path: string, reason: string)
}
export function refuse(area: string, path: string, reason: string): never
export function isRefusal(e: unknown): e is RefusalError
```

- The message is `[${area}] ${path}: ${reason}`, and `name` = 'RefusalError'.
- `refuse` throws a new RefusalError.
- This is the only error type that data validation and impossible requests throw, in every package.

## Module: detmath
Owner: M1. Consumes: workspace.

Files: `packages/sim/src/detmath.ts`, `packages/sim/src/vec.ts`, `packages/sim/test/detmath.test.ts`, `packages/sim/test/vec.test.ts`, `packages/sim/test/purity.test.ts`.

detmath.ts is a verbatim copy of gamesaloon-rollback `packages/kart-spike/src/detmath.ts` (fdlibm ports, MIT). The header records the source path and commit 29e78dc.

```ts
export const PI: number
export const TAU: number
export const HALF_PI: number
export interface SinCos { s: number; c: number }
export function dsin(x: number): number
export function dcos(x: number): number
export function dsincos(x: number, out: SinCos): void
export function dtan(x: number): number
export function datan(x: number): number
export function datan2(y: number, x: number): number
export function dasin(x: number): number
export function dacos(x: number): number
export function dexp(x: number): number
export function dlog(x: number): number
export function dpow(x: number, y: number): number
export function dhypot(x: number, y: number): number
export function dhypot3(x: number, y: number, z: number): number
```

vec.ts. Outputs may alias inputs; implementations read all inputs before writing.

```ts
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Pose { t: Vec3; r: Quat }
export function v3(x: number, y: number, z: number): Vec3
export function quatIdentity(): Quat
export function pose(): Pose
export function add3(a: Vec3, b: Vec3, out: Vec3): Vec3
export function sub3(a: Vec3, b: Vec3, out: Vec3): Vec3
export function scale3(a: Vec3, k: number, out: Vec3): Vec3
export function dot3(a: Vec3, b: Vec3): number
export function cross3(a: Vec3, b: Vec3, out: Vec3): Vec3
export function len3(a: Vec3): number
export function normalize3(a: Vec3, out: Vec3): Vec3
export function quatAxisAngle(axis: Vec3, angle: number, out: Quat): Quat
export function quatMul(a: Quat, b: Quat, out: Quat): Quat
export function quatConj(q: Quat, out: Quat): Quat
export function quatNormalize(q: Quat, out: Quat): Quat
export function quatRotate(q: Quat, v: Vec3, out: Vec3): Vec3
export function degToRad(deg: number): number
export function yawFacing(yaw: number, out: { x: number; z: number }): { x: number; z: number }
```

- `normalize3` of the zero vector returns (0,0,0).
- `quatAxisAngle` expects a unit axis and uses dsincos(angle/2).
- `quatMul(a, b)` = a*b (apply b, then a).
- `degToRad` = deg * (PI / 180).
- `yawFacing`: x = dsin(yaw), z = dcos(yaw), so yaw 0 faces +Z.

Tests:
- purity.test.ts scans every file under packages/sim/src for the forbidden tokens of 1.5 and fails with file:line.
- detmath.test.ts pins bit-exact golden values (hex of the f64 bits) for 12 inputs per function, and checks |d - Math| <= 1e-15 relative on V8.

## Module: world
Owner: M1. Consumes: detmath, refusal.

Files: `packages/sim/src/world.ts`, `packages/sim/src/groups.ts`, `packages/sim/test/world.test.ts`.

groups.ts:
```ts
export const G = { STATIC: 0x0001, MOVING: 0x0002, CHAR: 0x0004, DEBRIS: 0x0008, PROBE: 0x0010 } as const
export function groups(membership: number, filter: number): number
```
`groups` returns ((membership & 0xffff) << 16 | (filter & 0xffff)) >>> 0.

world.ts is the game's `Simulation<TInput>`. It is built on the docs/RAPIER.md wrapper, adapted with system composition and the u32-word blob.

```ts
export const GRAVITY_Y = -20
export const WORLD_MAGIC = 0x52465731
export const WORLD_VERSION = 1
export const MAX_PLAYERS = 8
export interface WorldCtx<TInput> {
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  readonly tick: number
  readonly dt: number
  readonly playerCount: number
  readonly resimulating: boolean
  system<S extends SimSystem<TInput>>(name: string): S
  hasSystem(name: string): boolean
}
export interface SimSystem<TInput> {
  readonly name: string
  init(ctx: WorldCtx<TInput>): void
  preStep(ctx: WorldCtx<TInput>, inputs: readonly TInput[]): void
  postStep(ctx: WorldCtx<TInput>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<TInput>): void
  playerDropped?(ctx: WorldCtx<TInput>, player: number): void
}
export interface FiestaWorldOptions<TInput> {
  playerCount: number
  systems: SimSystem<TInput>[]
  gravityY?: number
  view?: SimView
  regions?: RegionHints
}
export class FiestaWorld<TInput> implements Simulation<TInput> {
  constructor(R: RapierModule, opts: FiestaWorldOptions<TInput>)
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  readonly playerCount: number
  readonly view?: SimView
  readonly regions?: RegionHints
  get tick(): number
  get ctx(): WorldCtx<TInput>
  step(inputs: readonly TInput[]): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader): void
  playerDropped(player: number): void
  beginResim(): void
  endResim(): void
  takeSnapshotBytes(): Uint8Array
  restoreSnapshotBytes(bytes: Uint8Array): void
  stateHash(): number
  free(): void
}
export function writeBlob(w: SnapWriter, bytes: Uint8Array): void
export function readBlob(r: SnapReader): Uint8Array
```

Construction and stepping:
- The constructor creates RapierWorldSim(R, {gravity:{x:0, y:gravityY ?? GRAVITY_Y, z:0}}). It refuses duplicate system names and calls each system's `init` in order.
- `ctx.tick` is the tick being run.
- `step` runs each system's preStep(ctx, inputs) in order, then physics.step(), then each postStep in order. `inputs.length` must equal playerCount.

Snapshot and restore:
- `snapshot` writes the S5 layout.
- `restore` checks magic, version, playerCount and systemCount (refusing a mismatch), lets the systems restore in order, then calls `physics.restoreSnapshot(readBlob(r))`.
  - The Rapier world is replaced last. Systems that need body handles re-derive them lazily, in the next preStep or on first query.
- `takeSnapshotBytes` copies its own SnapWriter's bytes. `stateHash` = fnv1a32(takeSnapshotBytes()). `hash()` is deliberately not implemented.

Other rules:
- `beginResim`/`endResim` toggle ctx.resimulating.
- `playerDropped` forwards to every system that implements it.
- Blob: u32 length, then ceil(len/4) u32 LE words, with the last word zero-padded.

## Module: flat-floor
Owner: M1. Consumes: world.

Files: `packages/sim/src/scenarios/flatFloor.ts`, `packages/sim/test/flatFloor.test.ts`.

```ts
export interface FlatFloorOptions { players: number; seed: number }
export function createFlatFloorSystem(opts: FlatFloorOptions): SimSystem<number>
export function flatFloorScript(seed: number, player: number, tick: number): number
export function createFlatFloorWorld(R: RapierModule, opts: FlatFloorOptions): FiestaWorld<number>
```

System 'flatFloor':
- init creates:
  - a fixed ground cuboid, half (50, 0.5, 50), centred at y = -0.5, group STATIC/CHAR;
  - `players` dynamic capsules: radius 0.4, halfHeight 0.45, additional mass 60, rotations locked, canSleep false, friction 0, restitution 0, group CHAR/(STATIC|CHAR);
  - the capsules at x = (i-(players-1)/2)*2, y = 0.86, z = 0.
- preStep, per player in index order:
  - vx = (qx-127)/127*8 and vz = (qz-127)/127*8;
  - jump (bit 16) sets vy = 7.5 when y < 0.9 and |vy| <= 0.1;
  - then setLinvel.
- The snapshot is u32 players, which restore checks.

`flatFloorScript` changes every 30 ticks:
- h = mix32(seed ^ Math.imul(player+1, 0x9e3779b1) ^ Math.imul(floor(tick/30)+1, 0x85ebca6b)), using the murmur fmix32;
- qx = h & 255 and qz = (h >>> 8) & 255, each clamped to 254;
- the jump bit is set when ((h >>> 16) & 7) === 0.

`createFlatFloorWorld` builds a FiestaWorld<number> with this single system. It drives the M1 proof, the smoke and the boot page.

## Module: proofkit
Owner: M1. Consumes: bricks.

Files: `apps/headless/src/proofkit.ts`, `apps/headless/test/proofkit.test.ts`.

```ts
export type ProofMode = 'quick' | 'full'
export interface CheckResult { value: string; threshold: string; pass: boolean; notes?: string[] }
export interface ProofCheck { label: string; inQuick: boolean; timing?: boolean; run(mode: ProofMode, args: ProofArgs): Promise<CheckResult> }
export interface ProofArgs { only: RegExp | null; mode: ProofMode; child: boolean; writeGolden: boolean; rest: string[] }
export function parseProofArgs(argv: string[]): ProofArgs
export function cpuBudget(): number
export async function runProof(name: string, scriptUrl: string, checks: ProofCheck[], argv?: string[]): Promise<void>
export interface CaseOutcome { label: string; code: number; stdout: string; stderr: string; ms: number }
export async function spawnCases(script: string, cases: { label: string; args: string[] }[], limit?: number): Promise<CaseOutcome[]>
export function printCheck(label: string, r: CheckResult): void
export function report(label: string, fields: Record<string, string | number>): void
export function outDir(milestone: string): string
export function hex8(n: number): string
export function percentile(values: readonly number[], p: number): number
```

- `parseProofArgs` handles `--only <regex>` (case-insensitive), `--quick` (default), `--full`, `--child` and `--write-golden`. Unknown flags go to `rest`.
- `cpuBudget` = parseInt(NMC_CPUS) when >= 1, else 1.
- `runProof`:
  - selects checks by `only`, and in quick mode drops checks with inQuick false;
  - runs `timing` checks first, alone, in this process;
  - runs the others in parallel child processes (`process.execPath --experimental-strip-types <script> --child --only ^<label>$ --<mode>`) up to cpuBudget(). With a budget of 1 they run in-process, sequentially;
  - prints `== <name> (<mode>, NMC_CPUS=<n>) ==`, the `printCheck` lines with notes indented, and `== <name>: <passed>/<selected> passed in <s> s ==`;
  - stops launching at the first failure and sets process.exitCode = 1.
- `spawnCases` respects `limit` (default cpuBudget()).
- `report` prints `[report:<label>] k=v k=v`.
- `outDir` creates `<repo>/out/<milestone>`.
- `percentile` uses the nearest rank and refuses an empty input.

## Module: m1-proof
Owner: M1. Consumes: flat-floor, proofkit, guard, web-boot.

Files: `apps/headless/src/smoke.ts`, `apps/headless/proofs/m1-foundations.ts`.

smoke.ts is a CLI with no exports. It runs initRapier once, then:
- two createFlatFloorWorld({players:8, seed:7}) instances for 600 ticks of flatFloorScript inputs, with hashes compared every 60 ticks and the final snapshot bytes compared;
- a snapshot at tick 300, a run to 400, a restore, a rerun to 400, and a hash comparison.

It prints `smoke: OK ticks=600 hash=<hex8> bytes=<snapshot size>` or `smoke: FAIL <what>`, exits 0/1 and finishes in under 10 s.

m1-foundations.ts has 5 checks, all in quick mode:

| Check | What it does | Threshold |
|---|---|---|
| `tests` | spawns `npm test` | 0 failures |
| `guard` | checkPaths over trackedFiles | 0 violations |
| `determinism-5000` | two 8-character flat-floor worlds for 5000 ticks, hashes compared every 50 ticks, final bytes compared | 0 mismatches, bytes equal |
| `restore` | snapshots at ticks 0, 1234, 2500, 4999, each restored into the same and a fresh instance, rerun to 5000 | 8/8 identical final hashes |
| `web-build` | `npm run web:build` | exit 0 and apps/web/dist/index.html exists |

The report prints the snapshot bytes and the mean step+snapshot ms for 8 characters.

## Module: web-boot
Owner: M1. Consumes: flat-floor, bricks.

Files: `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/boot.ts`.

vite.config.ts (default export defineConfig):
- root apps/web, `build.outDir` `dist`, emptyOutDir;
- `build.rollupOptions.input` = every `*.html` in apps/web, found with readdirSync at config time;
- `server.fs.allow` = repoRoot();
- `resolve.preserveSymlinks` false;
- worker format es.
- no `resolve.alias`: `@etcito/raa` and `@etcito/haa` resolve through their package exports.

The boot page (index.html + src/boot.ts):
- initRapier, then createFlatFloorWorld({players:8, seed:7}) for 600 ticks;
- writes `<pre id="boot">royal-fiesta boot ticks=600 hash=<hex8></pre>`;
- sets `window.rfBoot = { ticks: 600, hash }`.

## Module: course-model
Owner: M2. Consumes: detmath.

Files: `packages/sim/src/course.ts`, `packages/sim/test/course.test.ts`.

```ts
export type CourseKind = 'race' | 'survival' | 'hub' | 'gallery'
export type ProfileName = 'standard' | 'sprint'
export const MOTION_KINDS: readonly ['static','spinner','pendulum','seesaw','rotatingDoor','conveyor','bouncePad','movingPlatform']
export type MotionKind = typeof MOTION_KINDS[number]
export const MAX_OBSTACLES = 96
export const MAX_COLLIDERS_PER_OBSTACLE = 8
export type ColliderSpec =
  | { shape: 'cuboid'; half: Vec3; t: Vec3; r: Quat }
  | { shape: 'roundCuboid'; half: Vec3; border: number; t: Vec3; r: Quat }
  | { shape: 'ball'; radius: number; t: Vec3; r: Quat }
  | { shape: 'capsule'; halfHeight: number; radius: number; t: Vec3; r: Quat }
  | { shape: 'cylinder'; halfHeight: number; radius: number; t: Vec3; r: Quat }
  | { shape: 'cone'; halfHeight: number; radius: number; t: Vec3; r: Quat }
export type Motion =
  | { kind: 'static' }
  | { kind: 'spinner'; axis: Vec3; radPerTick: number; phase: number }
  | { kind: 'pendulum'; pivot: Vec3; axis: Vec3; amp: number; periodTicks: number; phase: number }
  | { kind: 'seesaw'; axis: Vec3; maxAngle: number; spring: number; damping: number; inertia: number }
  | { kind: 'rotatingDoor'; axis: Vec3; stepAngle: number; periodTicks: number; moveTicks: number; phaseTicks: number }
  | { kind: 'conveyor'; velocity: Vec3 }
  | { kind: 'bouncePad'; speed: number }
  | { kind: 'movingPlatform'; offset: Vec3; periodTicks: number; phase: number; wave: 'sine' | 'pingpong' }
export interface ObstacleSpec { id: string; asset: string; t: Vec3; r: Quat; s: Vec3; friction: number; colliders: ColliderSpec[]; motion: Motion }
export interface Box { center: Vec3; half: Vec3 }
export interface SpawnPoint { t: Vec3; facing: { x: number; z: number } }
export interface Checkpoint { box: Box; respawn: SpawnPoint }
export interface PathNode { p: Vec3; jump: boolean; dive: boolean }
export interface Region { id: number; box: Box; adjacent: number[] }
export interface ResolvedCourse {
  id: string; name: string; kind: CourseKind; profiles: ProfileName[]
  timeLimitS: number; killPlaneY: number
  spawns: SpawnPoint[]; checkpoints: Checkpoint[]; finish: Box | null
  path: PathNode[]; regions: Region[]; queuePad: Box | null
  obstacles: ObstacleSpec[]
  contentHash: number
}
export function inBox(b: Box, p: Vec3): boolean
export function regionOf(c: ResolvedCourse, p: Vec3): number
```

- ResolvedCourse is plain data: game/course produces it and the sim consumes it.
- Colliders are already scaled by `s` and expressed in the obstacle's local frame.
- `inBox` tests |p - center| <= half per axis.
- `regionOf` returns the first region id whose box contains p, or -1.
- `contentHash` = fnv1a32 of the canonical course JSON mixed with each referenced asset's hash. It is part of the match setup hash.

## Module: motion
Owner: M2. Consumes: course-model.

Files: `packages/sim/src/obstacles/motion.ts`, `packages/sim/test/motion.test.ts`.

```ts
export function isKinematic(kind: MotionKind): boolean
export function motionPose(o: ObstacleSpec, localTick: number, seesawAngle: number, out: Pose): Pose
export function pointVelocity(o: ObstacleSpec, localTick: number, seesaw0: number, seesaw1: number, p: Vec3, out: Vec3): Vec3
export function triangleWave(u: number): number
export function smoothstep01(u: number): number
```

Helpers:
- `isKinematic` is true for spinner, pendulum, seesaw, rotatingDoor and movingPlatform.
- `smoothstep01(u)` = u*u*(3-2u) on a clamped u.
- `triangleWave(u)` = 1 - 4*|frac(u) - 0.5|.

`motionPose` formulas. t0 and r0 are the spec's t and r; L is the integer local tick.

| Kind | Angle / offset | Rotation | Translation |
|---|---|---|---|
| static, conveyor, bouncePad | – | r0 | t0 |
| spinner | θ = phase + radPerTick*L | quatAxisAngle(axis, θ)*r0 | t0 |
| pendulum | θ = amp*dsin(TAU*L/periodTicks + phase), q = quatAxisAngle(axis, θ) | q*r0 | pivot + q·(t0 - pivot) |
| rotatingDoor | τ = L + phaseTicks, k = floor(τ/periodTicks), u = (τ - k*periodTicks)/moveTicks, θ = stepAngle*(k + smoothstep01(u)) | quatAxisAngle(axis, θ)*r0 | t0 |
| movingPlatform | w = dsin(TAU*L/periodTicks + phase) (sine) or triangleWave(L/periodTicks + phase/TAU) (pingpong) | r0 | t0 + offset*w |
| seesaw | the snapshotted seesawAngle | quatAxisAngle(axis, seesawAngle)*r0 | t0 |

`pointVelocity` is the velocity over tick L -> L+1 of the world point p carried by the obstacle:
- (pose(L+1)·pose(L)^-1·p - p)/FIXED_DT, plus `velocity` for a conveyor;
- 0 for static and bouncePad;
- seesaw0 and seesaw1 are the see-saw angles at L and L+1.

Tests pin the poses at ticks 0, 1, 59, 60 and 3599 for each kind, and check that a spinner rim's pointVelocity equals ω×r within 1e-3.

## Module: obstacles
Owner: M2. Consumes: motion, world.

Files: `packages/sim/src/obstacles/system.ts`, `packages/sim/src/obstacles/colliders.ts`, `packages/sim/test/obstacles.test.ts`.

colliders.ts:
```ts
export function colliderDesc(R: RapierModule, c: ColliderSpec): InstanceType<RapierModule['ColliderDesc']>
```
It maps a ColliderSpec to a Rapier ColliderDesc with local translation and rotation. Any other shape is refused.

system.ts:
```ts
export class ObstacleSystem implements SimSystem<unknown> {
  readonly name: 'obstacles'
  constructor(courses: readonly ResolvedCourse[])
  readonly courses: readonly ResolvedCourse[]
  init(ctx: WorldCtx<unknown>): void
  load(ctx: WorldCtx<unknown>, courseIndex: number): void
  unload(ctx: WorldCtx<unknown>): void
  get courseIndex(): number
  get count(): number
  get loadTick(): number
  localTick(ctx: WorldCtx<unknown>): number
  spec(i: number): ObstacleSpec
  bodyId(i: number): BodyId
  obstacleOfCollider(ctx: WorldCtx<unknown>, colliderHandle: number): number
  pose(i: number, localTick: number, out: Pose): Pose
  pointVelocity(ctx: WorldCtx<unknown>, i: number, p: Vec3, out: Vec3): Vec3
  addLoad(i: number, point: Vec3, mass: number): void
  seesawAngle(i: number): number
  preStep(ctx: WorldCtx<unknown>, inputs: readonly unknown[]): void
  postStep(ctx: WorldCtx<unknown>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<unknown>): void
}
```

`load`:
- refuses when a course is already loaded;
- creates one body per obstacle in index order, at motionPose(o, 0, 0): kinematicPositionBased for kinematic kinds, fixed otherwise;
- colliders: membership MOVING (kinematic) or STATIC, filter CHAR|DEBRIS|PROBE, friction = spec.friction, restitution 0;
- sets loadTick = ctx.tick.

`unload` removes the bodies in reverse index order.

`preStep`, in index order, with L = ctx.tick - loadTick:
1. See-saws integrate first:
   - τ = Σ dot(axis, cross(point - t0, (0, -mass*20, 0))) over pending loads;
   - α = (τ - spring*angle - damping*angVel)/inertia, then angVel += α*dt and angle += angVel*dt;
   - when |angle| > maxAngle, the angle is clamped to ±maxAngle with angVel 0;
   - pending loads are then cleared.
2. Each kinematic body gets setNextKinematicTranslation/Rotation(motionPose(o, L+1, angle)).

Queries:
- `pointVelocity` uses L = localTick and the see-saw angle before and after this tick's integration (prevAngle).
- `obstacleOfCollider` uses a handle -> index map. The map is rebuilt lazily after `load` or `restore`.

Snapshot:
- i32 courseIndex, u32 loadTick, u32 count, count × u32 bodyId;
- then per see-saw, in index order: f64 angle, f64 prevAngle, f64 angVel, u32 nLoads, and nLoads × (f64 x, y, z, mass).

## Module: prims
Owner: M2. Consumes: course-model, refusal.

Files: `packages/game/src/prims.ts`, `packages/game/test/prims.test.ts`.

```ts
export type PrimKind = 'sphere' | 'box' | 'roundBox' | 'capsule' | 'cylinder' | 'cone' | 'torus' | 'ellipsoid'
export interface PrimTransform { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] }
export interface PrimNode { id: string; kind: PrimKind; params: Record<string, number | number[]>; transform: PrimTransform; material: string; op: 'union' | 'subtract' | 'intersect'; children?: PrimNode[] }
export interface PrimMaterial { color: [number, number, number]; roughness: number; metallic: number; emissive: [number, number, number] }
export interface PrimsAsset { format: 'raa.prims'; version: 0; id: string; name: string; nodes: PrimNode[]; materials: Record<string, PrimMaterial>; anchors: Record<string, PrimAnchor>; collision: PrimCollision; budget: PrimBudget }
export const PRIM_CAPS: { maxNodes: 64; maxDepth: 8; defaultBudget: 1500 }
export function parsePrims(json: unknown, path: string): PrimsAsset
export function parseColliderJson(j: unknown, path: string): ColliderSpec
export function collidersOf(asset: PrimsAsset, path: string): ColliderSpec[]
export function scaleColliders(cs: ColliderSpec[], s: Vec3, path: string): ColliderSpec[]
export function assetHash(text: string): number
```

- `parsePrims` validates the format, version, caps, finite numbers, known kinds and material references.
  - Defaults: missing transform parts become identity, missing children `[]`, op 'union'.
  - Anything else is refused with RefusalError('prims', path, ...).
- `collidersOf` applies the S3 derivation and its refusals.
- `scaleColliders` applies the S2 scale rules.
- `assetHash` = fnv1a32 of the UTF-8 file text.

## Module: assets
Owner: M2. Consumes: prims.

Files: `packages/game/src/assets.ts`, `packages/game/test/assets.test.ts`, and `fixtures/assets/{floor-tile,floor-disc,wall-block,spinner-bar,pendulum-hammer,seesaw-plank,rotating-door,conveyor-belt,bounce-pad,moving-platform,finish-arch,checkpoint-gate}.prims.json`.

```ts
export interface ResolvedAsset { name: string; asset: PrimsAsset; hash: number; origin: 'fixtures' | 'store' }
export interface AssetResolver { resolve(name: string): Promise<ResolvedAsset> }
export type ReadText = (repoRelPath: string) => Promise<string>
export function fixtureResolver(read: ReadText): AssetResolver
export interface ManifestEntry { sha256: string; size: number; type: string; version: number }
export interface Manifest { format: 'raa.manifest'; version: 0; entries: Record<string, ManifestEntry> }
export const ASSET_STORE_BASE = 'https://assets.etcito.com'
export function objectUrl(sha256: string, base?: string): string
export function parseManifest(json: unknown, path: string): Manifest
export function storeResolver(manifestSha256: string, fetchBytes: (url: string) => Promise<Uint8Array>, sha256Hex: (b: Uint8Array) => Promise<string>, base?: string): AssetResolver
```

- `fixtureResolver` reads `fixtures/assets/<name>.prims.json` (name ^[a-z0-9-]{1,48}$), parses it with parsePrims and caches per name.
- `storeResolver`:
  - fetches and verifies the manifest once;
  - refuses unknown names;
  - fetches each object and verifies its sha256 and size, refusing a mismatch with both values;
  - parses the object with parsePrims.
- The 15 fixtures are small raa.prims v0 files (<= 8 KiB each). Each has explicit `collision.colliders` of Rapier primitives and a bright flat palette.

## Module: course-loader
Owner: M2. Consumes: assets, obstacles.

Files: `packages/game/src/course.ts`, `packages/game/test/course.test.ts`, `fixtures/courses/obstacle-gallery.course.json`, `fixtures/courses/invalid/{trimesh-collider,bad-motion,unknown-asset,race-without-finish}.course.json`.

```ts
export async function loadCourse(json: unknown, path: string, assets: AssetResolver): Promise<ResolvedCourse>
export function canonicalJson(value: unknown): string
```

`loadCourse`:
- validates S2 completely and refuses with RefusalError('course', `${path}#/<json pointer>`, reason);
- converts:
  - degrees with degToRad;
  - seconds to ticks with round(s*60) >= 1;
  - speedDegS to radPerTick = degToRad(speedDegS)/60;
  - yawDeg to facing with yawFacing(degToRad(yawDeg));
- takes colliders from the override or from collidersOf(asset), then applies scaleColliders;
- sets contentHash = fnv1a32(canonicalJson(json)) mixed with the asset hashes in obstacle order.

`canonicalJson` sorts keys and uses no spaces.

obstacle-gallery (kind 'gallery'):
- exactly 40 obstacles: all 7 non-static motion kinds at least 3 times each, plus static floors;
- 8 spawns, kill plane -12;
- the M3 scripts reach a spinner, a pendulum, a see-saw, a door, a conveyor, a bounce pad and a moving platform within 10 s.
- platform-2 sits at t.y = 1.8 (movingPlatform, offset [0,2,0], periodS 3, phaseDeg 90, pingpong). Its top moves between 0.05 and 4.05 m, so it never goes below floor-lane-7 (top at y = 0).

Each invalid/ fixture triggers exactly one refusal.

## Module: node-files
Owner: M2. Consumes: course-loader, bricks.

Files: `apps/headless/src/files.ts`, `apps/headless/test/files.test.ts`.

```ts
export function repoPath(rel: string): string
export async function readRepoText(rel: string): Promise<string>
export function nodeFixtureResolver(): AssetResolver
export async function loadCourseFile(rel: string): Promise<ResolvedCourse>
export async function loadAllCourses(filter?: (c: ResolvedCourse) => boolean): Promise<ResolvedCourse[]>
```

- `repoPath` resolves against repoRoot() and refuses a path that escapes it.
- `loadCourseFile` caches per process.
- `loadAllCourses` reads `fixtures/courses/*.course.json` (not `invalid/`), sorted by id. Load order is part of determinism.

## Module: m2-proof
Owner: M2. Consumes: node-files, obstacles, proofkit.

Files: `apps/headless/proofs/m2-obstacles.ts`, `fixtures/golden/m2-obstacle-poses.json`.

4 checks:

| Check | What it does | Threshold |
|---|---|---|
| `course-valid` | loads obstacle-gallery | 40 obstacles, all 7 moving kinds, 0 non-primitive colliders |
| `refusals` | loads every fixtures/courses/invalid/* | 4/4 RefusalErrors naming file#pointer, no other exception type |
| `poses-golden` | poses (t, r) of every obstacle at local ticks [0, 1, 60, 600, 3600] (see below) | exact match with the golden (mismatches = 0) |
| `determinism` | two instances for 3600 ticks, plus a restore every 97 ticks into a fresh world and resim | 0 hash mismatches |

- `poses-golden`: a proof-local system loads the gallery and drops 12 dynamic DEBRIS boxes onto the see-saws, conveyors and platforms, so see-saw rows come from real loads.
- Golden regeneration: `node --experimental-strip-types apps/headless/proofs/m2-obstacles.ts --only poses-golden --write-golden`.
- The report prints the snapshot bytes and the mean step+snapshot ms for 40 obstacles + 12 debris.

## Module: input
Owner: M3. Consumes: world.

Files: `packages/sim/src/input.ts`, `packages/sim/test/input.test.ts`.

```ts
export interface PlayerInput { moveX: number; moveZ: number; jump: boolean; dive: boolean; grab: boolean }
export const NEUTRAL_CODE = 32639
export const BTN: { readonly JUMP: 65536; readonly DIVE: 131072; readonly GRAB: 262144 }
export function neutralInput(): PlayerInput
export function encodeInput(i: PlayerInput): number
export function decodeInput(code: number, out: PlayerInput): PlayerInput
export function inputCode(partial: Partial<PlayerInput>): number
export const inputCodec: InputCodec<PlayerInput>
```

- The layout is S1. Encode and decode do not allocate.
- `inputCodec` = { create: neutralInput, encode: encodeInput, decode: decodeInput, neutral: NEUTRAL_CODE }.
- Tests: decode(encode(decode(c))) is stable for all 2^19 codes, neutral decodes to zero, and the clamping rules hold.

## Module: character
Owner: M3. Consumes: input, obstacles, detmath.

Files: `packages/sim/src/character/constants.ts`, `packages/sim/src/character/controller.ts`, `packages/sim/src/character/system.ts`, `packages/sim/test/character.test.ts`.

constants.ts:
```ts
export const CHAR: {
  radius: 0.4; halfHeight: 0.45; mass: 60
  maxRun: 8; groundAccel: 60; groundBrake: 70; airAccel: 18; turnRate: number /* degToRad(720) per s */
  jumpSpeed: 7.5; coyoteTicks: 6; jumpBufferTicks: 6
  diveSpeed: 10.5; diveUp: 3.5; diveRecoverTicks: 24; diveRecoverBrake: 30
  grabRange: 1.0; grabConeDot: 0.5; grabSlow: 0.6; grabMaxTicks: 120; grabCooldownTicks: 60; grabberMaxSpeed: 3
  bumpMinSpeed: 2; stunTicks: 30; knockGain: 1.2; knockNormal: 4; knockUp: 4
  groundProbe: 0.08; groundMinNy: 0.6; parkOrigin: Vec3 /* (0,-500,0) */; parkStep: 5
}
export const CharMode: { readonly ground: 0; readonly air: 1; readonly dive: 2; readonly diveRecover: 3; readonly stunned: 4; readonly grabbing: 5; readonly frozen: 6; readonly parked: 7 }
export type CharModeValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
```
These are tuning values. The M3 `behaviours` thresholds are fixed.

controller.ts:
```ts
export function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number, out: { x: number; z: number }): { x: number; z: number }
export function turnFacing(fx: number, fz: number, tx: number, tz: number, maxAngle: number, out: { x: number; z: number }): { x: number; z: number }
```
- `approach2` moves (vx,vz) toward (tx,tz) by at most maxDelta.
- `turnFacing` rotates the unit facing toward the target by at most maxAngle, using datan2/dsincos. A target shorter than 1e-6 leaves it unchanged.

system.ts:
```ts
export interface CharacterOptions { playerCount: number }
export interface CharState { pos: Vec3; vel: Vec3; facing: { x: number; z: number }; mode: number; grounded: boolean; groundObstacle: number; knockbacks: number; teleportTick: number }
export class CharacterSystem implements SimSystem<PlayerInput> {
  readonly name: 'characters'
  constructor(opts: CharacterOptions)
  readonly playerCount: number
  init(ctx: WorldCtx<PlayerInput>): void
  place(ctx: WorldCtx<PlayerInput>, p: number, at: SpawnPoint): void
  park(ctx: WorldCtx<PlayerInput>, p: number): void
  freeze(p: number, frozen: boolean): void
  override(p: number, code: number): void
  isParked(p: number): boolean
  state(ctx: WorldCtx<PlayerInput>, p: number, out: CharState): CharState
  resetKnockbacks(p: number): void
  readPositions(ctx: WorldCtx<PlayerInput>, out: Float64Array): void
  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void
  postStep(ctx: WorldCtx<PlayerInput>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<PlayerInput>): void
}
```

Bodies and placement:
- `init` creates playerCount capsule bodies in index order:
  - dynamic, rotations locked, canSleep false, friction 0 (combine Min), restitution 0, group CHAR/(STATIC|MOVING|CHAR);
  - all parked at parkOrigin + (p*parkStep, 0, 0), with gravityScale 0 and collision groups 0.
- `place` teleports to `at.t` + (0, halfHeight+radius+0.01, 0) with zero velocity, gravityScale 1 and the CHAR groups. It sets mode air and teleportTick = ctx.tick.
- `park` reverses `place`.
- `freeze` ignores input, keeps vertical physics and zeroes horizontal velocity.
- `override` is consumed by the next preStep only.

preStep, per player in ascending index:
1. Effective code = the override, else encode(inputs[p]). Button edges are computed against prevButtons.
2. Ground probe: castRayAndGetNormal down from the centre.
   - Length = halfHeight+radius+groundProbe+max(0,-vy)*dt, filter STATIC|MOVING.
   - Grounded when n.y >= groundMinNy. groundObstacle = obstacleOfCollider(hit), or -1.
3. Base velocity = obstacles.pointVelocity at the hit point when grounded on a kinematic obstacle or a conveyor, else 0.
4. Mode machine:
   - stunned counts down with no control;
   - dive lasts until grounded, then diveRecover for diveRecoverTicks with a brake;
   - grabbing lasts while grab is held, at most grabMaxTicks, then cooldown.
5. Horizontal: desired = move*maxRun relative to the base.
   - Approached at groundAccel (input), groundBrake (no input) or airAccel (air).
   - Facing turns at turnRate*dt toward move.
6. Jump: a press fills the buffer. It fires when grounded or coyote > 0: vy = jumpSpeed + base.y.
7. Dive: a press, once per airtime.
   - v_h = facing*max(|v_h|, diveSpeed);
   - vy = grounded ? diveUp : max(vy, 0.6*diveUp).
8. A bounce pad under the player sets vy = speed and mode air.
9. setLinvel.

Grab pass, in index order:
- A grabber picks the nearest other non-parked character within grabRange with dot(facing, dir) >= grabConeDot. Ties go to the lower index.
- The target's horizontal velocity *= grabSlow, and the grabber's speed is capped at grabberMaxSpeed.

postStep, per player:
- Bumps: contactPairsWith on the character collider, sorted by obstacle index, counting MOVING colliders only.
  - The bump fires when dot(v_obs - v_char, n) > bumpMinSpeed.
  - The character becomes stunned for stunTicks, with velocity = v_obs*knockGain + n_h*knockNormal + (0, knockUp, 0), and knockbacks++.
- See-saw loads: a player grounded on a see-saw calls obstacles.addLoad(i, pos, mass).

Snapshot, per player in index order:
- mode u8, timer i32, coyote u8, jumpBuffer u8, prevButtons u8, diveUsed u8;
- grabTarget i8, grabTicks u16, grabCooldown u16, facing f64×2;
- grounded u8, groundObstacle i16, knockbacks u16, teleportTick i32;
- frozen u8, parked u8.

The system works without an ObstacleSystem (flat ground).

## Module: input-scripts
Owner: M3. Consumes: character, input, node-files.

Files: `apps/headless/src/scripts.ts`, `apps/headless/test/scripts.test.ts`.

```ts
export interface ScriptStep { from: number; to: number; code: number }
export type InputScript = readonly ScriptStep[]
export function codeAt(script: InputScript, tick: number): number
export const REPLAY_SCRIPTS: readonly InputScript[]
export const REPLAY_TICKS: readonly number[]
export interface ScenarioActor { spawn: number; script: InputScript }
export interface BehaviourScenario { label: string; course: string; spawn: number; script: InputScript; others: readonly ScenarioActor[]; ticks: number; measure: (samples: CharState[]) => { value: number; threshold: string; pass: boolean } }
export function behaviourScenarios(): BehaviourScenario[]
```

- `codeAt` returns the code of the step with from <= tick < to, else NEUTRAL_CODE.
- REPLAY_SCRIPTS has 8 scripts on obstacle-gallery, one per character:
  - run+turn into a spinner;
  - jump chain;
  - dive;
  - grab of character 4 by character 3, and the grab target;
  - conveyor ride;
  - bounce pad;
  - platform ride.
- REPLAY_TICKS = [0, 60, 120, 240, 480, 720, 1200, 1800].
- A BehaviourScenario:
  - measures player 0, placed at spawns[`spawn`] and driven by `script`;
  - `others[k]` is player k+1;
  - `samples[t]` is player 0's CharState after t steps (samples[0] = right after placement).
- `behaviourScenarios`, in order:
  - jump apex 1.30-1.50 m;
  - flat run speed after 60 ticks 7.9-8.0 m/s;
  - dive horizontal speed >= 10 m/s on the tick after the press;
  - spinner bump: stunned, knockbacks >= 1 and displacement >= 1.0 m within 30 ticks;
  - bounce-pad apex >= 4.5 m above the pad;
  - conveyor with neutral input moves >= 0.9*beltSpeed*2 m in 120 ticks;
  - moving platform: stays on for a full period;
  - grab: the target's speed while grabbed <= 0.6*maxRun.

## Module: m3-proof
Owner: M3. Consumes: input-scripts, node-files, proofkit.

Files: `apps/headless/proofs/m3-character.ts`, `fixtures/golden/m3-replay.json`.

First, alone, a `[report:cost]` line (no threshold): step, snapshot and restore ms (mean and p99 over 3600 ticks) and snapshot bytes, for 8 characters on obstacle-gallery, with machine and mode.

4 checks:

| Check | What it does | Threshold |
|---|---|---|
| `codec` | round-trip over all codes | 0 mismatches |
| `behaviours` | every behaviourScenario, each printed as a note | 8/8 |
| `replay-golden` | positions and velocities of the 8 characters at REPLAY_TICKS, plus the final hash | exact match with fixtures/golden/m3-replay.json |
| `determinism` | two instances for 3600 ticks, plus a restore every 61 ticks into a fresh world | 0 mismatches |

Golden regeneration: `node --experimental-strip-types apps/headless/proofs/m3-character.ts --only replay-golden --write-golden`.

## Module: match-rules
Owner: M4. Consumes: course-model, world.

Files: `packages/sim/src/match/setup.ts`, `packages/sim/src/match/rules.ts`, `packages/sim/test/rules.test.ts`.

setup.ts:
```ts
export interface MatchProfile { name: ProfileName; introTicks: number; roundEndTicks: number; intermissionTicks: number; podiumTicks: number; timeCapS: number | null }
export const PROFILES: Readonly<Record<ProfileName, MatchProfile>>
export interface MatchSetup { seed: number; playerCount: number; humans: readonly boolean[]; profile: ProfileName; courses: readonly ResolvedCourse[] }
export function validateSetup(s: MatchSetup): void
export function setupHash(s: MatchSetup): number
```

Profiles (ticks):

| Profile | intro | roundEnd | intermission | podium | cap |
|---|---|---|---|---|---|
| standard | 180 | 180 | 300 | 600 | null |
| sprint | 60 | 60 | 60 | 120 | 20 s |

- `validateSetup` refuses:
  - a non-u32 seed;
  - playerCount outside 1..8;
  - humans.length != playerCount;
  - courses unsorted or with duplicate ids;
  - a profile with no race or no survival course.
- `setupHash` = fnv1a32 of canonical JSON {seed, playerCount, humans, profile, courses: [id, contentHash]}.

rules.ts:
```ts
export interface RoundPlan { index: number; kind: 'race' | 'survival'; final: boolean; target: number }
export function qualifyTarget(alive: number): number
export function planRound(index: number, alive: number): RoundPlan
export function roundTicks(course: ResolvedCourse, profile: MatchProfile): number
export function coursePool(courses: readonly ResolvedCourse[], kind: 'race' | 'survival', profile: ProfileName): number[]
export function pickCourse(pool: readonly number[], lastCourse: number, rng: Rng): number
```

- `qualifyTarget(A)` = 1 if A <= 3, else clamp(floor(A*2/3), 2, A-1). Examples: 8->5, 5->3, 4->2.
- `planRound`: the final (survival, target 1) when alive <= 3. Otherwise an even index is a race and an odd one survival, with target qualifyTarget(alive).
- `roundTicks` = round(min(course.timeLimitS, cap ?? Infinity)*60).
- `coursePool` returns the indices of courses of that kind whose profiles include the profile, in index order.
- `pickCourse` = pool[rng.int(0, n-1)], over the pool without lastCourse when n > 1.

## Module: round-system
Owner: M4. Consumes: match-rules, character, obstacles.

Files: `packages/sim/src/match/roundSystem.ts`, `packages/sim/test/round.test.ts`.

```ts
export const PlayerStatus: { readonly out: 0; readonly alive: 1; readonly qualified: 2; readonly eliminated: 3 }
export type RoundReason = 'target' | 'timeCap' | 'lastStanding' | 'allFell'
export interface RoundResult { plan: RoundPlan; courseIndex: number; startTick: number; endTick: number; participants: number[]; qualified: number[]; eliminated: number[]; reason: RoundReason }
export class RoundSystem implements SimSystem<PlayerInput> {
  readonly name: 'round'
  constructor(setup: MatchSetup)
  begin(ctx: WorldCtx<PlayerInput>, plan: RoundPlan, courseIndex: number, participants: readonly number[], spawnOrder: readonly number[], capTicks: number): void
  get active(): boolean
  get over(): boolean
  result(): RoundResult
  status(p: number): number
  checkpoint(p: number): number
  ticksLeft(ctx: WorldCtx<PlayerInput>): number
  progress(ctx: WorldCtx<PlayerInput>, p: number): number
  end(ctx: WorldCtx<PlayerInput>): void
  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void
  postStep(ctx: WorldCtx<PlayerInput>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<PlayerInput>): void
}
```

- `begin` places the participants on spawns[spawnOrder[k]] and resets their knockbacks. Non-participants stay parked.
- `end` freezes everyone.

postStep runs in ascending player index, for alive participants.

Race:
- Being inside the next or any later checkpoint box sets checkpoint = its index.
- Inside the finish box: qualified (finish order appended) and frozen.
- y < killPlaneY: respawn at checkpoints[checkpoint].respawn, or at the player's own spawn when there is no checkpoint.
- Over when the qualified count >= target (`target`).
- At the cap:
  - with at least 1 finisher, the finishers qualify and the rest are eliminated (`timeCap`);
  - otherwise the top `target` by progress qualify (`timeCap`). Progress order: checkpoint desc, squared distance to the next checkpoint centre (or finish) asc, index asc.

Survival:
- y < killPlaneY: eliminated (fall order appended) and parked.
- Over when alive <= target: the alive players qualify (`target`, or `lastStanding` in the final).
- If alive reaches 0 in one tick, that tick's fallers qualify lowest index first (`allFell`). In the final, the winner is the lowest index.
- At the cap, all alive qualify (`timeCap`). In a final with more than 1 alive, the winner has the fewest knockbacks, then the lowest index.

Snapshot: active u8, plan fields, courseIndex i32, startTick u32, capTicks u32, per-player status u8 and checkpoint i16, then the finish order, the fall order and the per-tick fall list.

## Module: bots
Owner: M4. Consumes: round-system, character, match-rules.

Files: `packages/sim/src/bots/brain.ts`, `packages/sim/src/bots/botSystem.ts`, `packages/sim/test/bots.test.ts`.

brain.ts is pure and shared with the view-side pilots:
```ts
export interface BotSkill { reactionTicks: number; aimError: number; jumpLead: number; diveChance: number }
export function rollSkill(rng: Rng): BotSkill
export interface BrainMemory { pathIndex: number; stuckTicks: number; lastX: number; lastZ: number; wobble: number }
export function newMemory(): BrainMemory
export interface BrainInput { course: ResolvedCourse; pos: Vec3; vel: Vec3; facing: { x: number; z: number }; grounded: boolean; mode: number; obstacleAhead: boolean; hazardNear: boolean }
export function raceBrain(b: BrainInput, skill: BotSkill, mem: BrainMemory, rng: Rng): number
export function survivalBrain(b: BrainInput, skill: BotSkill, mem: BrainMemory, rng: Rng): number
```

- `rollSkill` draws reaction 0..10 (int), aimError 0..0.2, jumpLead 0..0.4 m and diveChance 0..0.3.
- `raceBrain`:
  - targets path[pathIndex], advancing within 1.5 m horizontally;
  - direction = normalize(target - pos) rotated by aimError*wobble, with the wobble redrawn from rng every 45 ticks;
  - jumps on a jump node within 2+jumpLead m, on obstacleAhead, or when stuckTicks > 30;
  - dives on a dive node, or near the finish with probability diveChance.
- `survivalBrain` moves toward the nearest path node (safe spot), jumps when hazardNear and re-targets from rng every 120 ticks.
- Both return an encodeInput code.

botSystem.ts:
```ts
export class BotSystem implements SimSystem<PlayerInput> {
  readonly name: 'bots'
  constructor(setup: MatchSetup)
  isBot(p: number): boolean
  setBot(p: number, on: boolean): void
  resetForRound(ctx: WorldCtx<PlayerInput>): void
  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void
  postStep(ctx: WorldCtx<PlayerInput>): void
  playerDropped(ctx: WorldCtx<PlayerInput>, p: number): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<PlayerInput>): void
}
```

- Bots are the players with humans[p] false, plus dropped players.
- Each bot has Rng = new Rng(setup.seed).fork(0xb0700000 + p) and a skill rolled at construction.
- preStep, for each active, alive, non-frozen bot in ascending index:
  - builds the BrainInput:
    - obstacleAhead = castRay from knee height along facing, 1.2 m, filter STATIC|MOVING, normal.y < 0.6;
    - hazardNear = any MOVING collider within 1.6 m horizontally (intersectionsWithShape, ball 1.6);
  - calls the brain for the round kind;
  - pushes the code through a reaction ring of length reactionTicks;
  - calls characters.override(p, delayedCode).
- Snapshot per bot: rng state u32, the BrainMemory fields and the reaction ring.

## Module: match-sim
Owner: M4. Consumes: bots, round-system, obstacles, character.

Files: `packages/sim/src/match/matchSim.ts`, `packages/sim/src/match/log.ts`, `packages/sim/src/match/offline.ts`, `packages/sim/test/matchSim.test.ts`.

log.ts:
```ts
export interface MatchLog { format: 'royal-fiesta.matchlog'; version: 0; seed: number; profile: ProfileName; playerCount: number; humans: boolean[]; setupHash: string; rounds: RoundLogEntry[]; winner: number; podium: number[]; finalTick: number; finalHash: string }
export interface RoundLogEntry { index: number; kind: 'race' | 'survival'; final: boolean; course: string; startTick: number; endTick: number; participants: number[]; target: number; qualified: number[]; eliminated: number[]; reason: RoundReason }
export function matchLogJson(log: MatchLog): string
```
The shape is S6. `matchLogJson` uses a stable key order, 2-space indent and a trailing newline.

matchSim.ts:
```ts
export const Phase: { readonly intro: 0; readonly playing: 1; readonly roundEnd: 2; readonly intermission: 3; readonly podium: 4; readonly done: 5 }
export interface MatchViewState { tick: number; phase: number; phaseTicksLeft: number; roundIndex: number; roundKind: 'race' | 'survival' | null; final: boolean; courseIndex: number; roundTicksLeft: number; alive: number; target: number; qualifiedCount: number; winner: number; podium: number[] }
export interface CharacterView { pos: Vec3; vel: Vec3; facing: { x: number; z: number }; mode: number; status: number; parked: boolean; teleportTick: number }
export class MatchSim implements Simulation<PlayerInput> {
  constructor(R: RapierModule, setup: MatchSetup)
  readonly setup: MatchSetup
  readonly world: FiestaWorld<PlayerInput>
  readonly view: SimView
  readonly regions: RegionHints
  get tick(): number
  get done(): boolean
  step(inputs: readonly PlayerInput[]): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader): void
  playerDropped(player: number): void
  beginResim(): void
  endResim(): void
  phase(out: MatchViewState): MatchViewState
  character(p: number, out: CharacterView): CharacterView
  obstacleCount(): number
  obstacleSpec(i: number): ObstacleSpec
  obstaclePose(i: number, out: Pose): Pose
  course(): ResolvedCourse | null
  log(): MatchLog
  stateHash(): number
  free(): void
}
export function createMatchSim(R: RapierModule, setup: MatchSetup): MatchSim
```

Construction:
- validateSetup;
- systems in S5 order: an internal 'match' system, BotSystem, ObstacleSystem(setup.courses), CharacterSystem({playerCount}), RoundSystem;
- view = {entities: playerCount, stride: 3, read: characters.readPositions};
- regions = { regionOf(p): regionOf(course, pos), adjacent(a, b): the course adjacency or a === b }.

The 'match' system's preStep drives the phases:
- Tick 0 enters the intro of round 0. Each round setup:
  - takes the plan from planRound(roundIndex, alive);
  - picks the course with pickCourse over coursePool (the survival pool for the final), using the match rng = new Rng(seed).fork(0x6d617463);
  - unloads the previous course and loads the new one;
  - draws the spawn order as a Fisher-Yates permutation from the match rng;
  - calls round.begin, freezes everyone and calls bots.resetForRound.
- intro -> playing unfreezes the participants.
- round.over -> roundEnd calls round.end and stores the result.
- roundEnd -> intermission, or -> podium when one or zero players remain or the round was final.
- intermission -> the next round's intro.
- podium: the top 3 stand frozen on spawns 0..2 of the current course. Podium = winner, then the rest in reverse elimination order.
- podium -> done completes the log with finalTick and finalHash = stateHash at that tick.

Once done, step() only advances physics and ticks.

The match snapshot holds phase, phaseTicksLeft, roundIndex, lastCourse, the rng state, the completed round results, winner and podium.

offline.ts:
```ts
export interface OfflineOptions { forcedRollback?: { every: number; back: number; fresh: boolean }; maxTicks?: number; humanCodes?: (tick: number, p: number) => number }
export interface OfflineResult { log: MatchLog; finalHash: number; ticks: number; rollbacks: number }
export function runMatchOffline(R: RapierModule, setup: MatchSetup, opts?: OfflineOptions): OfflineResult
```

- `runMatchOffline` steps until `done`. Humans get humanCodes, or neutral.
- forcedRollback keeps a ring of snapshot bytes. Every `every` ticks it restores the state of `back` ticks ago (into a fresh MatchSim when `fresh`) and resimulates with the same inputs.
- It refuses past maxTicks (default 108000): "match did not finish in N ticks".

## Module: course-set
Owner: M4. Consumes: course-loader, match-rules.

Files: `packages/game/src/courseSet.ts`, `packages/game/test/courseSet.test.ts`, `fixtures/courses/{race-bean-dash,race-hammer-hill,survival-spin-zone,survival-hammer-ring,race-sprint,survival-sprint}.course.json`.

```ts
export interface CourseEntry { path: string; json: unknown }
export async function resolveCourses(entries: readonly CourseEntry[], assets: AssetResolver, profile?: ProfileName): Promise<ResolvedCourse[]>
export async function matchCourses(entries: readonly CourseEntry[], assets: AssetResolver, profile: ProfileName): Promise<ResolvedCourse[]>
```

- `resolveCourses` loads every entry, refuses duplicate ids and sorts by id.
- `matchCourses` keeps the race and survival courses of the profile, and refuses when either kind is missing.

Playlist:
- race-bean-dash and race-hammer-hill: standard, about 40 obstacles, 3 checkpoints, 60-120 s;
- survival-spin-zone (spinning bars) and survival-hammer-ring (swinging hammers): standard, 90 s;
- race-sprint and survival-sprint: sprint and standard, short (a bot finishes the race in under 15 s, and the hazards eliminate within 20 s).

Race paths flag jump/dive nodes where needed.

## Module: m4-proof
Owner: M4. Consumes: match-sim, course-set, node-files, proofkit.

Files: `apps/headless/src/cli.ts`, `apps/headless/proofs/m4-rounds.ts`.

cli.ts (no exports):
- Usage: `node --experimental-strip-types apps/headless/src/cli.ts match --seed <u32> --profile sprint|standard [--humans N] [--rollback every,back[,fresh]] [--out out/m4/match-<seed>.json]`.
- It runs runMatchOffline and writes the S6 log.
- It prints one `round i kind course reason qualified=[..] eliminated=[..]` line per round, then `winner p podium [..] finalHash hex8 ticks n`.
- It exits 1 on a refusal.

m4-rounds.ts, 4 checks:

| Check | What it does | Threshold |
|---|---|---|
| `rules` | unit cases (see below) | all pass |
| `match-8-bots` | 8-bot matches (see below), logs written to out/m4/ | every match reaches done with exactly one winner and the podium |
| `repeat` | the same seed twice | identical log JSON and finalHash |
| `rollback` | forcedRollback {every 37, back 9, fresh false} and {every 113, back 15, fresh true} | log and finalHash identical to the plain run |

- `rules` cases: the 8->5->3->1 and 4->2->1 plans, race respawn at checkpoint, survival elimination on the kill plane, the cap rules and the allFell tie rule.
- `match-8-bots`:
  - seeds [1, 2] with sprint in quick mode; seeds [1..4] with standard in full mode; each case runs in parallel;
  - at least one race and one survival round are played across the run;
  - in standard mode, every non-final race ends by `target`.

## Module: net-match
Owner: M5. Consumes: match-sim, input.

Files: `packages/game/src/net/tuning.ts`, `packages/game/src/net/netMatch.ts`, `packages/game/src/net/pilot.ts`, `packages/game/test/netMatch.test.ts`.

tuning.ts:
```ts
export const FIESTA_TUNING: { tickRate: 60; maxSubsteps: 8; maxPrediction: 16; snapshotRing: 40; minDelay: 2; maxDelay: 2; delayHiddenTicks: 6; lostAfterMs: 3000; dropWaitMs: 1500 }
export const NET_PLAYERS = 8
export function netSetup(seed: number, humanPeers: number, profile: ProfileName, courses: readonly ResolvedCourse[]): MatchSetup
```
`netSetup` gives playerCount 8 with humans[i] = i < humanPeers, and refuses humanPeers outside 1..8.

netMatch.ts:
```ts
export interface NetMatchConfig { setup: MatchSetup; localPeer: number; humanPeers: number }
export interface NetMatch {
  readonly sim: MatchSim
  readonly session: RollbackSession<PlayerInput>
  frame(dtS: number, sample: (out: PlayerInput[]) => void): number
  readonly done: boolean
  log(): MatchLog
  dispose(): void
}
export function createNetMatch(R: RapierModule, cfg: NetMatchConfig, net: NetTransport, opts?: { cpuMs?: () => number }): NetMatch
```

- `createNetMatch` builds a MatchSim and RollbackSession(sim, {...FIESTA_TUNING, localPeer, playerCount: 8, peers: evenPeers(humanPeers, 1), codec: inputCodec, dumpInfo: () => ({setupHash, seed, profile}), cpuMs}, net).
- `frame` forwards to session.frame and returns alpha.
- `done` = sim.done && session.stats.confirmedTick >= sim.log().finalTick.

pilot.ts:
```ts
export class Pilot {
  constructor(player: number, seed: number)
  sample(sim: MatchSim, out: PlayerInput): PlayerInput
}
```
- Pilot is the view-side input source for headless and in-page humans.
- It reads only the local sim's view API and has its own Rng(seed).fork(0x9170 + player), skill and memory.
- It calls raceBrain/survivalBrain for the current round kind and decodes into out. It never writes the sim.

## Module: net-metrics
Owner: M5. Consumes: net-match.

Files: `packages/game/src/net/metrics.ts`, `packages/game/test/metrics.test.ts`.

```ts
export const SNAP_THRESHOLD_M = 0.5
export class ConfirmedHashLog {
  record(session: RollbackSession<PlayerInput>): void
  get(tick: number): number | undefined
  readonly count: number
}
export function compareHashLogs(logs: readonly ConfirmedHashLog[]): { ticksCompared: number; mismatches: number; firstMismatch: number }
export class DisplayJumpMeter {
  constructor(players: number)
  sample(sim: MatchSim, smoother: CorrectionSmoother | null): void
  readonly maxJump: number
  readonly visibleSnaps: number
}
export class CostStats {
  add(ms: number): void
  mean(): number
  p50(): number
  p99(): number
  max(): number
  readonly n: number
}
```

- `record` reads every newly confirmed tick through session.confirmedHash. Call it at least once per 100 ticks, because the ring holds 128.
- `compareHashLogs` compares every tick present in all logs.
- `DisplayJumpMeter.sample`:
  - displayed position = sim position + smoother.applyEntity offset;
  - a jump is the per-frame |Δdisplayed|, skipping parked players and players with teleportTick >= tick - 2;
  - a visible snap is a jump > SNAP_THRESHOLD_M.

## Module: m5-proof
Owner: M5. Consumes: net-metrics, net-match, course-set, node-files, proofkit.

Files: `apps/headless/src/netsimMatch.ts`, `apps/headless/proofs/m5-netsim.ts`.

netsimMatch.ts:
```ts
export interface NetSimCase { label: string; peers: 2 | 4 | 8; rttMs: number; jitterMs: number; loss: number; seed: number; profile: ProfileName }
export interface NetRunResult { label: string; ticksCompared: number; mismatches: number; firstMismatch: number; winners: number[]; logsEqual: boolean; frameMsMean: number; frameMsP99: number; frameMsMax: number; rollbacks: number; maxRollback: number; resimTicks: number; resimPerTick: number; maxDelay: number; maxDisplayJump: number; visibleSnaps: number; stalls: number; ticks: number; wallMs: number }
export async function runNetSimCase(c: NetSimCase): Promise<NetRunResult>
export const NETSIM_CASES: { quick: NetSimCase[]; full: NetSimCase[] }
```

`runNetSimCase` runs in one process:
- initRapier once, matchCourses for the profile, NetSim(peers, {seed, rttMs, jitterMs, loss});
- one createNetMatch per peer, with cpuMs = performance.now and a Pilot per human;
- loop: NetSim.advance(1000/60), every peer's frame(1/60) in peer order, ConfirmedHashLog.record, and DisplayJumpMeter.sample (peer 0), until every peer is done;
- it refuses after 2x the expected ticks.

Cases:
- quick (all sprint, seed 11):
  - 2 peers: rtt 40, jitter 5, loss 0;
  - 4 peers: rtt 100, jitter 10, loss 0.02;
  - 8 peers: rtt 100, jitter 10, loss 0.02.
- full adds 8 peers at rtt 200/jitter 30/loss 0.05, and standard-profile runs at 4 and 8 peers.

m5-netsim.ts, 5 checks:

| Check | What it does | Threshold |
|---|---|---|
| `frame-budget` | timing, first, alone: the 8-peer 100 ms case | p99 lastFrameSimMs <= 16.7 ms, with mean and max reported (QB2) |
| `hashes` | every case, in parallel children | 0 mismatches, with ticksCompared reported (QB1) |
| `match-complete` | every case | every peer done, same winner, identical logs (QB5) |
| `latency` | every case | maxDelay + 1 <= 3 (QB4) |
| `smoothing` | the 100 ms cases | visibleSnaps 0, with maxDisplayJump reported (QB3) |

Report lines per case: rollbacks, maxRollback, resimTicks, resim per tick, and frame ms mean/p99.

## Module: relay-client
Owner: M6. Consumes: refusal, net-match.

Files: `packages/game/src/net/ws.ts`, `packages/game/src/net/relayProtocol.ts`, `packages/game/src/net/relayClient.ts`, `packages/game/src/net/relayTransport.ts`, `packages/game/test/relayTransport.test.ts`.

ws.ts:
```ts
export interface WsLike { readonly readyState: number; send(data: string): void; close(code?: number, reason?: string): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number; reason: string }) => void) | null; onerror: ((e: unknown) => void) | null }
export type WsFactory = (url: string) => WsLike
export function globalWsFactory(): WsFactory
export function bytesToB64(b: Uint8Array): string
export function b64ToBytes(s: string): Uint8Array
```
`globalWsFactory` uses the global WebSocket (browser and Node >= 22).

relayProtocol.ts is the game's typed copy of the docs/RELAY.md subset:
- RelayClientMsg: create, join, queue, unqueue, act, bye, ping.
- RelayServerMsg: room, waiting, queued, unqueued, matched, act, ack, player_dropped, player_back, player_left, opp_dropped, opp_back, opp_left, pong, error.
- `RelayMatched { t: 'matched'; seed: number; hostStarts: boolean; youAre: number; token: string; players: number; opps: unknown[] }`.
- Constants: RELAY_MAX_PLAYERS = 4, RELAY_MAX_MSG_BYTES = 4096, RELAY_RATE_PER_SEC = 20, CADENCE_RATE_PER_SEC = 90, CADENCE_RATE_PER_MIN = 4000.
- `parseRelayServerMsg(raw: string): RelayServerMsg | null`.

relayClient.ts:
```ts
export interface FiestaQueuePayload { g: 'royal-fiesta'; v: 1; name: string; c: number }
export class RelayClient {
  constructor(url: string, ws: WsFactory)
  connect(timeoutMs?: number): Promise<void>
  create(players: number, payload?: object): Promise<string>
  join(code: string, payload?: object): Promise<{ seat: number; players: number } | RelayMatched>
  queue(players: number, payload: FiestaQueuePayload): Promise<RelayMatched>
  unqueue(): Promise<void>
  act(a: object | unknown[]): void
  onAct(fn: (a: unknown, from: number, n: number) => void): void
  onSeatEvent(fn: (ev: { t: string; seat: number }) => void): void
  onClose(fn: () => void): void
  readonly matched: RelayMatched | null
  readonly seat: number
  bye(): void
  close(): void
}
```

- `create` and `join` refuse players outside 2..RELAY_MAX_PLAYERS.
- `queue` refuses players outside 2..4 immediately, before sending, with RefusalError('relay', 'queue.players', 'GameSaloon relay seats are capped at 4 (MAX_PLAYERS in gamesaloon src/relay/protocol.ts) and an out-of-range queue is silently ignored by the server; use the WebRTC transport for 5-8 players').
- `queue` always sends cadence true and validates the opps payloads (S8).
- Two-seat `opp_*` events map to seat events for the other seat.

relayTransport.ts:
```ts
export interface RelayTransportStats { acts: number; bytesOut: number; maxActBytes: number; fragments: number; droppedFast: number; deferredReliable: number }
export class RelayTransport implements NetTransport {
  constructor(client: RelayClient, selfPeer: number, peerCount: number, now: () => number, opts?: { flushEveryFrames?: number; maxActBytes?: number; maxActsPerSec?: number; maxActsPerMin?: number })
  send(peer: number, ch: NetChannel, data: Uint8Array): void
  drain(out: { peer: number; ch: NetChannel; data: Uint8Array }[]): void
  closed(peer: number): boolean
  now(): number
  endFrame(): void
  readonly stats: RelayTransportStats
}
```

- The framing is S7, with defaults 2, 3800, 60 and 3900.
- `send` copies the data.
- `endFrame` is called once per rendered frame after the session frame, and flushes on its cadence.

## Module: loopback-relay
Owner: M6. Consumes: relay-client.

Files: `packages/game/src/net/loopbackRelay.ts`, `packages/game/test/loopbackRelay.test.ts`.

```ts
export class LoopbackRelay {
  constructor(opts?: { seed?: number })
  factory(): WsFactory
  pump(): void
  readonly serverLog: { to: number; t: string }[]
}
```

An in-memory implementation of the RELAY.md semantics the game uses.

Behaviour:
- private rooms with create/join, 4-digit codes from a seeded Rng, and waiting/matched;
- a quick queue per (players, cadence) with FIFO matching;
- act relay with ack and per-seat sequence numbers, including acts before the room is full;
- bye -> player_left/opp_left, and ping/pong.

Limits it enforces:
- the 4096-byte cap (oversize is ignored);
- the 2..4 player bounds (invalid is ignored);
- the rate limits: 20/s and 400/min per non-cadence socket over every client frame; 90/s and 4000/min for cadence seats after matched. Over the limit, the socket is closed with 'rate limited'.

Frames are JSON-stringified both ways. Delivery is queued and flushed by `pump()` or a microtask.

Used by tests, by the in-page browser hub and by the M6 conformance check.

## Module: rooms-client
Owner: M6. Consumes: relay-client.

Files: `packages/game/src/net/roomsProtocol.ts`, `packages/game/src/net/roomsClient.ts`, `packages/game/test/roomsClient.test.ts`.

roomsProtocol.ts is the game's typed copy of the PROTOCOL.md subset:
- types Welcome, RoomMsg, Started, Member, LocalPlayer, SignalData, IceServer, RoomsError;
- `ROOMS_GAME_ID = 'royal-fiesta-1'`;
- `fiestaLocalPlayer(name: string, colour: number): LocalPlayer` = {name, build: {characterId: 'bean', bodyId: `c${colour}`, wheelId: 'none', gliderId: 'none'}}.

roomsClient.ts:
```ts
export class RoomsClient {
  constructor(url: string, ws: WsFactory)
  hello(name: string, game?: string): Promise<Welcome>
  create(player: LocalPlayer, priv?: boolean): Promise<RoomMsg>
  join(code: string, player: LocalPlayer): Promise<RoomMsg>
  start(): Promise<Started>
  waitStarted(timeoutMs?: number): Promise<Started>
  signal(to: number, data: SignalData): void
  onSignal(fn: (from: number, data: SignalData) => void): void
  onRoom(fn: (r: RoomMsg) => void): void
  onPeerLeft(fn: (peer: number) => void): void
  get room(): RoomMsg | null
  readonly welcome: Welcome | null
  leave(): void
  close(): void
}
```

- Requests use `rid`. Errors reject with RefusalError('rooms', <t>, `${code}: ${message}`).
- `room` is the latest `room` message: the create/join reply or any later broadcast.
  - It is set before the pending create/join promise resolves and before the onRoom listeners run.
  - leave(), close() and a socket close reset it to null.

## Module: webrtc
Owner: M6. Consumes: rooms-client.

Files: `packages/game/src/net/rtcBackend.ts`, `packages/game/src/net/webrtcTransport.ts`, `packages/game/test/webrtcTransport.test.ts`.

rtcBackend.ts:
```ts
export interface RtcChannel { readonly label: 'fast' | 'reliable'; readonly open: boolean; send(data: Uint8Array): void; onMessage(fn: (data: Uint8Array) => void): void; onClose(fn: () => void): void; close(): void }
export interface IceCandidate { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
export interface RtcPeer { createOffer(): Promise<string>; acceptOffer(sdp: string): Promise<string>; acceptAnswer(sdp: string): Promise<void>; addIce(c: IceCandidate): void; onIce(fn: (c: IceCandidate | null) => void): void; channels(): Promise<{ fast: RtcChannel; reliable: RtcChannel }>; close(): void }
export interface RtcBackend { createPeer(iceServers: IceServer[], initiator: boolean): RtcPeer }
export function browserRtcBackend(): RtcBackend
```
- The initiator creates `fast` {ordered:false, maxRetransmits:0} and `reliable` {ordered:true}.
- `browserRtcBackend` wraps RTCPeerConnection with binaryType arraybuffer.

webrtcTransport.ts:
```ts
export class WebRtcTransport implements NetTransport {
  static connect(rooms: RoomsClient, started: Started, backend: RtcBackend, now: () => number, opts?: { iceServers?: IceServer[]; timeoutMs?: number }): Promise<WebRtcTransport>
  readonly selfPeer: number
  readonly peerIds: number[]
  send(peer: number, ch: NetChannel, data: Uint8Array): void
  drain(out: { peer: number; ch: NetChannel; data: Uint8Array }[]): void
  closed(peer: number): boolean
  now(): number
  close(): void
}
export function playerOfPeer(started: Started, peer: number): number
```

- The mesh follows S8. The mesh peers are the Started members' rooms peer ids, which are also the rollback peer ids. The player index is the member rank.
- selfPeer = `rooms.room?.you`.
  - With no room, it refuses with RefusalError('webrtc','selfPeer','no room joined; await RoomsClient.create() or join() before connect').
  - It also refuses on path 'selfPeer' when selfPeer is not among `started.members[].peer`.
- `connect` resolves when every channel to every member is open. After timeoutMs (default 15000) it refuses, listing the missing peers.
- Tests use a fake in-memory backend.

## Module: rtc-node
Owner: M6. Consumes: webrtc.

Files: `apps/headless/src/rtcNode.ts`, `apps/headless/test/rtcNode.test.ts`.

```ts
export function nodeRtcBackend(opts?: { bindAddress?: string; portRange?: [number, number] }): RtcBackend
export function closeNodeRtc(): void
```

- It implements RtcBackend with `node-datachannel` (exact version): PeerConnection, createDataChannel, onLocalDescription/onLocalCandidate, and binary Buffer messages converted to Uint8Array. The default bind is 127.0.0.1.
- `closeNodeRtc` calls the library's cleanup.
- The test runs two loopback peers with iceServers [] and exchanges 100 messages per channel. If node-datachannel cannot open on loopback, the test fails with a refusal naming the bindAddress tried. It never skips.

## Module: gamesaloon-local
Owner: M6. Consumes: bricks.

Files: `apps/headless/src/gamesaloon.ts`, `apps/headless/test/gamesaloon.test.ts`.

```ts
export interface LocalServer { url: string; port: number; dir: string; logs: string[]; stop(): Promise<void> }
export async function startGameSaloon(opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<LocalServer>
export async function helloHandshake(server: LocalServer): Promise<string>
```

`startGameSaloon`:
- dir = brickDir('gamesaloon-public'). It refuses when the dir or `<dir>/node_modules/ws` is missing ("run npm ci in <dir>").
- It picks a free port (bind 127.0.0.1:0, then close).
- It spawns `process.execPath --experimental-strip-types src/main.ts` in dir, with env PORT, HOST=127.0.0.1, LOG_LEVEL=warn.
- It waits for `GET /health` 200 (default 10 s). url = `ws://127.0.0.1:<port>/ws`.
- `stop` sends SIGTERM and waits for the exit.

`helloHandshake` runs `node examples/hello-client.mjs <url>` in dir and returns its `OK: created room` line, or refuses with its output.

The test is skipped with a message ONLY when the dir is absent. In proofs that case counts as failed.

## Module: m6-proof
Owner: M6. Consumes: relay-client, loopback-relay, webrtc, rtc-node, gamesaloon-local, m5-proof.

Files: `apps/headless/src/realMatch.ts`, `apps/headless/proofs/m6-transports.ts`, `docs/network.md`, `docs/gamesaloon-gaps.md`.

realMatch.ts:
```ts
export interface RealCase { label: string; transport: 'relay' | 'webrtc'; clients: number; profile: ProfileName }
export async function runRealCase(server: LocalServer, c: RealCase): Promise<NetRunResult & { transportStats: Record<string, number>; seed: number }>
```

`runRealCase` runs `clients` headless clients in one process, each with its own MatchSim, RollbackSession and Pilot.
- Real-time 60 Hz loop: setTimeout scheduling, dt from performance.now, RelayTransport.endFrame after each frame.
- relay: every client queues with players = clients, and seed = matched.seed.
- webrtc: client 0 creates a rooms room and the others join by code. The owner starts, and WebRtcTransport.connect uses nodeRtcBackend with iceServers [].
- It refuses when the match is not done within 3x the expected wall time.

m6-transports.ts starts one local GameSaloon for the whole proof. The cases run sequentially in-process, in real time.

| Check | What it does | Threshold |
|---|---|---|
| `relay-4` | helloHandshake, then 4 clients over the relay play a sprint match; reports rollback ms p99/mean, resims, acts/s | 0 hash mismatches, all done, same winner |
| `webrtc` | 4- and 8-client cases (both also in quick mode); same reports | 0 mismatches, all done, same winner |
| `relay-8-refused` | queue(8) | the documented RefusalError in < 50 ms, no socket hang (QB7) |
| `loopback-conformance` | a scripted relay scenario (create 4 seats, 3 joins, acts before/after full, ack, bye) on the real server and on LoopbackRelay | identical per-client message-type sequences |

Docs:
- docs/network.md documents the transports, S7/S8 and how to run the cases.
- docs/gamesaloon-gaps.md lists the workarounds, each with what GameSaloon could add:
  - the relay 4-seat cap;
  - JSON-only 4 KiB acts;
  - the 20/90 msg/s rates and the 400/min non-cadence frame budget;
  - a queue keyed by player count only, not by game;
  - kart-shaped rooms player/settings;
  - no hub directory;
  - no 5-8 player matchmaking.

## Module: render-port
Owner: M7. Consumes: prims.

Files: `packages/game/src/render/port.ts`, `packages/game/src/render/nullPort.ts`, `packages/game/test/nullPort.test.ts`.

```ts
export type Vec3T = readonly [number, number, number]
export type QuatT = readonly [number, number, number, number]
export interface Viewport { x: number; y: number; width: number; height: number }
export interface CameraPose { eye: Vec3T; target: Vec3T; fovYDeg: number; near: number; far: number }
export interface RenderTarget { canvas: unknown | null; width: number; height: number; viewports: Viewport[] }
export interface RenderStats { frameMs: number; drawCalls: number; triangles: number; instances: number; visible: number }
export interface RenderPort {
  readonly kind: 'null' | 'raa'
  init(target: RenderTarget): Promise<void>
  registerAsset(name: string, asset: PrimsAsset): number
  createInstance(asset: number, tint: Vec3T | null): number
  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void
  setVisible(instance: number, visible: boolean): void
  destroyInstance(instance: number): void
  setCamera(viewport: number, cam: CameraPose): void
  render(): RenderStats
  capture(): Promise<Uint8Array | null>
  dispose(): void
}
export class NullRenderPort implements RenderPort {
  readonly kind: 'null'
  readonly calls: { registerAsset: number; createInstance: number; setTransform: number; render: number }
}
```

- Rendering reads sim state and never writes it.
- `registerAsset` is idempotent per name.
- `capture` returns PNG bytes, or null for the null port.
- NullRenderPort refuses unknown handles and non-finite transforms, counts the calls and reports triangles 0.

## Module: scene-view
Owner: M7. Consumes: render-port, match-sim, net-match.

Files: `packages/game/src/render/palette.ts`, `packages/game/src/render/camera.ts`, `packages/game/src/render/sceneView.ts`, `packages/game/test/sceneView.test.ts`, `fixtures/assets/bean.prims.json`.

```ts
export const PALETTE: readonly (readonly [number, number, number])[]
export const PALETTE_NAMES: readonly string[]
export function followCamera(prev: CameraPose | null, player: Vec3, facing: { x: number; z: number }, dtS: number): CameraPose
export interface SceneViewOptions { port: RenderPort; viewport: number; localPlayer: number; assets: (name: string) => PrimsAsset; bean: PrimsAsset }
export class SceneView {
  constructor(opts: SceneViewOptions)
  update(sim: MatchSim, smoother: CorrectionSmoother | null, alpha: number, frameDtS: number): void
  readonly camera: CameraPose | null
  readonly instanceCount: number
  readonly courseIndex: number
  dispose(): void
}
```

- PALETTE is the 8 colours of 1.6.
- `followCamera` uses the framing of 1.6 and an exponential follow (1 - Math.exp(-8*dt)).
- `update`:
  - when sim.course() changes, it rebuilds the obstacle instances (asset from spec.asset, scale spec.s);
  - each frame, obstacles are posed between the previous and current tick by alpha (lerp + nlerp);
  - one bean instance per player, tinted PALETTE[p], hidden when parked, at lerp(prev, cur, alpha) + the smoother offset, with yaw from facing;
  - the camera follows localPlayer.
- bean.prims.json is the jelly-bean: a capsule body, two eye spheres with pupils and a mouth, under 1500 triangles, with one capsule collider matching CHAR.

## Module: client-core
Owner: M7. Consumes: scene-view, net-match, net-metrics.

Files: `packages/game/src/client/inputMap.ts`, `packages/game/src/client/inpageMatch.ts`, `packages/game/test/inpageMatch.test.ts`.

```ts
export interface RawControls { left: boolean; right: boolean; forward: boolean; back: boolean; stickX: number; stickY: number; jump: boolean; dive: boolean; grab: boolean }
export function controlsToInput(c: RawControls, cameraFacing: { x: number; z: number }, out: PlayerInput): PlayerInput
export function emptyControls(): RawControls
export interface InPageOptions { R: RapierModule; clients: number; seed: number; profile: ProfileName; courses: readonly ResolvedCourse[]; ports: RenderPort[]; assets: (name: string) => PrimsAsset; bean: PrimsAsset; net: { rttMs: number; jitterMs: number; loss: number }; pilots: boolean[] }
export class InPageMatch {
  constructor(o: InPageOptions)
  frame(dtS: number, local?: (client: number, out: PlayerInput) => void): void
  readonly done: boolean
  readonly matches: NetMatch[]
  readonly views: SceneView[]
  hashes(): { ticksCompared: number; mismatches: number }
  dispose(): void
}
```

Controls:
- `controlsToInput` rotates the stick/keys so stickY (forward) follows the camera facing on XZ and stickX is right, with the length clamped to 1.
- Keys: WASD/arrows, Space jump, Shift dive, E grab. A gamepad maps through stickX/stickY.

InPageMatch:
- runs N clients (1..4) on NetSim(N) with a virtual clock advanced by dtS, with one NetMatch and one SceneView per client;
- client k renders in ports[k], or in viewport k of one shared port;
- humans are driven by a Pilot when pilots[k] is set, else by `local`;
- it is DOM-free, so Node runs it with NullRenderPort.

## Module: web-client
Owner: M7. Consumes: client-core, raa-port, relay-client, webrtc, rooms-client.

Files: `apps/web/client.html`, `apps/web/src/client/main.ts`, `apps/web/src/client/hud.ts`, `apps/web/src/client/sources.ts`, `apps/web/src/nmc/ops.ts`, `apps/web/public/nmc.gpu.json`.

sources.ts:
```ts
export function browserAssetResolver(): AssetResolver
export async function browserCourses(profile: ProfileName): Promise<ResolvedCourse[]>
export async function preloadAssets(courses: readonly ResolvedCourse[], resolver: AssetResolver): Promise<(name: string) => PrimsAsset>
```
Legacy fixtures are bundled with `import.meta.glob('fixtures/**/*.json', ?raw)`.
V1 game assets and courses are fetched at runtime from a content root (default
`content/` next to the page, build override `VITE_RF_CONTENT_URL`, runtime override
`?content=<root URL>`). Every fetch uses `cache: 'no-cache'`. The root contains
`index.json` = `{assets: [{id, world, path, hash}], courses: [{id, path}]}`, plus
`assets/<world>/<id>.asset.json` and `courses/<id>.course.json`. The index hash
comes from the asset's own hash field, which also keys the client mesh cache.
Node tools use `RF_CONTENT_DIR`, defaulting to the repository root. Local play
serves this content live; `npm run content:pack -- <out dir>` produces a separate
upload tree. The plain web build includes no v1 data. Shipping bundles include a
content copy until the CDN serves it.

hud.ts:
```ts
export function mountHud(root: HTMLElement): { update(state: MatchViewState, names: string[], local: number): void; banner(text: string): void }
export function hudLines(state: MatchViewState, names: string[], local: number): string[]
```
`hudLines` is the shared HUD text (round type, timer, qualified count, podium places). The DOM overlay uses it, and ops.ts draws it onto captures.

ops.ts:
```ts
export interface AdapterInfo { vendor: string; architecture: string; description: string; software: boolean }
export interface RoundCaptureInput { clients: number; profile: string; width: number; height: number; captureAtS: number[] }
export interface CaptureOut { name: string; width: number; height: number; mime: 'image/png'; base64: string }
export interface RoundCaptureOutput { captures: CaptureOut[]; adapter: AdapterInfo; renderer: 'raa' }
export interface FrameTimingInput { frames: number; width: number; height: number }
export interface FrameTimingOutput { p50Ms: number; p95Ms: number; frames: number; adapter: AdapterInfo }
export function installNmcOps(): void
```

- `installNmcOps` sets `window.nmcGpu = { ops: { roundCapture, frameTiming } }`.
- Both ops refuse unless raaStatus() is available: captures are only ever RAA renders.
- Adapter info comes from navigator.gpu. A fallback or SwiftShader adapter sets software true.
- `roundCapture` runs a 4-client InPageMatch at 1920x1080 in the 2x2 grid and captures at the given seconds, with the HUD drawn in.
- `frameTiming` measures frames on race-bean-dash (40 obstacles, 8 beans) after 60 warm-up frames.
- nmc.gpu.json declares these ops for the GPU client.

main.ts (the client.html entry) query parameters:
- `mode=inpage|relay|webrtc|ops` (default inpage);
- `clients` 1..4 (default 1 in inpage: one client, one full-canvas view; 2 is side by side, 3 and 4 a 2x2 grid, each client with its own canvas and RAA engine, see client/canvases.ts; default 4 for relay/webrtc);
- `seed` u32 (default 1);
- `profile` sprint|standard (default sprint);
- `server` ws(s):// URL (required for relay/webrtc);
- `pilot` 0|1;
- `room` code (webrtc join).

Behaviour:
- Invalid parameters are refused with a message.
- inpage runs InPageMatch at rtt 100/jitter 10/loss 0.02, one RenderPort and canvas per client (clients 1..4 of `#views`).
- relay queues through RelayClient + RelayTransport.
- webrtc creates or joins a rooms room and connects WebRtcTransport over browserRtcBackend.
- `mode=ops` installs the ops only.
- It uses the RAA port when available, else the null port with a banner.

## Module: raa-port
Owner: M7. Consumes: render-port, bricks.

Files: `apps/web/src/render/raaStatus.ts`, `apps/web/src/render/raaPort.ts`.

```ts
export interface RaaStatus { available: boolean; reason: string; apiVersion: string | null }
export async function raaStatus(): Promise<RaaStatus>
export const RAA_REASON_PREFIX: string // 'RAA not available: '
export const RAA_API_VERSION: string // '0.1.0', the @etcito/raa public API v0
export async function createRaaPort(): Promise<RenderPort>
```

- `raaStatus`: available iff `navigator.gpu` exists (RAA draws with WebGPU only). Otherwise reason = RAA_REASON_PREFIX + the missing piece.
- `createRaaPort` implements RenderPort on `@etcito/raa` 0.1.1: `loadRaa()` then `createEngine(canvas)`. Each registered prims asset goes to `loadPrimsAsset(JSON)` once, by name. An instance without tint is `spawnAsset`; with a tint, each mesh gets one cached tint material. The port draws one full-canvas viewport (RAA has one camera and no scissor); more viewports refuse. The client page never asks one port for more: `client/canvases.ts` gives each in-page client its own canvas with its own port. Captures are `canvas.toBlob('image/png')`. When RAA is unavailable it refuses with RefusalError('render', 'raa', status.reason).
- No stub and no alias: a missing package is a build failure, not a runtime fallback.

## Module: m7-proof
Owner: M7. Consumes: web-client, client-core, node-files, proofkit.

Files: `apps/headless/proofs/m7-web.ts`, `proofs/m7/raa-status.json`, `proofs/m7/captures.json` (only when RAA is available).

3 checks:

| Check | What it does | Threshold |
|---|---|---|
| `web-build` | `npm run web:build` | exit 0, and dist/client.html and dist/nmc.gpu.json exist |
| `inpage-round` | InPageMatch, 4 clients, sprint, seed 11, NullRenderPort, in Node, until done; instanceCount reported | 0 hash mismatches, and every frame of client 0 has 8 beans + the course's obstacle instances |
| `raa` | compares proofs/m7/raa-status.json with a live detection | match (a mismatch fails as "stale record"), plus the rules below |

`raa` rules:
- Available: proofs/m7/captures.json must hold >= 3 non-empty 4-client captures with renderer 'raa', and frameTiming p95Ms <= 16.7 at 1920x1080 (QB2). Software results are labelled and fail the timing.
- Absent: prints `RAA API v0 absent: RAA port and browser captures not produced (brief: stop at the null port)` with value=absent threshold=n/a, and PASS.

The proof records follow S10. They are written by the task that publishes the build to the GPU client, or records the absence.

## Module: hub-protocol
Owner: M8. Consumes: relay-client.

Files: `packages/game/src/hub/protocol.ts`, `packages/game/test/hubProtocol.test.ts`.

```ts
export interface HubHello { k: 'hi'; v: 1; name: string; c: number }
export interface HubState { k: 'st'; s: number; p: [number, number, number]; f: number; m: number; e: number; q: 0 | 1; x: 0 | 1 }
export const HUB_RATE_HZ = 5
export const HUB_MATCH_RATE_HZ = 1
export const HUB_HELLO_EVERY_MS = 5000
export const HUB_MAX_ACTS_PER_MIN = 360
export const EMOTES: readonly ['none', 'wave', 'dance', 'cheer', 'laugh']
export const EMOTE_MS = 2000
export function encodeState(pos: Vec3, facing: { x: number; z: number }, mode: number, emote: number, queued: boolean, inMatch: boolean, seq: number): HubState
export function decodeHubAct(a: unknown): HubHello | HubState | null
export function stateToPose(s: HubState, out: { pos: Vec3; yaw: number }): { pos: Vec3; yaw: number }
```

- The shapes are S9: integer centimetres, and a facing byte from Math.atan2.
- `decodeHubAct` validates types and ranges (name 1..24 characters, colour 0..7) and returns null for anything else.
- Why 5 Hz and 360/min: the hub socket is a non-cadence private room, capped by the relay at 400 frames/min and 20/s. 360 covers 300 states/min, 12 hellos/min and the control frames, with headroom. The tests assert these values.

## Module: hub-world
Owner: M8. Consumes: hub-protocol, character, obstacles, course-loader.

Files: `packages/game/src/hub/hubWorld.ts`, `packages/game/src/hub/remotes.ts`, `packages/game/src/hub/queuePad.ts`, `packages/game/test/hubWorld.test.ts`, `fixtures/courses/hub-plaza.course.json`, `fixtures/assets/queue-pad.prims.json`, `fixtures/assets/plaza-fountain.prims.json`.

hubWorld.ts is the local, non-rollback plaza. It uses the match character controller, so the hub feels the same as the matches.
```ts
export class HubWorld {
  constructor(R: RapierModule, plaza: ResolvedCourse, spawn: number)
  step(input: PlayerInput): void
  readonly tick: number
  state(out: CharState): CharState
  onQueuePad(): boolean
  setEmote(id: number, nowMs: number): void
  emote(nowMs: number): number
  free(): void
}
```
- It is a FiestaWorld<PlayerInput> with ObstacleSystem([plaza]) loaded at init and CharacterSystem({playerCount: 1}) placed at spawns[spawn].
- The caller steps it at a fixed 60 Hz.
- A fall below the kill plane respawns the player at the spawn.

remotes.ts:
```ts
export interface RemoteView { seat: number; name: string; colour: number; pos: Vec3; yaw: number; mode: number; emote: number; queued: boolean; inMatch: boolean; stale: boolean }
export class RemoteBuffer {
  push(seat: number, msg: HubHello | HubState, recvMs: number): void
  sample(nowMs: number): RemoteView[]
  remove(seat: number): void
}
```
- `sample` renders at nowMs - 300 ms (RENDER_DELAY_MS, 1.5 send intervals at 5 Hz) by linear interpolation over a 16-entry ring.
- It extrapolates for at most 200 ms (MAX_EXTRAP_MS), then holds and marks the remote stale, i.e. when the newest state is more than 500 ms old.
- Remotes with inMatch = 1 are hidden. Results are ordered by seat.

queuePad.ts:
```ts
export type QueuePadEvent = 'idle' | 'arming' | 'armed' | 'cancel'
export class QueuePad {
  constructor(dwellFrames?: number)
  update(onPad: boolean): QueuePadEvent
}
```
'armed' fires once after 90 consecutive frames on the pad. 'cancel' fires when the player leaves the pad after being armed.

hub-plaza.course.json (kind hub):
- a walkable round plaza: floor discs, low walls, a fountain, a few bounce pads and a moving platform;
- a queuePad box near the north side;
- 8 spawns, kill plane -10.

## Module: play-flow
Owner: M8. Consumes: hub-world, net-match, relay-client, client-core.

Files: `packages/game/src/hub/flow.ts`, `packages/game/src/hub/hubPilot.ts`, `packages/game/test/flow.test.ts`.

```ts
export type FlowState = 'connecting' | 'hub' | 'queued' | 'match' | 'podium' | 'returning' | 'failed'
export interface FlowEvent { ms: number; client: string; state: FlowState; detail: Record<string, string | number | boolean | number[]> }
export interface FlowDeps {
  R: RapierModule; relayUrl: string; ws: WsFactory; hubCode: string | 'new'; name: string; colour: number
  courses: readonly ResolvedCourse[]; plaza: ResolvedCourse; partySize: 2 | 3 | 4; now: () => number
  pilot: boolean; log: (ev: FlowEvent) => void
}
export class PlayFlow {
  constructor(d: FlowDeps)
  start(): Promise<void>
  frame(dtS: number, controls: RawControls | null, emote: number): void
  readonly state: FlowState
  readonly hubCode: string | null
  readonly hub: HubWorld
  readonly match: NetMatch | null
  remotes(nowMs: number): RemoteView[]
  readonly lastLog: MatchLog | null
  close(): void
}
export class HubPilot {
  constructor(plaza: ResolvedCourse, seat: number, partySize: number)
  sample(nowMs: number, x: number, z: number, othersInHub: number, queueAllowed: boolean, out: PlayerInput): PlayerInput
  takeEmote(nowMs: number): number
}
```

States:
- `connecting`:
  - validates partySize (2..4) and the hello identity;
  - connects the hub RelayClient, then create(4) for 'new' or join(code);
  - sends hello.
- `hub`: steps HubWorld at 60 Hz from controls, or from HubPilot when `pilot` is set, and broadcasts state at HUB_RATE_HZ.
  - When QueuePad becomes armed: opens a second RelayClient, calls queue(partySize, payload), and moves to `queued` (q = 1).
  - 'cancel' sends unqueue.
- On `matched`:
  - netSetup(matched.seed, partySize, 'sprint', courses) and createNetMatch with a RelayTransport on the match socket;
  - moves to `match`. The hub socket stays open, sending st with x = 1 at HUB_MATCH_RATE_HZ.
- `match` -> `podium` when the phase is podium.
- `podium` -> `returning` when the match is done: the match socket says bye, the NetMatch is disposed and lastLog is kept.
- `returning` -> `hub`: placed back at the hub spawn, with x = 0.
- Any refusal or a hub socket close -> `failed`, with the message logged.
- Every transition calls log().

Hub socket budget:
- PlayFlow is the only sender on the hub socket. It keeps a sliding 60 s window of every frame it sends there (create/join, hi and st acts, ping, bye).
- It sends at most HUB_MAX_ACTS_PER_MIN (360) per 60 s and 10 per 1 s.
- A send that would exceed the window is skipped:
  - a st is dropped without using up a seq;
  - a hi is retried at the next state slot;
  - bye is always sent.
- hi goes out every HUB_HELLO_EVERY_MS and at the next state slot after a new seat is seen.
- The matchmaking socket is separate and keeps the RelayClient/RelayTransport budgets.

HubPilot:
- It is view-side (Math allowed).
- Until the party is full, it circles its seat's spawn (radius 2.5 m, 6 s lap).
- Once the other partySize-1 players have been seen in the hub for 3 s, and queueing is allowed (no match played yet), it walks onto the queue pad and stays.
- `takeEmote` returns wave once when the party fills, and cheer once when queueing stops being allowed.

Tests, on a virtual clock with LoopbackRelay:
- no 60 s window of hub-socket frames exceeds 360 and no 1 s window exceeds 10;
- a hub held for 3 minutes and a full queue -> match -> podium -> hub loop both run without 'rate limited'.

## Module: web-play
Owner: M8. Consumes: play-flow, loopback-relay, scene-view, web-client.

Files: `apps/web/play.html`, `apps/web/src/play/main.ts`, `apps/web/src/play/hubView.ts`, `apps/web/src/play/inpageHub.ts`, `apps/web/src/play/ops.ts`.

hubView.ts:
```ts
export class HubView {
  constructor(port: RenderPort, viewport: number, assets: (n: string) => PrimsAsset, bean: PrimsAsset, plaza: ResolvedCourse)
  update(local: CharState, localColour: number, remotes: RemoteView[], dtS: number): void
}
```
- It renders the plaza obstacles, the local bean and the remote beans with their palette tint.
- Emotes are view-side pose offsets: wave, dance, cheer and laugh bob or spin the bean.
- The camera follows the local bean.

inpageHub.ts:
```ts
export class InPageHubLoop {
  constructor(R: RapierModule, clients: number, relay: LoopbackRelay, deps: Omit<FlowDeps, 'relayUrl' | 'ws' | 'hubCode' | 'name' | 'colour' | 'log'>, ports: RenderPort[])
  frame(dtS: number): void
  readonly flows: PlayFlow[]
  readonly events: FlowEvent[]
  readonly done: boolean
}
```
- N PlayFlows (pilot true) share one LoopbackRelay. Client 0 creates the hub and the others join its code.
- `done` = all clients are back in the hub after one match.

main.ts (the play.html entry):
- Query parameters: `server=ws://...`, `hub=new|<code>`, `name`, `colour`, `party=2..4`, or `mode=inpage&clients=4`.
- Keys 1-4 trigger emotes. The keyboard and gamepad map as in client-core.
- HUD: hub code, queue status, players online, and the match HUD during the match.
- It uses the RAA port when available, else the null port with a banner.

ops.ts sets `window.nmcGpu.ops.hubLoopCapture({ clients: 4, width: 1920, height: 1080, captureAt: ['hub', 'match', 'podium', 'back-in-hub'] })`. It runs InPageHubLoop in the 2x2 grid and returns the captures plus the event log. It refuses when RAA is unavailable.

## Module: m8-proof
Owner: M8. Consumes: play-flow, gamesaloon-local, web-play, proofkit.

Files: `apps/headless/src/hubLoop.ts`, `apps/headless/proofs/m8-hub.ts`, `proofs/m8/raa-status.json`, `proofs/m8/captures.json` (only when RAA is available).

hubLoop.ts:
```ts
export interface HubLoopResult { events: FlowEvent[]; clientsBackInHub: number; remoteSightings: number[]; matchHashes: { ticksCompared: number; mismatches: number }; winners: number[]; wallMs: number }
export async function runHubLoop(server: LocalServer, clients: number): Promise<HubLoopResult>
```
- `runHubLoop` runs N PlayFlows (pilot true) in one Node process against the real local GameSaloon. Client 0 creates the hub and the others join.
- It writes the event log to out/m8/loop-log.jsonl and refuses after 240 s of wall time.

m8-hub.ts, 4 checks:

| Check | What it does | Threshold |
|---|---|---|
| `hub-loop` | 4 clients against the local GameSaloon | see below |
| `match-consistency` | the loop's match | 0 confirmed-hash mismatches and the same winner on all 4 clients (QB1, QB5) |
| `inpage-loop` | InPageHubLoop, 4 clients, LoopbackRelay, null port, in Node | the loop completes with all 4 back in hub |
| `captures` | M7's `raa` rule on proofs/m8/*.json | see below |

`hub-loop` threshold:
- before queueing, each client saw the other 3 moving (>= 20 distinct interpolated samples each);
- all 4 reached match, podium and back-in-hub;
- after returning, each sees the other 3 again.

`captures`:
- Available: >= 4 non-empty 4-client captures (hub-loop-hub, hub-loop-match, hub-loop-podium, hub-loop-back-in-hub).
- Absent: prints `RAA API v0 absent: RAA port and browser hub captures not produced (brief: stop at the null port)`, PASS n/a.

## Milestone proofs
- M1 Foundations: TypeScript workspace, git guard and a bit-identical world: `node --experimental-strip-types apps/headless/proofs/m1-foundations.ts`
- M2 Course data and parametric obstacles: `node --experimental-strip-types apps/headless/proofs/m2-obstacles.ts`
- M3 Jelly-bean character controller with a golden replay: `node --experimental-strip-types apps/headless/proofs/m3-character.ts`
- M4 Rounds, elimination and bots: a full headless match: `node --experimental-strip-types apps/headless/proofs/m4-rounds.ts`
- M5 Rollback match on NetSim with 2, 4 and 8 peers: `node --experimental-strip-types apps/headless/proofs/m5-netsim.ts`
- M6 Real transports: GameSaloon relay and WebRTC: `node --experimental-strip-types apps/headless/proofs/m6-transports.ts`
- M7 Web client shell with the RenderPort (RAA when available): `node --experimental-strip-types apps/headless/proofs/m7-web.ts`
- M8 3D hub lobby and the lobby -> match -> podium -> lobby loop: `node --experimental-strip-types apps/headless/proofs/m8-hub.ts`
```
