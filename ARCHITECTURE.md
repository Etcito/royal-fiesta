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

## 1. Conventions (every module follows these)

### 1.1 Runtime and language
- Node >= 22.18. TypeScript `.ts` source runs directly with `node --experimental-strip-types <file.ts>`.
- Erasable syntax only (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties, no `import =`. Enumerations are `as const` objects plus a derived union type.
- Imports carry the `.ts` extension. ESM only (`"type": "module"`).
- Typecheck: `npm run typecheck` is ONE pass of `tsc --noEmit -p tsconfig.json` over the whole repo.
  - The root tsconfig includes `tools`, `packages/*/src`, `packages/*/test`, `apps/*/src`, `apps/*/test`, `apps/*/proofs` and the Vite configs.
  - Compiler options (tsconfig.base.json): target ES2022, module ESNext, moduleResolution Bundler, strict, noEmit, allowImportingTsExtensions, verbatimModuleSyntax, erasableSyntaxOnly, skipLibCheck, lib [ES2022, DOM, DOM.Iterable], types [node].
  - `npm run typecheck:mama` (tsconfig.mama.json) checks the MAMA mesher glue (`apps/web/src/sdf/mama`, `apps/headless/src/mama`) against `.bricks/MAMA/src` through the `@etcito/mama/*` path.
  - Each workspace package also has a `typecheck` script (`tsc --noEmit -p .`).
- Tests: `npm test` runs `node --experimental-strip-types --test "tools/test/*.test.ts" "packages/*/test/*.test.ts" "apps/headless/test/*.test.ts" "apps/web/test/*.test.ts"` with node:test and node:assert/strict.
  - A test file is `<subject>.test.ts` in the `test/` folder of the package it tests.
  - Tests never need network, a GPU, a browser or a running GameSaloon server. Those belong in proofs and cards.
- Style: 2-space indent, single quotes, no semicolons, named exports only (the Vite configs in apps/web are the only default exports). Comments are short and say why.
- Web: Vite, exact version pinned. `npm run web:build` bakes audio (`audio:bake`) and UI fonts (`ui:fonts`), then builds every `apps/web/*.html` page into `apps/web/dist/`.

### 1.2 Dependencies and bricks
- Bricks are patched only by the cross-repository modules that own brick files (raa-*, mama-*, haa-spatial, sdfm-*). Other gaps go to `docs/brick-gaps.md` or `docs/gamesaloon-gaps.md`.
- Release tarballs (GitHub releases, pinned in package.json):
  - `@gamesaloon/rollback` and `@gamesaloon/rollback-rapier` v0.1.0, with `@dimforge/rapier3d-deterministic-compat` 0.21.0 declared in every workspace that uses Rapier;
  - `@etcito/haa` v0.1.1 (root devDependency and packages/game: the sound engine; the Royal Fiesta pack is game content in `packages/game/src/audio/pack`);
  - `@etcito/raa-assets-tools` v0.1.0 (root devDependency).
- Sibling checkouts (`file:` dependencies next to the royal-fiesta folder):
  - `@etcito/raa`, `@etcito/raa-anim`, `@etcito/raa-sdfm` = `raa/dist/bricks/<name>`, rebuilt with raa `scripts/build-bricks.sh` (raa-anim is also a root dependency);
  - `@etcito/haa-spatial` = `haa/packages/haa` (haa 0.2.0 with `createSpatialScene`), apps/web only;
  - `@etcito/uaa` = `uaa` (root);
  - MAMA sources under `.bricks/MAMA` (1.1).
- No source file imports `node_modules/@etcito/...` paths: bricks are reached through their package exports.
- gamesaloon-public (the GameSaloon server) is located by directory (`GAMESALOON_DIR`, `$RF_BRICKS_DIR/gamesaloon-public`, or a sibling folder) for the optional local-server test, skipped when absent.
- `tools/bricks.ts`: `check` verifies that the packages resolve and the Rapier WASM initialises; `where <name>` prints a local brick directory.
- Brick facts the code relies on:
  - `SnapWriter`/`SnapReader` have no blob method; `SnapWriter.bytes()` returns the written view. Blobs are a u32 length plus u32 words (`writeBlob`/`readBlob` in sim/world).
  - `RollbackSession.frame(frameDt, sampleLocal)` returns the interpolation alpha. `confirmedHash(tick)` reads a 128-entry ring. `smoother` exists only when the Simulation has `view`. The session ignores `RegionHints`.
  - The GameSaloon relay caps rooms at 4 seats (`MAX_PLAYERS = 4` in src/relay/protocol.ts) and accepts JSON text only, at most 4 KiB per message.
  - Relay rates are 20 msg/s per socket, or 90/s and 4000/min for cadence seats after `matched`. Every client frame counts, over a sliding 60 s window, with a cap of 400/min for non-cadence sockets. Private create/join rooms never get cadence.
  - The rooms protocol (8 peers) only forwards WebRTC signaling and never relays game data.
  - Rapier 0.21 shares a hinge axis between both bodies; mech-physics works around it with a hidden identity body.

### 1.3 Layout
- `packages/sim` (`@royal-fiesta/sim`): the deterministic simulation only, i.e. everything inside the rollback snapshot (world, systems, characters, obstacles, mechanisms, rounds, bots). Pure: no DOM, no Node API, no clock, no I/O, no async.
- `packages/game` (`@royal-fiesta/game`): everything outside the snapshot that the apps share: data loading (prims, assets, legacy and v1 courses, game assets, mechanisms JSON), network, render port and scene view, client core (seats, split layout, local match, pad maps), screens, hub, audio.
  - No Node-only module. Browser and Node globals are reached only through injected factories or at call time.
- `apps/headless` (`@royal-fiesta/headless`): Node CLIs (`src/`), proof scripts (`proofs/mN-<name>.ts`), Node-only adapters.
- `apps/web` (`@royal-fiesta/web`): Vite pages (`*.html` at the root: index, client, play, game, candy-assets), code in `src/`, plus `public/nmc.gpu.json`.
- `tools/`: repository CLIs (guard, bricks, content, play, judgeCard, ...) with tests in `tools/test/`.
- Content root (S29): `assets/<world>/<id>.asset.json` (S12), `courses/<id>.course.json` (S13), `audio/<id>.haa.json`, `ui/*.ui.json`, `sdfm.game.json` (S14); saved meshes `assets/<world>/<id>.mesh` (S24) are never tracked. `tools/authored.json` lists the hand-authored content files.
- `fixtures/`: small JSON only: legacy `assets/<name>.prims.json`, `courses/<id>.course.json` (with `courses/invalid/`), `golden/<name>.json`.
- `docs/`: markdown. `proofs/mN/`: committed proof records (JSON). `out/`: untracked outputs (logs, PNGs).
- `.nmc/commands.json` and `.nmc/judge/*.json`: the cards (S31).
- Packages export subpaths through one wildcard, `"exports": { "./*": "./src/*.ts" }`, e.g. `import { FiestaWorld } from '@royal-fiesta/sim/world'`. No barrel files.
- Dependency direction is sim <- game <- apps. sim never imports game, and game never imports apps.

### 1.4 Module ownership and shared files
- A module's files belong to its owner milestone. A later milestone adds new modules that consume earlier ones and never rewrites another milestone's module, except a minimal fix the lead explicitly authorizes.
- Shared manifests are additive: package.json scripts and dependencies, tsconfig include lists, `.gitignore` lines, README sections. Existing entries are not removed or changed.
- Authorized cross-milestone edits (M4):
  - append the 16 M4 content files (12 ice/jungle/neon assets, 4 world courses) to `tools/authored.json`, kept sorted, so `tools/test/placeholders.test.ts` sees them as authored;
  - add the four S31 entries `rf-judge-m4-candy-seesaw-run`, `rf-judge-m4-ice-slide-gates`, `rf-judge-m4-jungle-crane-crossing`, `rf-judge-m4-neon-piston-alley` to `.nmc/commands.json` (judge-cards); `tools/judgeCard.ts` is unchanged.
- Test split: `packages/sim/test/bots.test.ts` covers wait/pull rules and 8 bots on mech-lab; `packages/game/test/worldCourses.test.ts` covers 8 bots on each M4 world course.

### 1.5 Determinism (sim scope = packages/sim/src)
- Allowed float operations: `+ - * /`, Math.sqrt, abs, floor, ceil, round, trunc, min, max, sign, imul, clz32.
- Trig, exp, log and pow come only from `@royal-fiesta/sim/detmath`.
- Forbidden in sim: Math.sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh/pow/exp/expm1/log/log2/log10/log1p/hypot/cbrt/fround/random, Date, performance, setTimeout/setInterval, crypto, `for...in`. The purity test enforces this list.
- Never iterate a Map/Set built from unordered data: iterate arrays by index. Mechanism ids resolve to sorted indices.
- RNG: only `Rng` from `@gamesaloon/rollback`, with its `state` in the snapshot. Each consumer gets its own stream via `rng.fork(salt)`.
- Everything that `step()` reads or writes is in the snapshot (S5), including mechanism motors, kinematic targets, loads, signals, logic state and the event ring.
- Rapier rules (docs/RAPIER.md): create and remove bodies and joints only in `init` or inside a step, in a fixed order; apply inputs in ascending player index before the physics step; keep BodyIds, never RigidBody/Collider objects across ticks; read queries inside the tick that uses them; no EventQueue. Mass comes from density (setDensity), never setMass; a body's type never changes at runtime.
- State is organised by entity and region (structure-of-arrays by index; regions exposed as `RegionHints`).
- Legacy obstacle motion is a deterministic function of the round-local tick, except the snapshotted see-saw. Mechanism bodies are Rapier-simulated; animations are a function of their snapshotted local tick. No per-frame randomness.
- View, render, hub, audio and network code may use any Math, but never writes sim state and never uses the sim RNG.

### 1.6 Units and fixed values
- Sim units are metres, seconds, radians and kg/m³. Degrees and seconds appear only in JSON and are converted at load (`degToRad`, round(s*60) >= 1 ticks). Y is up; courses run along +Z; +X is right when looking along +Z.
- TICK_RATE = 60 and FIXED_DT = 1/60 (`@gamesaloon/rollback-rapier`). Gravity (0, -20, 0) m/s² (`GRAVITY_Y`).
- Players: 1..8 per match (`MAX_PLAYERS = 8`); networked and local matches use playerCount 8; humans are players 0..humans-1, the rest are bots.
- Rollback tuning `FIESTA_TUNING` (game/net/tuning): tickRate 60, maxSubsteps 8, maxPrediction 16, snapshotRing 40, minDelay 2, maxDelay 2, delayHiddenTicks 6, lostAfterMs 3000, dropWaitMs 1500. Input-to-screen latency = 3 ticks.
- Collision groups (sim/groups): STATIC 0x0001, MOVING 0x0002, CHAR 0x0004, DEBRIS 0x0008, PROBE 0x0010. Group word = (membership << 16) | filter.
- Character palette (game/render/palette): player i uses PALETTE[i] (shown through the S23 Player Color node on SDF assets).

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

- Mechanism caps (`MECH_CAPS`): <= 48 items, <= 16 bodies per item, <= 64 joints, <= 64 signals, <= 32 keys per animation, <= 32 sounds. Default per-course budget (`DEFAULT_BUDGET`): 24 dynamic bodies, 32 joints.
- Split screen (game/client/splitLayout): 1 seat = full canvas; 2 seats = left/right halves; 3 seats = 2x2 grid with seats 0..2 and the overview camera in the bottom-right cell (seat -1); 4 seats = 2x2 grid, seat k at column k%2, row floor(k/2). Backing size = round(css × min(dpr, DPR_CAP = 2)).
- Captures are 1920x1080 unless the judge input says otherwise. A 4-client capture is a 2x2 grid of 960x540 viewports.
- Camera: vertical FOV 60°, near 0.1, far 500; eye = player + facing*(-7) + (0,4,0), target = player + (0,1.2,0); exponential follow at 8/s.
- Hub: state at 5 Hz in the hub and 1 Hz during a match, hello every 5 s; <= 360 hub-socket frames per sliding minute and 10 per second; remote render delay 300 ms, extrapolation <= 200 ms; queue-pad dwell 90 frames; party size 2..4 (default 4).
- Match profiles `standard` and `sprint` (sim/match/setup). Networked proofs, captures and bot course tests use `sprint`.
- GameSaloon ids: rooms `game` = `royal-fiesta-1`; relay queue payload = `{ "g": "royal-fiesta", "v": 1, "name": <string>, "c": <colour index> }`.

### 1.7 Errors and refusals
- Invalid data or an impossible request throws `RefusalError` (sim/refusal), message `[area] path: what is wrong; the fix`, path = file plus JSON pointer (e.g. `courses/mech-lab.course.json#/mechanisms/links/2/to/joint`).
- Never NaN, never a silent default for a required field, never a silent skip. CLIs and proofs print the message and exit 1.

### 1.8 Data on disk
- JSON is UTF-8, 2-space indented, with a trailing newline; numbers via JSON.stringify.
- Golden files carry their exact regeneration command in `"regenerate"`. Courses and assets follow section 2; v1 assets carry their own `hash`, regenerated by the content tooling or the sdfm save.

### 1.9 Git guard (no binary or asset in git)
- `tools/guard.ts` holds the rules; `.githooks/pre-commit` runs it on staged files (`prepare` sets `core.hooksPath`); `npm run guard` checks tracked files.
- `docs/private-assets.md` explains the policy: where content JSON, audio patches and saved meshes may live, and that binaries (including `.mesh`) are never tracked.

### 1.10 Proofs and cards
- Each milestone proof is `apps/headless/proofs/mN-<name>.ts`, built on `@royal-fiesta/headless/proofkit`, with `--only <regex>`, `--quick` (default), `--full` and `--write-golden`.
- Each check prints `[label] value=<measured> threshold=<threshold> PASS|FAIL`; reports print `[report:<label>] k=v ...`; the proof exits non-zero at the first failure.
- At most 5 checks per proof; never split one behaviour into several checks. Independent cases run in parallel child processes up to `NMC_CPUS` (1 when unset). A timing check exists only for the 16.7 ms frame and runs first and alone. Default mode runs in at most 3 minutes; thresholds are never lowered to meet it.
- Cards (S31) are the acceptance commands: `rf-tests` runs `npm test`; judge cards build, publish to the GPU client, render the judge inputs and score each capture with `$NMC_JUDGE_CLIENT` at `--min-score 6`.
- GPU: the project GPU is off, so there is never a Node WebGPU proof. Browser captures go through the client GPU: `apps/web/public/nmc.gpu.json` is copied into dist and the page exposes `window.nmcGpu.ops`; `node "$NMC_GPU_CLIENT" publish apps/web/dist/`, then `render <input.json> --page-ref REF -o out/...`. Never launch Linux Chrome in the sandbox and never print tokens. No GPU client means a visible wait, not a substitute.
- The GPU browser cannot reach a server in the sandbox: in-browser multi-client runs use in-page NetSim or LoopbackRelay; real GameSaloon runs are headless Node clients against a local server from `brickDir('gamesaloon-public')`.

### 1.11 Quality bar
- **QB1 Determinism.** Same inputs give bit-identical snapshots; restore + resim equals the uninterrupted run; networked peers have identical confirmed hashes. Commands: the proofs (M1-M8 of step 1), matchSim/mechanism/logic tests with restore. Mismatches must be 0.
- **QB2 Steady 60 fps at 1080p with 8 characters and 40 obstacles.** Sim: p99 `stats.lastFrameSimMs` <= 16.7 ms for 8 peers at 100 ms RTT (M5). Render: browser p95 <= 16.7 ms when RAA is available.
- **QB3 Smoothed corrections.** Displayed positions move <= 0.5 m per rendered frame outside teleports; visible snaps 0 (M5).
- **QB4 Input-to-screen latency <= 3 ticks** in every NetSim case.
- **QB5 Every round type plays through to the podium**: offline bot matches, networked matches, the hub loop, and 8 bots finishing mech-lab and each world course.
- **QB6 Party look and feel**, reviewed by the judge cards: tinted penguins, moving mechanisms, HUD, podium, hub, split screen, touch controls.
- **QB7 Refusals are messages**: invalid courses, assets, mechanisms (file#pointer) and an 8-seat relay request.
- **QB8 No asset in git**: `tools/guard.ts` reports 0 violations over tracked files.
- **QB9 Honest numbers**: cost per tick, snapshot bytes, rollback ms and resim counts are printed from real measurements.

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
- Scale: `s` applies to the colliders. Non-uniform `s` is allowed only when every collider is cuboid or roundCuboid; otherwise `s` must be uniform, or the course is refused.
- `colliders` (when not null) overrides the asset's collision list and uses the course collider JSON (flat shape fields, see S3 "Course colliders").
- Caps: <= 96 obstacles and <= 8 colliders per obstacle. Obstacle ids are unique. Asset names match ^[a-z0-9-]{1,48}$.
- Refused with a message: an unknown kind; a trimesh/convexHull/heightfield/polyline shape ("primitive colliders only: the kart study measured 1.25 MB / 12 ms per snapshot for a trimesh track"); a race without finish; too few spawns; non-finite numbers.

### S3. Primitive asset subset (raa.prims v0), game/prims
Fields read: `format` ("raa.prims"), `version` (0), `id`, `name`; `nodes[]` with `id`, `kind`, `params`, `transform {t,r,s}`, `material`, `op`, `children`; `materials`, `anchors`, optional `budget` (default 1500), and `collision`.

Validator caps: <= 64 nodes in total, depth <= 8, finite numbers.

Param names (raa-assets-tools 0.1.0 schema): sphere {radius}; box {size:[x,y,z]}; roundBox {size, radius}; capsule {radius, height} (height = cylinder part, Y axis); cylinder {radius, height}; cone {height, radiusBottom, radiusTop} (apex up when radiusTop is 0); torus {majorRadius, minorRadius}; ellipsoid {radii:[x,y,z]}.

`collision` = `{ "mode": "override" | "derived", "colliders": [ColliderJson] }`. ColliderJson is `{"node": null | nodeId, "shape", "params", "t", "r"}` with one of:
- `{"shape":"cuboid","params":{"halfExtents":[x,y,z]}}`
- `{"shape":"roundCuboid","params":{"halfExtents":[...],"borderRadius":b}}`
- `{"shape":"ball","params":{"radius":r}}`
- `{"shape":"capsule","params":{"halfHeight":h,"radius":r}}`
- `{"shape":"cylinder","params":{"halfHeight":h,"radius":r}}`
- `{"shape":"cone","params":{"halfHeight":h,"radius":r}}`

Each has a local `"t":[x,y,z]` and `"r":[x,y,z,w]`. Y-axis shapes follow Rapier's conventions.

Course colliders (a course's `obstacles[].colliders`, the sim's own form): flat fields, `{"shape":"cuboid","half":[x,y,z]}`, `roundCuboid` with `half` and `border`, `ball`/`capsule`/`cylinder`/`cone` with `radius` and `halfHeight`, each with optional `t` and `r`. S12 game assets use the halfExtents/borderRadius names, never half/border.

Derivation when `collision` is absent. Every `op: union` node, including descendants (transforms composed), maps as: box -> cuboid(size/2 * s); roundBox -> roundCuboid(size/2 * s - radius, border = radius); sphere -> ball; capsule -> capsule(halfHeight = height/2); cylinder -> cylinder; cone -> cone.

Refusals: subtract/intersect nodes are ignored for collision; torus or ellipsoid without an override is refused ("no Rapier primitive for <kind>: add collision.colliders"); non-uniform node scale on ball/capsule/cylinder/cone is refused.

### S4. Asset store manifest and URLs
- Object URL: `https://assets.etcito.com/objects/<first 2 hex of sha256>/<sha256>`.
- Manifest (itself an object, fetched by its hash): `{ "format": "raa.manifest", "version": 0, "entries": { "<logical name>": { "sha256": "<64 hex>", "size": <bytes>, "type": "application/vnd.raa.prims+json", "version": <int> } } }`. This shape is assumed until raa-assets-tools publishes it.
- Every fetched object is verified (sha256 and size) and refused on mismatch.
- Courses with `"assetsManifest": null` read `fixtures/assets/<name>.prims.json`.
- The game never writes to the store.

### S5. FiestaWorld snapshot layout (sim/world)
`u32 magic 0x52465731 ('RFW1') | u32 version 1 | u32 playerCount | u32 systemCount | system sections in registration order | blob(RapierWorldSim.takeSnapshot())`

- blob = `u32 byteLength | ceil(len/4) u32 little-endian words` (the last word is zero-padded).
- The tick lives in the Rapier snapshot header.
- The desync hash is fnv1a32 of the full snapshot bytes. FiestaWorld does not implement `Simulation.hash`, so the session hashes the snapshot.
- System order of a match (pre and post): `match`, `bots`, `obstacles`, `mechLogic`, `mechanisms`, `characters`, `round`. A world without mechanisms keeps the same relative order of the systems it has.
- Mechanism bodies and joints live in the Rapier blob. Their ids, motor targets, signals and the event ring live in the `mechanisms` and `mechLogic` sections.

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
One relay `act` carries `a = { "k": "rb", "m": [ [toMask, ch, "<base64>"], ... ] }`: `toMask` is a bitmask of destination seats (bit = seat index = rollback peer id); `ch` is 0 for `fast` and 1 for `reliable`; the base64 string is one NetTransport packet.

Sender rules:
- Entries with identical (ch, bytes) to several peers merge into one mask.
- Each act stays <= 3800 bytes of JSON and <= 500 entries.
- A packet that does not fit in one act on its own is sent alone as `{ "k": "rbf", "id": u32, "i": part, "n": parts, "to": mask, "ch": c, "d": "<base64 chunk>" }` fragments.
- Flushes happen every 2 rendered frames (30 Hz).
- Rate budget per socket: <= 60 acts per rolling second and <= 3900 per rolling minute. Over budget, the oldest fast packets are dropped (counted) and reliable packets wait.

Receiver rules: the receiver keeps only entries whose mask has its own bit. A peer is closed after `player_left`/`opp_left` for its seat, or when the socket closes.

### S8. GameSaloon usage by the game
- **Relay match (2..4 humans).** Every client sends `{t:'queue', players:N, cadence:true, payload:{g:'royal-fiesta', v:1, name, c}}` on a dedicated socket. On `matched`: seat = `youAre` = rollback peer = player index, seed = `matched.seed`. If any `opps[i]` payload is not `{g:'royal-fiesta', v:1}`, the client refuses ("matched with a non-Royal-Fiesta client"), sends `bye` and re-queues. N > 4 is refused client-side.
- **WebRTC match (2..8 humans).** Rooms protocol on `/ws` with `hello {v:1, game:'royal-fiesta-1', name}`, then `create`/`join` by code with players `[{name, build:{characterId:'bean', bodyId:'c<colour>', wheelId:'none', gliderId:'none'}}]`. The owner sends `start`. On `started`, the members sorted by peer give player index = rank, and rollback peer = rooms peer id.
- **WebRTC mesh.** The lower peer id makes the offer. Two data channels carry binary messages: `fast` {ordered:false, maxRetransmits:0} and `reliable` {ordered:true}. Signaling uses `signal` data `{kind:'offer'|'answer', sdp}` / `{kind:'ice', candidate, sdpMid, sdpMLineIndex}` / `{kind:'ice-end'}`. ICE servers come from `welcome.iceServers` unless overridden; loopback proofs pass `[]`.
- **Hub.** A relay private room, `create {players:4}` / `join {code}`. Acts flow to the occupied seats before the room is full. The hub socket stays open during a match; it is non-cadence, so it obeys the hub frame budget (1.6).

### S9. Hub act payloads (game/hub/protocol)
- `{ "k": "hi", "v": 1, "name": "Bean", "c": 2 }`: sent on join, to newly seen seats, and every 5 s.
- `{ "k": "st", "s": seq, "p": [xcm, ycm, zcm], "f": facing 0..255, "m": CharMode, "e": emote 0..4, "q": 0|1, "x": 0|1 }`: sent at 5 Hz in the hub and at 1 Hz during a match (`x` = 1); integers only.
- Facing byte = `round(atan2(fx,fz)/TAU*256) & 255`, computed view-side. Emotes: 0 none, 1 wave, 2 dance, 3 cheer, 4 laugh, 2 s each. Malformed acts are dropped and counted.

### S10. Proof records (committed, JSON)
- `proofs/mN/raa-status.json`: `{ "available": bool, "raaDir": string|null, "reason": string, "apiVersion": string|null, "checkedAt": ISO date }`.
- `proofs/mN/captures.json` (only when RAA is available): `{ "renderer": "raa", "adapter": string, "software": bool, "pageRef": string, "captures": [ { "name", "width", "height", "sha256", "bytes", "nonEmpty": bool } ], "frameTiming": { "width":1920, "height":1080, "frames":600, "p50Ms", "p95Ms" } | null }`.
- PNGs live in out/ (untracked). Software results set `software: true`.

### S11. Golden files (`fixtures/golden/*.json`)
`{ "format": "royal-fiesta.golden", "version": 0, "name": string, "regenerate": "<exact command>", "ticks": [int], "rows": [ { "tick", "entity", "values": [numbers] } ], "hash": "<hex8 of final snapshot>" }`. Comparison is exact (===).

### S12. Game asset v1 (`assets/<world>/<id>.asset.json`), game/gameAsset
- Top keys: `format` `sdfm.game-asset`, `version` 1, `game` `royal-fiesta`; `id` (^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$, the file stem); `name`; `category` (obstacle | prop | scenery | character | cosmetic | fx); `world` (candy | ice | jungle | neon | common, the folder); `mesher {output: quad|paramesh|dc|lowpoly|poly, params?}`; `document` (the sdfm document, <= 2 MiB); `collision` (<= 8 entries, S3 halfExtents/borderRadius names); `anchors`, `bounds`, `hash` (lowercase sha256 hex of the canonical asset without `hash`).
- Authoring form (what SDF Modeler writes, MAMA `parseAssetFile` accepts): document node ids match ^[a-z][a-z0-9_]{0,47}$; each collision entry has one hidden `gameCollision` node whose document preorder equals the collision index order, so MAMA deriveCollision gives back the stored array; physics bodies sit at the asset origin.
- Optional `physics`. When absent, the asset is one fixed body made of all its colliders.
```
"physics": {
  "bodies": [ { "id": "plank", "type": "dynamic",          // dynamic | kinematic | fixed
                "colliders": [0, 1],                        // indices into collision; each collider in exactly one body
                "parts": ["plank"],                         // document part ids drawn with this body
                "t": [0,0,0], "r": [0,0,0,1],
                "density": 400, "friction": 0.6, "restitution": 0, "linearDamping": 0, "angularDamping": 0.05,
                "gravityScale": 1, "ccd": false, "surface": "normal" } ],   // normal | ice | mud | rubber
  "joints": [ { "id": "pivot", "kind": "hinge",              // fixed | hinge | slider | ball | spring | rope
                "a": "base", "b": "plank",
                "anchorA": [0,0.5,0], "anchorB": [0,0,0],   // in each body's frame
                "axis": [1,0,0],                            // unit, in body a's frame (hinge, slider)
                "limitsDeg": [-20, 20],                     // hinge; slider uses "limitsM": [min,max]; null = free
                "stiffness": 0, "damping": 0,               // spring only: rest length = anchor distance at load
                "lengthM": 0,                               // rope only: max distance
                "motor": null } ] }                         // or { "mode": "speed"|"target", "speedDegS"|"speedMS", "targetDeg"|"targetM",
                                                            //      "stiffness", "damping", "maxForce", "enabled" }
```
- Validation: body and joint ids ^[a-z0-9-]{1,32}$ and unique; every collider in exactly one body; joint bodies exist and differ; unit axes; ordered limits; density > 0, maxForce >= 0; caps from 1.6. Mass = density × volume.

### S13. Course v1 (`courses/<id>.course.json`), game/courseV1
- The v0 fields plus `world`, `decor`, `environment` and `podium`, with S12 asset ids. Kinds: race | survival | hub | podium | gallery.
- Per obstacle: optional `"surface": "normal" | "ice" | "mud" | "rubber"` (default normal). Per path node: optional `"wait": "<signal id>"` (a bot waits until the signal is on) and `"pull": "<lever id>"` (a bot grabs that lever).
- An obstacle whose asset has `physics` becomes a mechanism item; ObstacleSystem never sees it.
- Optional `mechanisms`:
```
"mechanisms": {
  "joints":   [ { "id", "kind", "a": {"item": "<obstacle id>"|null, "body": "<body id>"}, "b": {...}, ...S12 joint fields } ],  // item null = the world
  "switches": [ { "id", "plate": {"item","body"}, "mode": "weight", "onKg": 50, "offKg": 30 }
              | { "id", "plate": {"item","body"}, "mode": "travel", "joint": "<joint id>", "onM": 0.1, "offM": 0.05 } ],
  "levers":   [ { "id", "handle": {"item","body"}, "joint": "<hinge id>", "onDeg": 30, "offDeg": 10, "grabRangeM": 1 } ],
  "logic":    [ { "id", "op": "and"|"or"|"not"|"toggle"|"timer"|"delay"|"counter", "inputs": ["<signal id>"], "seconds": 0, "count": 0 } ],
  "animations": [ { "id", "target": {"item","body"}, "keys": [ { "atS": 0, "t": [x,y,z], "rDeg": [x,y,z] } ],
                    "easing": "linear"|"smooth", "loop": "loop"|"pingpong"|"once", "autostart": true } ],
  "links":    [ { "id", "from": "<signal id>", "to": { "kind": "motor", "joint", "on": {motor}, "off": {motor} }
                                              | { "kind": "door", "joint", "openDeg", "closedDeg" }
                                              | { "kind": "spring", "joint", "stiffnessOn", "stiffnessOff" }
                                              | { "kind": "animation", "animation", "on": "play"|"reverse", "off": "pause"|"reverse"|"stop" } } ],
  "budget": { "dynamicBodies": 24, "joints": 32 } }
```
- Signals are the switch, lever and logic ids, resolved to sorted indices (switches, then levers, then logic, each sorted by id).
- Animations target kinematic bodies only; a dynamic target is refused.
- v0 motions stay loadable; the shipped candy courses use mechanism presets instead (spinner/rotatingDoor = hinge motor, movingPlatform = keyframe track, bouncePad/seesaw = spring or limited hinge).
- Optional `sounds`:
```
"sounds": [ { "id", "patch": "<haa patch id>", "item": "<obstacle id>"|null, "t": [x,y,z],
              "event": null|"switchOn"|"switchOff"|"leverOn"|"leverOff"|"motorStart"|"motorStop"|"animStart"|"animEnd"|"impact",
              "signal": null|"<signal id>", "gain": 1, "refM": 2, "maxM": 60, "loop": false } ]
```
- The S13 hash covers mechanisms and sounds. Budget overflow, an unknown reference or a logic cycle without toggle/delay is refused with file#pointer.

### S14. Game manifest (`sdfm.game.json`), game/gameManifest
Optional `folders.audio` (default `audio`) and `mechanisms {version: 1, jointKinds, linkTargets, presets}`, which declares the S12/S13 mechanism schemas to sdfm. `manifestCoverage` reports them. Presets: seesaw, door, piston, crane, springPlatform, lever, pressurePlate.

### S15-S22. Reserved
Numbers that code comments cite. S16 is the client mesh cache key: `meshCacheKey` = sha256 of `${asset.hash}|${canonicalJson(asset.mesher)}|${mamaVersion}|${raaSdfmVersion}`.

### S23. Player Color material node
- MAMA node `input.player_color`, category input; output `color` (vec3); param `color` (kind color, default `#808080`): the preview colour.
- WGSL emit: `let <out> = select(<color>, mat_instance_tint.rgb, mat_instance_tint_set > 0.5);`.
- A material containing the node is tint mode `graph`: RAA does not multiply the instance tint after it. Every other material keeps `multiply`. raa-sdfm `mapMaterial` returns `tintMode: 'graph'` when the compiled WGSL uses `mat_instance_tint`.
- The game sets PALETTE[player] through `setInstanceTint`; sdfm previews a palette index. The old `player*` part-name convention does not exist.

### S24. Saved mesh (`assets/<world>/<id>.mesh`)
- Bytes = the game meshWire encoding of the MeshedAsset plus `key`: byte 0 = 1; u32 headerLen @1, u32 bufferCount @5 (big-endian); a UTF-8 JSON header `{assetId, hash, mesher, parts, triangles, key, data}` with typed arrays as buffer references; then per buffer a u32 length and its bytes.
- `key` is the S16 key. The game accepts the file iff key, assetId and hash match and `validMeshed` passes.
- Lookup order: memory/IndexedDB cache, then the `.mesh` file, then browser MAMA meshing; the result is cached. There is no server-side meshing.
- Never tracked. sdfm writes it on asset save (S29); content:pack copies it.
- `fixtures/golden/mesh-wire-vector.json` is checked by royal-fiesta and mama tests.

### S25. RAA overlays (raa API m21)
- `setOverlayLines(layer, positions: Float32Array, colors: Float32Array, opts: { depthTest: boolean; widthPx: number })`: positions are world-space segment pairs; colors are linear rgba per vertex. `clearOverlay(layer)`.
- Layers 0..7, drawn after tonemap, never captured into lighting. Used by sdfm gizmos (layer 1), sound icons (layer 2) and debug views.

### S26. Viewports, seats and resize (raa API m21, game)
- `setViewports(rects)`: 1..4 non-overlapping canvas fractions. `setViewportCamera(index, { eye, target, fovYDeg, near, far })`. `resize(cssWidth, cssHeight, dpr)`: backing size round(css × min(dpr, DPR_CAP)).
- The split layout follows 1.6. Cells with seat -1 show `overviewCamera(course)`: course bounds seen from above and behind at 50°.

### S27. Pad map (localStorage `rf.padmap.<gamepad id>`)
`{ "v": 1, "buttons": { "jump": 0, "dive": 1, "grab": 2, "pause": 9, "join": 9 }, "axes": { "x": 0, "y": 1 }, "invertY": false, "dead": 0.15 }`
- An invalid stored map loads as DEFAULT_PAD_MAP, with a console warning naming the key and the problem. Keyboard bindings keep `KeyBindings`.

### S28. Mechanism events, MechanismView and sound emitters (sim/mechanismSpec, game/audio)
- `MechEvent { tick; kind; source; x; y; z; strength }`: `source` is the signal index (switch/lever kinds), joint index (motor), animation index (anim) or item index (impact); `strength` 0..1. The `mechanisms` system keeps the last 64 in a snapshotted ring.
- `MechanismView` (MatchSim and the preview world): `mechanismEvents(fromTick, out)`, `mechanismBodyPose(ref, out)`, `signal(id)`; detected with `isMechanismView(sim)`.
- Course sounds become emitters: with `event`, one shot per matching event at its position; with `signal`, play/loop while on, stop when off; otherwise a loop at the item or point.
- haa `createSpatialScene` computes distance gain, equal-power pan from the listener facing, and doppler, and sets the reserved patch inputs `_dist`, `_pan`, `_doppler` when declared.

### S29. Content root and game file tools
- `index.json` = `{assets: [{id, world, path, hash, mesh?}], courses: [{id, path}], audio: [{id, path}]}`.
- `tools/play.ts` serves the content root live: courses, assets, `.mesh` files and `audio/*.haa.json`.
- `npm run content:pack -- <out dir>` validates strictly and copies courses, assets, meshes and audio.
- sdfm: `game_file_write` (text: `*.asset.json`, `*.course.json`, `*.ui.json`, `*.haa.json`, <= 2 MiB); `game_file_write_bytes` (`assets/<world>/<id>.mesh` only, <= 32 MiB, base64); `game_files_list` also lists `audio/*.haa.json`.

### S30. MCP parity (sdfm)
Every `src/app/game/controls/<name>.ts` exports `controls: readonly ControlSpec[]` (`{ id, panel, label, tool, tooltip }`). `CONTROLS` is their union. The unit `unit.game.mcp-parity` fails when a `tool` is not a registered ToolOperation or a tooltip is empty. Tool names are snake_case `<area>_<verb>`.

### S31. Cards (`.nmc/commands.json` in each repository)
- royal-fiesta entries are `{name, command, timeout_s, after?}`, at most 10. Cards: rf-tests (`npm test`), rf-judge-m2, rf-judge-m3 (all M3 items), and the M4 per-course commands `rf-judge-m4-candy-seesaw-run`, `-ice-slide-gates`, `-jungle-crane-crossing`, `-neon-piston-alley` (`tools/judgeCard.ts m4 --item 0..3`, timeout 1800, after rf-tests), plus the build/content steps they depend on. A milestone that needs a new entry removes or merges one; a finished milestone's per-item commands fold into its whole-file command.
- Other repositories: raa `raa-tests`; mama `mama-tests`; sdfm `sdfm-units`, `sdfm-judge`; haa `haa-tests`. Each card <= 3600 s.
- Judge input (`.nmc/judge/<name>.json`): `{ "page": "game"|"sdfm", "op": "gameCapture"|"sdfmCapture", "input": {...}, "judge": [ { "capture", "description" } ] }`, or the items form `{ page, op, items: [ { prefix?, input, judge } ] }` (judge-cards).

## Module ownership

| Module | Files | Consumes |
|---|---|---|
| workspace | `package.json`<br>`tsconfig.json`<br>`tsconfig.base.json`<br>`.gitignore`<br>`README.md`<br>`packages/sim/package.json`<br>`packages/sim/tsconfig.json`<br>`packages/game/package.json`<br>`packages/game/tsconfig.json`<br>`apps/headless/package.json`<br>`apps/headless/tsconfig.json`<br>`apps/web/package.json`<br>`apps/web/tsconfig.json` | — |
| guard | `tools/guard.ts`<br>`tools/test/guard.test.ts`<br>`.githooks/pre-commit`<br>`docs/private-assets.md` | workspace |
| bricks | `tools/bricks.ts`<br>`tools/test/bricks.test.ts` | workspace |
| refusal | `packages/sim/src/refusal.ts`<br>`packages/sim/test/refusal.test.ts` | workspace |
| detmath | `packages/sim/src/detmath.ts`<br>`packages/sim/src/vec.ts`<br>`packages/sim/test/detmath.test.ts`<br>`packages/sim/test/vec.test.ts`<br>`packages/sim/test/purity.test.ts` | workspace |
| world | `packages/sim/src/world.ts`<br>`packages/sim/src/groups.ts`<br>`packages/sim/test/world.test.ts` | detmath, refusal |
| flat-floor | `packages/sim/src/scenarios/flatFloor.ts`<br>`packages/sim/test/flatFloor.test.ts` | world |
| proofkit | `apps/headless/src/proofkit.ts`<br>`apps/headless/test/proofkit.test.ts` | bricks |
| m1-proof | `apps/headless/src/smoke.ts`<br>`apps/headless/proofs/m1-foundations.ts` | flat-floor, proofkit, guard, web-boot |
| web-boot | `apps/web/vite.config.ts`<br>`apps/web/index.html`<br>`apps/web/src/boot.ts` | flat-floor, bricks |
| course-model | `packages/sim/src/course.ts`<br>`packages/sim/src/mechanismSpec.ts`<br>`packages/sim/test/course.test.ts`<br>`packages/sim/test/mechanismSpec.test.ts` | detmath |
| motion | `packages/sim/src/obstacles/motion.ts`<br>`packages/sim/test/motion.test.ts` | course-model |
| obstacles | `packages/sim/src/obstacles/system.ts`<br>`packages/sim/src/obstacles/colliders.ts`<br>`packages/sim/test/obstacles.test.ts` | motion, world |
| prims | `packages/game/src/prims.ts`<br>`packages/game/test/prims.test.ts` | course-model, refusal |
| assets | `packages/game/src/assets.ts`<br>`packages/game/test/assets.test.ts`<br>`fixtures/assets/floor-tile.prims.json`<br>`fixtures/assets/floor-disc.prims.json`<br>`fixtures/assets/wall-block.prims.json`<br>`fixtures/assets/spinner-bar.prims.json`<br>`fixtures/assets/pendulum-hammer.prims.json`<br>`fixtures/assets/seesaw-plank.prims.json`<br>`fixtures/assets/rotating-door.prims.json`<br>`fixtures/assets/conveyor-belt.prims.json`<br>`fixtures/assets/bounce-pad.prims.json`<br>`fixtures/assets/moving-platform.prims.json`<br>`fixtures/assets/finish-arch.prims.json`<br>`fixtures/assets/checkpoint-gate.prims.json` | prims |
| course-loader | `packages/game/src/course.ts`<br>`packages/game/test/course.test.ts`<br>`fixtures/courses/obstacle-gallery.course.json`<br>`fixtures/courses/invalid/trimesh-collider.course.json`<br>`fixtures/courses/invalid/bad-motion.course.json`<br>`fixtures/courses/invalid/unknown-asset.course.json`<br>`fixtures/courses/invalid/race-without-finish.course.json` | assets, obstacles |
| node-files | `apps/headless/src/files.ts`<br>`apps/headless/test/files.test.ts` | course-loader, bricks |
| m2-proof | `apps/headless/proofs/m2-obstacles.ts`<br>`fixtures/golden/m2-obstacle-poses.json` | node-files, obstacles, proofkit |
| input | `packages/sim/src/input.ts`<br>`packages/sim/test/input.test.ts` | world |
| character | `packages/sim/src/character/constants.ts`<br>`packages/sim/src/character/controller.ts`<br>`packages/sim/src/character/system.ts`<br>`packages/sim/test/character.test.ts`<br>`packages/sim/test/characterMechanisms.test.ts` | input, obstacles, detmath, mech-physics |
| input-scripts | `apps/headless/src/scripts.ts`<br>`apps/headless/test/scripts.test.ts` | character, input, node-files |
| m3-proof | `apps/headless/proofs/m3-character.ts`<br>`fixtures/golden/m3-replay.json` | input-scripts, node-files, proofkit |
| match-rules | `packages/sim/src/match/setup.ts`<br>`packages/sim/src/match/rules.ts`<br>`packages/sim/test/rules.test.ts` | course-model, world |
| round-system | `packages/sim/src/match/roundSystem.ts`<br>`packages/sim/test/round.test.ts` | match-rules, character, obstacles |
| bots | `packages/sim/src/bots/brain.ts`<br>`packages/sim/src/bots/botSystem.ts`<br>`packages/sim/src/bots/behaviour.ts`<br>`packages/sim/src/bots/routes.ts`<br>`packages/sim/src/bots/courseRead.ts`<br>`packages/sim/test/bots.test.ts` | round-system, character, match-rules, mech-logic, mech-physics |
| match-sim | `packages/sim/src/match/matchSim.ts`<br>`packages/sim/src/match/log.ts`<br>`packages/sim/src/match/offline.ts`<br>`packages/sim/test/matchSim.test.ts` | bots, round-system, obstacles, character, mech-physics, mech-logic |
| course-set | `packages/game/src/courseSet.ts`<br>`packages/game/test/courseSet.test.ts`<br>`fixtures/courses/race-bean-dash.course.json`<br>`fixtures/courses/race-hammer-hill.course.json`<br>`fixtures/courses/survival-spin-zone.course.json`<br>`fixtures/courses/survival-hammer-ring.course.json`<br>`fixtures/courses/race-sprint.course.json`<br>`fixtures/courses/survival-sprint.course.json` | course-loader, match-rules |
| m4-proof | `apps/headless/src/cli.ts`<br>`apps/headless/proofs/m4-rounds.ts` | match-sim, course-set, node-files, proofkit |
| net-match | `packages/game/src/net/tuning.ts`<br>`packages/game/src/net/netMatch.ts`<br>`packages/game/src/net/pilot.ts`<br>`packages/game/test/netMatch.test.ts` | match-sim, input |
| net-metrics | `packages/game/src/net/metrics.ts`<br>`packages/game/test/metrics.test.ts` | net-match |
| m5-proof | `apps/headless/src/netsimMatch.ts`<br>`apps/headless/proofs/m5-netsim.ts` | net-metrics, net-match, course-set, node-files, proofkit |
| relay-client | `packages/game/src/net/ws.ts`<br>`packages/game/src/net/relayProtocol.ts`<br>`packages/game/src/net/relayClient.ts`<br>`packages/game/src/net/relayTransport.ts`<br>`packages/game/test/relayTransport.test.ts` | refusal, net-match |
| loopback-relay | `packages/game/src/net/loopbackRelay.ts`<br>`packages/game/test/loopbackRelay.test.ts` | relay-client |
| rooms-client | `packages/game/src/net/roomsProtocol.ts`<br>`packages/game/src/net/roomsClient.ts`<br>`packages/game/test/roomsClient.test.ts` | relay-client |
| webrtc | `packages/game/src/net/rtcBackend.ts`<br>`packages/game/src/net/webrtcTransport.ts`<br>`packages/game/test/webrtcTransport.test.ts` | rooms-client |
| rtc-node | `apps/headless/src/rtcNode.ts`<br>`apps/headless/test/rtcNode.test.ts` | webrtc |
| gamesaloon-local | `apps/headless/src/gamesaloon.ts`<br>`apps/headless/test/gamesaloon.test.ts` | bricks |
| m6-proof | `apps/headless/src/realMatch.ts`<br>`apps/headless/proofs/m6-transports.ts`<br>`docs/network.md`<br>`docs/gamesaloon-gaps.md` | relay-client, loopback-relay, webrtc, rtc-node, gamesaloon-local, m5-proof |
| render-port | `packages/game/src/render/port.ts`<br>`packages/game/src/render/nullPort.ts`<br>`packages/game/test/nullPort.test.ts` | prims |
| scene-view | `packages/game/src/render/palette.ts`<br>`packages/game/src/render/camera.ts`<br>`packages/game/src/render/sceneView.ts`<br>`packages/game/test/sceneView.test.ts`<br>`fixtures/assets/bean.prims.json` | render-port, match-sim, net-match |
| client-core | `packages/game/src/client/inputMap.ts`<br>`packages/game/src/client/inpageMatch.ts`<br>`packages/game/test/inpageMatch.test.ts` | scene-view, net-match, net-metrics |
| web-client | `apps/web/client.html`<br>`apps/web/src/client/main.ts`<br>`apps/web/src/client/hud.ts`<br>`apps/web/src/client/sources.ts`<br>`apps/web/src/nmc/ops.ts`<br>`apps/web/public/nmc.gpu.json` | client-core, raa-port, relay-client, webrtc, rooms-client |
| raa-port | `apps/web/src/render/raaStatus.ts`<br>`apps/web/src/render/raaPort.ts` | render-port, bricks |
| m7-proof | `apps/headless/proofs/m7-web.ts`<br>`proofs/m7/raa-status.json` | web-client, client-core, node-files, proofkit |
| hub-protocol | `packages/game/src/hub/protocol.ts`<br>`packages/game/test/hubProtocol.test.ts` | relay-client |
| hub-world | `packages/game/src/hub/hubWorld.ts`<br>`packages/game/src/hub/remotes.ts`<br>`packages/game/src/hub/queuePad.ts`<br>`packages/game/test/hubWorld.test.ts`<br>`fixtures/courses/hub-plaza.course.json`<br>`fixtures/assets/queue-pad.prims.json`<br>`fixtures/assets/plaza-fountain.prims.json` | hub-protocol, character, obstacles, course-loader |
| play-flow | `packages/game/src/hub/flow.ts`<br>`packages/game/src/hub/hubPilot.ts`<br>`packages/game/test/flow.test.ts` | hub-world, net-match, relay-client, client-core |
| web-play | `apps/web/play.html`<br>`apps/web/src/play/main.ts`<br>`apps/web/src/play/hubView.ts`<br>`apps/web/src/play/inpageHub.ts`<br>`apps/web/src/play/ops.ts` | play-flow, loopback-relay, scene-view, web-client |
| m8-proof | `apps/headless/src/hubLoop.ts`<br>`apps/headless/proofs/m8-hub.ts`<br>`proofs/m8/raa-status.json` | play-flow, gamesaloon-local, web-play, proofkit |
| content-formats | `packages/game/src/gameAsset.ts`<br>`packages/game/src/courseV1.ts`<br>`packages/game/src/gameManifest.ts`<br>`packages/game/src/mechanismsJson.ts`<br>`tools/content.ts`<br>`packages/game/test/gameAsset.test.ts`<br>`packages/game/test/courseV1.test.ts`<br>`packages/game/test/gameManifest.test.ts`<br>`packages/game/test/mechanismsJson.test.ts`<br>`tools/test/content.test.ts` | course-model, course-loader, prims, guard |
| sdf-runtime | `apps/web/src/sdf/meshWire.ts`<br>`apps/web/src/sdf/meshCache.ts`<br>`apps/web/src/sdf/meshFile.ts`<br>`apps/web/src/sdf/sdfPort.ts`<br>`apps/web/src/sdf/mamaApi.ts`<br>`apps/web/src/content/sdfLoad.ts`<br>`apps/web/src/content/v1Data.ts`<br>`tools/play.ts`<br>`apps/web/test/meshFile.test.ts`<br>`apps/web/test/meshCache.test.ts`<br>`apps/web/test/sdfTint.test.ts`<br>`apps/web/test/v1Data.test.ts`<br>`tools/test/play.test.ts`<br>`fixtures/golden/mesh-wire-vector.json` | content-formats, raa-player-color, raa-views, web-client |
| penguin-color | `assets/common/penguin.body.asset.json` | content-formats, sdf-runtime, sdfm-player-color |
| mech-physics | `packages/sim/src/mechanisms/bodies.ts`<br>`packages/sim/src/mechanisms/joints.ts`<br>`packages/sim/src/mechanisms/system.ts`<br>`packages/sim/src/mechanisms/preview.ts`<br>`packages/sim/test/mechanisms.test.ts`<br>`packages/sim/test/mechanismsL12.test.ts` | course-model, world, obstacles, detmath |
| game-audio | `apps/web/src/play/sound.ts`<br>`apps/web/src/play/courseAudio.ts`<br>`apps/web/src/client/sound.ts`<br>`packages/game/src/audio/context.ts`<br>`packages/game/src/audio/ids.ts`<br>`packages/game/src/audio/events.ts`<br>`packages/game/src/audio/gameAudio.ts`<br>`packages/game/src/audio/emitters.ts`<br>`packages/game/src/audio/pack/families.ts`<br>`packages/game/src/audio/pack/index.ts`<br>`packages/game/src/audio/pack/crowd.ts`<br>`packages/game/src/audio/pack/mix.ts`<br>`packages/game/src/audio/pack/crowdModel.ts`<br>`packages/game/test/emitters.test.ts`<br>`packages/game/test/audio.test.ts`<br>`apps/web/test/clientSound.test.ts`<br>`apps/web/test/courseAudio.test.ts` | course-model, haa-spatial, content-formats, match-sim, sdf-runtime |
| judge-cards | `.nmc/commands.json`<br>`.nmc/judge/m1.json`<br>`tools/judgeCard.ts`<br>`tools/test/judgeCard.test.ts` | — |
| raa-player-color | `raa:crates/raa-shader/src/lib.rs`<br>`raa:crates/raa-shader/src/wgsl/prelude.wgsl`<br>`raa:crates/raa-shader/src/wgsl/pass_forward.wgsl`<br>`raa:crates/raa-shader/src/wgsl/pass_prepass.wgsl`<br>`raa:crates/raa-shader/src/wgsl/pass_transparent.wgsl`<br>`raa:crates/raa-shader/src/wgsl/pass_furshell.wgsl`<br>`raa:crates/raa-js/src/api/m20_player_tint.rs`<br>`raa:packages/raa/types/m20-player-tint.d.ts`<br>`raa:docs/api/m20-player-tint.md`<br>`raa:packages/raa-sdfm/src/map-material.js`<br>`raa:packages/raa-sdfm/src/loader.js`<br>`raa:packages/raa-sdfm/test/player-tint.test.js`<br>`raa:crates/raa-js/tests/player_tint.rs` | mama-player-color |
| raa-views | `raa:crates/raa-js/src/api/m21_views.rs`<br>`raa:crates/raa-js/src/api/m07_pipeline.rs`<br>`raa:packages/raa/types/m21-views.d.ts`<br>`raa:docs/api/m21-views.md`<br>`raa:crates/raa-js/tests/views.rs`<br>`raa:.nmc/commands.json` | — |
| mama-player-color | `mama:src/core/material-graph/nodes/input.player_color.ts`<br>`mama:src/core/material-graph/nodes/manifest.ts`<br>`mama:src/core/material-graph/node-tags.ts`<br>`mama:src/core/material-graph/cpu-eval.ts`<br>`mama:src/core/material-graph/labels.ts`<br>`mama:src/core/material-graph/player-color.test.ts`<br>`mama:.nmc/commands.json` | — |
| mama-game-mesh | `mama:src/core/game/mesh-assets.ts`<br>`mama:src/core/game/mesh-file.ts`<br>`mama:src/core/game/mesh-file.test.ts`<br>`mama:src/core/game/mesh-wire-vector.json` | mama-player-color |
| haa-spatial | `haa:packages/haa/src/spatial.ts`<br>`haa:packages/haa/src/index.ts`<br>`haa:packages/haa/test/spatial.test.ts`<br>`haa:docs/spatial.md`<br>`haa:.nmc/commands.json` | — |
| sdfm-game-io | `sdfm:src/node/ops/games.ts`<br>`sdfm:src/app/game/games-client.ts`<br>`sdfm:src/app/game/asset-actions.ts`<br>`sdfm:src/app/game/controls.ts`<br>`sdfm:src/app/game/controls/game-files.ts`<br>`sdfm:src/app/nmc-ops.ts`<br>`sdfm:public/nmc.gpu.json`<br>`sdfm:scripts/game-units.mjs`<br>`sdfm:scripts/judge-card.mjs`<br>`sdfm:src/app/game/game-io.test.ts`<br>`sdfm:.nmc/commands.json` | mama-game-mesh, raa-player-color |
| sdfm-player-color | `sdfm:src/app/game/player-color.ts`<br>`sdfm:src/plugins/ui/64-player-color.ts`<br>`sdfm:src/node/ops/player-color.ts`<br>`sdfm:src/app/game/controls/player-color.ts`<br>`sdfm:src/app/game/player-color.test.ts`<br>`sdfm:.nmc/judge/player-color.json` | sdfm-game-io, mama-player-color, raa-player-color |
| mech-logic | `packages/sim/src/mechanisms/logic.ts`<br>`packages/sim/src/mechanisms/animation.ts`<br>`packages/sim/src/mechanisms/logicSystem.ts`<br>`packages/sim/test/mechLogic.test.ts` | mech-physics, course-model, detmath |
| candy-patches | `assets/candy/candy.spinner-bar.asset.json`<br>`assets/candy/candy.rotating-door.asset.json`<br>`assets/candy/candy.seesaw-plank.asset.json`<br>`assets/candy/candy.bounce-pad.asset.json`<br>`assets/candy/candy.moving-platform.asset.json`<br>`assets/candy/candy.pendulum-hammer.asset.json`<br>`courses/race-bean-dash.course.json`<br>`courses/race-hammer-hill.course.json`<br>`courses/survival-spin-zone.course.json`<br>`courses/survival-hammer-ring.course.json`<br>`courses/race-sprint.course.json`<br>`courses/survival-sprint.course.json`<br>`courses/obstacle-gallery.course.json`<br>`courses/hub-plaza.course.json`<br>`packages/game/test/candyPresets.test.ts` | content-formats, mech-logic, sdfm-physics |
| test-level | `courses/mech-lab.course.json`<br>`assets/candy/candy.mech-seesaw.asset.json`<br>`assets/candy/candy.mech-door.asset.json`<br>`assets/candy/candy.mech-piston.asset.json`<br>`assets/candy/candy.mech-crane.asset.json`<br>`assets/candy/candy.mech-spring-pad.asset.json`<br>`assets/candy/candy.mech-lever.asset.json`<br>`assets/candy/candy.mech-plate.asset.json`<br>`audio/mech-click.haa.json`<br>`audio/mech-motor.haa.json`<br>`audio/mech-thud.haa.json`<br>`.nmc/judge/m2.json`<br>`packages/game/test/mechLab.test.ts` | content-formats, mech-logic, match-sim, sdfm-physics, sdfm-sound |
| sdfm-physics | `sdfm:src/app/game/physics/model.ts`<br>`sdfm:src/app/game/physics/picking.ts`<br>`sdfm:src/app/game/physics/gizmos.ts`<br>`sdfm:src/app/game/physics/presets.ts`<br>`sdfm:src/app/game/physics/preview.ts`<br>`sdfm:src/app/game/physics/contraptions.ts`<br>`sdfm:src/app/game/physics/mechanisms.ts`<br>`sdfm:src/plugins/ui/65-physics.ts`<br>`sdfm:src/node/ops/physics.ts`<br>`sdfm:src/app/game/controls/physics.ts`<br>`sdfm:src/app/game/physics/physics.test.ts`<br>`sdfm:package.json`<br>`sdfm:.nmc/judge/physics.json` | sdfm-game-io, mech-logic, mech-physics, content-formats, raa-views |
| sdfm-sound | `sdfm:src/app/game/sounds.ts`<br>`sdfm:src/plugins/ui/66-sounds.ts`<br>`sdfm:src/node/ops/sounds.ts`<br>`sdfm:src/app/game/controls/sounds.ts`<br>`sdfm:src/app/game/sounds.test.ts`<br>`sdfm:.nmc/judge/sound.json` | sdfm-game-io, sdfm-physics, haa-spatial |
| game-page | `apps/web/game.html`<br>`apps/web/src/game/main.ts`<br>`apps/web/src/game/ops.ts`<br>`apps/web/src/game/uiTour.ts`<br>`apps/web/test/gameLayout.test.ts`<br>`.nmc/judge/m3.json` | local-play, pad-remap, web-input, sdf-runtime, game-audio, scene-view, web-client |
| local-play | `packages/game/src/client/seats.ts`<br>`packages/game/src/client/splitLayout.ts`<br>`packages/game/src/client/localMatch.ts`<br>`packages/game/test/seats.test.ts`<br>`packages/game/test/splitLayout.test.ts`<br>`packages/game/test/localMatch.test.ts` | client-core, match-sim, render-port, course-model |
| pad-remap | `packages/game/src/client/padMap.ts`<br>`packages/game/src/screens/padRemap.ts`<br>`packages/game/test/padMap.test.ts` | client-core |
| web-input | `apps/web/src/input/input.ts`<br>`apps/web/src/input/touch.ts`<br>`apps/web/src/input/padRemapScreen.ts`<br>`apps/web/test/webInput.test.ts` | pad-remap, local-play, client-core |
| world-courses | `courses/candy-seesaw-run.course.json`<br>`courses/ice-slide-gates.course.json`<br>`courses/jungle-crane-crossing.course.json`<br>`courses/neon-piston-alley.course.json`<br>`assets/ice/ice.slide-gate.asset.json`<br>`assets/ice/ice.floe-platform.asset.json`<br>`assets/ice/ice.floor-tile.asset.json`<br>`assets/ice/ice.wall-block.asset.json`<br>`assets/jungle/jungle.crane-arm.asset.json`<br>`assets/jungle/jungle.vine-bridge.asset.json`<br>`assets/jungle/jungle.floor-tile.asset.json`<br>`assets/jungle/jungle.wall-block.asset.json`<br>`assets/neon/neon.piston-block.asset.json`<br>`assets/neon/neon.laser-door.asset.json`<br>`assets/neon/neon.floor-tile.asset.json`<br>`assets/neon/neon.wall-block.asset.json`<br>`audio/ice-creak.haa.json`<br>`audio/jungle-crank.haa.json`<br>`audio/neon-hum.haa.json`<br>`.nmc/judge/m4.json`<br>`packages/game/test/worldCourses.test.ts` | content-formats, mech-logic, bots, test-level, game-audio, judge-cards, match-sim |

## Module: workspace
Consumes: none.

Files: `package.json`, `tsconfig.json`, `tsconfig.base.json`, `.gitignore`, `README.md`, `packages/sim/package.json`, `packages/sim/tsconfig.json`, `packages/game/package.json`, `packages/game/tsconfig.json`, `apps/headless/package.json`, `apps/headless/tsconfig.json`, `apps/web/package.json`, `apps/web/tsconfig.json`.

Files only, no code exports.

Root package.json: name `royal-fiesta`, private, MIT, type module, engines node >= 22.18, workspaces `["packages/*", "apps/*"]`.
- Scripts: `test` (glob of 1.1), `typecheck`, `typecheck:mama`, `build` (= web:build), `guard`, `bricks`, `smoke`, `rf` (headless cli), `audio:bake`, `ui:fonts`, `web:build`, `content:pack`, `play`, `wavedash`, `etcito:build`, `prepare`. There is no mesh-baking script.
- Dependencies `@etcito/raa-anim` and `@etcito/uaa` (sibling `file:`); devDependencies `@etcito/haa` 0.1.1 and `@etcito/raa-assets-tools` 0.1.0 tarballs, `@types/node`, `sharp`, `typescript`.

Workspace packages (each `"exports": {"./*": "./src/*.ts"}` and `typecheck`):
- `@royal-fiesta/sim`: rollback, rollback-rapier, Rapier 0.21.0.
- `@royal-fiesta/game`: sim, rollback, rollback-rapier, Rapier, `@etcito/haa` 0.1.1.
- `@royal-fiesta/headless`: sim, game, node-datachannel (exact).
- `@royal-fiesta/web`: sim, game, rollback, Rapier, and the sibling `file:` bricks `@etcito/raa`, `@etcito/raa-anim`, `@etcito/raa-sdfm` (raa `dist/bricks`) and `@etcito/haa-spatial` (haa `packages/haa`, 0.2.0); devDependency vite (exact); `build` = `vite build --config anim-brick.vite.config.ts`.

Other files:
- `.gitignore`: `out/`, `.vite/`, `*.png`, `*.mesh`, `.nmc/*` with `!.nmc/commands.json` and `!.nmc/judge/`.
- README: what Royal Fiesta is; setup with the sibling checkouts (raa, haa, uaa, MAMA) and `npm run bricks -- check`; commands; proofs; the cards section pointing to `.nmc/commands.json`; the assets policy.

## Module: guard
Consumes: workspace.

Files: `tools/guard.ts`, `tools/test/guard.test.ts`, `.githooks/pre-commit`, `docs/private-assets.md`.

```ts
export type GuardRule = 'binary-ext' | 'nul-byte' | 'not-utf8' | 'too-large' | 'asset-outside-fixtures' | 'fixture-not-json' | 'fixture-too-large' | 'public-leak'
export interface GuardViolation { path: string; rule: GuardRule; detail: string }
export interface LeakHit { pattern: string; index: number; excerpt: string }
export const BINARY_EXTS: readonly string[]
export const MAX_FILE_BYTES = 262144
export const MAX_FIXTURE_BYTES = 65536
export const MAX_ASSET_FILE_BYTES = 2200000
export function leakScan(text: string, deny?: readonly string[]): LeakHit[]
export function redact(text: string, secrets: readonly string[]): string
export function checkFile(path: string, bytes: Uint8Array): GuardViolation[]
export function checkPaths(root: string, paths: readonly string[]): GuardViolation[]
export function trackedFiles(root: string): string[]
export function stagedFiles(root: string): string[]
export function main(argv: string[]): number
```

Rules of `checkFile`:
- extension in BINARY_EXTS (images, models, archives, audio/video, fonts, `.wasm`, `.bin`, `.pdf`, `.mesh`, ...);
- a NUL byte in the first 8000 bytes; invalid UTF-8; larger than MAX_FILE_BYTES (package-lock.json exempt; `assets/` files use MAX_ASSET_FILE_BYTES);
- placement: `.prims.json`/`.manifest.json` in `fixtures/`; `.course.json` in `fixtures/` or `courses/`; `.asset.json` in `fixtures/` or `assets/<world>/`; `.ui.json` in `ui/`; `.haa.json` in `fixtures/` or `audio/`;
- a file under `fixtures/` that is not JSON or exceeds MAX_FIXTURE_BYTES;
- `public-leak`: home paths, private IPv4, internal hosts, tokens and private keys, plus `RF_GUARD_DENY` substrings (the guard's own files exempt).

`trackedFiles` = `git ls-files -z`; `stagedFiles` = `git diff --cached --name-only -z --diff-filter=ACMR`.

CLI: `tools/guard.ts [--staged]` prints `guard: <n> files checked, <m> violations`, then `<path>: <rule>: <detail>` lines, exit 1 when m > 0. `.githooks/pre-commit` runs it with `--staged`. `docs/private-assets.md` documents the placement, saved-mesh and audio rules.

Tests cover each rule, `.mesh` refused as binary, `.haa.json` refused outside audio/ and fixtures/, and a clean pass of the current tree.

## Module: course-model
Consumes: detmath.

Files: `packages/sim/src/course.ts`, `packages/sim/src/mechanismSpec.ts`, `packages/sim/test/course.test.ts`, `packages/sim/test/mechanismSpec.test.ts`.

course.ts:
```ts
export type CourseKind = 'race' | 'survival' | 'hub' | 'gallery'
export type ProfileName = 'standard' | 'sprint'
export const MOTION_KINDS: readonly ['static','spinner','pendulum','seesaw','rotatingDoor','conveyor','bouncePad','movingPlatform']
export type MotionKind = typeof MOTION_KINDS[number]
export const MAX_OBSTACLES = 96
export const MAX_COLLIDERS_PER_OBSTACLE = 8
export type Surface = 'normal' | 'ice' | 'mud' | 'rubber'
export const SURFACES: readonly Surface[]
export type ColliderSpec =
  | { shape: 'cuboid'; half: Vec3; t: Vec3; r: Quat }
  | { shape: 'roundCuboid'; half: Vec3; border: number; t: Vec3; r: Quat }
  | { shape: 'ball'; radius: number; t: Vec3; r: Quat }
  | { shape: 'capsule' | 'cylinder' | 'cone'; halfHeight: number; radius: number; t: Vec3; r: Quat }
export type Motion =
  | { kind: 'static' }
  | { kind: 'spinner'; axis: Vec3; radPerTick: number; phase: number }
  | { kind: 'pendulum'; pivot: Vec3; axis: Vec3; amp: number; periodTicks: number; phase: number }
  | { kind: 'seesaw'; axis: Vec3; maxAngle: number; spring: number; damping: number; inertia: number }
  | { kind: 'rotatingDoor'; axis: Vec3; stepAngle: number; periodTicks: number; moveTicks: number; phaseTicks: number }
  | { kind: 'conveyor'; velocity: Vec3 }
  | { kind: 'bouncePad'; speed: number }
  | { kind: 'movingPlatform'; offset: Vec3; periodTicks: number; phase: number; wave: 'sine' | 'pingpong' }
export interface ObstacleSpec { id: string; asset: string; t: Vec3; r: Quat; s: Vec3; friction: number; colliders: ColliderSpec[]; motion: Motion; surface?: Surface }
export interface Box { center: Vec3; half: Vec3 }
export interface SpawnPoint { t: Vec3; facing: { x: number; z: number } }
export interface Checkpoint { box: Box; respawn: SpawnPoint }
export interface PathNode { p: Vec3; jump: boolean; dive: boolean; wait?: string; pull?: string }
export interface Region { id: number; box: Box; adjacent: number[] }
export interface ResolvedCourse {
  id: string; name: string; kind: CourseKind; profiles: ProfileName[]
  timeLimitS: number; killPlaneY: number
  spawns: SpawnPoint[]; checkpoints: Checkpoint[]; finish: Box | null
  path: PathNode[]; regions: Region[]; queuePad: Box | null
  obstacles: ObstacleSpec[]
  contentHash: number
  mechanisms?: MechanismSpec | null
  sounds?: SoundSpec[]
}
export function inBox(b: Box, p: Vec3): boolean
export function regionOf(c: ResolvedCourse, p: Vec3): number
export function surfaceOf(o: ObstacleSpec): Surface
```
- ResolvedCourse is plain data produced by game/course or game/courseV1. Colliders are already scaled and in the obstacle's local frame.
- `inBox` tests |p - center| <= half per axis; `regionOf` returns the first containing region id or -1.
- `contentHash` mixes the canonical course JSON with the referenced asset hashes; it is part of the setup hash.
- A missing `surface` reads as 'normal' (`surfaceOf`); a missing `mechanisms` reads as none.

mechanismSpec.ts is the converted sim form of S12/S13 (radians, metres, kg/m³, ticks; indices instead of ids, sorted by id):
```ts
export type BodyType = 'dynamic' | 'kinematic' | 'fixed'
export type JointKind = 'fixed' | 'hinge' | 'slider' | 'ball' | 'spring' | 'rope'
export interface BodySpec { id: string; type: BodyType; colliders: ColliderSpec[]; rest: Pose; density: number; friction: number; restitution: number; linearDamping: number; angularDamping: number; gravityScale: number; ccd: boolean; surface: Surface }
export interface MotorSpec { mode: 'speed' | 'target'; speed: number; target: number; stiffness: number; damping: number; maxForce: number; enabled: boolean }
export interface BodyRef { item: number; body: number } // item -1 = the world
export interface JointSpec { id: string; kind: JointKind; a: BodyRef; b: BodyRef; anchorA: Vec3; anchorB: Vec3; axis: Vec3; limits: [number, number] | null; stiffness: number; damping: number; length: number; motor: MotorSpec | null }
export interface MechItem { id: string; asset: string; t: Vec3; r: Quat; s: Vec3; bodies: BodySpec[]; joints: JointSpec[] }
export interface SwitchSpec { id: string; plate: BodyRef; mode: 'weight' | 'travel'; onKg: number; offKg: number; joint: number; onM: number; offM: number }
export interface LeverSpec { id: string; handle: BodyRef; joint: number; onAngle: number; offAngle: number; grabRange: number }
export type LogicOp = 'and' | 'or' | 'not' | 'toggle' | 'timer' | 'delay' | 'counter'
export interface LogicSpec { id: string; op: LogicOp; inputs: number[]; ticks: number; count: number }
export type LinkTarget =
  | { kind: 'motor'; joint: number; on: MotorSpec; off: MotorSpec }
  | { kind: 'door'; joint: number; openAngle: number; closedAngle: number }
  | { kind: 'spring'; joint: number; stiffnessOn: number; stiffnessOff: number }
  | { kind: 'animation'; animation: number; on: 'play' | 'reverse'; off: 'pause' | 'reverse' | 'stop' }
export interface LinkSpec { id: string; from: number; to: LinkTarget }
export interface KeyframeSpec { tick: number; t: Vec3; r: Quat }
export interface AnimationSpec { id: string; target: BodyRef; keys: KeyframeSpec[]; easing: 'linear' | 'smooth'; loop: 'loop' | 'pingpong' | 'once'; autostart: boolean }
export interface MechanismBudget { dynamicBodies: number; joints: number }
export interface MechanismSpec { items: MechItem[]; joints: JointSpec[]; switches: SwitchSpec[]; levers: LeverSpec[]; logic: LogicSpec[]; links: LinkSpec[]; animations: AnimationSpec[]; signals: string[]; budget: MechanismBudget }
export type MechEventKind = 'switchOn' | 'switchOff' | 'leverOn' | 'leverOff' | 'motorStart' | 'motorStop' | 'animStart' | 'animEnd' | 'impact'
export interface MechEvent { tick: number; kind: MechEventKind; source: number; x: number; y: number; z: number; strength: number }
export interface SoundSpec { id: string; patch: string; item: number; t: Vec3; event: MechEventKind | null; signal: number; gain: number; ref: number; max: number; loop: boolean }
export interface MechanismView { mechanismEvents(fromTick: number, out: MechEvent[]): number; mechanismBodyPose(ref: BodyRef, out: Pose): boolean; signal(id: string): boolean }
export const MECH_EVENT_RING = 64
export const MECH_CAPS: { maxItems: 48; maxBodiesPerItem: 16; maxJoints: 64; maxSignals: 64; maxKeys: 32; maxSounds: 32 }
export const DEFAULT_BUDGET: MechanismBudget // { dynamicBodies: 24, joints: 32 }
export function isMechanismView(sim: unknown): sim is MechanismView
export function emptyMechanisms(): MechanismSpec
export function countBudget(m: MechanismSpec): MechanismBudget
```
- `signals` = switch ids, then lever ids, then logic ids, each group sorted. `isMechanismView` checks the three methods are functions.

The raa-anim graph facade belongs to this module's card: raa `packages/raa-anim/index.js` returns `loadGraph` from `loadRaaAnim`, `index.d.ts` re-exports the graph types (AnimationGraph, AnimationGraphState, GraphStep, GraphEvent, GraphParams, GraphParamValue, RaaAnimGraphApi), and `packages/game/src/anim/brick.ts` imports them from `@etcito/raa-anim` with no deep-import shim.

Tests: isMechanismView, emptyMechanisms, countBudget, surfaceOf defaulting.

## Module: character
Consumes: input, obstacles, detmath, mech-physics.

Files: `packages/sim/src/character/constants.ts`, `packages/sim/src/character/controller.ts`, `packages/sim/src/character/system.ts`, `packages/sim/test/character.test.ts`, `packages/sim/test/characterMechanisms.test.ts`.

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
export const SURFACE_TUNING: Readonly<Record<Surface, { accel: number; brake: number; maxRun: number; bounce: number }>>
// normal {1, 1, 1, 0}; ice {0.25, 0.15, 1.1, 0}; mud {0.7, 1.2, 0.6, 0}; rubber {1, 1, 1, 0.6}
export const CharMode: { readonly ground: 0; readonly air: 1; readonly dive: 2; readonly diveRecover: 3; readonly stunned: 4; readonly grabbing: 5; readonly frozen: 6; readonly parked: 7 }
export type CharModeValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
```

controller.ts:
```ts
export function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number, out: { x: number; z: number }): { x: number; z: number }
export function turnFacing(fx: number, fz: number, tx: number, tz: number, maxAngle: number, out: { x: number; z: number }): { x: number; z: number }
```
`approach2` moves (vx,vz) toward the target by at most maxDelta; `turnFacing` rotates the unit facing by at most maxAngle (datan2/dsincos), unchanged for a target shorter than 1e-6.

system.ts:
```ts
export interface CharacterOptions { playerCount: number }
export interface CharState { pos: Vec3; vel: Vec3; facing: { x: number; z: number }; mode: number; grounded: boolean; groundObstacle: number; knockbacks: number; teleportTick: number; groundBody: BodyRef | null; grabLever: number }
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
  grabbingLever(p: number): number
  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void
  postStep(ctx: WorldCtx<PlayerInput>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<PlayerInput>): void
}
```

Bodies and placement:
- `init` creates playerCount dynamic capsules in index order (rotations locked, canSleep false, friction 0 combine Min, restitution 0), parked at parkOrigin + (p*parkStep, 0, 0) with gravityScale 0 and no collision groups.
- `place` teleports to `at.t` + (0, halfHeight+radius+0.01, 0) with zero velocity, gravityScale 1, groups CHAR/(STATIC|MOVING|CHAR), mode air, teleportTick = ctx.tick. `park` reverses it. `freeze` ignores input and zeroes horizontal velocity. `override` is consumed by the next preStep.

preStep, per player in ascending index:
1. Effective code = override, else encode(inputs[p]); button edges against prevButtons.
2. Ground probe: a downward ray of length halfHeight+radius+groundProbe+max(0,-vy)*dt, filter STATIC|MOVING; grounded when n.y >= groundMinNy. groundObstacle = obstacleOfCollider(hit) or -1; groundBody = `mechanisms.bodyOfCollider(hit)` when the system exists.
3. Base velocity = obstacle pointVelocity (kinematic obstacle or conveyor) or `mechanisms.pointVelocity(ref, hit)` on a mechanism body, else 0.
4. Mode machine: stunned counts down; dive until grounded, then diveRecover with a brake; grabbing while held, at most grabMaxTicks, then cooldown.
5. Horizontal: desired = move*maxRun relative to the base, approached at groundAccel/groundBrake/airAccel; accel, brake and maxRun scale by SURFACE_TUNING of the ground (surfaceOf(obstacle) or the body's `surface`). Facing turns at turnRate*dt.
6. Jump: buffered press fires when grounded or coyote > 0: vy = jumpSpeed + base.y. On rubber, a landing faster than 3 m/s sets vy = bounce × impact speed.
7. Dive: once per airtime, v_h = facing*max(|v_h|, diveSpeed), vy = grounded ? diveUp : max(vy, 0.6*diveUp).
8. A bounce-pad obstacle sets vy = speed and mode air. 9. setLinvel.

Grab pass (index order): a grab press within a lever's grabRange of its handle sets grabLever and calls `mechanisms.grabHandle(ctx, lever, p)`; release or grabMaxTicks calls `releaseHandle`. Lever grabs take priority. Otherwise the grabber picks the nearest non-parked character within grabRange with dot(facing, dir) >= grabConeDot (ties to the lower index): the target's horizontal velocity *= grabSlow, the grabber is capped at grabberMaxSpeed.

postStep, per player:
- Bumps: contact pairs sorted by index, counting MOVING obstacle colliders and dynamic/kinematic mechanism colliders; when dot(v_obs - v_char, n) > bumpMinSpeed the character is stunned for stunTicks with velocity v_obs*knockGain + n_h*knockNormal + (0, knockUp, 0), knockbacks++.
- Loads: grounded on a see-saw calls obstacles.addLoad; grounded on a mechanism body calls `mechanisms.addLoad(ref, pos, CHAR.mass)` (weight switches).

Snapshot per player: mode, timer, coyote, jumpBuffer, prevButtons, diveUsed, grabTarget, grabTicks, grabCooldown, facing, grounded, groundObstacle, knockbacks, teleportTick, frozen, parked, groundBody (i16 item, i16 body), grabLever i16.

The system works without ObstacleSystem and without mechanisms. Tests cover a ride on a hinge-driven platform, ice/mud/rubber, weight loads and a lever grab.

## Module: bots
Consumes: round-system, character, match-rules, mech-logic, mech-physics.

Files: `packages/sim/src/bots/brain.ts`, `packages/sim/src/bots/botSystem.ts`, `packages/sim/src/bots/behaviour.ts`, `packages/sim/src/bots/routes.ts`, `packages/sim/src/bots/courseRead.ts`, `packages/sim/test/bots.test.ts`.

brain.ts is pure and shared with the view-side pilots:
```ts
export interface BotSkill { reactionTicks: number; aimError: number; jumpLead: number; diveChance: number }
export function rollSkill(rng: Rng): BotSkill
export interface BrainMemory { pathIndex: number; stuckTicks: number; lastX: number; lastZ: number; wobble: number; ticks: number; waitTicks: number }
export function newMemory(): BrainMemory
export interface BrainInput { course: ResolvedCourse; pos: Vec3; vel: Vec3; facing: { x: number; z: number }; grounded: boolean; mode: number; obstacleAhead: boolean; hazardNear: boolean; signalOn?: (id: string) => boolean; leverNear?: (id: string) => boolean; bot?: { behaviour: BotBehaviour; route: RoutePlan; localTick: number } }
export function raceBrain(b: BrainInput, skill: BotSkill, mem: BrainMemory, rng: Rng): number
export function survivalBrain(b: BrainInput, skill: BotSkill, mem: BrainMemory, rng: Rng): number
export function evaluateBrain(b: BrainInput, behaviour: BotBehaviour, route: RoutePlan, tick: number, stuckTicks?: number): number
```
- `rollSkill`: reaction 0..10 (int), aimError 0..0.2, jumpLead 0..0.4 m, diveChance 0..0.3, in a fixed draw order.
- `raceBrain`: follows path nodes (advance within 1.5 m), direction rotated by aimError*wobble (wobble redrawn every 45 ticks, `ticks` is the cadence counter); jumps on jump nodes within 2+jumpLead m, on obstacleAhead or when stuck > 30; dives on dive nodes or near the finish with diveChance.
- Mechanism rules: a `wait` node holds neutral input until signalOn(wait), at most 600 ticks (waitTicks). A `pull` node is skipped when signalOn(pull) is already true; otherwise the bot walks to the lever handle and, once leverNear(pull), presses grab in short presses (4 ticks held, 8 released) until signalOn(pull) or 240 ticks. Absent callbacks read as false.
- `survivalBrain` heads for the nearest safe spot, jumps when hazardNear, re-targets every 120 ticks.
- `evaluateBrain` drives a bot from a data-driven BotBehaviour (behaviour.ts: parseBehaviour, loadBehaviour, bindBehaviour) and a region RoutePlan (routes.ts: planRoute, updateRoute, cheapestRegions, replanDue).
- All return an encodeInput code.

courseRead.ts (pure reads): readNavigation, regionNeighbours, regionDistance, nearestPathIndex, readMechanisms, `readLevers(course)` ({index, id, handle, grabRange, rest} in world space), `leverByPull`, `signalIndex`, obstaclePhase, phaseInWindow, and courseCapabilities (with `levers` and `hasLevers`).

botSystem.ts:
```ts
export class BotSystem implements SimSystem<PlayerInput> {
  readonly name: 'bots'
  constructor(setup: MatchSetup, behaviours?: readonly BotBehaviour[])
  isBot(p: number): boolean
  setBot(p: number, on: boolean): void
  setBehaviours(behaviours: readonly BotBehaviour[]): void
  setBehaviour(p: number, behaviour: BotBehaviour | null): void
  actionOf(p: number): number
  resetForRound(ctx: WorldCtx<PlayerInput>): void
  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void
  postStep(ctx: WorldCtx<PlayerInput>): void
  playerDropped(ctx: WorldCtx<PlayerInput>, p: number): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<PlayerInput>): void
}
```
- Bots are players with humans[p] false, plus dropped players. Each has Rng = new Rng(setup.seed).fork(0xb0700000 + p) and a skill rolled at construction.
- preStep, per active, alive, non-frozen bot in index order: obstacleAhead = a 1.2 m knee-height ray along facing (STATIC|MOVING, normal.y < 0.6); hazardNear = a MOVING collider within 1.6 m (mechanism bodies included through their groups); signalOn reads `mechLogic.signal`; leverNear compares the horizontal distance to the handle's current pose (`mechanisms.bodyPose`) with grabRange; the brain's code goes through a reaction ring into characters.override.
- Snapshot per bot: isBot, rng state, BrainMemory (with ticks, then waitTicks i32), reaction ring, behaviour id, route plan, waypoint.

Tests: wait hold and timeout, pull press and skip, absent callbacks, courseRead on mech-lab, 8 bots finishing mech-lab in sprint with waits and pulls exercised, snapshot determinism mid-wait. World-course bot runs live in packages/game/test/worldCourses.test.ts.

## Module: match-sim
Consumes: bots, round-system, obstacles, character, mech-physics, mech-logic.

Files: `packages/sim/src/match/matchSim.ts`, `packages/sim/src/match/log.ts`, `packages/sim/src/match/offline.ts`, `packages/sim/test/matchSim.test.ts`.

log.ts:
```ts
export interface MatchLog { format: 'royal-fiesta.matchlog'; version: 0; seed: number; profile: ProfileName; playerCount: number; humans: boolean[]; setupHash: string; rounds: RoundLogEntry[]; winner: number; podium: number[]; finalTick: number; finalHash: string }
export interface RoundLogEntry { index: number; kind: 'race' | 'survival'; final: boolean; course: string; startTick: number; endTick: number; participants: number[]; target: number; qualified: number[]; eliminated: number[]; reason: RoundReason }
export function matchLogJson(log: MatchLog): string
```
The shape is S6; stable key order, 2-space indent, trailing newline.

matchSim.ts:
```ts
export const Phase: { readonly intro: 0; readonly playing: 1; readonly roundEnd: 2; readonly intermission: 3; readonly podium: 4; readonly done: 5 }
export interface MatchViewState { tick: number; phase: number; phaseTicksLeft: number; roundIndex: number; roundKind: 'race' | 'survival' | null; final: boolean; courseIndex: number; roundTicksLeft: number; alive: number; target: number; qualifiedCount: number; winner: number; podium: number[] }
export interface CharacterView { pos: Vec3; vel: Vec3; facing: { x: number; z: number }; mode: number; status: number; parked: boolean; teleportTick: number }
export class MatchSim implements Simulation<PlayerInput>, MechanismView {
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
  mechanismItemCount(): number
  mechanismItem(i: number): MechItem
  mechanismEvents(fromTick: number, out: MechEvent[]): number
  mechanismBodyPose(ref: BodyRef, out: Pose): boolean
  signal(id: string): boolean
  course(): ResolvedCourse | null
  log(): MatchLog
  stateHash(): number
  free(): void
}
export function createMatchSim(R: RapierModule, setup: MatchSetup): MatchSim
```

Construction: validateSetup; systems in S5 order: the internal 'match' system, BotSystem, ObstacleSystem, MechLogicSystem, MechanismSystem (each over setup.courses), CharacterSystem({playerCount}), RoundSystem. view = {entities: playerCount, stride: 3, read: characters.readPositions}; regions from the course regions.

The 'match' system drives the phases:
- Each round setup takes planRound(roundIndex, alive), picks the course with pickCourse over coursePool (survival pool for the final) using the match rng (new Rng(seed).fork(0x6d617463)), switches course, draws the spawn order (Fisher-Yates, match rng), calls round.begin, freezes everyone and calls bots.resetForRound.
- Course switches unload mechLogic, mechanisms, obstacles in that order and load obstacles, mechanisms, mechLogic.
- intro -> playing unfreezes the participants; round.over -> roundEnd (round.end, result stored); roundEnd -> intermission, or podium when <= 1 player remains or the round was final; podium shows the top 3 frozen on spawns 0..2 (winner, then reverse elimination order); podium -> done completes the log with finalTick and finalHash. Once done, step() only advances physics and ticks.
- The match snapshot holds phase, phaseTicksLeft, roundIndex, lastCourse, rng state, round results, winner and podium. Mechanism state lives in the systems' own sections.

MechanismView forwards to `mechanisms` (events, body poses) and `mechLogic` (signal by id).

offline.ts:
```ts
export interface OfflineOptions { forcedRollback?: { every: number; back: number; fresh: boolean }; maxTicks?: number; humanCodes?: (tick: number, p: number) => number }
export interface OfflineResult { log: MatchLog; finalHash: number; ticks: number; rollbacks: number }
export function runMatchOffline(R: RapierModule, setup: MatchSetup, opts?: OfflineOptions): OfflineResult
```
- Steps until done (humans get humanCodes or neutral). forcedRollback restores the state of `back` ticks ago every `every` ticks (into a fresh MatchSim when `fresh`) and resimulates. Refuses past maxTicks (default 108000).

Tests: a sprint match on mech-lab with forcedRollback {every 37, back 9} and {every 113, back 15, fresh} gives the same log and finalHash as the plain run.

## Module: scene-view
Consumes: render-port, match-sim, net-match.

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
  readonly mechanismInstanceCount: number
  dispose(): void
}
```

