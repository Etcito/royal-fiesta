# C2 / Tidal Relay — drawn asset needs

Three rings with alternating north/south transfers: choose a side at every stage.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 2 | Ring deck × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C2-wipeout-rings/Z02/floor` | cuboid segments | 540.3 long × 18 wide × 1 | Centre radius 86 m; width 18 m; height 0 m. |
| 5 | Ring deck × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C2-wipeout-rings/Z05/floor` | cuboid segments | 364.4 long × 16 wide × 1 | Centre radius 58 m; width 16 m; height 3 m. |
| 7 | Ring deck × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C2-wipeout-rings/Z07/floor` | cuboid segments | 188.5 long × 14 wide × 1 | Centre radius 30 m; width 14 m; height 6 m. |
| 1 | Start arc × 60 | `course.spawn` | EXISTS — course data | `C2-wipeout-rings/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots, 5 rows × 12; ≥2 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `C2-wipeout-rings/Z01/cp` | sensor cuboid | 18 × 4 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | West hammers × 3 | `candy.pendulum-hammer` | EXISTS — resize / configure | `C2-wipeout-rings/Z02/hammer` | kinematic cuboids | Ø8 × 6 sweep envelope | 4 m reach; outside shoulder 6 m wide. |
| 2 | West mud × 2 | `plan.mud-patch` | NEW | `C2-wipeout-rings/Z02/mud` | cuboid surface | Ø8 × 0 | Wide but slow; shoulder can bypass mud. |
| 3 | East sweepers × 3 | `candy.spinner-bar` | EXISTS — resize / configure | `C2-wipeout-rings/Z03/spinner` | kinematic cuboids | Ø12 × 0.5 sweep envelope | 12 m sweep leaves 3 m radial shoulders; 8 s rotation. |
| 3 | East conveyor × 2 | `candy.conveyor-belt` | EXISTS — resize / configure | `C2-wipeout-rings/Z03/conveyor` | cuboid + surface velocity | 4 × 12 × 0.5 | 2 m/s northward; inner fast line. |
| 4 | North ramp × 1 | `plan.ramp-deck` | NEW | `C2-wipeout-rings/Z04/bridge` | convex hull segments | 28.0 long × 12 wide × 0.6 | 28 m run, +3 m rise; only outer-to-middle transfer. |
| 4 | CP1 × 1 | `plan.respawn-pad` | NEW | `C2-wipeout-rings/Z04/cp` | sensor cuboid | 12 × 4 × 3 | Must cross CP1 before CP2; prevents ring skipping. |
| 4 | Shared plate × 2 | `candy.mech-plate` | EXISTS — resize / configure | `C2-wipeout-rings/Z04/switch` | roundCuboid + weight sensor | 2 × 2 × 0.28 | Opens matching door for 4 s; leaders help trailers. |
| 4 | North door × 2 | `candy.mech-door` | EXISTS — resize / configure | `C2-wipeout-rings/Z04/door` | cuboids + hinge | 4 × 0.8 × 3.5 | 4 m portal; 4 m centre lane always open. |
| 4 | Door timer × 2 | `course.mechanisms.links` | EXISTS — course data | `C2-wipeout-rings/Z04/link` | none (logic record) | 7.0 long × 0.12 wide × 0 | 4 s hold from plate. |
| 5 | Ferry channel × 1 | `plan.fall-volume` | NEW | `C2-wipeout-rings/Z05/gap` | sensor below deck; no floor | 16 × 8 × 4 | 8 m along-ring gap; ride two docks, do not jump the whole gap. |
| 5 | Middle shuttle × 1 | `candy.moving-platform` | EXISTS — resize / configure | `C2-wipeout-rings/Z05/moving` | kinematic cuboid | 8 × 6 × 0.5 | 6 m along travel; ±1 m travel; ≤2 m boarding gap. |
| 5 | Ferry bypass × 1 | `plan.ramp-deck` | NEW | `C2-wipeout-rings/Z05/bridge` | convex hull segments | 45.3 long × 4 wide × 0.6 | Continuous 4 m outer detour; equal height to middle ring. |
| 5 | Middle east flaps × 3 | `plan.trap-tile` | NEW | `C2-wipeout-rings/Z05/trap` | kinematic cuboid + sensor | 7 × 5 × 0.3 | 1 s warning / 2 s open. Outer 4 m continuous shoulder. |
| 6 | South ramp × 1 | `plan.ramp-deck` | NEW | `C2-wipeout-rings/Z06/bridge` | convex hull segments | 28.0 long × 10 wide × 0.6 | 28 m run, +3 m rise; merge at 10 m throat. |
| 6 | CP2 × 1 | `plan.respawn-pad` | NEW | `C2-wipeout-rings/Z06/cp` | sensor cuboid | 10 × 4 × 3 | Must cross CP2 before CP3. |
| 6 | Optional hop × 1 | `candy.bounce-pad` | EXISTS — resize / configure | `C2-wipeout-rings/Z06/bounce` | cylinder + launch sensor | Ø3 × 0.3 | Vertical impulse 9 m/s; stay on the ramp or hop through the merge. |
| 7 | Inner seesaw × 2 | `candy.mech-seesaw` | EXISTS — resize / configure | `C2-wipeout-rings/Z07/seesaw` | dynamic roundCuboid + hinge | 5 × 10 × 0.4 | ±4° tilt; max end rise 0.35 m; 4.5 m shoulder. |
| 7 | Inner spinner × 2 | `candy.spinner-bar` | EXISTS — resize / configure | `C2-wipeout-rings/Z07/spinner` | kinematic cuboids | Ø8 × 0.5 sweep envelope | 8 m sweep; 10 s cycle. Narrow inside route saves distance. |
| 8 | CP3 × 1 | `plan.respawn-pad` | NEW | `C2-wipeout-rings/Z08/cp` | sensor cuboid | 10 × 4 × 3 | CP0 → CP1 → CP2 → CP3 → finish; ordered. |
| 8 | Crown bridge × 1 | `plan.ramp-deck` | NEW | `C2-wipeout-rings/Z08/bridge` | convex hull segments | 30.0 long × 8 wide × 0.6 | 8 m bridge, level at +6 m; final shared choke. |
| 8 | Crown finish × 1 | `plan.crown-finish` | NEW | `C2-wipeout-rings/Z08/finish` | cylinder + sensor | Ø14 × 0.6 | Ø14 m receiving pad at +6 m. |

