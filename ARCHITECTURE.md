# Royal Fiesta architecture

The deliverable is the existing Royal Fiesta game running on the Etcito engine behind `?engine=1`: start, hub, an offline or online 60-seat show, qualification, podium and return to the hub. `engine-show.html` is its dedicated demonstration page. The existing simulation remains available and its mandatory checks remain intact.

## Project configuration

Royal Fiesta owns this project contract. Modules belong to exactly one repository; the generated ownership table identifies their tracked files and owners. Shared registrations have one producer and preserve existing consumers.

Creation settings are repo mode, clarify_answerer jev, autorun true, regressions each_milestone, milestone merge enabled and GPU false. Writable repository aliases are engine and royal-fiesta, with changed-scope branch checks; merge engine first. Studied repositories remain read-only. RAA, MAMA and SDF Modeler are consumed through existing APIs. The integration preserves the rollback dependency and transport protocols.

## Implementation conventions
Node >=22.18; ESM; TypeScript imports end in `.ts`; erasable syntax only. Use two spaces, single quotes, no semicolons and named exports, except Vite's configuration default export. TypeScript is loading, transport, serialization and presentation glue. New computation belongs in Rust/WASM or WebGPU; game logic belongs in AssemblyScript. Existing TypeScript simulation and presentation implementations are retained as existing coverage, not copied into the engine path. Normals and materials for SDF content come from the SDF in shaders; do not bake them.

AssemblyScript 0.28.20 is compiled through the existing engine compiler. Persistent script state is declared in schema components/resources, never mutable module globals. Use deterministic SDK math; scratch allocations use the arena. State that follows an entity across domain transfer, including bot RNG, reaction queues, route state and event accumulation, belongs to transferable entity records rather than world-local caches. The engine remains genre-neutral, including its documentation and tests. Its frozen model/ABI contract, including the maximum of 32 input players per world, is preserved.

Rust uses the repository's Rust 1.96.0 toolchain, edition 2024, deterministic guards and existing raw WASM ABI. No unordered collections, clocks, threads, native transcendental substitutes or Rapier parallel/SIMD features in deterministic code. Errors retain EgeError/EgeResult; game data errors use RefusalError with source path, field and repair instruction. Required invalid data never silently defaults.

Dependencies are linked by Kong. Existing file-linked engine, compiler, RAA and MAMA bricks are built/provided before consumers read their dist outputs. Do not add a git dependency merely to connect existing siblings. If a later authorized change introduces one, use an HTTPS URL pinned to a full commit and require the clean-copy Kong check from the standing rules.

Tests use `node --experimental-strip-types --test <selected files>` in Royal Fiesta and engine TypeScript packages. Test files remain in their subject's existing test directory. Rust tests use `cargo test -p <crate> --test <subject>`. Rust task lint is scoped to changed files/crates, with host `--all-targets --no-deps` and WASM `--lib --target wasm32-unknown-unknown --no-deps`; milestone checks retain the full existing repository checks. Royal Fiesta retains npm run typecheck, npm run guard and npm run build. Engine retains cargo check and bash scripts/check.sh. Both repositories are checked at every milestone.

Search implementation and tests before decomposing any changed interface, text or schema layout. Include every affected pinning test in its implementation owner's scope. Do not make a consumer's acceptance depend on an unfinished producer's generated output. Build entries precede every dist reader through explicit command dependencies.

No new benchmark, timing report, measurement card, proof script, golden image, snapshot-hash comparison, CPU rendering oracle or old-versus-new simulation comparison. Existing checks are neither removed nor narrowed because they use those techniques. Legacy proof files remain owned and runnable, but are not scheduled as milestone proof/regression cards by this chain. Functional engine tests execute the new implementation and assert rules, state, restore behavior and delivered effects.

## Visual execution and command ownership
Server GPU remains off. Browser rendering uses the managed GPU client on a physical GPU, never a sandbox Chrome or software substitute. Model producers implement the page, inventory and commands; subsequent programmatic execution and image judgment use those outputs. Each programmatic selection declares its own `only` names. Every visual increment includes a simple scene from its first visual implementation and a judged capture of the completed increment. Images are rendered once per current build/inventory and valid results are reused on retries.

Extend the existing engine-round capture implementation by extracting its reusable lifecycle into one shared job module. Preserve engine-round behavior and tests. Show-specific files contain scenarios, inventories and page adapters, not copies of clean/render/fresh/judge logic. Captures are 1920x1080 and are delivered beneath ignored `out/engine-show/<stage>/`; resumable state is `$NMC_CACHE_DIR/engine-show/<stage>`, falling back to the delivery directory. Clean creates an attempt without deleting retained records. Copy retained images and job records into each new delivery directory. Save successful jobs and verdicts before a later failure. Reuse requires unchanged build identity, inventory metadata, intact image bytes and identical judgment description/held constants. No hash comparison is introduced. An explicit ENGINE_SHOW_RERENDER_ALL=1 switch disables reuse.

Each image has a descriptive filename, one visible expectation and held-constant fixtures. Judge with python3 and NMC_JUDGE_CLIENT, minimum score 6. The host archives and mails passed milestone images before cleanup; delivery failures remain host responsibilities. No image or generated binary is committed.

Commands files are lists of objects using only name, command, timeout_s, optional cwd and after. Each entry is one executable without shell operators; at most 40 selected entries, timeout at most 3600 seconds, at most ten parallel entries. Build -> selection/content validation -> clean -> render -> fresh -> judge. Judge depends on both render and fresh and names the delivery directory. Long builds/tests run programmatically when they can exceed five minutes.

Browser flows use one explicit test mode: minimum presentation durations, skipped decorative transitions and readiness/state signals instead of fixed sleeps. Simulation ticks, real mesh ordering and confirmation semantics remain real. Preparation stays loading while pending and visibly failed on rejection. Preparation is cached outside fresh checkouts. The online Chrome harness is executed once by the host on the browser machine; no preceding local-browser duplicate is planned.

## Quality bar

These are acceptance requirements, not assertions that every scenario has passed. Current integration limitations are documented in the relevant modules.

- QB1: deterministic restore/replay and transferable controller, bot, route and scoring state, checked through functional assertions without new hash comparisons.
- QB2: preserve existing performance coverage; add no measurement deliverable or timing threshold.
- QB3: preserve stable identity across near/far transitions, parking, return and domain replacement, without duplicate penguins.
- QB4: preserve existing input-latency coverage and avoid presentation-controlled simulation delay.
- QB5: support round kinds, playoffs, qualification, confirmed winner, podium and hub return through authoritative scripts.
- QB6: render upright penguins, legible round/timer/qualification HUD, visible mechanisms, costumes, movement poses, an elevated winner and walking/emoting hub occupants.
- QB7: invalid schema, scripts, content, identity and preparation fail visibly with actionable errors; pending or failed preparation never reports ready.
- QB8: repository guards pass; generated WASM, captures, fonts and assets remain untracked.
- QB9: eligible confirmed effects deliver sound and rewards once, remain silent during replay and retain receipts across world replacement.
- QB10: required visual results use their working page and managed GPU captures judged at least 6.
- QB11: scripts compile against the actual schema, load successfully and report zero runtime faults in completed scenarios.
- QB12: movement, jumping, diving, sliding/strokes, grabbing, stunning, swimming, carrying and surface behavior include their presentation fields.
- QB13: gates, laps, finish, kill plane, respawn slots/protection, elimination and closure obey the rules contract.
- QB14: all 22 feature kinds remain supported, with roster-sized seat storage on the show path.
- QB15: equal engine inputs produce equal engine state; the legacy simulation is not an execution oracle.
- QB16: preserve existing flows and mandatory checks; browser exercises use dedicated pages or explicit engine=1 URLs.
- QB17: host online acceptance requires two clients and 58 bots, one completed confirmed round, zero reported desyncs and zero script faults.
- QB18: a modeler-saved script changes subsequent local ticks without resetting the round; rejected edits preserve the running module and state. The interactive page is engine-show-dev.html; the judged saved-script scenario composes reload/status modules in engine-show.html.

## 1. Conventions (every module follows these)

### 1.1 Runtime and language
Node >=22.18, ESM, strict erasable TypeScript and .ts import extensions. Tests use node:test and node:assert/strict through node --experimental-strip-types. tools/typecheck.ts checks the workspace projects; AssemblyScript compiles separately. Vite discovers root HTML pages in apps/web and emits apps/web/dist. Implementation conventions specify language ownership and deterministic restrictions.

### 1.2 Dependencies and layout
Manifest/lockfile pins are authoritative. Kong links engine/compiler bricks; tools/egeBricks.ts checks their outputs. RAA and MAMA are read-only dependencies. packages/sim contains the existing simulation; packages/game contains browser-safe adapters; apps/headless contains Node runners; apps/web contains pages; scripts/ege contains game scripts; ege.schema.json declares their state; tools contains build/capture jobs. Dependency direction is sim <- game <- apps. No Node imports enter packages/game.

### 1.3 State and ownership
The module table governs shared registrations. Schema declarations and generated accessors have one owner; consumers do not invent offsets. Simulation state uses deterministic math, ordered operations and snapshotted RNG. Engine scripts own authoritative show rules and bot decisions. TypeScript loads, transports and decodes state, including copying declared lifecycle/protocol inputs at deterministic boundaries; presentation does not decide qualification or run bot brains.

### 1.4 Units and fixed values
Metres, seconds, radians; Y up, forward +Z, 60 Hz and gravity (0,-20,0). Legacy matches and engine-round use eight seats. Shows support sixty stable room seats; human input slots are 0..7 and bots use -1. Engine worlds retain the 32-input-player limit. Unused engine slots are zero; S1 neutral is 32639.

FIESTA_TUNING retains tickRate 60, maxSubsteps 8, maxPrediction 16, snapshotRing 40, minDelay/maxDelay 2, delayHiddenTicks 6, lostAfterMs 3000 and dropWaitMs 1500. Zone sessions retain their tuning. Group bits are STATIC 1, MOVING 2, CHAR 4, DEBRIS 8 and PROBE 16. Captures are 1920x1080; camera FOV 60 degrees, near .1, far 500. Hub rates are 5 Hz or 1 Hz during matches, hello every five seconds, 360 frames/minute and ten/second; remote delay 300 ms and maximum extrapolation 200 ms. Standard/sprint profiles remain available.

### 1.5 Errors and storage
RefusalError identifies area, path and repairable reason; engine errors retain their codes. Engine preparation/content failures never silently select the legacy simulation. JSON is UTF-8 with two-space indentation and a trailing newline. SnapWriter/SnapReader use explicit lengths and raw/u32 words for blobs. Content-address fields remain product data. Generated scripts, declarations, manifests and captures are untracked.

### 1.6 Guard and verification
The guard enforces binary/UTF-8/NUL rules, a 262144-byte general limit and a 65536-byte fixture limit, with its existing lockfile exemption. Existing proof modules, golden files and mandatory checks remain runnable. New engine coverage asserts behavior, restore and delivered effects without adding benchmarks, golden images or legacy-oracle comparisons. The Quality bar governs acceptance. Managed physical-GPU captures and the host browser harness provide their respective visual and online evidence.

## 2. Shared data shapes and formats

### S1. PlayerInput wire code (u32), sim/input
Bits 0..7 and 8..15 are moveX/moveZ encoded as round(clamp(axis,-1,1)*127)+127, range 0..254; decode clamps to 254 then subtracts 127 and divides by 127. Bits 16,17,18 are jump,dive,grab. Other bits encode zero and decode ignored. Neutral is 32639. Direction is world-space; the client rotates controls by the camera before encoding. Controller normalization and button-edge state remain simulation responsibilities.

### S2. Course JSON v0 (`fixtures/courses/<id>.course.json`), game/course
Retain format royal-fiesta.course, version 0, id/name/kind/profiles/assetsManifest/timeLimitS/killPlaneY/spawns/checkpoints/finish/path/regions/queuePad/obstacles. Course ids match ^[a-z0-9-]{1,40}$ and their stem. Kinds are race, survival, hub, gallery. A spawn is translation and yawDeg; checkpoints contain center/half/respawn; finish and queuePad are nullable boxes; paths contain position and jump/dive flags; regions contain id/center/half/adjacent. Obstacles contain id/asset/t/r/s/friction/motion/colliders.

Motion forms remain static; spinner(axis,speedDegS,phaseDeg); pendulum(pivot,axis,ampDeg,periodS,phaseDeg); seesaw(axis,maxDeg,spring,damping,inertia); rotatingDoor(axis,stepDeg,periodS,moveS,phaseS); conveyor(velocity); bouncePad(speed); movingPlatform(offset,periodS,phaseDeg,wave sine or pingpong). Degrees convert through deterministic math; seconds become rounded ticks, minimum one. Axes/quaternions have unit tolerance 1e-6. Nonuniform scaling is admitted only for supported collider shapes. Preserve loader caps, unique ids, finite-number checks, race finish/spawn checks and source-pointer refusals. G7 uses the already-landed CourseV1/LevelSpec and zone sidecars for show content; it does not replace their format with this legacy subset.