- PALETTE is the 8 colours of 1.6. `followCamera` uses the 1.6 framing with an exponential follow (1 - Math.exp(-8*dt)).
- `update`:
  - on course change, destroys instances in reverse order and rebuilds the obstacle instances (spec.asset, scale spec.s);
  - obstacles are posed between the previous and current tick by alpha (lerp + nlerp);
  - when the course has mechanisms, one instance per mechanism body in item then body order, from the item's asset (registered once by name); with the SDF port the body's `parts` go through the port's part filter, otherwise the whole asset goes on body 0. Body poses come from `sim.mechanismBodyPose` and are interpolated by alpha against the previous pose kept per body;
  - one bean per player, tinted PALETTE[p], hidden when parked, at lerp(prev, cur, alpha) + the smoother offset, yaw from facing; the camera follows localPlayer.
- bean.prims.json is the jelly-bean (capsule body, eyes, mouth, < 1500 triangles, one capsule collider matching CHAR).

## Module: content-formats
Consumes: course-model, course-loader, prims, guard.

Files: `packages/game/src/gameAsset.ts`, `packages/game/src/courseV1.ts`, `packages/game/src/gameManifest.ts`, `packages/game/src/mechanismsJson.ts`, `tools/content.ts`, `packages/game/test/gameAsset.test.ts`, `packages/game/test/courseV1.test.ts`, `packages/game/test/gameManifest.test.ts`, `packages/game/test/mechanismsJson.test.ts`, `tools/test/content.test.ts`.