## Numbered zones

1. **Split start.** Start arc: 60 spots, 5 rows × 12; ≥2 m centres. CP0: Respawn here after a fall; 3 s penalty.
2. **Outer west.** Ring deck: Centre radius 86 m; width 18 m; height 0 m. West hammers: 4 m reach; outside shoulder 6 m wide. West mud: Wide but slow; shoulder can bypass mud.
3. **Outer east.** East sweepers: 12 m sweep leaves 3 m radial shoulders; 8 s rotation. East conveyor: 2 m/s northward; inner fast line.
4. **North transfer.** North ramp: 28 m run, +3 m rise; only outer-to-middle transfer. CP1: Must cross CP1 before CP2; prevents ring skipping. Shared plate: Opens matching door for 4 s; leaders help trailers. North door: 4 m portal; 4 m centre lane always open. Door timer: 4 s hold from plate.
5. **Middle ring.** Ring deck: Centre radius 58 m; width 16 m; height 3 m. Ferry channel: 8 m along-ring gap; ride two docks, do not jump the whole gap. Middle shuttle: 6 m along travel; ±1 m travel; ≤2 m boarding gap. Ferry bypass: Continuous 4 m outer detour; equal height to middle ring. Middle east flaps: 1 s warning / 2 s open. Outer 4 m continuous shoulder.
6. **South transfer.** South ramp: 28 m run, +3 m rise; merge at 10 m throat. CP2: Must cross CP2 before CP3. Optional hop: Vertical impulse 9 m/s; stay on the ramp or hop through the merge.
7. **Inner carousel.** Ring deck: Centre radius 30 m; width 14 m; height 6 m. Inner seesaw: ±4° tilt; max end rise 0.35 m; 4.5 m shoulder. Inner spinner: 8 m sweep; 10 s cycle. Narrow inside route saves distance.
8. **Crown bridge.** CP3: CP0 → CP1 → CP2 → CP3 → finish; ordered. Crown bridge: 8 m bridge, level at +6 m; final shared choke. Crown finish: Ø14 m receiving pad at +6 m.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Wide west / balance | 632.5 m | 6 m/s | 14–31 s | 119–136 s |
| Inside east / timing | 593.9 m | 6 m/s | 8–25 s | 107–124 s |

Race: 150 s cap; first N finishers qualify (N open). Fall: last CP + 3 s; never elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.bounce-pad`: `assets/candy/candy.bounce-pad.asset.json`; current collider kinds: cylinder; examples: hub-plaza.course.json, obstacle-gallery.course.json, race-bean-dash.course.json.
- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.mech-door`: `assets/candy/candy.mech-door.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.mech-plate`: `assets/candy/candy.mech-plate.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, ice-slide-gates.course.json, mech-lab.course.json.
- `candy.mech-seesaw`: `assets/candy/candy.mech-seesaw.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.moving-platform`: `assets/candy/candy.moving-platform.asset.json`; current collider kinds: cuboid; examples: hub-plaza.course.json, obstacle-gallery.course.json, race-bean-dash.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: warning, delayed drop and reset policy for the drawn trap tiles. NEW: ordered multi-route checkpoint stages; the 8 m ferry gap is crossed by riding the drawn shuttle or using its continuous bypass. Existing weight switch / timer / door links are reusable; the drawn shared-opening timer needs course configuration.

## Owner decisions

- Approve ordered checkpoint stages so radial jumps cannot skip the course?
- Do moving decks carry all beans, or should they have a soft crowd limit? Proposal: no hard limit.