### S3. Primitive asset subset (raa.prims v0), game/prims
Retain format/version/id/name, nodes, materials, anchors, budget and collision. Nodes carry id/kind/params/transform/material/op/children. Existing sphere, box, roundBox, capsule, cylinder, cone, torus and ellipsoid parameter names remain. Limits are 64 nodes, depth 8 and finite values. Collider overrides retain cuboid, roundCuboid, ball, capsule, cylinder and cone with local pose; course convexHull retains its existing 4..64-point/version validation. Union descendants compose transforms; subtract/intersect nodes are ignored for collision. Torus/ellipsoid without an override and unsupported nonuniform primitive scaling refuse. Engine conversion retains its explicit supported-shape refusals rather than silently approximating unimplemented course shapes.

### S4. Asset store manifest and URLs
Retain the asset object URL https://assets.etcito.com/objects/<first-two-hex>/<sha256> and raa.manifest version 0 entries keyed by logical name with sha256,size,type,version. Existing store verification remains product behavior. Null assetsManifest resolves fixtures. The game reads content; modeler tooling writes authored content. No G7 acceptance compares artifact hashes.

### S5. FiestaWorld snapshot layout (sim/world)
Retain RFW1 magic 0x52465731, version 1, playerCount, systemCount, sections in registration order and length-prefixed Rapier snapshot words. Legacy order is match,bots,obstacles,characters,round. Existing hashes remain protocol implementation details. G7 uses the engine's EGW1/EGT1/EGZ1 formats without replacing them.

### S6. Match log JSON (sim/match/log; CLIs write it to out/)
Retain royal-fiesta.matchlog version 0 with seed,profile,playerCount,humans,setupHash,rounds,winner,podium,finalTick,finalHash. Each round has index,kind,final,course,startTick,endTick,participants,target,qualified,eliminated,reason. Qualification/elimination ordering remains meaningful. G7's typed show result adds the already-landed season fields described in G7.2 and does not fabricate legacy hash evidence.

### S7. RB1: rollback packets over the GameSaloon relay (game/net/relayTransport)
Retain this legacy format for its existing callers: rb entries [toMask,ch,base64], ch fast 0/reliable 1; identical packets combine destination masks; maximum 3800 JSON bytes and 500 entries; oversize packets use rbf id/i/n/to/ch/d fragments. Existing two-frame flush cadence, 60 acts/s,3900/min and fast-drop/reliable-wait behavior remain. G7 online play does not select this game-data transport.

### S8. GameSaloon usage by the game
Existing relay queue/private hub and rooms clients remain compatible with their existing protocols. G7 follows the landed ZoneRelayClient plus ZoneMeshTransport route: lobby/signaling/presence through the relay, game traffic exclusively through WebRTC fast/reliable channels. No relay fallback. Lower peer id initiates an RTC pair. Missing connectivity remains a visible refusal. Module admission is checked before an engine match starts, as G7.5 specifies.

### S9. Hub act payloads (game/hub/protocol)
Retain hi {k:'hi',v:1,name,c} and st {k:'st',s,p:[xcm,ycm,zcm],f,m,e,q,x}. Positions are integer centimetres, facing is a byte, emotes are none/wave/dance/cheer/laugh and last two seconds. Malformed acts are dropped/counted. Presence remains presentation data for remote hub occupants, not authority over local engine physics.

### S10. Proof records (committed, JSON)
Existing proofs/mN records remain legacy artifacts owned by their existing modules. Their schemas and existing tests are retained. New render records, images, facts and verdicts live in ignored output/capture storage and are not added to this format.

### S11. Golden files (`fixtures/golden/*.json`)
Existing royal-fiesta.golden version 0 files retain name,regenerate,ticks,rows and hash, and their existing tests. G7 introduces no golden image, reference simulation or recorded hash fixture.

## 3. Engine round contracts (G6)

### E1. Boundaries and fixed values
engine-round.html remains an offline eight-seat round. files.ts retains ege.schema.json, scripts/ege, world kind round, seat count 8 and ege/rf-scripts.wasm. Its default behavior is preserved. G7 world kinds and entrypoints are additional.

### E2. Input conversion
Engine axes are signed bytes while S1 uses offset bytes. engineCodeOfS1 clamps S1 bytes to 254, subtracts 127 and packs their low bytes; s1CodeOfEngine sign-extends, clamps to [-127,127], adds 127 and repacks. Preserve button mask 0x70000 only. S1 neutral maps to engine zero.

### E3. Schema and schedule
ege.schema.json owns all declarations, layouts and access lists. Game numeric state remains f64 with f32 physics boundaries; counts are at most 16 per field and components/resources fit 256 bytes. Existing seat/character/gate/spawn/home/path/surface/feature records and round/course resources remain. Collision pairs are static 1/28, moving 2/28, char 4/7, debris 8/11, probe 16/3. Status rank: out=0, alive=1, qualified=2, eliminated=3. Round phase rank: intro=0, playing=1, overtime=2, ended=3.

Existing order remains movers, road, mechanism logic/joints, clock, character pre, feature pre, body properties, box dimensions, physics, contacts, mechanism watch, character post, feature post, seat rules. Feature rank: marker=0, boostLane=1, launchPad=2, catchVolume=3, rollingLog=4, doorBank=5, swimVolume=6, carryItem=7, tileField=8, hexField=9, memoryTiles=10, annulus=11, sweep=12, risingKill=13, ball=14, goal=15, collectible=16, bank=17, captureZone=18, tailSet=19, crown=20, road=21. Road has no script system; ball consumes goal behavior. Events remain finish,fall,eliminate,gate,progress,score,team_score,possess,crown,match. Sub-tick crossings are 0..65535; match carries seat:u32,a:i32,b:i32.

### E4. Scene emission
buildEngineAssembly builds from CourseV1, resolved assets, capsule and setup; emitEngineScene converts through engine assembly and resolves named ids. Upright seat capsules have density zero, additional mass 60, body gravity scale zero, contacts and body-properties records. Scripts provide gravity/placement. Course-data entities carry gates/homes/spawns/paths. Mechanisms are assembly items; other obstacles are movers. Apply obstacle scale exactly once. Supported collider conversion and source-pointer refusals remain. Feature children retain ownership references and deterministic initialization. G7's additive EmitInput options select seat count/world kind/input slots; absence preserves eight-seat round emission.

### E5. Script compilation and state
Compile recursive .as.ts sources under scripts/ege in UTF-8 relative-path order. System exports replace dots with underscores. Use SDK/generated accessors and relative helpers. No mutable module globals or object-valued constants. Diagnostics preserve scripts/generated/sdk source distinctions. Schema changes recompile the whole set. The modeler's compatible script paths are governed by sdfm:src/core/game/paths.ts:23 SCRIPT_PATH_RE, ^scripts/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+[.]as[.]ts$.

### E6. Round runtime
createEngineRound retains its existing arguments and eight human flags. It loads schema/module/world/ScriptHost, converts S1 inputs and steps once. Its existing TypeScript DomainBot path remains confined to G6. RoundObservation retains post-step tick, counts, eight character observations, module faults and event counts. Sprint observation tick 60 is intro and 61 is playing. G7 does not reuse this non-rollback bot host for show authority.

### E7. Rendering and capture arguments
EngineSceneSim remains the read adapter for engine-round, now implementing the shared SceneReadView. SceneView and the SDF port share the actual RAA canvas with roundRenderBridge; hexTiles keeps its existing authored mesh/deck materials. Existing RoundRunArgs defaults, local idle/run/dive/sideways/grab modes, end/dive/firstFinish/respawned triggers, focus and authored runPath remain. Frames range 1..7200, default 600; profile sprint, seed 7. First-finish waits three ticks; respawn waits thirty ticks after reactivation; dive waits ten ticks after local dive. The op steps virtually, advances presentation each tick, draws first/every sixtieth/final tick and settles eight frames. Its output remains {json:{facts,capture:{name,width,height,mime,base64}},files:[]}.

### E8. Inventory and resumable job
Existing engine-round rows retain id,milestone m2..m7,filename,args,require,description,held_constant and eq/gt/ge/lt/empty requirements. tools/engineRoundCapture.ts retains check/clean/render/fresh/judge and its existing CLI. check validates content and construction without running the browser flow. Its store remains NMC_CACHE_DIR/engine-round-mN or its output fallback. Extraction into the shared capture job preserves selection, retained records, failed-first scheduling, fresh checks and judgment budget/reuse. Engine-round callers retain their CLI and inventory; show callers supply their own typed inventory adapter.

### E9. Engine prerequisites
Preserve ege.body.props (28-byte record), ege.contact.track (132-byte record with four sorted contacts), ege.box.collider (12-byte f32 half extents) and bodyType fixed=0,dynamic=1,position-kinematic=2,velocity-kinematic=3,absent=-1. Box dimensions validate before mutation, preserve collider identity/properties and apply before physics. SDK/engine ABI compatibility and access checks remain unchanged.

## 4. G7 show, zone and presentation contracts

### G7.1 Identity, control and worlds
RoomSeat is a stable integer 0..59. RoundSeat indexes the ascending surviving seatOf roster. InputSlot is -1 for bots or 0..7 for humans; RoomSeat is never an engine player index. show_seat/show_field have eight inputs, show_rules zero and show_hub one. The engine limit remains 32.

show_seat_identity stores room_seat, round_seat, input_slot and bot. show_control.code uses S1 offset-byte encoding, neutral 32639. SDK inputCode, traversal, behavior and reaction queues use signed engine-axis bytes, neutral zero. Controls convert SDK/reaction output to S1 before character pre; retained S1 control converts back before entering the reaction path. Both conversions preserve only button mask 0x70000 and clamp axes as E2 specifies. Missing human slots are neutral; invalid or duplicate mappings refuse.

Seat/field schedules prepare controls before character pre and publish cumulative results after seat/feature rules. show_rules consumes ege.zone.inbox without physics. show_hub provides character control, wandering and fall recovery without competitive closure. Entity-owned route, controller, respawn, bot/reaction and cumulative state transfers with its seat; entity references are remapped by the engine. Rules handoff restores the complete rules snapshot. Course/static ownership follows zone construction.

The script bot implementation and its serializers exist, but playable show scene emission currently omits bot_seat, bot_behaviour and show_nav_* rows. Consequently those emitted show bots remain neutral. Route lookup and cursor limitations are documented in ege-show-bots; runtime bot counts do not establish successful navigation.

### G7.2 Scripted rules and results
The behavior specification is packages/sim/src/zones/ledger.ts and season/plan, qualify, points, scheduler, teams, respawn and route; these are not runtime oracles. Kind ranks are race 0, survival 1, team 2, collection 3, hunt 4, logic 5, final 6. Final rules are none 0, crown 1, lastStanding 2. Reasons are target 0, timeCap 1, lastStanding 2, allFell 3, overtime 4, teamWin 5, score 6, crown 7, playoff 8.

Default plan is [60,40,24,12,6,1], long plan [60,48,36,24,12,6,1]. The next target is clamp(ceil(alive*nextNominal/currentNominal),1,alive-1). Finals above twelve survivors insert a cut to twelve; final target is one. Team rounds require an even roster, half cut and no preceding team round in the show. Cuts/playoffs do not advance the nominal step. Selection preserves the reserved final, unused-map and kind preferences, voting and deterministic ties. Final/cut/playoff offers one candidate; ordinary slots offer up to three. Catalog order is committed season order. NO_BACK_TO_BACK is mapped by map identity: show_catalog_entry.cut packs cut in bit 0 and banned-predecessor catalog index plus one in bits 8..31, zero for none. Multiple banned predecessors refuse.

SeatRecord fields are seat,status,finishTick,finishSub,lap,stage,routeMm,falls,score,lastScoreTick,holdTicks,possessing,lastAcquireTick,matches,crossTicks,outTick,outSub,team,openingRank. show_result_a stores the first ten; show_result_b the remaining nine. Numeric fields are i32 except possessing as u32 0/1. Missing tick/stage/team values initialize to -1; counters to zero and status alive.

Race orders finishers by tick/subtick, then unfinished seats by descending lap/stage, ascending remaining route distance and falls. Survival puts living seats first, then latest exit. Collection sorts descending score then earliest last score; hunt descending hold, possession first then earliest acquisition; logic descending matches then ascending crossing penalty. Crown uses finish order and last-standing uses survival order. Remaining ties use seedOrder and numeric seat.

Race closes at target/cap; survival at target/all-fell or overtime end after its cap; team on a non-tied cap score, overtime score change or overtime end; collection/hunt/logic at cap; finals on their winning condition or overtime. Survival/crown quota-boundary ties create playoffs; tied replays use positive opening rank, seed order and seat. Qualified points are entrants-rank+1, eliminated points zero, with winning-team rank treatment. Opening ranks and cumulative points persist.