gameAsset.ts exports `World`, `AssetCategory`, `MesherOutput`, `GameAssetSource`, `ASSET_ID_RE`, `GAME_ASSET_CAPS`, `assetFilePath`, `parseGameAsset`, and:
```ts
export interface AssetBodyJson { id: string; type: 'dynamic' | 'kinematic' | 'fixed'; colliders: number[]; parts: string[]; t: [number, number, number]; r: [number, number, number, number]; density: number; friction: number; restitution: number; linearDamping: number; angularDamping: number; gravityScale: number; ccd: boolean; surface: Surface }
export interface MotorJson { mode: 'speed' | 'target'; speedDegS?: number; speedMS?: number; targetDeg?: number; targetM?: number; stiffness: number; damping: number; maxForce: number; enabled: boolean }
export interface AssetJointJson { id: string; kind: JointKind; a: string; b: string; anchorA: [number, number, number]; anchorB: [number, number, number]; axis: [number, number, number]; limitsDeg?: [number, number] | null; limitsM?: [number, number] | null; stiffness?: number; damping?: number; lengthM?: number; motor: MotorJson | null }
export interface AssetPhysicsJson { bodies: AssetBodyJson[]; joints: AssetJointJson[] }
export interface GameAsset { /* S12 fields */ physics?: AssetPhysicsJson }
export function assetMeshPath(world: World, id: string): string // assets/<world>/<id>.mesh
```

mechanismsJson.ts (S12/S13 reader and writer):
```ts
export function parseAssetPhysics(json: unknown, collision: readonly ColliderSpec[], path: string): AssetPhysicsJson | null
export function itemOf(o: { id: string; asset: string; t: Vec3; r: Quat; s: Vec3 }, asset: GameAsset, path: string): MechItem
export function parseCourseMechanisms(json: unknown, items: readonly MechItem[], path: string): MechanismSpec
export function parseCourseSounds(json: unknown, m: MechanismSpec, obstacleIds: readonly string[], path: string): SoundSpec[]
export function presetFromMotion(o: { id: string; motion: Record<string, unknown> }): { physics: AssetPhysicsJson; animation: Record<string, unknown> | null } | null
export const MECHANISM_PRESETS: readonly ['seesaw', 'door', 'piston', 'crane', 'springPlatform', 'lever', 'pressurePlate']
export function presetPhysics(preset: typeof MECHANISM_PRESETS[number]): AssetPhysicsJson
```
- Degrees -> radians (degToRad), `*S` -> round(s*60) >= 1 ticks; spring rest length = world anchor distance at rest; body poses transformed by the item pose; colliders scaled by `s` (S2 rules).
- Budget, caps, unknown references and logic cycles without toggle/delay are refused with RefusalError('course', `${path}#/mechanisms/...`).