Routes start stage=-1, lap=0, finished=0. Ordered gates require the next stage; unordered gates a later checkpoint. Premature finishes are ignored and earlier laps reset stage. Remaining distance projects onto authored path segments with first-index nearest ties. Subtick is round(clamp((previousY-plane)/(previousY-y),0,1)*65535), zero for equal heights. Respawn uses waits/protection, 1..12 slots in a four-column/three-row grid, deterministic anchor cursors and source facing, clearing stale movement/grab state.

EngineRoundResult contains index,map,course,kind,final,playoff,endTick,reason,ranking,qualified,eliminated,points,teamScores,champion. Seat lists use RoomSeat; points align with ranking; champion -1 is absent. Results require confirmedTick > endTick. Pending ledger is null. Callers vote only on the vote screen with candidates and an active seatOf membership; runtime validation additionally rejects bots, invalid indices and out-of-phase votes.

Runtime physics construction follows the script-committed selected map and surviving roster, preserving human slots. It applies authored cap/overtime consistently to rules and physics; missing/inconsistent content refuses. testMode shortens presentation waits, not gameplay settings.

### G7.3 Bots and cumulative messages
Behavior data is royal-fiesta.bot v0, validated with parseBehaviour/bindBehaviour and serialized into records. Route preferences are short/safe; predicates always, obstacleAhead, hazardNear, stuck, nearNode, nearFinish; actions jump, dive, grab, useLever. Scripts own decisions, cadence, reaction queues and traversal queries. Safe cost is exposure*1000000+distanceMm+1; short cost (distanceMm+1)*64+exposure. Equal distances settle by region id and equal predecessor costs by tieKey. Unreachable routes fall back to authored paths. Reaction chunks hold at most sixteen engine-format codes and support delays 0..120. Transfer retains initialization, RNG and pending reactions. Scene integration limitations are stated in G7.1.

Zone outbox encoding is u16 count followed by {key:u32,kind:u32,value:u32,tick:u32}; inbox adds source. Resimulation replaces that tick's payload. Seat publishers use stable ids 65536+roomSeat*32+fieldRank, owner=roundSeat, kind=fieldRank and cumulative i32 bit-pattern values. Field ranks 0..18 follow SeatRecord order. Team contribution ids begin at 131072 and use authored feature/team identity. Construction refuses collisions.

Rules assemble complete records by stable key and produced tick. New complete records replace old cumulative state; older/repeated records do nothing and incomplete records wait. Conflicting complete values for the same key/tick refuse. Source domain is provenance, not identity. Accepted ticks and contributions are snapshotted. Presentation events never directly invoke sound or persistence from scripts.

### G7.4 Presentation and effects
SceneReadView exposes tick, setup.playerCount, phase(out), character(player,out), course(), obstacleCount/spec/pose, mechanismItemCount/item/bodyPose/events and signal(id). It has no step method. CharacterView includes optional strokeTimer, strokePhase, strokeStart, slideSpeed, carry, surface and slideAir. Missing seats park and clear detail; invalid non-seat indices refuse; absent mechanism bodies return false without changing out.

EngineShowRuntime.presentation() returns the selected course and live entity mappings for seats, obstacles, mechanisms, features and publishers. Incarnations distinguish reused handles. Borrowed data expires at tick/replacement/release boundaries; absent physics exposes no stale world. farSnapshot() returns a fresh copy of the live domain's raw far poses and refuses after invalidation.

onPresentation emits synchronous post-tick observations after every executed tick, including rules-only ticks, and before-release while the event source remains readable. SceneView.observeTick runs once for each presented post-tick, never again for before-release. Listener errors surface without replaying executed ticks or bypassing cleanup. Legacy tick wrapping is isolated in legacySceneTicks.

EngineShowView selects at most eight active near seats: humans by inputSlot/roomSeat, then bots by roomSeat. Other active seats remain far candidates; near exclusion prevents duplication without changing authority. EngineFarView decodes engine far bytes; incarnation replacement clears stale snapshots. Existing RAA/SDF, skins, costumes, camera, podium and audio assets remain in use.

EngineShowEffects drains per-world EventBridge sources after ticks and before release, using confirmation/resimulation state. Sound and grants deliver only when eligible and confirmed; replay is silent. Receipts survive world replacement and are keyed by show, round, stable publisher, sequence and effect kind. Only authoritative results authorize grants. Dropped ring records fail visibly; deliveryStats reports actual dropped records and repeated sink deliveries. HUD/camera/animation may read prediction without committing grants.

### G7.5 Admission and transport
EngineModuleIdentity is {backend:'engine',schemaKey:number,moduleKey:string}. schemaKey identifies the loaded schema; moduleKey is an opaque publication identity associated with exact compiled bytes and retained in cache, not a verification hash. Successful new compilation receives a new key.

Engine lobby offers and all participating peer payloads must match backend/schemaKey/moduleKey before session creation. Missing, malformed or mismatched identities refuse visibly; legacy peers are admitted only on the legacy path. The relay carries presence/signaling, never scripts/WASM or show game data. ZoneMeshTransport, RoundTransport and ZoneSession carry WebRTC traffic without relay fallback. Factory script preparation completes before constructing a session; rejection exposes no partially ready runtime. A late client joins before roster sealing; delayed session readiness is separate from live roster insertion.

### G7.6 Saved script reload
rfEgeScripts observes saved .as.ts files, compiles the complete set and publishes revision,moduleKey,schemaKey,wasmUrl,diagnostics. Latest requested revision wins; failure retains runnable bytes and exposes diagnostics. SDF Modeler uses its existing registered-game writeGameFile path.

Local reload validates every live world before swapping timelines. It preserves tick, round, records, scores, runtime identity and effect receipts; refusals leave old timelines intact. Online swaps refuse and schema changes require restart. Later-created worlds adopt the applied runner at their first post-tick observation. engine-show-dev.html attaches the reload/status UI; ege-dev-swap specifies the saved-file capture path and module lifetime.

### G7.7 Pages and captures
mountEngineShow(root,options) returns a page with ready, state() and dispose(). Options are mode local/online, testMode, seed, humans and optional onRuntime. State reports screen,ready,error,backend,seats,humans,bots,round,tick,moduleKey,faults,completedRounds,desyncs. Pending/failed preparation is not ready. engine-show.html defaults to local, sixty seats, one human and starts in the engine hub; online shows attach through remountWith.

Operations register before loading. Signals are page-ready, hub-ready, round-ready, round-ended, podium-ready, hub-returned and script-applied. Missing transitions fail. Capture inventories use id,stage,filename,args,require,description,held_constant, with unique lowercase hyphenated PNG filenames. Shared jobs own check/clean/render/fresh/judge and resumable storage.

Offline images are simple-engine-character.png, sixty-seat-engine-round.png and engine-show-winner-podium.png. Hub images are engine-hub-walking-and-emotes.png and engine-show-returned-to-hub.png. The online inventory contains only engine-online-late-client-round.png, seed 7 and two humans, with twelve requirements for engine identity, errors/faults, clients/humans/bots, same round, delayed start, desyncs and membership. It does not require podium or effect facts. The background-client-podium scenario remains registered but is not an inventory requirement. Swap uses engine-saved-script-applied.png. Selection validates content before managed GPU execution; required moving features must be visible. The page budget is 270 seconds.

### G7.8 Host online demonstration
The existing tools/onlineChromes.mjs supports engine, late-client, background-client and until round-ended/show-ended options. URLSearchParams preserves engine=1. State-driven CDP waits cover lobby entry, a second client before sealing, actual background visibility and terminal assertions. Round acceptance requires two humans, fifty-eight bots, a confirmed round and zero desyncs/faults; process survival alone is insufficient. Failures/stalls exit nonzero. Cleanup affects only owned Chromes. The harness runs on the host browser machine against a locally served build; no public deployment or sandbox-browser substitute is part of this contract.

## Module ownership

| Module | Files | Consumes |
|---|---|---|
| workspace | `package.json`<br>`tsconfig.json`<br>`tsconfig.base.json`<br>`.gitignore`<br>`README.md`<br>`packages/sim/package.json`<br>`packages/sim/tsconfig.json`<br>`packages/game/package.json`<br>`packages/game/tsconfig.json`<br>`apps/headless/package.json`<br>`apps/headless/tsconfig.json`<br>`apps/web/package.json`<br>`apps/web/tsconfig.json`<br>`package-lock.json` | — |
| guard | `tools/guard.ts`<br>`tools/test/guard.test.ts`<br>`.githooks/pre-commit`<br>`docs/private-assets.md` | workspace |
| bricks | `tools/bricks.ts`<br>`tools/test/bricks.test.ts` | workspace |
| refusal | `packages/sim/src/refusal.ts`<br>`packages/sim/test/refusal.test.ts` | workspace |
| detmath | `packages/sim/src/detmath.ts`<br>`packages/sim/src/vec.ts`<br>`packages/sim/test/detmath.test.ts`<br>`packages/sim/test/vec.test.ts`<br>`packages/sim/test/purity.test.ts` | workspace |
| world | `packages/sim/src/world.ts`<br>`packages/sim/src/groups.ts`<br>`packages/sim/test/world.test.ts` | detmath, refusal |
| flat-floor | `packages/sim/src/scenarios/flatFloor.ts`<br>`packages/sim/test/flatFloor.test.ts` | world |
| proofkit | `apps/headless/src/proofkit.ts`<br>`apps/headless/test/proofkit.test.ts` | bricks |
| m1-proof | `apps/headless/src/smoke.ts`<br>`apps/headless/proofs/m1-foundations.ts` | flat-floor, proofkit, guard, web-boot |
| web-boot | `apps/web/vite.config.ts`<br>`apps/web/index.html`<br>`apps/web/src/boot.ts` | flat-floor, bricks, ege-build |
| course-model | `packages/sim/src/course.ts`<br>`packages/sim/test/course.test.ts` | detmath |
| motion | `packages/sim/src/obstacles/motion.ts`<br>`packages/sim/test/motion.test.ts` | course-model |
| obstacles | `packages/sim/src/obstacles/system.ts`<br>`packages/sim/src/obstacles/colliders.ts`<br>`packages/sim/test/obstacles.test.ts` | motion, world |
| prims | `packages/game/src/prims.ts`<br>`packages/game/test/prims.test.ts` | course-model, refusal |
| assets | `packages/game/src/assets.ts`<br>`packages/game/test/assets.test.ts`<br>`fixtures/assets/floor-tile.prims.json`<br>`fixtures/assets/floor-disc.prims.json`<br>`fixtures/assets/wall-block.prims.json`<br>`fixtures/assets/spinner-bar.prims.json`<br>`fixtures/assets/pendulum-hammer.prims.json`<br>`fixtures/assets/seesaw-plank.prims.json`<br>`fixtures/assets/rotating-door.prims.json`<br>`fixtures/assets/conveyor-belt.prims.json`<br>`fixtures/assets/bounce-pad.prims.json`<br>`fixtures/assets/moving-platform.prims.json`<br>`fixtures/assets/finish-arch.prims.json`<br>`fixtures/assets/checkpoint-gate.prims.json` | prims |
| course-loader | `packages/game/src/course.ts`<br>`packages/game/test/course.test.ts`<br>`fixtures/courses/obstacle-gallery.course.json`<br>`fixtures/courses/invalid/trimesh-collider.course.json`<br>`fixtures/courses/invalid/bad-motion.course.json`<br>`fixtures/courses/invalid/unknown-asset.course.json`<br>`fixtures/courses/invalid/race-without-finish.course.json` | assets, obstacles |
| node-files | `apps/headless/src/files.ts`<br>`apps/headless/test/files.test.ts` | course-loader, bricks |
| m2-proof | `apps/headless/proofs/m2-obstacles.ts`<br>`fixtures/golden/m2-obstacle-poses.json` | node-files, obstacles, proofkit |
| input | `packages/sim/src/input.ts`<br>`packages/sim/test/input.test.ts` | world |
| character | `packages/sim/src/character/capsule.ts`<br>`packages/sim/src/character/constants.ts`<br>`packages/sim/src/character/controller.ts`<br>`packages/sim/src/character/system.ts`<br>`packages/sim/test/character.test.ts`<br>`packages/sim/test/characterCapsule.test.ts` | input, obstacles, detmath |
| input-scripts | `apps/headless/src/scripts.ts`<br>`apps/headless/test/scripts.test.ts` | character, input, node-files |
| m3-proof | `apps/headless/proofs/m3-character.ts`<br>`fixtures/golden/m3-replay.json` | input-scripts, node-files, proofkit |
| match-rules | `packages/sim/src/match/setup.ts`<br>`packages/sim/src/match/rules.ts`<br>`packages/sim/test/rules.test.ts` | course-model, world |
| round-system | `packages/sim/src/match/roundSystem.ts`<br>`packages/sim/test/round.test.ts` | match-rules, character, obstacles |
| bots | `packages/sim/src/bots/brain.ts`<br>`packages/sim/src/bots/botSystem.ts`<br>`packages/sim/test/bots.test.ts` | round-system, character, match-rules |
| match-sim | `packages/sim/src/match/matchSim.ts`<br>`packages/sim/src/match/log.ts`<br>`packages/sim/src/match/offline.ts`<br>`packages/sim/test/matchSim.test.ts` | bots, round-system, obstacles, character |
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
| scene-view | `packages/game/src/render/palette.ts`<br>`packages/game/src/render/camera.ts`<br>`packages/game/src/render/sceneView.ts`<br>`packages/game/test/sceneView.test.ts`<br>`fixtures/assets/bean.prims.json`<br>`packages/game/src/render/sceneReadView.ts`<br>`packages/game/src/render/legacySceneTicks.ts`<br>`packages/game/test/sceneViewAnimRate.test.ts`<br>`packages/game/test/sceneViewNetAnimRate.test.ts`<br>`packages/game/test/sceneReadView.test.ts` | render-port, match-sim, net-match |
| client-core | `packages/game/src/client/inputMap.ts`<br>`packages/game/src/client/inpageMatch.ts`<br>`packages/game/test/inpageMatch.test.ts` | scene-view, net-match, net-metrics |
| web-client | `apps/web/client.html`<br>`apps/web/src/client/main.ts`<br>`apps/web/src/client/hud.ts`<br>`apps/web/src/client/sources.ts`<br>`apps/web/src/nmc/ops.ts`<br>`apps/web/public/nmc.gpu.json` | client-core, raa-port, relay-client, webrtc, rooms-client |
| raa-port | `apps/web/src/render/raaStatus.ts`<br>`apps/web/src/render/raaPort.ts` | render-port, bricks |
| m7-proof | `apps/headless/proofs/m7-web.ts`<br>`proofs/m7/raa-status.json` | web-client, client-core, node-files, proofkit |
| hub-protocol | `packages/game/src/hub/protocol.ts`<br>`packages/game/test/hubProtocol.test.ts` | relay-client |
| hub-world | `packages/game/src/hub/hubWorld.ts`<br>`packages/game/src/hub/remotes.ts`<br>`packages/game/src/hub/queuePad.ts`<br>`packages/game/test/hubWorld.test.ts`<br>`fixtures/courses/hub-plaza.course.json`<br>`fixtures/assets/queue-pad.prims.json`<br>`fixtures/assets/plaza-fountain.prims.json` | hub-protocol, character, obstacles, course-loader |
| play-flow | `packages/game/src/hub/flow.ts`<br>`packages/game/src/hub/hubPilot.ts`<br>`packages/game/test/flow.test.ts` | hub-world, net-match, relay-client, client-core, ege-hub, ege-show-runtime, ege-online |
| web-play | `apps/web/play.html`<br>`apps/web/src/play/main.ts`<br>`apps/web/src/play/hubView.ts`<br>`apps/web/src/play/inpageHub.ts`<br>`apps/web/src/play/ops.ts` | play-flow, loopback-relay, scene-view, web-client |
| m8-proof | `apps/headless/src/hubLoop.ts`<br>`apps/headless/proofs/m8-hub.ts`<br>`proofs/m8/raa-status.json` | play-flow, gamesaloon-local, web-play, proofkit |
| ege-body-contacts | `crates/ege-physics/src/body_props.rs`<br>`crates/ege-physics/src/contacts.rs`<br>`crates/ege-physics/tests/body_props.rs`<br>`crates/ege-physics/tests/contacts.rs`<br>`engine:crates/ege-physics/src/body_props.rs`<br>`engine:crates/ege-physics/src/contacts.rs`<br>`engine:crates/ege-physics/tests/body_props.rs`<br>`engine:crates/ege-physics/tests/contacts.rs` | — |
| ege-schema | `ege.schema.json`<br>`tools/test/egeSchema.test.ts` | ege-body-contacts, ege-box-collider |
| ege-build | `tools/egeScripts.ts`<br>`tools/egeBricks.ts`<br>`apps/web/src/engineRound/scriptsPlugin.ts`<br>`tools/test/egeScripts.test.ts`<br>`tools/test/egeBricks.test.ts`<br>`tools/test/egePublication.test.ts` | ege-schema, bricks |
| ege-scene | `packages/game/src/ege/files.ts`<br>`packages/game/src/ege/inputCodes.ts`<br>`packages/game/src/ege/colliders.ts`<br>`packages/game/src/ege/featureEmitters.ts`<br>`packages/game/src/ege/sceneEmitter.ts`<br>`packages/game/test/egeInputCodes.test.ts`<br>`packages/game/test/egeScene.test.ts` | course-loader, course-model, character, match-rules, world, input, ege-schema |
| ege-round | `packages/game/src/ege/round.ts`<br>`packages/game/src/ege/observe.ts`<br>`packages/game/test/egeObserve.test.ts` | ege-scene, bots, character, round-system |
| ege-script-core | `scripts/ege/lib/vec.as.ts`<br>`scripts/ege/lib/seats.as.ts`<br>`scripts/ege/lib/boxes.as.ts`<br>`scripts/ege/lib/units.as.ts`<br>`scripts/ege/round/clock.as.ts`<br>`scripts/ege/lib/show_events.as.ts` | ege-schema |
| ege-harness | `apps/headless/src/egeHarness.ts`<br>`apps/headless/test/egeRound.test.ts` | ege-round, ege-scene, ege-build, ege-script-core, node-files |
| ege-view | `packages/game/src/ege/sceneSim.ts`<br>`packages/game/test/egeSceneSim.test.ts` | ege-round, scene-view, match-sim |
| ege-page | `apps/web/engine-round.html`<br>`apps/web/src/engineRound/main.ts`<br>`apps/web/src/engineRound/run.ts`<br>`apps/web/src/engineRound/hud.ts`<br>`apps/web/src/engineRound/ready.ts`<br>`apps/web/src/engineRound/ops.ts`<br>`apps/web/public/engine-round/inventory.json`<br>`apps/web/test/engineRoundRun.test.ts`<br>`apps/web/test/engineRoundPage.test.ts`<br>`apps/web/src/engineRound/pace.ts`<br>`apps/web/src/engineRound/hexTiles.ts` | ege-view, ege-round, ege-scene, scene-view, web-client, render-port |
| ege-capture | `tools/engineRoundCapture.ts`<br>`tools/test/engineRoundCapture.test.ts`<br>`tools/engineCaptureJob.ts`<br>`tools/test/engineCaptureJob.test.ts` | ege-harness, ege-page |
| ege-manifest | `packages/game/src/gameManifest.ts`<br>`sdfm.game.json`<br>`packages/game/test/gameManifestEge.test.ts` | course-model |
| ege-character | `scripts/ege/character/constants.as.ts`<br>`scripts/ege/character/pre.as.ts`<br>`scripts/ege/character/post.as.ts`<br>`scripts/ege/character/ground.as.ts`<br>`scripts/ege/character/moves.as.ts`<br>`scripts/ege/character/grab.as.ts`<br>`scripts/ege/character/bump.as.ts`<br>`apps/headless/test/egeCharacter.test.ts` | ege-script-core, ege-schema, ege-harness, ege-body-contacts, character |
| ege-seat-rules | `scripts/ege/seat/rules.as.ts`<br>`scripts/ege/seat/route.as.ts`<br>`scripts/ege/seat/respawn.as.ts`<br>`fixtures/ege/ege-strip.course.json`<br>`apps/headless/test/egeSeatRules.test.ts` | ege-character, ege-script-core, ege-harness |
| ege-features-race | `scripts/ege/features/marker.as.ts`<br>`scripts/ege/features/boost_lane.as.ts`<br>`scripts/ege/features/launch_pad.as.ts`<br>`scripts/ege/features/catch_volume.as.ts`<br>`scripts/ege/features/rolling_log.as.ts`<br>`scripts/ege/features/door_bank.as.ts`<br>`scripts/ege/features/swim_volume.as.ts`<br>`scripts/ege/features/tile_field.as.ts`<br>`packages/game/src/ege/features/marker.ts`<br>`packages/game/src/ege/features/boostLane.ts`<br>`packages/game/src/ege/features/launchPad.ts`<br>`packages/game/src/ege/features/catchVolume.ts`<br>`packages/game/src/ege/features/rollingLog.ts`<br>`packages/game/src/ege/features/doorBank.ts`<br>`packages/game/src/ege/features/swimVolume.ts`<br>`packages/game/src/ege/features/tileField.ts`<br>`packages/game/src/ege/features/road.ts`<br>`fixtures/ege/ege-yard-a.course.json`<br>`packages/game/test/egeFeatureEmitRace.test.ts`<br>`apps/headless/test/egeFeaturesRace.test.ts` | ege-scene, ege-seat-rules, ege-character, ege-harness |
| ege-features-hazard | `scripts/ege/features/hex_field.as.ts`<br>`scripts/ege/features/memory_tiles.as.ts`<br>`scripts/ege/features/annulus.as.ts`<br>`scripts/ege/features/sweep.as.ts`<br>`scripts/ege/features/rising_kill.as.ts`<br>`packages/game/src/ege/features/hexField.ts`<br>`packages/game/src/ege/features/memoryTiles.ts`<br>`packages/game/src/ege/features/annulus.ts`<br>`packages/game/src/ege/features/sweep.ts`<br>`packages/game/src/ege/features/risingKill.ts`<br>`fixtures/ege/ege-yard-b.course.json`<br>`packages/game/test/egeFeatureEmitHazard.test.ts`<br>`apps/headless/test/egeFeaturesHazard.test.ts` | ege-features-race, ege-box-collider, ege-schema |
| ege-features-objective | `scripts/ege/features/carry_item.as.ts`<br>`scripts/ege/features/ball.as.ts`<br>`scripts/ege/features/goal.as.ts`<br>`scripts/ege/features/collectible.as.ts`<br>`scripts/ege/features/bank.as.ts`<br>`scripts/ege/features/capture_zone.as.ts`<br>`scripts/ege/features/tail_set.as.ts`<br>`scripts/ege/features/crown.as.ts`<br>`packages/game/src/ege/features/carryItem.ts`<br>`packages/game/src/ege/features/ball.ts`<br>`packages/game/src/ege/features/goal.ts`<br>`packages/game/src/ege/features/collectible.ts`<br>`packages/game/src/ege/features/bank.ts`<br>`packages/game/src/ege/features/captureZone.ts`<br>`packages/game/src/ege/features/tailSet.ts`<br>`packages/game/src/ege/features/crown.ts`<br>`fixtures/ege/ege-yard-c.course.json`<br>`packages/game/test/egeFeatureEmitObjective.test.ts`<br>`apps/headless/test/egeFeaturesObjective.test.ts` | ege-features-hazard, ege-script-body-type |
| ege-box-collider | `crates/ege-physics/src/box_collider.rs`<br>`crates/ege-physics/src/lib.rs`<br>`crates/ege-physics/tests/box_collider.rs`<br>`ARCHITECTURE.md`<br>`AGENTS.md`<br>`engine:crates/ege-physics/src/box_collider.rs`<br>`engine:crates/ege-physics/src/lib.rs`<br>`engine:crates/ege-physics/tests/box_collider.rs`<br>`engine:ARCHITECTURE.md`<br>`engine:AGENTS.md` | — |
| ege-script-body-type | `crates/ege-wasm/src/abi_script.rs`<br>`crates/ege-wasm/tests/abi_script.rs`<br>`packages/game-engine/src/abi.ts`<br>`packages/game-engine/src/script.ts`<br>`packages/game-engine/test/script.test.ts`<br>`sdk/assembly/engine.ts`<br>`sdk/assembly/physics.ts`<br>`sdk/sdk.json`<br>`packages/game-engine/compile/test/compile.test.ts`<br>`engine:crates/ege-wasm/src/abi_script.rs`<br>`engine:crates/ege-wasm/tests/abi_script.rs`<br>`engine:packages/game-engine/src/abi.ts`<br>`engine:packages/game-engine/src/script.ts`<br>`engine:packages/game-engine/test/script.test.ts`<br>`engine:sdk/assembly/engine.ts`<br>`engine:sdk/assembly/physics.ts`<br>`engine:sdk/sdk.json`<br>`engine:packages/game-engine/compile/test/compile.test.ts` | — |
| ege-show-runtime | `packages/game/src/ege/showFactory.ts`<br>`packages/game/src/ege/showRuntime.ts`<br>`packages/game/src/ege/showScene.ts`<br>`packages/game/src/ege/showState.ts`<br>`packages/game/src/ege/showTypes.ts`<br>`packages/game/src/ege/worldRead.ts`<br>`apps/headless/src/engineShow.ts`<br>`packages/game/test/egeShowFactory.test.ts`<br>`apps/headless/test/egeShow.test.ts` | ege-domain-binding, ege-show-rules, ege-show-bots, ege-scene, ege-build |
| ege-show-view | `packages/game/src/ege/showView.ts`<br>`packages/game/src/ege/showFar.ts`<br>`packages/game/src/ege/showEffects.ts`<br>`packages/game/test/egeShowView.test.ts`<br>`packages/game/test/egeShowEffects.test.ts`<br>`packages/game/test/egeShowFar.test.ts` | scene-view, ege-show-runtime, render-port |
| ege-show-page | `apps/web/engine-show.html`<br>`apps/web/src/engineShow/main.ts`<br>`apps/web/src/engineShow/ops.ts`<br>`apps/web/src/engineShow/page.ts`<br>`apps/web/src/engineShow/presentation.ts`<br>`apps/web/src/engineShow/ready.ts`<br>`apps/web/src/engineShow/testMode.ts`<br>`apps/web/public/engine-show/offline.inventory.json`<br>`apps/web/test/engineShowPage.test.ts`<br>`apps/web/test/engineShowReady.test.ts`<br>`apps/web/test/engineShowPresentation.test.ts`<br>`tools/engineShowCapture.ts` | ege-show-view, ege-capture, ege-page, web-client, render-port, ege-online |
| ege-dev-swap | `packages/game/src/ege/localSwap.ts`<br>`apps/web/src/engineShowDev/reload.ts`<br>`apps/web/src/engineShowDev/status.ts`<br>`apps/web/src/engineShowDev/main.ts`<br>`apps/web/engine-show-dev.html`<br>`apps/web/src/engineShow/scenarios/savedScript.ts`<br>`apps/web/public/engine-show/swap.inventory.json`<br>`tools/savedScriptSave.ts`<br>`packages/game/test/egeLocalSwap.test.ts`<br>`apps/web/test/engineShowReload.test.ts`<br>`apps/web/test/engineShowDevStatus.test.ts`<br>`apps/web/test/engineSwapInventory.test.ts`<br>`tools/test/savedScriptSave.test.ts` | ege-build, ege-show-runtime, ege-show-page, ege-show-view, ege-manifest, ege-capture |
| ege-domain-binding | `engine:packages/game-engine/src/rollback.ts`<br>`engine:packages/game-engine/src/zones.ts`<br>`engine:packages/game-engine/test/rollback.test.ts`<br>`engine:packages/game-engine/test/rollback-script.test.ts`<br>`engine:packages/game-engine/test/hotswap.test.ts`<br>`engine:packages/game-engine/test/zones.test.ts`<br>`engine:packages/game-engine/test/events.test.ts` | ege-script-body-type |
| ege-show-rules | `scripts/ege/show/ledger.as.ts`<br>`scripts/ege/show/qualification.as.ts`<br>`scripts/ege/show/season.as.ts`<br>`scripts/ege/show/scheduler.as.ts`<br>`scripts/ege/show/teams.as.ts`<br>`scripts/ege/show/clock.as.ts`<br>`scripts/ege/show/publish.as.ts`<br>`scripts/ege/show/hub.as.ts`<br>`apps/headless/test/egeLedger.test.ts`<br>`apps/headless/test/egeSeason.test.ts`<br>`apps/headless/test/egeShowTransfer.test.ts` | ege-schema, ege-script-core, ege-seat-rules, ege-features-objective |
| ege-show-bots | `scripts/ege/bots/brain.as.ts`<br>`scripts/ege/bots/routes.as.ts`<br>`scripts/ege/bots/behaviour.as.ts`<br>`scripts/ege/bots/traversal.as.ts`<br>`packages/game/src/ege/botData.ts`<br>`packages/game/test/egeBotData.test.ts`<br>`apps/headless/test/egeBots.test.ts` | ege-schema, ege-character, ege-show-rules |
| ege-hub | `packages/game/src/ege/hub.ts`<br>`packages/game/src/ege/hubFlow.ts`<br>`packages/game/test/egeHub.test.ts`<br>`apps/web/src/engineShow/scenarios/hub.ts`<br>`apps/web/public/engine-show/hub.inventory.json`<br>`apps/web/test/engineHubFlow.test.ts` | ege-show-runtime, ege-show-page, ege-show-rules, hub-protocol, hub-world |
| ege-online | `packages/game/src/ege/online.ts`<br>`packages/game/src/ege/admission.ts`<br>`packages/game/src/ege/onlineState.ts`<br>`packages/game/test/egeAdmission.test.ts`<br>`packages/game/test/egeOnline.test.ts`<br>`packages/game/test/egeOnlineState.test.ts`<br>`packages/game/test/egeOnlineRound.test.ts`<br>`packages/game/src/net/zoneRelayProtocol.ts`<br>`packages/game/test/zoneRelayProtocol.test.ts`<br>`apps/web/src/engineShow/scenarios/online.ts`<br>`apps/web/public/engine-show/online.inventory.json`<br>`apps/web/test/engineOnlineInventory.test.ts` | ege-show-runtime, ege-hub, ege-show-view, webrtc, relay-client, ege-show-page, net-match |
| ege-game-switch | `apps/web/src/game/main.ts`<br>`apps/web/src/game/showMode.ts`<br>`apps/web/src/game/showDirector.ts`<br>`apps/web/src/game/entry.ts`<br>`apps/web/src/game/engineBackend.ts`<br>`apps/web/src/game/engineProbe.ts`<br>`apps/web/src/client/sound.ts`<br>`apps/web/src/play/sound.ts`<br>`packages/game/src/audio/events.ts`<br>`packages/game/src/flow/endScreen.ts`<br>`apps/web/src/zone/zoneNetScene.ts`<br>`apps/web/test/engineGameSwitch.test.ts`<br>`apps/web/test/gameSound.test.ts`<br>`apps/web/test/zoneSceneReady.test.ts`<br>`apps/web/test/zonePenguin.test.ts`<br>`apps/web/test/showMode.test.ts`<br>`apps/web/test/showDirector.test.ts`<br>`apps/web/test/engineProbe.test.ts` | play-flow, ege-online, ege-hub, ege-show-page, scene-view, ege-show-view, ege-show-runtime |
| ege-online-harness | `tools/onlineChromes.mjs`<br>`tools/test/onlineChromes.test.ts`<br>`docs/engine-show.md` | ege-game-switch, ege-online |