courseV1.ts keeps `CourseKindV1`, `DecorItem`, `PodiumSpec`, `CourseV1`, `ResolvedGameAsset`, `GameAssetResolver`, `MOTION_FIELDS`, `V0_ASSET_MAP`, `migrateCourseV0`, `loadCourseV1`, `podiumLayoutOf`. `loadCourseV1` sends obstacles whose asset has `physics` to `mechanisms.items`, reads `surface` and path `wait`/`pull`, fills `mechanisms` and `sounds`, and hashes them (S13).

gameManifest.ts: `parseGameManifest` and `manifestCoverage` accept `folders.audio` and `mechanisms` (S14).

tools/content.ts: `buildContentIndex()` returns the S29 index (with `mesh` when the file exists and `audio`); `npm run content:pack -- <out>` validates strictly (assets, courses, haa headers `{haa: 1, id === stem}`) and copies courses, assets, meshes and audio, in under 60 s.

`tools/test/placeholders.test.ts` compares only `assets/**/*.asset.json` and `courses/**/*.course.json` against buildContent plus `tools/authored.json`; other authored files (e.g. `assets/common/penguin.animgraph.json`) are outside it.

## Module: sdf-runtime
Consumes: content-formats, raa-player-color, raa-views, web-client.

Files: `apps/web/src/sdf/meshWire.ts`, `apps/web/src/sdf/meshCache.ts`, `apps/web/src/sdf/meshFile.ts`, `apps/web/src/sdf/sdfPort.ts`, `apps/web/src/sdf/mamaApi.ts`, `apps/web/src/content/sdfLoad.ts`, `apps/web/src/content/v1Data.ts`, `tools/play.ts`, `apps/web/test/meshFile.test.ts`, `apps/web/test/meshCache.test.ts`, `apps/web/test/sdfTint.test.ts`, `apps/web/test/v1Data.test.ts`, `tools/test/play.test.ts`, `fixtures/golden/mesh-wire-vector.json`. There is no server mesh baker and no server-mesh wait.