## Module: workspace
Consumes: none.

Owns root/workspace package manifests, tsconfigs, `.gitignore` and README. Workspaces are `packages/*` and `apps/*`; packages are private ESM sources targeting Node >=22.18. Package subpath exports resolve directly to source `.ts` files.

Root scripts define test, multi-project typecheck, guard, bricks, smoke and build entry points. `build` calls `web:build`, which bakes audio, bundles UI fonts, builds the Vite workspace and generates cosmetic thumbnails. `ege:build` runs `tools/egeScripts.ts build --out out/ege`; `ege:bricks` runs `tools/egeBricks.ts build`. Engine/compiler dependencies are local built-brick links and AssemblyScript is pinned to 0.28.20. Package-lock records the dependency graph.

AssemblyScript is excluded from TypeScript project compilation and ordinary test discovery. Generated out/dist files, captures and Kong rules are untracked. See section 1 for language, dependency, layout and guard rules.

## Module: guard
Consumes: workspace.

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
Consumes: workspace.

Files: `tools/bricks.ts`, `tools/test/bricks.test.ts`.

`repoRoot()` locates the real repository root. `brickDir()` supports gamesaloon-public, raa-assets-tools, raa and MAMA, consulting the applicable environment override, RF_BRICKS_DIR and siblings; absence returns null. `checkBricks()` checks workspace resolution, rollback dependencies and Rapier initialization, and reports available content/render sources. `bricksRequired()` recognizes RF_REQUIRE_BRICKS and NMC_PUSH_GATE.

Source/pin helpers include `mamaSource`, `raaLocal`, `raaSdfmVersion`, UAA/RAA source inspection and pin/status operations. CLI commands are `check`, `status`, `pins`, `where <name>` and `fetch mama|uaa|raa`. Fetch operations prepare the appropriate pinned checkout/link and build prerequisites. Credentials are redacted. Engine brick preparation is owned separately by ege-build.

## Module: refusal
Consumes: workspace.

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
Consumes: workspace.

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
Consumes: detmath, refusal.

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
Consumes: world.

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
Consumes: bricks.

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
Consumes: flat-floor, proofkit, guard, web-boot.

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
Consumes: flat-floor, bricks, ege-build.

Files: `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/boot.ts`.

Vite discovers every root HTML page, builds to dist with relative base URLs, disables asset inlining, allows repository files and emits ES workers. Plugins select MAMA or its absent stub, retain only imported asset game-data fields, fix UAA text shader edges, and compile engine scripts through `rfEgeScripts()`.

Aliases resolve game/sim source, available MAMA dependencies and configured local RAA packages. Build defines expose MAMA identity and raa-sdfm version for content caching. UAA WebGPU is excluded from dependency optimization.

The boot page initializes Rapier, steps an eight-player flat-floor world for 600 ticks and exposes its tick/hash result in the page and `window.rfBoot`.

## Module: course-model
Consumes: detmath.

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
Consumes: course-model.

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
Consumes: motion, world.

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
Consumes: course-model, refusal.

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
Consumes: prims.

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
Consumes: assets, obstacles.

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
Consumes: course-loader, bricks.

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
Consumes: node-files, obstacles, proofkit.

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
Consumes: world.

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
Consumes: input, obstacles, detmath.

Files: `packages/sim/src/character/{capsule,constants,controller,system}.ts`, `packages/sim/test/character.test.ts`, `packages/sim/test/characterCapsule.test.ts`.

`CAPSULE` comes from the saved collider in `assets/common/penguin.body.asset.json`. `parseCharacterCapsule` requires exactly one upright, origin-centred capsule with positive radius and nonnegative halfHeight; stand is their sum. Collider, spawn, probe and presentation consumers use this shared geometry.

`constants.ts` exports CHAR, SLIDE_STROKE and stroke timing/animation helpers, CharMode, CarryKind, SURFACE_TUNING, GLARE_ICE, ICE_GRIP_MU and iceWalkTuning. Modes are ground 0, air 1, dive 2, diveRecover 3, stunned 4, grabbing 5, frozen 6, parked 7, slide 8 and swim 9. Carry kinds are none 0, object 1, player 2, tail 3 and crown 4. `approach2` limits planar velocity change; `turnFacing` limits deterministic angular change.

`characterBody` creates capsule body descriptors. CharacterSystem can create bodies or bind external bodies. It exposes placement, parking, body restoration, freezing, input override, protection, carry/swim/friction controls, knockback, state/position reads and lever-grab inspection, alongside preStep/postStep and per-player/full snapshot methods.

Pre-step handles input edges, ground support and carried velocity, surface steering, jump buffering/coyote time, dive/slide/stroke transitions, swimming, player/lever grabs and protection. Post-step resolves landing, contact knockback and support loads. Placement uses feet + stand + .01; parked bodies use the configured off-course slots. Persistent mode, timers, facing, support, grab, carry, slide, swim and protection state are serialized by the implementation.

CharState includes position, velocity, facing, mode, grounded/support information, knockbacks and teleport tick, with optional mechanism, protection, slide, carry and stroke presentation fields. Engine gameplay consumes these definitions and constants through its separate script port.

## Module: input-scripts
Consumes: character, input, node-files.

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
Consumes: input-scripts, node-files, proofkit.

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
Consumes: course-model, world.

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
Consumes: match-rules, character, obstacles.

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
Consumes: round-system, character, match-rules.

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
Consumes: bots, round-system, obstacles, character.

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
Consumes: course-loader, match-rules.

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
Consumes: match-sim, course-set, node-files, proofkit.

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
Consumes: match-sim, input.

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
Consumes: net-match.

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
Consumes: net-metrics, net-match, course-set, node-files, proofkit.

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
Consumes: refusal, net-match.

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
Consumes: relay-client.

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
Consumes: relay-client.

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
Consumes: rooms-client.

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
Consumes: webrtc.

Files: `apps/headless/src/rtcNode.ts`, `apps/headless/test/rtcNode.test.ts`.

```ts
export function nodeRtcBackend(opts?: { bindAddress?: string; portRange?: [number, number] }): RtcBackend
export function closeNodeRtc(): void
```

- It implements RtcBackend with `node-datachannel` (exact version): PeerConnection, createDataChannel, onLocalDescription/onLocalCandidate, and binary Buffer messages converted to Uint8Array. The default bind is 127.0.0.1.
- `closeNodeRtc` calls the library's cleanup.
- The test runs two loopback peers with iceServers [] and exchanges 100 messages per channel. If node-datachannel cannot open on loopback, the test fails with a refusal naming the bindAddress tried. It never skips.

## Module: gamesaloon-local
Consumes: bricks.

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
Consumes: relay-client, loopback-relay, webrtc, rtc-node, gamesaloon-local, m5-proof.

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
Consumes: prims.

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

Consumes: render-port, match-sim, net-match.

Files: packages/game/src/render/{palette,camera,sceneView,sceneReadView,legacySceneTicks}.ts; sceneView, sceneViewAnimRate, sceneViewNetAnimRate and sceneReadView tests; fixtures/assets/bean.prims.json.