- meshWire.ts: `encodeMesh(m: MeshedAsset & { key?: string }): Uint8Array` and `decodeMesh(bytes)`, the S24 bytes.
- meshFile.ts: `fetchMeshFile(url, key, asset, fetcher?)` returns the decoded mesh only when key, assetId, hash and `validMeshed` match; `meshFileStats: { hits: number; stale: number }`.
- meshCache.ts: memory/IndexedDB cache keyed by the S16 key. mamaApi.ts: browser MAMA meshing (worker), the last step of the S24 lookup.
- v1Data.ts: `browserAudioPatches(): Promise<ReadonlyMap<string, string>>` and `browserContentIndex(): Promise<ContentIndexV1>` (cached S29 index). sdfLoad.ts loads v1 assets through the S24 lookup.
- sdfPort.ts: `createSdfPort` returns a `ResizablePort` (resize, setPartFilter). Graph-mode materials get `setInstanceTint` without the post multiply; the fixed materials of an asset using Player Color are also graph mode, so they ignore the tint; prims assets keep multiply. 1..4 viewports through setViewports/setViewportCamera.
- tools/play.ts serves content assets and courses, `/content/index.json`, `.mesh` (application/octet-stream) and `audio/*.haa.json`.

Tests: meshFile, meshCache, sdfTint (tint and viewports), v1Data, play; `apps/web/test/mamaMaterials.test.ts` pins the distinct material-program count.

## Module: penguin-color
Consumes: content-formats, sdf-runtime, sdfm-player-color.

Files: `assets/common/penguin.body.asset.json`.

Content only. The body and head plumage use a material whose graph contains `input.player_color` (preview `#808080`); beak, eyes and feet keep fixed materials. The hash is recomputed by the sdfm save and its `.mesh` saved alongside (untracked). In game every penguin shows PALETTE[player] on the tinted parts only (S23).

## Module: mech-physics
Consumes: course-model, world, obstacles, detmath.

Files: `packages/sim/src/mechanisms/bodies.ts`, `packages/sim/src/mechanisms/joints.ts`, `packages/sim/src/mechanisms/system.ts`, `packages/sim/src/mechanisms/preview.ts`, `packages/sim/test/mechanisms.test.ts`, `packages/sim/test/mechanismsL12.test.ts`.

bodies.ts:
```ts
export function colliderVolume(c: ColliderSpec): number
export function createBody(ctx: WorldCtx<unknown>, item: MechItem, b: BodySpec, itemPose: Pose): BodyId
```
- Mass = density × Σ volume (setDensity per collider). Kinematic bodies are kinematicPositionBased for good. Groups: MOVING for dynamic/kinematic, STATIC for fixed; filter CHAR|DEBRIS|PROBE|MOVING|STATIC. Bodies welded by a `fixed` joint have contacts disabled on that joint.

joints.ts:
```ts
export function createJoint(ctx: WorldCtx<unknown>, j: JointSpec, a: BodyId | null, b: BodyId | null): number
export function applyMotor(ctx: WorldCtx<unknown>, joint: number, kind: JointKind, m: MotorSpec | null): void
```
- hinge = revolute, slider = prismatic (limits in radians/metres), ball = spherical, spring = generic joint with stiffness/damping at rest length, rope = rope joint.
- Motors: speed -> configureMotorVelocity(speed, damping); target -> configureMotorPosition(target, stiffness, damping); maxForce always applied; `enabled` false zeroes them. A hidden fixed identity body carries the hinge frame (1.2).

system.ts:
```ts
export class MechanismSystem implements SimSystem<unknown> {
  readonly name: 'mechanisms'
  constructor(courses: readonly ResolvedCourse[])
  load(ctx: WorldCtx<unknown>, courseIndex: number): void
  unload(ctx: WorldCtx<unknown>): void
  spec(): MechanismSpec | null
  bodyId(ref: BodyRef): BodyId
  bodyOfCollider(ctx: WorldCtx<unknown>, colliderHandle: number): BodyRef | null
  bodyPose(ctx: WorldCtx<unknown>, ref: BodyRef, out: Pose): boolean
  pointVelocity(ctx: WorldCtx<unknown>, ref: BodyRef, p: Vec3, out: Vec3): Vec3
  addLoad(ref: BodyRef, point: Vec3, mass: number): void
  loadKg(ref: BodyRef): number
  jointAngle(ctx: WorldCtx<unknown>, joint: number): number
  jointTravel(ctx: WorldCtx<unknown>, joint: number): number
  setMotor(ctx: WorldCtx<unknown>, joint: number, m: MotorSpec | null): void
  setSpringStiffness(ctx: WorldCtx<unknown>, joint: number, stiffness: number): void
  setKinematicTarget(ref: BodyRef, pose: Pose): void
  grabHandle(ctx: WorldCtx<unknown>, lever: number, player: number): void
  releaseHandle(ctx: WorldCtx<unknown>, lever: number, player: number): void
  emit(ev: MechEvent): void
  events(fromTick: number, out: MechEvent[]): number
  // init, preStep, postStep, snapshot, restore
}
```
- `load`: bodies in item then body order, item joints, then level joints, then initial motors.
- `preStep`: pending loads as downward forces (mass × 20 N) at their points; this tick's kinematic targets to setNextKinematic*. `postStep` clears loads and records `impact` events (a dynamic body losing > 3 m/s in a tick, strength min(1, Δv/10)); sensors match every collider of a body.
- Snapshot: courseIndex, body ids, joint handles, per-joint motor and spring stiffness, kinematic targets, pending loads, and the 64-entry event ring.

preview.ts (the world sdfm runs):
```ts
export interface MechanismWorld extends MechanismView { readonly world: FiestaWorld<unknown>; readonly tick: number; step(): void; reset(): void; free(): void }
export function createMechanismWorld(R: RapierModule, course: ResolvedCourse): MechanismWorld
```
ObstacleSystem + MechanismSystem at FIXED_DT; `reset` restores the tick-0 snapshot; mech-logic's `withLogic` adds the logic.

Tests: seesaw tip under load, hinge limits, motor capped by maxForce, spring rest length, rope distance, determinism with restore/resim, and one test per L12 bug in mechanismsL12.test.ts.

## Module: mech-logic
Consumes: mech-physics, course-model, detmath.

Files: `packages/sim/src/mechanisms/logic.ts`, `packages/sim/src/mechanisms/animation.ts`, `packages/sim/src/mechanisms/logicSystem.ts`, `packages/sim/test/mechLogic.test.ts`.

```ts
export interface LogicState { value: Uint8Array; timer: Int32Array; count: Int32Array; prev: Uint8Array }
export function newLogicState(m: MechanismSpec): LogicState
export function evalLogic(m: MechanismSpec, inputs: Uint8Array, s: LogicState): void
export function trackPose(a: AnimationSpec, localTick: number, out: Pose): Pose
export class MechLogicSystem implements SimSystem<unknown> {
  readonly name: 'mechLogic'
  constructor(courses: readonly ResolvedCourse[])
  load(ctx: WorldCtx<unknown>, courseIndex: number): void
  unload(ctx: WorldCtx<unknown>): void
  signal(id: string): boolean
  signalAt(index: number): boolean
  // init, preStep, postStep, snapshot, restore
}
export function withLogic(R: RapierModule, course: ResolvedCourse): MechanismWorld
```
- Logic in index order: toggle flips on a rising edge; timer stays on `ticks` after a rising edge; delay outputs its input `ticks` later (ring per node); counter turns on after `count` rising edges; not/and/or are combinational.
- `trackPose`: linear or smoothstep easing; loop, pingpong or once; lerp + nlerp through detmath.
- preStep (before `mechanisms`): switches (weight: on at loadKg >= onKg, off at <= offKg; travel: jointTravel vs onM/offM); levers (on past onAngle, off below offAngle; a grab press shorter than 12 ticks toggles by driving the hinge motor to the other side); evalLogic; links on signal edges (motor on/off, door target motor, spring stiffness, animation play/reverse/pause/stop); running animations send trackPose to setKinematicTarget (autostart at load). Events go through `mechanisms.emit`.
- Snapshot: courseIndex, signal bytes, logic state, per-animation (running, dir, localTick), lever press timers.

Tests: hysteresis, lever toggle, each logic op, link kind and loop mode, determinism with restore every 41 ticks.

## Module: game-audio
Consumes: course-model, haa-spatial, content-formats, match-sim, sdf-runtime.

Files: `apps/web/src/play/sound.ts`, `apps/web/src/play/courseAudio.ts`, `apps/web/src/client/sound.ts`, `packages/game/src/audio/context.ts`, `packages/game/src/audio/ids.ts`, `packages/game/src/audio/events.ts`, `packages/game/src/audio/gameAudio.ts`, `packages/game/src/audio/emitters.ts`, `packages/game/src/audio/pack/families.ts`, `packages/game/src/audio/pack/index.ts`, `packages/game/src/audio/pack/crowd.ts`, `packages/game/src/audio/pack/mix.ts`, `packages/game/src/audio/pack/crowdModel.ts`, `packages/game/test/emitters.test.ts`, `packages/game/test/audio.test.ts`, `apps/web/test/clientSound.test.ts`, `apps/web/test/courseAudio.test.ts`.

- emitters.ts (pure, view-side): `ListenerPose`, `EmitterCommand`, `CourseEmitters` (frame(sim, tick, out), reset()) turning S13 sounds and S28 events into play/loop/stop commands with positions and optional strength.
- gameAudio.ts: the game sound events and `interface CourseAudio { apply(cmds: readonly EmitterCommand[], n: number): void; setListener(l: ListenerPose): void; dispose(): void }`, with no haa-spatial import (packages/game resolves haa 0.1.1). context.ts is the only module that creates an AudioContext and may expose it and its output node. ids, events and pack (families, crowd, mix, crowdModel) are the Royal Fiesta sound pack.
- apps/web/src/play/courseAudio.ts:
```ts
export function createCourseAudio(ctx: BaseAudioContext, patches: ReadonlyMap<string, string>, module: WebAssembly.Module, processorUrl: string | URL, output: AudioNode, makePlayer?: typeof createPlayer): CourseAudio
```
  haa `createSpatialScene`, one HaaPlayer per active emitter (<= 32); a missing patch id is named once and skipped; `makePlayer` is a test seam.
- play/sound.ts: `SoundDriver { frame(sim, listener?); setCourseAudio(a); dispose(); close() }`; `open()` builds the course audio from `browserAudioPatches()`; without a listener it uses player 0. client/sound.ts keeps SoundDeps, RfAudioDebug, ClientSound.

Tests: emitters from a scripted MechanismView; courseAudio falloff and pan with a fake player; audio pack; client sound.

## Module: judge-cards
Consumes: none.

Files: `.nmc/commands.json`, `.nmc/judge/m1.json`, `tools/judgeCard.ts`, `tools/test/judgeCard.test.ts`.

- tools/judgeCard.ts exports parseJudgeInput, judgeCommands, pageRefOf and main. It reads the S31 single-input file `{page, op, input, judge}` or the items file `{page, op, items: [{prefix?, input, judge: [{capture, description}]}]}` (1..8 items, prefix ^[a-z0-9-]{0,24}$, judged names prefix+capture unique).
- Items commands: build, content:pack, publish once; per item k a render of `out/judge/mN/input-k.json` into `out/judge/mN/item-k/`, a `cp` of each judged capture to `out/judge/mN/<prefix><capture>.png`, then one judge step per entry (`--min-score 6`).
- CLI: `node --experimental-strip-types tools/judgeCard.ts mN [--item k]`.
- .nmc/commands.json holds at most 10 entries `{name, command, timeout_s, after?}`: the build/content chain (sdf-port-typecheck -> sdf-port-build -> candy-content-pack -> candy-assets-proof), rf-tests, rf-judge-m2, rf-judge-m3 (all M3 items), and `rf-judge-m4-candy-seesaw-run`, `rf-judge-m4-ice-slide-gates`, `rf-judge-m4-jungle-crane-crossing`, `rf-judge-m4-neon-piston-alley` (`--item 0..3`, timeout 1800, after rf-tests). Subset test entries already covered by rf-tests are not kept.

## Module: raa-player-color
Repository: raa. Consumes: mama-player-color.

Files: `crates/raa-shader/src/lib.rs`, `crates/raa-shader/src/wgsl/prelude.wgsl`, `crates/raa-shader/src/wgsl/pass_forward.wgsl`, `crates/raa-shader/src/wgsl/pass_prepass.wgsl`, `crates/raa-shader/src/wgsl/pass_transparent.wgsl`, `crates/raa-shader/src/wgsl/pass_furshell.wgsl`, `crates/raa-js/src/api/m20_player_tint.rs`, `packages/raa/types/m20-player-tint.d.ts`, `docs/api/m20-player-tint.md`, `packages/raa-sdfm/src/map-material.js`, `packages/raa-sdfm/src/loader.js`, `packages/raa-sdfm/test/player-tint.test.js`, `crates/raa-js/tests/player_tint.rs`.

```ts
export type TintMode = 'multiply' | 'graph'
interface Engine { setMaterialTintMode(material: number, mode: TintMode): void; clearInstanceTint(instance: number): void }
```
- The prelude exposes `mat_instance_tint: vec4<f32>` and `mat_instance_tint_set: f32` (1 after setInstanceTint, 0 after clearInstanceTint; stored in InstanceExtra.tint_set). A graph-mode material sets a VariantKey bit and is composed without the post-material tint multiply; multiply materials render pixel-identical to before. Errors: `tint.material_range`, `tint.mode_unknown`.
- raa-sdfm `mapMaterial(m)` returns `tintMode: 'graph'` when the MAMA WGSL uses `mat_instance_tint`, else `'multiply'`; loader.js calls `setMaterialTintMode` after `addSurfaceMaterial`.
- Tests: registry exports, both composition modes, variant selection, tint reaching the node, raa-sdfm detection and loader call. Bricks rebuilt with scripts/build-bricks.sh.