SceneView.update(view:SceneReadView,smoother,alpha,frameDtS) presents the read-only interface in G7.4. observeTick(view) advances animation from executed ticks. attachLegacySceneTicks(sim,observe) returns an unsubscribe function; engine hosts observe explicitly. SceneView retains camera, instanceCount, courseIndex, readiness and disposal APIs, course rebuilding, correction smoothing, camera obstruction, skins, animation, costumes and environments.

Exports also include PALETTE, PALETTE_NAMES, seatTint, followCamera, ikInputs, characterObservation, restPoseSkin and costume/skinned-character types. SceneViewOptions includes its full implemented rendering and animation options; the bean fixture remains a fallback asset rather than the complete penguin presentation contract.

## Module: client-core
Consumes: scene-view, net-match, net-metrics.

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
Consumes: client-core, raa-port, relay-client, webrtc, rooms-client.

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
Consumes: render-port, bricks.

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
Consumes: web-client, client-core, node-files, proofkit.

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
Consumes: relay-client.

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
Consumes: hub-protocol, character, obstacles, course-loader.

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

Consumes: hub-world, net-match, relay-client, client-core, ege-hub, ege-show-runtime, ege-online.

Files: packages/game/src/hub/{flow,hubPilot}.ts and packages/game/test/flow.test.ts.

PlayFlow supports connecting, hub, queued, choosing, watching, match, podium, returning and failed states. FlowDeps includes zones/season, lobby or pad matchmaking, RTC/mesh settings, seat count, vote/intermission durations, presentationDone and optional backend. FlowHub is the common hub-facing surface implemented by HubWorld and HubRuntime.

FlowBackend contains identity, asynchronous createHub(plaza,spawn) and createMatch(matched,transport). Absent backend preserves legacy factories. Engine admission precedes match creation; pending loads remain pending and cancellation disposes stale completions. Engine failures do not fall back. ZoneRelayClient supplies lobby/signaling and ZoneMeshTransport carries game traffic.

The flow preserves lobby reentry, watcher/presentation completion, spawn return, remote presence and disposal. The hub sender retains 360 frames/minute and ten/second budgets, hello cadence, dropped-state handling and bye behavior. HubPilot supplies presentation-side movement/emotes for its existing automated callers. Tests cover flow/budgets and backend preparation/admission failures.

## Module: web-play
Consumes: play-flow, loopback-relay, scene-view, web-client.

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
Consumes: play-flow, gamesaloon-local, web-play, proofkit.

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

## Module: ege-body-contacts

- Repository: engine
- Files: `crates/ege-physics/src/body_props.rs`, `crates/ege-physics/src/contacts.rs`, `crates/ege-physics/tests/body_props.rs`, `crates/ege-physics/tests/contacts.rs`
- Owner: 0
- Consumes: nothing

Engine-owned `ege.body.props` (28-byte record) applies validated rotation locks, additional mass and gravity/buoyancy properties; `ege.contact.track` is a 132-byte record with four sorted contacts. `bodyType` is fixed 0, dynamic 1, position-kinematic 2, velocity-kinematic 3 and absent -1; the host enforces transform-read access, phase/world validity and pointer bounds. These systems and records are owned and tested in the engine repository. See E9.

## Module: ege-schema

Consumes: ege-body-contacts, ege-box-collider.

Files: ege.schema.json and tools/test/egeSchema.test.ts.

Declares round plus show_seat, show_field, show_rules and show_hub, their input counts, real script schedules and access lists. Game records include shared control, stable seat identity, transferable bot/reaction state, cumulative publication and ledger state, season/catalog/candidate/vote/used-map rows and hub state. Engine-prefixed declarations come from engine registration. Counts per field are at most sixteen and records at most 256 bytes; larger state uses child rows.

G6 ordering/events remain as E3. Memory cells retain twenty symbols split as u32[16] and u32[4], with total size 152 bytes; seat crossing rows scale with the emitted roster. Tests inspect actual schema layouts, schedules, groups, input packing and construction of all world kinds.

## Module: ege-build

Consumes: ege-schema, bricks.

Files: tools/{egeScripts,egeBricks}.ts, apps/web/src/engineRound/scriptsPlugin.ts and egeScripts/egeBricks/egePublication tests.

collectRfScripts returns sorted {name,text} sources. rfCompiler caches compilation services and resets after rejection. compileRfScripts({root?,overrides?}) compiles against engine schema/SDK and returns bytes, diagnostics and source names; formatRfDiagnostic maps paths. CLI check/build and engine brick discovery remain available.

createRfPublicationManager and readRfPublication manage ScriptPublication and PublicationEvent, revision ordering, cached exact bytes and EngineModuleIdentity. RF_PUBLICATION_EVENT is rf:script-publication; output files are rf-publication.json and rf-scripts.wasm. A successful compilation receives an opaque moduleKey; unchanged cached results retain it. Failed edits expose diagnostics while preserving the runnable publication.

rfEgeScripts serves/emits the schema, WASM and publication, watches saved sources, coalesces requests and prevents older asynchronous completions from replacing newer revisions. Tests cover compilation/load, diagnostics, publication ordering/cache and brick lookup.

## Module: ege-scene

Consumes: course-loader, course-model, character, match-rules, world, input, ege-schema.

Files: packages/game/src/ege/{files,inputCodes,colliders,featureEmitters,sceneEmitter}.ts and egeInputCodes/egeScene tests.

Exports RF_EGE constants, E2 codecs, collider conversion, FEATURE_EMITTERS, buildEngineAssembly and emitEngineScene. EmitInput adds optional show {worldKind,seatOf,inputSlots,humans}; omission preserves G6. EmittedScene retains assembly/document/text, named entity lookup and seat/obstacle/feature/item-body mappings, plus show seat and zone ownership metadata.

Show helpers allocate stable seat, child, result-publisher and membership zone identities and validate collisions, roster lengths and human-slot consistency. Entity references are resolved after conversion. FeatureEmitContext includes seatCount/world kind; all 22 feature kinds remain registered. E4 governs geometry, capsule setup, scaling and supported-shape refusals.

Current limitation: sceneEmitter emits bot memory/route/reaction state but does not attach bot_seat or serialize authored bot_behaviour/show_nav_* rows into playable show worlds. rf_show_bots therefore has no runnable bot seats there. serializeBotData exists separately in ege-show-bots; it is not wired into this construction path.

## Module: ege-round
Consumes: ege-scene, bots, character, round-system.

Files: `packages/game/src/ege/{round,observe}.ts`, `packages/game/test/egeObserve.test.ts`.

createEngineRound validates eight human flags and simulation data, then creates EngineRound as specified in E6. EngineRound exposes engine/world/module/host/layout/scene, tick, step(human), observe(), worldState(), poses(ids) and idempotent dispose(). Poses contain 23 floats per entity: position, quaternion and matrix.

observeRound decodes schema records into RoundObservation and CharObservation; charStateOf supplies the bot-facing CharState. Missing required seats are refused. Event totals accumulate only the interval stepped, including match. Tests exercise record decoding, mode/status/facing/phase values and missing-seat refusal.

## Module: ege-script-core

Consumes: ege-schema.

Files: scripts/ege/lib/{vec,seats,boxes,units,show_events}.as.ts and scripts/ege/round/clock.as.ts.

Exports arena vector/quaternion helpers, approach2/turnFacing, inBox, degree/tick conversions, TICK_DT, seat/character/transform/velocity access and placement/parking. Placement clears velocity and initializes the character at feet plus stand height and clearance.

rf_round_clock retains G6 phase, freezing, placement and previous-position behavior; show schedules have their own clock. recordShowEvent updates transferable cumulative records when present and emits the existing event payload. It is shared by show-enabled seat/features and never invokes external sound or grants. Persistent state lives in schema records.

## Module: ege-harness
Consumes: ege-round, ege-scene, ege-build, ege-script-core, node-files.

Files: `apps/headless/src/egeHarness.ts`, `apps/headless/test/egeRound.test.ts`.

loadEgeCourse reads courses/<id>.course.json, falling back only on absence to fixtures/ege, and resolves assets with nodeGameAssets. rfScriptBytes compiles once per process and rejects error diagnostics or missing WASM. harnessRound creates an engine/schema/scene/round; defaults are sprint, seed 7, human seat zero and seven bots. runTicks passes each current tick to the supplied human input callback and returns the final observation.

Tests cover construction, first placement/uprightness, zero faults, the tick-60/61 phase boundary and equality of two worlds driven by identical codes. Feature and character tests reuse this harness without GPU/browser/network dependencies.

## Module: ege-view

Consumes: ege-round, scene-view, match-sim.

Files: packages/game/src/ege/sceneSim.ts and packages/game/test/egeSceneSim.test.ts.

EngineSceneSim implements SceneReadView. constructor(course,scene) and refresh(round) expose observations, poses, characters, obstacles, mechanisms and signals without impersonating MatchSim. Missing/unsupported character detail is cleared and absent seats parked. Any compatibility step method is outside SceneReadView; engine animation uses explicit observeTick calls.

focusCamera retains center+(0,9,-14), target center+(0,1,0), FOV 60, near .1 and far 500. Tests cover pose/character reads, parking and camera values.

## Module: ege-page
Consumes: ege-view, ege-round, ege-scene, scene-view, web-client, render-port.

Files: `apps/web/engine-round.html`, `apps/web/src/engineRound/{main,run,hud,ready,ops,pace,hexTiles}.ts`, `apps/web/public/engine-round/inventory.json`, engine-round browser tests. The SDF port exposes raaEngine(), refusing access before initialization.

parseRunArgs, localCode, focusedFeature and createRoundRun implement E7. The pure run controller owns capture triggers and facts; FIRST_FINISH_TICKS is 3. createReadyGate exposes loading/ready/error. hudLines and drawRoundHud produce the five-line overlay. registerEngineRoundOps installs the page op.

main loads the round and existing content, binds EngineSceneSim/SceneView to the shared SDF/RAA port, composites PNG output and manages disposal. Live mode uses WASD/arrows, Space, Shift and E. pace.ts separates per-tick scene advancement from periodic drawing and final temporal settling. hexTiles.ts routes copied engine view records to ordinary or per-deck RenderBridge instances, retaining engine transforms/visibility while using a beveled hex mesh and deck colours.

The committed inventory supplies exact capture arguments and requirements. The survival demo row currently captures at frame 750; the crown row at 2280 with an authored path. Tests cover argument validation, input patterns, capture conditions, facts, readiness and HUD behavior; no capture result is implied by these unit tests.

## Module: ege-capture

Consumes: ege-harness, ege-page.

Files: tools/{engineRoundCapture,engineCaptureJob}.ts and their tools/test files.

engineRoundCapture retains InventoryRow, loadInventory, selectRows, requireProblems, keptRows, renderOrder, judgeImages, main and its CLI/inventory adapter. engineCaptureJob exports shared row validation, requirement evaluation, attempt/store management, retained-image restoration, render ordering, freshness and judgment.

runEngineCaptureJob<A>(config,argv,execution?) accepts topic,inventory,page,parseArgs,validateSelection and run. CaptureRow contains id,stage,filename,args,require,description,held_constant; CaptureResult contains facts and a 1920x1080 PNG capture. Optional CaptureExecution supplies execution boundaries for tests.

The shared lifecycle is check -> clean -> render -> fresh -> judge. Check validates selection/content; clean allocates an attempt without deleting retained records. Render checks facts before persistence and saves each success. Reuse requires matching build/inventory metadata, intact image bytes and judgment inputs; ENGINE_SHOW_RERENDER_ALL disables show reuse. Judge minimum is 6. E8 and Visual execution specify cache/delivery behavior. Show adapters supply scenarios, not duplicate persistence logic.

## Module: ege-manifest
Consumes: course-model.

Files: `packages/game/src/gameManifest.ts`, `sdfm.game.json`, `packages/game/test/gameManifestEge.test.ts`.

GameManifest and parseGameManifest accept optional schema/scripts only as a pair. Schema is a plain relative .schema.json path; scripts is scripts or a plain folder beneath it. Refusals point to /schema or /scripts. The committed manifest names ege.schema.json and scripts/ege, matching the modeler rules. Tests cover the committed file, path/pair refusals and schema existence; the existing formatting test still applies.

## Module: ege-character

Consumes: ege-script-core, ege-schema, ege-harness, ege-body-contacts, character.

Files: scripts/ege/character/{constants,pre,post,ground,moves,grab,bump}.as.ts and apps/headless/test/egeCharacter.test.ts.

rf_character_pre/post implement movement, support velocity, timers, grabs, bumps, knockback, protection, carrying, sliding/strokes and swimming over generated state and engine queries. Pre reads S1 show_control when present; otherwise it reads SDK axes/buttons. Both paths share controller behavior and transferable state. Neutral show control is 32639, not zero.

Pre precedes feature velocity effects; post follows physics/contacts. Persistent mode/button/support/facing state and entity references survive transfer/restore. Tests cover the controller, mapped show inputs and high seat ids alongside G6 behavior.

## Module: ege-seat-rules

Consumes: ege-character, ege-script-core, ege-harness.

Files: scripts/ege/seat/{rules,route,respawn}.as.ts, fixtures/ege/ege-strip.course.json and apps/headless/test/egeSeatRules.test.ts.

rf_seat_rules handles due respawn, feature kill requests, gates/laps, finish, falling/elimination and route progress, parking terminal seats. G6 retains local recount/closure; show worlds publish cumulative state and leave qualification/closure to show_rules.

Route helpers calculate gate/finish decisions, subticks and remaining distance. Respawn uses 1..12 spread slots, wait/protection, transferable anchor cursors and source facing, clearing stale grounding/jump/grab state. Shared show events preserve stable room-seat identity. Tests cover route, respawn and terminal behavior, including restore/transfer cases.

## Module: ege-features-race
Consumes: ege-scene, ege-seat-rules, ege-character, ege-harness.

Owns emitters under `packages/game/src/ege/features` for marker, boostLane, launchPad, catchVolume, rollingLog, doorBank, swimVolume, tileField and road; matching snake-case scripts except road; ege-yard-a fixture; egeFeatureEmitRace and egeFeaturesRace tests.

Each emitter exports <kind>Emitter with FeatureEmitter type. Marker updates visual state; boost modifies current character-pre velocity; launch/catch manage launch and recovery; logs move/knock; doors manage their deterministic pools; swim writes character swim state; tiles progress through warning/fall states. Road is emitter-only. Preallocated children associate through course feature index.

Boost applies approach2 toward input*(8+boost), with the source acceleration, after character steering; boost 4 yields the bounded 9 m/s ordinary grounded test result rather than an unconditional 12 m/s. Launch computes initial ballistic velocity once; subsequent character air steering remains active. Tests separately cover the initial formula and an apex-4 target-landing scenario, alongside per-kind records, behavior, zero faults and determinism.

## Module: ege-features-hazard

Consumes: ege-features-race, ege-schema, ege-box-collider.

Files: hexField, memoryTiles, annulus, sweep and risingKill emitters under packages/game/src/ege/features, corresponding snake-case scripts, ege-yard-b fixture and egeFeatureEmitHazard/egeFeaturesHazard tests.

Scripts initialize deterministic geometry. Annulus tangential half extent is mid*sin(step/2)+.02. Annulus, memory cells and sweep update placeholder cuboids through ege.box_collider before physics and match render dimensions. Sweep reuses one body for all-laser phases or two otherwise. Hex occupancy drives warning/fall; risingKill advances its plane and requests seat kills.

Memory supports 4..256 cells and 1..20 cycles. Root phases are idle/reveal/hide/choice/done. Children hold cells, cycle targets, roster-sized per-seat crossing rows and cells+1 visual markers. Twenty symbols use sixteen-plus-four storage. Generation is cycle-major/cell-major followed by one target draw per cycle. Post handles crossing penalties, incorrect cells and match events through the shared show writer. Persistent state and entity ownership survive snapshots/transfer. Tests cover geometry, pools, phase boundaries, high seats and twenty-cycle layout.

## Module: ege-features-objective
Consumes: ege-features-hazard and engine SDK bodyType.

Owns carryItem, ball, goal, collectible, bank, captureZone, tailSet and crown emitters and snake-case script files, ege-yard-c fixture, egeFeatureEmitObjective and egeFeaturesObjective tests.

Dynamic props use zero collider density plus explicit additional mass. Scripts manage carry pickup/drop, ball/goal scoring, collectible pickup/regeneration, bank membership, capture ownership, tail assignment/stealing and crown pickup. Goal is consumed by ball's scheduled post system. Events retain source score/team_score/possess/crown payload semantics.

Bank queries debris overlap, retries at total capacity when truncated, requires bodyType==1 and center containment, and excludes carried-hand proximity within .2 m. Membership records are spawned/despawned without bodies and retain actual bank/item entity IDs and credited team. Neutral credit uses nearest alive seat with seat-ID tie breaks; transitions emit +1/-1 team_score. Tests include dynamic debris without carry records, fixed/kinematic rejection, sleeping bodies and overlap overflow, plus per-kind behavior, zero faults and deterministic stepping.

## Module: ege-box-collider

- Repository: engine
- Files: `crates/ege-physics/src/box_collider.rs`, `crates/ege-physics/src/lib.rs`, `crates/ege-physics/tests/box_collider.rs`, `ARCHITECTURE.md`, `AGENTS.md`
- Owner: 0
- Consumes: nothing

Export BOX_COLLIDER: DeclSpec, SYSTEM: SystemDecl and `pub fn run(world: &mut World, schema: &Schema) -> EgeResult<()>` from crates/ege-physics/src/box_collider.rs. Register SYSTEM through ege_physics::register. Component ege.box_collider contains half_extents: f32[3], in metres; its independent 12-byte record has x at byte 0, y at byte 4 and z at byte 8, relative to the record start. No existing record changes. System ege.box.collider reads ege.box_collider and runs after ege.body.props and before ege.physics. Visit entities in ascending id; skip entities without bodies. A body carrying this record must have exactly one cuboid collider, and all three dimensions must be finite and strictly positive. Validate all applicable records before mutating physics. Invalid dimensions return ErrorCode::InvalidArgument with `ege.box_collider of entity <e>: half_extents[<axis>] must be finite and greater than 0`; invalid collider topology returns the same code with `ege.box_collider of entity <e>: expected exactly one cuboid collider`. Axis is 0, 1 or 2. Apply only changed dimensions through Rapier's shape update, preserving collider identity, local pose, material, groups, enabled state and body properties; wake the affected body. Dimensions take effect in the immediately following physics step and survive snapshot/restore. The component does not change ege.render: scripts write matching render parameters. No scene format, WASM ABI export, SDK import or existing component changes. Engine files remain genre-neutral. Public function run returns EgeResult<()>, meaning Result<(), EgeError>: success carries unit and failure carries the existing engine error type, with the codes and messages specified above. BOX_COLLIDER and SYSTEM are typed declaration constants, not functions returning an untyped object.

## Module: ege-script-body-type

- Repository: engine
- Files: `crates/ege-wasm/src/abi_script.rs`, `crates/ege-wasm/tests/abi_script.rs`, `packages/game-engine/src/abi.ts`, `packages/game-engine/src/script.ts`, `packages/game-engine/test/script.test.ts`, `sdk/assembly/engine.ts`, `sdk/assembly/physics.ts`, `sdk/sdk.json`, `packages/game-engine/compile/test/compile.test.ts`
- Owner: 0
- Consumes: nothing

Export `bodyType(entity)` from the engine script ABI and SDK. It returns the authoritative physics classification fixed 0, dynamic 1, position-kinematic 2, velocity-kinematic 3 or absent -1. The host enforces transform-read access, phase/world validity and pointer bounds; engine and SDK 0.1.2/ABI 1 are deployed together for callers of this query. These additions and their access checks are owned and tested in the engine repository.

## Module: ege-show-runtime

Repository: royal-fiesta. Consumes: ege-domain-binding, ege-show-rules, ege-show-bots, ege-scene, ege-build.

Files: packages/game/src/ege/{showTypes,showScene,showFactory,showRuntime,showState}.ts, apps/headless/src/engineShow.ts and runtime/factory/state/transfer tests. Presentation component read helpers are in worldRead.ts; effects, bots, hub and online integration have their own modules.

EngineShowConfig supplies engine,schemaText,scriptBytes,identity,seed,courses,assets,zones,season,humans and optional plan,testMode,limitCatchup. createEngineShowFactory awaits script admission before returning a usable factory; create/rebuild/reset remain synchronous. Failure releases preparation resources. The factory retains correct selected-course/roster context and live entity mappings, composes EngineDomainFactory/SwapTimeline/RollbackBinding, uses EGZ physics transfer and complete rules snapshots for handoff.

createEngineShow returns EngineShowRuntime with identity, mode, snapshot, frame, vote, worlds, presentation, onPresentation and dispose. Snapshots decode script-owned selection, results and state without recomputing rules. buildShowPhysicsScenes, buildShowRulesScene and buildShowHubScene construct their declared contexts. catalogCutField packs the cut/predecessor field and showState validates it against the season.

frame validates finite nonnegative elapsed time and S1 input batches, samples active humans in stable order and converts inputs once. Default accumulation runs at most eight consecutive 60-Hz ticks and retains debt. limitCatchup enables the rendered-local tick cap and drops excess whole-tick wall-clock debt while preserving fractional time and consecutive simulation tick ids. testMode only changes presentation waits. Bots are not sampled as humans.

Presentation mappings have incarnation lifetimes. farSnapshot calls the live EngineDomainSim.far(writer,1) and returns independent bytes, refusing after release/replacement/disposal. post-tick and before-release observations follow G7.4, including terminal ticks inside accumulated frames. PresentationMemo and worldRead cache read-only data with explicit invalidation. patchLifecycle, patchVote, patchClock and entityBytes are exported for online reuse. The headless engineShow CLI is a local product runner.

## Module: ege-show-view

Repository: royal-fiesta. Consumes: scene-view, ege-show-runtime, render-port.

Files: packages/game/src/ege/{showView,showEffects,showFar,worldRead}.ts and egeShowView, egeShowEffects, egeShowEffectsOnline, egeShowFar and egePresentationMemo tests.

EngineShowView(runtime) implements SceneReadView with refresh(alpha), nearSeats and dispose. EngineViewReaders/ENGINE_VIEW_READERS supply engine read boundaries. Reads use live mappings and include optional character animation fields. At most eight active near seats are selected, humans first by input slot/room seat then bots by room seat. Unselected/absent characters park and clear detail; authority is unchanged.

EngineFarView accepts(domain,tick,bytes), read(near) returns RenderBridge records, and clear removes stored snapshots. It decodes the engine format, excludes near/inactive seats and never uses legacy farState. worldRead exports SHOW_VIEW_COMPONENTS, readShowViewState and forgetWorldReads to constrain and invalidate component reads.

EngineShowEffects(runtime,{sound,grant}) subscribes to every post-tick and before-release source. pump is repeat-safe; dispose unsubscribes. Confirmed EventBridge delivery is silent during replay. Stable receipts persist across domain replacement; authoritative results alone authorize grants. deliveryStats returns copied droppedRecords,repeatedSoundDeliveries,repeatedGrantDeliveries, counting actual sink delivery duplicates. Ring loss fails visibly. Tests cover terminal multi-tick delivery, confirmation/replay, retained receipts, membership and borrowed-view invalidation.

## Module: ege-show-page

Repository: royal-fiesta. Consumes: ege-show-view, ege-capture, ege-page, web-client, render-port, ege-hub, ege-online.

Files: apps/web/engine-show.html, apps/web/src/engineShow/{main,page,ops,ready,presentation,testMode}.ts, offline.inventory.json, engineShow page/readiness/presentation/effects-wiring/content tests and tools/engineShowCapture.ts. Hub, online and saved-script scenario files belong to their respective modules.

mountEngineShow, EngineShowPageOptions, EngineShowPage and EnginePageState follow G7.7. Local and online modes prepare the same engine hub. EngineHubFlow owns hub/loading/show/returning/failed transitions. HubView renders S9 remotes/emotes on the shared port; SceneView/RenderBridge present show worlds. onPresentation explicitly observes every presented tick; EngineShowEffects owns draining/receipts. Failed preparation sets error and never signals ready.

engineShowHost exposes capture operations, flow(), hub(), presence/pushPresence, signals(), showConfig and remountWith(start,overrides?). Online attachment uses remountWith. loadEnginePublication validates the schema/publication key; loadEngineAuthoredShow, applyConfigOverrides and their exported types share loading with the shell. Attached configuration supplies humans/bots; engineOnlineStats supplies desyncs.

main eagerly imports scenarios before registering operations. registerScenario rejects duplicate ids. The offline inventory owns simple-character, sixty-seat-round and winner-podium rows. engineShowCapture selects <stage>.inventory.json, validates its scenario ids/content and delegates persistence to the shared job, storing under NMC_CACHE_DIR/engine-show/<stage> or out/engine-show/<stage>. The staged capture page is engine-show.html. Page/scenario unit checks do not imply a successful judged capture.

## Module: ege-dev-swap

- Repository: royal-fiesta
- Files: `packages/game/src/ege/localSwap.ts`, `apps/web/src/engineShowDev/reload.ts`, `apps/web/src/engineShowDev/status.ts`, `apps/web/src/engineShowDev/main.ts`, `apps/web/engine-show-dev.html`, `apps/web/src/engineShow/scenarios/savedScript.ts`, `apps/web/public/engine-show/swap.inventory.json`, `tools/savedScriptSave.ts`, `packages/game/test/egeLocalSwap.test.ts`, `apps/web/test/engineShowReload.test.ts`, `apps/web/test/engineShowDevStatus.test.ts`, `apps/web/test/engineSwapInventory.test.ts`, `tools/test/savedScriptSave.test.ts`
- Owner: M5
- Consumes: ege-build, ege-show-runtime, ege-show-page, ege-show-view, ege-manifest, ege-capture