## Module: raa-views
Repository: raa. Consumes: none.

Files: `crates/raa-js/src/api/m21_views.rs`, `crates/raa-js/src/api/m07_pipeline.rs`, `packages/raa/types/m21-views.d.ts`, `docs/api/m21-views.md`, `crates/raa-js/tests/views.rs`, `.nmc/commands.json`.

```ts
export interface ViewRect { x: number; y: number; width: number; height: number }
export interface ViewCamera { eye: [number, number, number]; target: [number, number, number]; fovYDeg: number; near: number; far: number }
interface Engine {
  setViewports(rects: ViewRect[]): void
  setViewportCamera(index: number, cam: ViewCamera): void
  resize(cssWidth: number, cssHeight: number, dpr: number): void
  setOverlayLines(layer: number, positions: Float32Array, colors: Float32Array, opts: { depthTest: boolean; widthPx: number }): void
  clearOverlay(layer: number): void
}
```
- Each frame clears the backbuffer once, then runs the full pipeline (scene and post) per viewport into an offscreen target set sized to its rect (separate post history per view); only the final tonemap pass writes the backbuffer at the view's viewport/scissor with LoadOp::Load. A single full-canvas viewport renders exactly as before. Overlays draw after tonemap per viewport (S25).
- Errors: `views.count`, `views.rect`, `views.index`, `overlay.layer`, `overlay.length`.
- Card `raa-tests`: `cargo test -p raa-js --quiet && node --test packages/raa-sdfm/test/`, 2400 s.

## Module: mama-player-color
Repository: mama. Consumes: none.

Files: `src/core/material-graph/nodes/input.player_color.ts`, `src/core/material-graph/nodes/manifest.ts`, `src/core/material-graph/node-tags.ts`, `src/core/material-graph/cpu-eval.ts`, `src/core/material-graph/labels.ts`, `src/core/material-graph/player-color.test.ts`, `.nmc/commands.json`.

```ts
export const playerColorNode // defineNode<{ color: string }>: id 'input.player_color', category 'input', output color: vec3, default '#808080', S23 WGSL emit
export function graphUsesPlayerColor(graph: { nodes: readonly { type: string }[] }): boolean
```
- manifest.ts registers it (MATERIAL_NODES = 46, with the semantics.ts row exec 'field' and the pinned counts updated); node-tags.ts tags it `input` and `game`; cpu-eval.ts returns the preview colour or the given instance tint; labels.ts adds English and French names.
- Card `mama-tests`: `npm test`, 1800 s. Tests: WGSL text, CPU eval with and without tint, graphUsesPlayerColor, labels.

## Module: mama-game-mesh
Repository: mama. Consumes: mama-player-color.

Files: `src/core/game/mesh-assets.ts`, `src/core/game/mesh-file.ts`, `src/core/game/mesh-file.test.ts`, `src/core/game/mesh-wire-vector.json`.

- mesh-assets.ts: `AssetSubMesh` (with `playerColor: boolean` when its material graph uses the node), `labelColors`, `AssetMeshPart`, `AssetMeshResult`, `MeshAssetsOptions`, `splitByMaterial`, `meshAssets(doc, o)`.
- mesh-file.ts (the S24 writer for sdfm):
```ts
export interface MeshFileInput { assetId: string; hash: string; mesher: string; parts: number; triangles: number; key: string; data: unknown }
export function encodeMeshFile(m: MeshFileInput): Uint8Array
export function decodeMeshFile(bytes: Uint8Array): MeshFileInput
export async function meshFileKey(asset: { hash: string; mesher: unknown }, mamaVersion: string, raaSdfmVersion: string, sha256Hex: (b: Uint8Array) => Promise<string>): Promise<string>
```
- Bytes equal royal-fiesta `encodeMesh`; mesh-wire-vector.json copies the royal-fiesta golden and the test checks both directions. `meshFileKey` is the S16 key.

## Module: haa-spatial
Repository: haa. Consumes: none.

Files: `packages/haa/src/spatial.ts`, `packages/haa/src/index.ts`, `packages/haa/test/spatial.test.ts`, `docs/spatial.md`, `.nmc/commands.json`.

```ts
export interface Falloff { ref: number; max: number; rolloff: number }
export const DEFAULT_FALLOFF: Falloff // { ref: 2, max: 60, rolloff: 1 }
export const SPEED_OF_SOUND = 343
export interface Listener { x: number; y: number; z: number; fx: number; fz: number }
export interface SpatialEmitter { readonly id: string; readonly player: HaaPlayer; setPosition(x: number, y: number, z: number): void; setVelocity(vx: number, vy: number, vz: number): void; setGain(g: number): void; dispose(): void }
export interface SpatialScene { readonly output: GainNode; setListener(l: Listener): void; addEmitter(id: string, player: HaaPlayer, falloff?: Falloff): SpatialEmitter; update(): void; dispose(): void }
export function createSpatialScene(ctx: BaseAudioContext, output?: AudioNode): SpatialScene
export function emitterGain(dist: number, f: Falloff): number
export function equalPowerPan(pan: number): { left: number; right: number }
export function dopplerRatio(relSpeedTowardListener: number): number
```
- Gain 1 within ref, ref/(ref + rolloff × (dist - ref)) beyond, 0 past max. Pan = dot(normalised XZ direction, listener right) in -1..1; left = cos((pan+1)π/4), right = sin((pan+1)π/4). Doppler c/(c - v) clamped 0.5..2.
- `update` drives a StereoPanner/GainNode per emitter and sets `_dist`, `_pan`, `_doppler` only when `player.info.inputs` declares them. Exported from `.` via index.ts. royal-fiesta consumes it as `@etcito/haa-spatial`.
- Card `haa-tests`: `npm test && npm run test:host`, 1800 s.

## Module: sdfm-game-io
Repository: sdfm. Consumes: mama-game-mesh, raa-player-color.

Files: `src/node/ops/games.ts`, `src/app/game/games-client.ts`, `src/app/game/asset-actions.ts`, `src/app/game/controls.ts`, `src/app/game/controls/game-files.ts`, `src/app/nmc-ops.ts`, `public/nmc.gpu.json`, `scripts/game-units.mjs`, `scripts/judge-card.mjs`, `src/app/game/game-io.test.ts`, `.nmc/commands.json`.

- games.ts: `game_file_write` (S29 text files), `game_file_write_bytes` `{path: 'assets/<world>/<id>.mesh', base64}` (<= 32 MiB), `game_files_list` including audio.
- games-client.ts: `writeGameBytes(path, bytes)`, `listAudioPatches()`.
- asset-actions.ts: the asset save builds the MeshedAsset as the game worker does and writes the `.mesh` (mama `encodeMeshFile`, `meshFileKey`) after the JSON.
- controls.ts: `ControlSpec` and `CONTROLS` (S30, union of `controls/*.ts`).
- nmc-ops.ts: `SdfmCaptureInput { scene; panel: 'asset'|'course'|'physics'|'sounds'|'material'; width; height; steps: {tool, input}[]; captureAt }` and `installSdfmOps()` (`window.nmcGpu.ops.sdfmCapture`: runs the MCP steps, captures canvas and panels).
- scripts/game-units.mjs runs the compiled game and node-ops tests, including `unit.game.mcp-parity`. scripts/judge-card.mjs builds, publishes and judges every `.nmc/judge/*.json`.
- Cards: `sdfm-units` (900 s), `sdfm-judge` (1800 s).

## Module: sdfm-player-color
Repository: sdfm. Consumes: sdfm-game-io, mama-player-color, raa-player-color.

Files: `src/app/game/player-color.ts`, `src/plugins/ui/64-player-color.ts`, `src/node/ops/player-color.ts`, `src/app/game/controls/player-color.ts`, `src/app/game/player-color.test.ts`, `.nmc/judge/player-color.json`.

```ts
export const PREVIEW_PALETTE: readonly (readonly [number, number, number])[] // the 1.6 PALETTE
export function setPreviewPlayer(display: GameDisplay, index: number | null): void
export function addPlayerColorNode(materialId: string, at: { x: number; y: number }): string
```
- `setPreviewPlayer` sets PALETTE[index] as instance tint, or clears it (null). The asset panel has a preview-player picker; the material editor lists Player Color under Input.
- MCP tools: `material_player_color_add {material, x, y}`, `game_preview_player_set {index: 0..7 | null}`, both declared in controls/player-color.ts.
- Judge `penguin-sky`: penguin.body with preview player 1, body and head sky blue, beak and feet orange, a Player Color node in the graph panel.

## Module: candy-patches
Consumes: content-formats, mech-logic, sdfm-physics.

Files: `assets/candy/candy.spinner-bar.asset.json`, `assets/candy/candy.rotating-door.asset.json`, `assets/candy/candy.seesaw-plank.asset.json`, `assets/candy/candy.bounce-pad.asset.json`, `assets/candy/candy.moving-platform.asset.json`, `assets/candy/candy.pendulum-hammer.asset.json`, `courses/race-bean-dash.course.json`, `courses/race-hammer-hill.course.json`, `courses/survival-spin-zone.course.json`, `courses/survival-hammer-ring.course.json`, `courses/race-sprint.course.json`, `courses/survival-sprint.course.json`, `courses/obstacle-gallery.course.json`, `courses/hub-plaza.course.json`, `packages/game/test/candyPresets.test.ts`.

The shipped candy movers are mechanism presets (written through the sdfm course save), keeping positions, periods and amplitudes:
- spinner-bar, rotating-door, pendulum-hammer: a fixed base plus a dynamic part on a hinge motor (speed mode for spinners, target stepping for doors, a timer-linked target motor for the pendulum);
- seesaw-plank: limited hinge plus centring spring; bounce-pad: spring platform; moving-platform: kinematic body on a pingpong keyframe track.

candyPresets.test.ts: each mover's pose envelope stays within 5% of its legacy v0 motion; race-sprint round 0 (8 bots, sprint, fixed seed) ends by 'target'; race-bean-dash and race-hammer-hill are checked for parity against the legacy fixture through migrateCourseV0 (8 participants, finishers >= legacy, finisher ticks <= legacy last + 10%, no more kill-plane falls), with the baseline computed in the test.

## Module: test-level
Consumes: content-formats, mech-logic, match-sim, sdfm-physics, sdfm-sound.

Files: `courses/mech-lab.course.json`, `assets/candy/candy.mech-seesaw.asset.json`, `assets/candy/candy.mech-door.asset.json`, `assets/candy/candy.mech-piston.asset.json`, `assets/candy/candy.mech-crane.asset.json`, `assets/candy/candy.mech-spring-pad.asset.json`, `assets/candy/candy.mech-lever.asset.json`, `assets/candy/candy.mech-plate.asset.json`, `audio/mech-click.haa.json`, `audio/mech-motor.haa.json`, `audio/mech-thud.haa.json`, `.nmc/judge/m2.json`, `packages/game/test/mechLab.test.ts`.

- mech-lab (race, world candy, sprint and standard, 8 spawns, 2 checkpoints, timeLimitS 90), in order: a seesaw; a pressure plate (weight, onKg 50, offKg 30) linked to a door; a lever through a toggle to a piston; a spring platform; a crane arm on a speed motor; the finish. Path nodes `wait` at the door and `pull` at the lever. Sounds: click on switch/lever events, a motor loop on the piston signal, thud on impacts.
- The seven mech assets are in the S12 authoring form (underscore node ids, halfExtents/borderRadius, bodies at the origin, one hidden gameCollision node per collision entry in index order).
- .nmc/judge/m2.json: `{content: 'sdf', course: 'mech-lab', flow: 'match', clients: 1, width: 1920, height: 1080, captureAt: ['playing', 'playing+8s']}`, judging the candy course with seesaw, door, piston and penguins, then the door opened a few seconds later.
- The test runs 8 bots in sprint to the finish and checks the door opens after the plate is loaded and the piston follows the lever.

## Module: sdfm-physics
Repository: sdfm. Consumes: sdfm-game-io, mech-logic, mech-physics, content-formats, raa-views.

Files: `src/app/game/physics/model.ts`, `src/app/game/physics/picking.ts`, `src/app/game/physics/gizmos.ts`, `src/app/game/physics/presets.ts`, `src/app/game/physics/preview.ts`, `src/app/game/physics/contraptions.ts`, `src/app/game/physics/mechanisms.ts`, `src/plugins/ui/65-physics.ts`, `src/node/ops/physics.ts`, `src/app/game/controls/physics.ts`, `src/app/game/physics/physics.test.ts`, `package.json`, `.nmc/judge/physics.json`.

- model.ts: `physicsOf`, `withPhysics`, `addBody`, `addJoint`, `setJoint`, `removeJoint` (stores degrees and seconds, S12).
- picking.ts: `snapAnchor(hit, grid)`, `inferAxis(kind, nA, nB)` (pick A then B, anchors snap to surfaces).
- gizmos.ts: `drawPhysicsGizmos(display, p, poses, selected)`: anchors, axes and limit arcs on overlay layer 1.
- presets.ts: `applyPreset(asset, preset)` using royal-fiesta `presetPhysics`.
- preview.ts: `PhysicsPreview(R, course)` with play/pause/reset/stepOnce, `tick`, `playing`, `bodyPose`, `dispose`, running `withLogic` at FIXED_DT from an accumulator.
- contraptions.ts: `duplicateWithJoints` (Ctrl+D), `groupContraption`. mechanisms.ts: `setSwitch`, `setLever`, `addLogic`, `addLink`, `removeLink`, `setAnimation`.
- 65-physics.ts: body/joint lists, inspector with tooltips (unit and effect), presets, Play/Pause/Reset, mechanism editors.
- MCP tools: physics_mode_set, physics_body_set, physics_joint_add, physics_joint_set, physics_joint_remove, physics_preset_apply, physics_play, physics_pause, physics_reset, physics_duplicate, physics_group, mechanism_switch_set, mechanism_lever_set, mechanism_logic_add, mechanism_link_add, mechanism_link_remove, mechanism_animation_set (each < 60 s), all mapped in controls/physics.ts.
- package.json adds `@royal-fiesta/sim` (sibling `file:`), Rapier 0.21.0 and `@etcito/haa`.
- Judge `physics-gizmos`: candy.mech-seesaw in physics mode with joint `pivot` selected.
- Tests: anchor snap, axis inference, degree round trip, duplicate id remap, preview determinism at tick 600.

## Module: sdfm-sound
Repository: sdfm. Consumes: sdfm-game-io, sdfm-physics, haa-spatial.

Files: `src/app/game/sounds.ts`, `src/plugins/ui/66-sounds.ts`, `src/node/ops/sounds.ts`, `src/app/game/controls/sounds.ts`, `src/app/game/sounds.test.ts`, `.nmc/judge/sound.json`.

- sounds.ts: `addEmitter`, `setEmitter`, `removeEmitter` (S13 `sounds`), and `previewEmitter(patchUrl, listener, at)` on haa `createPlayer` + `createSpatialScene`.
- 66-sounds.ts: course-editor sound panel (patch list from `listAudioPatches`, emitter inspector with tooltips, preview) and emitter icons on overlay layer 2.
- MCP tools: sound_patches_list, sound_emitter_add, sound_emitter_set, sound_emitter_remove, sound_preview.
- Judge `sound-panel`: mech-lab with an emitter at the door. Tests: emitter JSON per S13, unknown patch refused.

## Module: game-page
Consumes: local-play, pad-remap, web-input, sdf-runtime, game-audio, scene-view, web-client.

Files: `apps/web/game.html`, `apps/web/src/game/main.ts`, `apps/web/src/game/ops.ts`, `apps/web/src/game/uiTour.ts`, `apps/web/test/gameLayout.test.ts`, `.nmc/judge/m3.json`.

ops.ts:
```ts
export interface GameCaptureInput { content: ContentId; course?: string; flow: 'match' | 'hub' | 'podium' | 'tour'; clients: 1 | 2 | 4; local?: 1 | 2 | 3 | 4; width: number; height: number; captureAt: string[]; reload?: boolean; touch?: boolean; net?: { server: string; party: 2 } }
export function installGameOps(teardown: () => void, bootGame: BootGame): void
```
- Registers `roundCapture`, `controlsProbe`, `gameCapture` and `uiTour` (no frameTiming). `local` runs a LocalMatch with Pilot-driven seats split per S26; `touch` mounts the touch controls. captureAt: `playing`, `playing+<n>s`, `podium`, `hub`, tour screens such as `settings-controls`.

main.ts (game.html): one canvas; viewports from `splitLayout(seats, seats === 3)` scaled by `pixelViewports`; a ResizeObserver calls `port.resize`. Local play: join prompt, each device's join button takes the next seat (SeatTable), start launches a LocalMatch with one SceneView per seat and the overview in the empty fourth cell. The SoundDriver listens from seat 0's camera. On a coarse pointer or `?touch=1`, touch controls feed seat 0 and one seat is forced. Settings open the pad remap screen. Online and hub flows as in web-play.

.nmc/judge/m3.json items: 3 local seats on race-sprint at 1920x1080 (2x2 grid with overview); 1 seat with touch at 844x390 (joystick and buttons); the tour `settings-controls` (Jump, Dive, Grab, Pause with buttons and a remap prompt). Run only by `rf-judge-m3`.

Test: layout math for 1..4 seats and DPR capping on resize.

## Module: local-play
Consumes: client-core, match-sim, render-port, course-model.

Files: `packages/game/src/client/seats.ts`, `packages/game/src/client/splitLayout.ts`, `packages/game/src/client/localMatch.ts`, `packages/game/test/seats.test.ts`, `packages/game/test/splitLayout.test.ts`, `packages/game/test/localMatch.test.ts`.

```ts
export type DeviceId = 'keyboard' | 'touch' | `pad:${number}`
export interface Seat { index: number; device: DeviceId; player: number; colour: number }
export const MAX_LOCAL_SEATS = 4
export class SeatTable { constructor(max?: number); join(device: DeviceId): Seat | null; leave(device: DeviceId): void; seatOf(device: DeviceId): number; readonly seats: readonly Seat[] }
export const DPR_CAP = 2
export interface SplitCell { x: number; y: number; width: number; height: number; seat: number }
export function splitLayout(seats: number, overview: boolean): SplitCell[]
export function pixelViewports(cells: readonly SplitCell[], cssWidth: number, cssHeight: number, dpr: number): Viewport[]
export function overviewCamera(course: ResolvedCourse): CameraPose
export interface LocalMatchOptions { R: RapierModule; seats: number; seed: number; profile: ProfileName; courses: readonly ResolvedCourse[] }
export class LocalMatch { constructor(o: LocalMatchOptions); frame(dtS: number, sample: (seat: number, out: PlayerInput) => void): number; readonly sim: MatchSim; readonly done: boolean; dispose(): void }
```
- Seat k is player k with colour k; a leave compacts higher seats down. Layouts follow 1.6 (seat -1 = overview); pixel rects are integer and gap-free; splitLayout refuses seats outside 1..4.
- LocalMatch: one MatchSim (playerCount 8, humans = seats) stepped at 60 Hz from an accumulator (<= 8 steps per frame), no rollback; `frame` returns alpha.

Tests: seat join/leave, layouts with and without overview, a 2-seat LocalMatch with Pilots reaching done.

## Module: pad-remap
Consumes: client-core.

Files: `packages/game/src/client/padMap.ts`, `packages/game/src/screens/padRemap.ts`, `packages/game/test/padMap.test.ts`.

```ts
export type PadAction = 'jump' | 'dive' | 'grab' | 'pause' | 'join'
export interface PadMap { v: 1; buttons: Record<PadAction, number>; axes: { x: number; y: number }; invertY: boolean; dead: number }
export const DEFAULT_PAD_MAP: PadMap
export function padMapKey(gamepadId: string): string
export function parsePadMap(json: unknown): { map: PadMap; problem: string | null }
export interface PadLike { buttons: readonly { pressed: boolean }[]; axes: readonly number[] }
export function padControls(pad: PadLike, map: PadMap, out: RawControls): RawControls
export interface PadMapStore { get(id: string): PadMap; set(id: string, m: PadMap): void; reset(id: string): void }
export function localPadMapStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): PadMapStore
export interface RemapState { pad: string; action: PadAction | null; map: PadMap }
export function startRemap(map: PadMap, pad: string): RemapState
export function listenFor(s: RemapState, action: PadAction): RemapState
export function pressed(s: RemapState, button: number): RemapState
export function remapRows(s: RemapState): { action: PadAction; label: string; button: number; listening: boolean }[]
```
- DEFAULT_PAD_MAP is the S27 example; `padMapKey` = `rf.padmap.` + id; the dead zone is radial.

Tests: parse round trip, invalid map problem, axis inversion and dead zone, the remap sequence.

## Module: web-input
Consumes: pad-remap, local-play, client-core.

Files: `apps/web/src/input/input.ts`, `apps/web/src/input/touch.ts`, `apps/web/src/input/padRemapScreen.ts`, `apps/web/test/webInput.test.ts`.

- input.ts keeps `UiEvent`, `STICK_DEADZONE`, `PAD_JUMP`, `PAD_DIVE`, `PAD_GRAB`, `PAD_START`, `KEY_ACTIONS`, `KeyAction`, `KeyBindings`, `DEFAULT_BINDINGS`, `GameInput`, and adds:
```ts
export interface DevicePoll { device: DeviceId; controls: RawControls; joinPressed: boolean; pausePressed: boolean }
export class InputDevices {
  constructor(target: HTMLElement, pads: () => readonly (Gamepad | null)[], maps: PadMapStore, touch: { active: boolean; read(out: RawControls): void } | null)
  poll(out: DevicePoll[]): number
  dispose(): void
}
```
  Each pad reads through `padControls` with its stored map.
- touch.ts: `mountTouchControls(root)` -> `{ active, read(out), dispose() }`: a bottom-left joystick (radius 60 CSS px, dead zone 0.15) and jump/dive/grab buttons bottom right, multi-touch, `touch-action: none`.
- padRemapScreen.ts: `mountPadRemap(root, store, pads)` -> `{ close() }`, rendering `remapRows`; the next pressed button is assigned; Reset restores DEFAULT_PAD_MAP.

Tests (fake DOM and pads): per-device polls, join edges, touch reading.

## Module: world-courses
Consumes: content-formats, mech-logic, bots, test-level, game-audio, judge-cards, match-sim.

Files: `courses/candy-seesaw-run.course.json`, `courses/ice-slide-gates.course.json`, `courses/jungle-crane-crossing.course.json`, `courses/neon-piston-alley.course.json`, `assets/ice/ice.slide-gate.asset.json`, `assets/ice/ice.floe-platform.asset.json`, `assets/ice/ice.floor-tile.asset.json`, `assets/ice/ice.wall-block.asset.json`, `assets/jungle/jungle.crane-arm.asset.json`, `assets/jungle/jungle.vine-bridge.asset.json`, `assets/jungle/jungle.floor-tile.asset.json`, `assets/jungle/jungle.wall-block.asset.json`, `assets/neon/neon.piston-block.asset.json`, `assets/neon/neon.laser-door.asset.json`, `assets/neon/neon.floor-tile.asset.json`, `assets/neon/neon.wall-block.asset.json`, `audio/ice-creak.haa.json`, `audio/jungle-crank.haa.json`, `audio/neon-hum.haa.json`, `.nmc/judge/m4.json`, `packages/game/test/worldCourses.test.ts`.

Four race courses (sprint and standard, 8 spawns, 3 checkpoints, timeLimitS 120, within the default budget):
- candy-seesaw-run: seesaws and pressure-plate doors;
- ice-slide-gates: ice surfaces, spring floe platforms, timer gates;
- jungle-crane-crossing: a lever-driven crane, a rope vine bridge, mud;
- neon-piston-alley: counter-gated pistons, linked laser doors, rubber pads.

Each uses at least one switch or lever with a `wait` or `pull` node, has world sounds on mechanism events, and lets 8 bots finish within the sprint cap. The world floor-tile and wall-block assets reuse the candy collision with a world look. All assets are in the S12 authoring form and registered in `tools/authored.json`.

.nmc/judge/m4.json (items form) has one item per course in the order candy, ice, jungle, neon: prefix `<id>-`, input `{content: 'sdf', course: <id>, flow: 'match', clients: 1, width: 1920, height: 1080, captureAt: ['playing']}`, and the course's description. `rf-judge-m4-<id>` copies the capture to `out/judge/m4/<id>.png` and judges it at --min-score 6.

The test has one case per course (`world course <id>`): shape and budgets (a lowered budget refuses at '#/mechanisms/budget'), wait/pull references and sounds, and 8 bots in an eight-finisher sprint race round, all qualifying by 'target' with every wait/pull signal observed on.

## Module: bricks

- Repository: royal-fiesta
- Files: tools/bricks.ts, tools/test/bricks.test.ts
- Owner: existing
- Consumes: workspace

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

- Repository: royal-fiesta
- Files: packages/sim/src/refusal.ts, packages/sim/test/refusal.test.ts
- Owner: existing
- Consumes: workspace

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

- Repository: royal-fiesta
- Files: packages/sim/src/detmath.ts, packages/sim/src/vec.ts, packages/sim/test/detmath.test.ts, packages/sim/test/vec.test.ts, packages/sim/test/purity.test.ts
- Owner: existing
- Consumes: workspace

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

- Repository: royal-fiesta
- Files: packages/sim/src/world.ts, packages/sim/src/groups.ts, packages/sim/test/world.test.ts
- Owner: existing
- Consumes: detmath, refusal

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

- Repository: royal-fiesta
- Files: packages/sim/src/scenarios/flatFloor.ts, packages/sim/test/flatFloor.test.ts
- Owner: existing
- Consumes: world

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

- Repository: royal-fiesta
- Files: apps/headless/src/proofkit.ts, apps/headless/test/proofkit.test.ts
- Owner: existing
- Consumes: bricks

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

- Repository: royal-fiesta
- Files: apps/headless/src/smoke.ts, apps/headless/proofs/m1-foundations.ts
- Owner: existing
- Consumes: flat-floor, proofkit, guard, web-boot

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

- Repository: royal-fiesta
- Files: apps/web/vite.config.ts, apps/web/index.html, apps/web/src/boot.ts
- Owner: existing
- Consumes: flat-floor, bricks

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

## Module: motion

- Repository: royal-fiesta
- Files: packages/sim/src/obstacles/motion.ts, packages/sim/test/motion.test.ts
- Owner: existing
- Consumes: course-model

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

- Repository: royal-fiesta
- Files: packages/sim/src/obstacles/system.ts, packages/sim/src/obstacles/colliders.ts, packages/sim/test/obstacles.test.ts
- Owner: existing
- Consumes: motion, world

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

- Repository: royal-fiesta
- Files: packages/game/src/prims.ts, packages/game/test/prims.test.ts
- Owner: existing
- Consumes: course-model, refusal

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

- Repository: royal-fiesta
- Files: packages/game/src/assets.ts, packages/game/test/assets.test.ts, fixtures/assets/floor-tile.prims.json, fixtures/assets/floor-disc.prims.json, fixtures/assets/wall-block.prims.json, fixtures/assets/spinner-bar.prims.json, fixtures/assets/pendulum-hammer.prims.json, fixtures/assets/seesaw-plank.prims.json, fixtures/assets/rotating-door.prims.json, fixtures/assets/conveyor-belt.prims.json, fixtures/assets/bounce-pad.prims.json, fixtures/assets/moving-platform.prims.json, fixtures/assets/finish-arch.prims.json, fixtures/assets/checkpoint-gate.prims.json
- Owner: existing
- Consumes: prims

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

- Repository: royal-fiesta
- Files: packages/game/src/course.ts, packages/game/test/course.test.ts, fixtures/courses/obstacle-gallery.course.json, fixtures/courses/invalid/trimesh-collider.course.json, fixtures/courses/invalid/bad-motion.course.json, fixtures/courses/invalid/unknown-asset.course.json, fixtures/courses/invalid/race-without-finish.course.json
- Owner: existing
- Consumes: assets, obstacles

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

- Repository: royal-fiesta
- Files: apps/headless/src/files.ts, apps/headless/test/files.test.ts
- Owner: existing
- Consumes: course-loader, bricks

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

- Repository: royal-fiesta
- Files: apps/headless/proofs/m2-obstacles.ts, fixtures/golden/m2-obstacle-poses.json
- Owner: existing
- Consumes: node-files, obstacles, proofkit

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

- Repository: royal-fiesta
- Files: packages/sim/src/input.ts, packages/sim/test/input.test.ts
- Owner: existing
- Consumes: world

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

## Module: input-scripts

- Repository: royal-fiesta
- Files: apps/headless/src/scripts.ts, apps/headless/test/scripts.test.ts
- Owner: existing
- Consumes: character, input, node-files

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

- Repository: royal-fiesta
- Files: apps/headless/proofs/m3-character.ts, fixtures/golden/m3-replay.json
- Owner: existing
- Consumes: input-scripts, node-files, proofkit

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

- Repository: royal-fiesta
- Files: packages/sim/src/match/setup.ts, packages/sim/src/match/rules.ts, packages/sim/test/rules.test.ts
- Owner: existing
- Consumes: course-model, world

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

- Repository: royal-fiesta
- Files: packages/sim/src/match/roundSystem.ts, packages/sim/test/round.test.ts
- Owner: existing
- Consumes: match-rules, character, obstacles

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

## Module: course-set

- Repository: royal-fiesta
- Files: packages/game/src/courseSet.ts, packages/game/test/courseSet.test.ts, fixtures/courses/race-bean-dash.course.json, fixtures/courses/race-hammer-hill.course.json, fixtures/courses/survival-spin-zone.course.json, fixtures/courses/survival-hammer-ring.course.json, fixtures/courses/race-sprint.course.json, fixtures/courses/survival-sprint.course.json
- Owner: existing
- Consumes: course-loader, match-rules

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

- Repository: royal-fiesta
- Files: apps/headless/src/cli.ts, apps/headless/proofs/m4-rounds.ts
- Owner: existing
- Consumes: match-sim, course-set, node-files, proofkit

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

- Repository: royal-fiesta
- Files: packages/game/src/net/tuning.ts, packages/game/src/net/netMatch.ts, packages/game/src/net/pilot.ts, packages/game/test/netMatch.test.ts
- Owner: existing
- Consumes: match-sim, input

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

- Repository: royal-fiesta
- Files: packages/game/src/net/metrics.ts, packages/game/test/metrics.test.ts
- Owner: existing
- Consumes: net-match

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

- Repository: royal-fiesta
- Files: apps/headless/src/netsimMatch.ts, apps/headless/proofs/m5-netsim.ts
- Owner: existing
- Consumes: net-metrics, net-match, course-set, node-files, proofkit

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

- Repository: royal-fiesta
- Files: packages/game/src/net/ws.ts, packages/game/src/net/relayProtocol.ts, packages/game/src/net/relayClient.ts, packages/game/src/net/relayTransport.ts, packages/game/test/relayTransport.test.ts
- Owner: existing
- Consumes: refusal, net-match

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

- Repository: royal-fiesta
- Files: packages/game/src/net/loopbackRelay.ts, packages/game/test/loopbackRelay.test.ts
- Owner: existing
- Consumes: relay-client

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

- Repository: royal-fiesta
- Files: packages/game/src/net/roomsProtocol.ts, packages/game/src/net/roomsClient.ts, packages/game/test/roomsClient.test.ts
- Owner: existing
- Consumes: relay-client

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

- Repository: royal-fiesta
- Files: packages/game/src/net/rtcBackend.ts, packages/game/src/net/webrtcTransport.ts, packages/game/test/webrtcTransport.test.ts
- Owner: existing
- Consumes: rooms-client

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

- Repository: royal-fiesta
- Files: apps/headless/src/rtcNode.ts, apps/headless/test/rtcNode.test.ts
- Owner: existing
- Consumes: webrtc

```ts
export function nodeRtcBackend(opts?: { bindAddress?: string; portRange?: [number, number] }): RtcBackend
export function closeNodeRtc(): void
```

- It implements RtcBackend with `node-datachannel` (exact version): PeerConnection, createDataChannel, onLocalDescription/onLocalCandidate, and binary Buffer messages converted to Uint8Array. The default bind is 127.0.0.1.
- `closeNodeRtc` calls the library's cleanup.
- The test runs two loopback peers with iceServers [] and exchanges 100 messages per channel. If node-datachannel cannot open on loopback, the test fails with a refusal naming the bindAddress tried. It never skips.

## Module: gamesaloon-local

- Repository: royal-fiesta
- Files: apps/headless/src/gamesaloon.ts, apps/headless/test/gamesaloon.test.ts
- Owner: existing
- Consumes: bricks

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

- Repository: royal-fiesta
- Files: apps/headless/src/realMatch.ts, apps/headless/proofs/m6-transports.ts, docs/network.md, docs/gamesaloon-gaps.md
- Owner: existing
- Consumes: relay-client, loopback-relay, webrtc, rtc-node, gamesaloon-local, m5-proof

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

- Repository: royal-fiesta
- Files: packages/game/src/render/port.ts, packages/game/src/render/nullPort.ts, packages/game/test/nullPort.test.ts
- Owner: existing
- Consumes: prims

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

## Module: client-core

- Repository: royal-fiesta
- Files: packages/game/src/client/inputMap.ts, packages/game/src/client/inpageMatch.ts, packages/game/test/inpageMatch.test.ts
- Owner: existing
- Consumes: scene-view, net-match, net-metrics

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

- Repository: royal-fiesta
- Files: apps/web/client.html, apps/web/src/client/main.ts, apps/web/src/client/hud.ts, apps/web/src/client/sources.ts, apps/web/src/nmc/ops.ts, apps/web/public/nmc.gpu.json
- Owner: existing
- Consumes: client-core, raa-port, relay-client, webrtc, rooms-client

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

- Repository: royal-fiesta
- Files: apps/web/src/render/raaStatus.ts, apps/web/src/render/raaPort.ts
- Owner: existing
- Consumes: render-port, bricks

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

- Repository: royal-fiesta
- Files: apps/headless/proofs/m7-web.ts, proofs/m7/raa-status.json, proofs/m7/captures.json
- Owner: existing
- Consumes: web-client, client-core, node-files, proofkit

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

- Repository: royal-fiesta
- Files: packages/game/src/hub/protocol.ts, packages/game/test/hubProtocol.test.ts
- Owner: existing
- Consumes: relay-client

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

- Repository: royal-fiesta
- Files: packages/game/src/hub/hubWorld.ts, packages/game/src/hub/remotes.ts, packages/game/src/hub/queuePad.ts, packages/game/test/hubWorld.test.ts, fixtures/courses/hub-plaza.course.json, fixtures/assets/queue-pad.prims.json, fixtures/assets/plaza-fountain.prims.json
- Owner: existing
- Consumes: hub-protocol, character, obstacles, course-loader

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

- Repository: royal-fiesta
- Files: packages/game/src/hub/flow.ts, packages/game/src/hub/hubPilot.ts, packages/game/test/flow.test.ts
- Owner: existing
- Consumes: hub-world, net-match, relay-client, client-core

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

- Repository: royal-fiesta
- Files: apps/web/play.html, apps/web/src/play/main.ts, apps/web/src/play/hubView.ts, apps/web/src/play/inpageHub.ts, apps/web/src/play/ops.ts
- Owner: existing
- Consumes: play-flow, loopback-relay, scene-view, web-client

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

- Repository: royal-fiesta
- Files: apps/headless/src/hubLoop.ts, apps/headless/proofs/m8-hub.ts, proofs/m8/raa-status.json, proofs/m8/captures.json
- Owner: existing
- Consumes: play-flow, gamesaloon-local, web-play, proofkit

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