`localSwap.ts` exports applyLocalScript, localSwapState, releaseLocalSwap, formatScriptDiagnostic and LOCAL_SWAP_AREA. applyLocalScript(runtime, publication, bytes) never rejects for a refusal and refuses, without touching any timeline, in this order: a disposed runtime; online mode; publications with error diagnostics; revisions not newer than the applied one; a publication schema key differing from runtime.identity.schemaKey (schema changes need a local restart); loadScript failures (EgeError SCHEMA maps to the restart refusal); a revision superseded while loading; a module failing validateFor on any live world. Otherwise it swaps every live SwapTimeline at that frame boundary and disposes the superseded loaded module; generation is 1 + successful applies. World ticks, round, components, scores, runtime.identity and effect receipts are unchanged. Worlds created after a swap (a later round's physics world) are validated and swapped to the applied module at their first post-tick observation, replacing only the runner. localSwapState returns {generation,revision,moduleKey,faults}; faults sums the modules localSwap loaded. formatScriptDiagnostic maps the formatRfDiagnostic path, for example {file:'show/clock.as.ts',line:3,column:5,code:'TS2304',message:'x'} to 'scripts/ege/show/clock.as.ts:3:5 TS2304 x'. LOCAL_SWAP_AREA is 'ege-local-swap'.

`reload.ts` exports SCRIPT_PUBLICATION_EVENT ('rf:script-publication'), SavedScriptSource, ScriptReloadStatus, ScriptReloadOptions, attachSavedScriptReload, publicationOfEvent and hotPublicationSource. attachSavedScriptReload coalesces to one pending publication, drops completions older than the newest received revision, shows diagnostics without fetching, keeps the last valid module and unsubscribes once on disposal. `status.ts` exports SCRIPT_APPLIED_SIGNAL ('script-applied'), scriptStatusLines, ScriptStatusCanvas, drawScriptStatus and createScriptStatus; createScriptStatus emits 'script-applied' once per successful apply and shows source diagnostics, applied generation, module key and faults.

engine-show-dev.html and main.ts are the interactive authoring page under the Vite dev server. They mount the same page through mountEngineShow with mode local and onRuntime, attach the reload to each runtime through the Vite publication event, and show source diagnostics, applied generation, module key and faults. The page is built by npm run build. It is not the captured surface; tools/engineShowCapture.ts:60-63 stageShowPage always stages engine-show.html.

`tools/savedScriptSave.ts` exports runSavedScriptSave and main. In one process, through the modeler library session (createSdfm; game_list, script_list, script_read, script_write -> writeGameFile), it performs: a rejected save and an accepted save of scripts/ege/character/constants.as.ts in the registered disposable checkout; a filesystem compile of the complete set after each save; staging of <page>/ege/swap/events.json and <page>/ege/swap/rf-scripts.wasm, where <page> is the --page directory as given (--page apps/web/dist -> apps/web/dist/ege/swap/events.json); and a verified restore of the original text.

The judged authoring scenario 'engine-saved-script-applied' runs in the engine-show.html capture page. It composes the dev modules reload.ts and status.ts in a local engine-show.html round fed by the modeler-saved staged publications. It observes the rejected edit kept, script-applied, preserved tick/round and a changed jump in the current local round, and captures engine-saved-script-applied.png with the status panel composed. This scenario is QB18's judged control. Its facts add swap: {rejectedKept,rejectedDiagnostics,applied,generation,appliedRevision,moduleChanged,tickPreserved,roundPreserved,riseBeforeM,riseAfterM,behaviorChanged,signals,faults}; swap.inventory.json owns that row. Command registration: g7-swap-unit-check, g7-swap-save, g7-swap-check, g7-swap-clean, g7-swap-render, g7-swap-fresh, g7-swap-judge. Tests cover failed compile, schema mismatch, missing export, out-of-order and superseded results, atomic multi-world validation, preserved state/tick, changed next ticks, duplicate-effect suppression, reload coalescing/cancellation and the tool's save/restore.

## Module: ege-domain-binding

Repository: engine. Consumes: ege-script-body-type.

Files: packages/game-engine/src/{rollback,zones}.ts and rollback, rollback-script, hotswap, zones and events tests.

RollbackBinding.stepCodes(inputs:ArrayLike<number>) requires exactly playerCount dense codes, rejects count errors before stepping, clears captured input on success and runs the configured runner/engine once with tick/resimulation accounting.

EngineDomainOptions.inputPlayers(spec) optionally maps spec.seats to -1 or unique valid world input indices; default behavior retains seat-index mapping. -1 consumes session capture without assigning an engine input. EngineDomainSim retains absolute domain tick and zone export/shadow/far/sleep metadata while delegating ordinary step/snapshot/restore/resimulation to the binding. Inbound shadows apply before the tick. Scratch/release behavior and the rollback protocol remain unchanged. Tests cover high sparse seat identities, script runners, restore/rebuild and muted event draining.

## Module: ege-show-rules

Repository: royal-fiesta. Consumes: ege-schema, ege-script-core, ege-seat-rules, ege-features-objective.

Files: scripts/ege/show/{ledger,qualification,season,scheduler,teams,clock,publish,hub}.as.ts and apps/headless/test/{egeLedger,egeSeason,egeShowTransfer}.test.ts.

Scheduled exports rf_show_ledger, rf_show_season, rf_show_clock, rf_show_publish and rf_show_hub implement G7.1-G7.3. Ledger/qualification, team decisions, selection/votes, points, playoff state and accepted cumulative messages live in snapshotted records; helpers operate within the script tick. Scheduler decodes cut bit 0 and banned predecessor (cut >>> 8)-1, so adjacency follows catalog map identity. Reserved finals remain single-candidate votes.

Hub scripts convert human SDK inputs through s1OfEngine. Lobby bots steer toward wander targets using S1 offset axes, neutral within 0.5 m, without buttons. Tests cover scripted outcomes, ties/overtime, duplicate messages, restore/handoff, high seats and hub movement/input encoding.

## Module: ege-show-bots

Repository: royal-fiesta. Consumes: ege-schema, ege-character, ege-show-rules.

Files: scripts/ege/bots/{brain,routes,behaviour,traversal}.as.ts, packages/game/src/ege/botData.ts and egeBotData/egeBots tests.

rf_show_controls and rf_show_bots run before character pre. serializeBotData(course,behaviours) serializes validated authored navigation/behavior into RawEntity records; TypeScript does not evaluate brains or routes. Scripts implement route costs/ties, decision cadence, predicates/actions, traversal queries, skill/RNG and delayed reactions. Seat-owned initialization and queue state survive restore/transfer. s1OfEngine is shared with the hub; G7.1 specifies the S1/engine encoding boundary. Missing routes produce neutral control and malformed required data refuses.

Current integration limitations: playable show scenes do not emit bot_seat or authored bot/navigation rows. In addition, traversal and behavior locate bot_route by scanning owner==seatEntity although routes are keyed by the live seat entity, and route planning can move memory.path_index backward. These limitations remain in the final source; isolated script tests do not establish end-to-end show navigation.

## Module: ege-hub

Repository: royal-fiesta. Consumes: ege-show-runtime, ege-show-page, ege-show-rules, hub-protocol, hub-world.

Files: packages/game/src/ege/{hub,hubFlow}.ts, packages/game/test/egeHub.test.ts, apps/web/src/engineShow/scenarios/hub.ts, hub.inventory.json and apps/web/test/engineHubFlow.test.ts.

createEngineHub(config,plaza,spawn,bots?) returns HubRuntime with tick,botCount,spawn,faults,step,state,botViews,respawn,onQueuePad,setEmote,emote,free and view():SceneReadView. The roster is local human room seat zero plus 0..8 lobby bots, independent of config.humans. show_hub supplies control/recovery. Respawn rebuilds on the loaded module while preserving monotonic tick; faults reports the module fault count.

EngineHubFlow(hub,startShow) exposes start, frame, state, error and dispose. States are hub/loading/show/returning/failed. start settles with state/error; pending/failed preparation is not ready. The first frame after show done frees the completed show and restores hub.spawn once, preserving the final presentation frame. Disposal frees hub/show and late preparation results exactly once.

Hub scenarios exercise local movement/emotes, S9 remote emotes and show-to-hub return through the page host. Their inventory contains engine-hub-walking-and-emotes.png and engine-show-returned-to-hub.png. HubFacts reports readiness/faults, local/bot movement, emotes, return count and spawn restoration. Tests cover movement, recovery, lobby wandering, resource release and pending/failed/cancelled flow preparation.

## Module: ege-online

Repository: royal-fiesta. Consumes: ege-show-runtime, ege-hub, ege-show-view, webrtc, relay-client, ege-show-page, net-match.

Files: packages/game/src/ege/{online,admission,onlineState}.ts, packages/game/src/net/zoneRelayProtocol.ts, associated admission/state/online/round/podium/protocol tests, apps/web/src/engineShow/scenarios/online.ts, online.inventory.json and engineOnlineInventory.test.ts.

parseEngineIdentity, requireEnginePeers and requireLegacyPeers enforce backend admission. ZoneQueuePayload optionally carries engine identity while retaining legacy validation. createEngineOnlineShow(config,{localPeer,roster,transport,measurements}) awaits factory preparation before constructing ZoneSession/RoundTransport and returns EngineShowRuntime with mode online. It reuses runtime lifecycle/clock/vote encoding helpers at deterministic boundaries, preserves confirmation and nullable recovery results, and disposes prepared/session resources on failure.

onlineSeatMap exposes inputSlotOf,peerOfSeat,localSeats,localHumanSeats; onlineMeasurements copies peer measurements. EngineVoteBarrier exposes complete and ordered choices. registerEngineOnlineStats/engineOnlineStats expose desyncs,confirmedTick,peers,livePeers,spectator without fabricating ready state. Callers skip votes for eliminated seats or absent candidates.

The online inventory has exactly one row: engine-online-late-client-round, seed 7, humans 2, default plan and twelve requirements specified in G7.7. The background-client-podium scenario and podium unit tests remain, but no inventory row requires podium, winner or effect facts. The page budget remains 270 seconds. Tests cover admission/preparation failures, sparse input mapping, session round behavior and inventory requirements; host completion is separate evidence.

## Module: ege-game-switch

Repository: royal-fiesta. Consumes: play-flow, ege-online, ege-hub, ege-show-page, scene-view, ege-show-view, ege-show-runtime.

Files: apps/web/src/game/{main,showMode,showDirector,entry,engineBackend,engineProbe}.ts, client/play sound adapters, packages/game/src/audio/events.ts, packages/game/src/flow/endScreen.ts, apps/web/src/zone/zoneNetScene.ts and associated switch/sound/show/zone/probe tests.

selectGameBackend selects engine only for engine=1; absent/0 selects legacy and other explicit values refuse. loadEngineBackend shares publication/authored loaders and exposes identity,authored,config,createHub,createShow,flowBackend. The existing shell handles engine start/hub/local/online/result/return with its menu/input/costume/audio services, without fallback after engine failure.

engineShowPort adapts authoritative candidates, rounds, done, champion, alive, vote and round plan to ShowDirector's read-only ShowPort. ShowMode.engine uses EngineShowView, ZoneNetScene.present/observe, EngineSeatPresenter/farPenguinBridge and EngineShowEffects. Sound sampling accepts SceneReadView; confirmed engine effects remain the authoritative sink. endScreen accepts a rounds-bearing object.

EngineShellProbe and installEngineProbe expose window.rfEngine.state(), signals() and play(). State extends EnginePageState with flow,lobbyId,lobbyMembers,visibility,online for host automation. Tests cover backend selection, preparation rejection, screen/read boundaries and legacy compatibility.

## Module: ege-online-harness

Repository: royal-fiesta. Consumes: ege-game-switch, ege-online.

Files: tools/onlineChromes.mjs, tools/test/onlineChromes.test.ts and docs/engine-show.md.

The existing launcher supports --engine, --late-client, --background-client and --until round-ended|show-ended alongside URL/server/client/browser options. --bots denotes total seats, so two-human acceptance uses --bots 60. URLSearchParams preserves existing query parameters. CDP waits use shell state/signals, delay the second launch until lobby readiness, exercise actual hidden-tab behavior and require terminal state rather than process survival.

Round acceptance checks two humans/fifty-eight bots, confirmed completion and zero reported desyncs/faults. Missing/error/stalled transitions fail nonzero. Cleanup closes only owned processes on exit, signal or failure. Unit tests fake process/CDP boundaries. The host invocation uses --until round-ended against a locally served build; the online capture inventory contains only engine-online-late-client-round.png. Full background-podium capture is not a current inventory requirement.
