# C1 / Diamond Citadel — drawn asset needs

A widening diamond: outer endurance routes, a high central risk route, and a mid-course transfer spine.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Start boulevard × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C1-castle-gauntlet/Z01/floor` | cuboid segments | 40.0 long × 24 wide × 1 | 24 m start, splits into three routes. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `C1-castle-gauntlet/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.8 × 1.6 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z01/cp` | sensor cuboid | 6 × 24 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Upper safe route × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C1-castle-gauntlet/Z02/floor` | cuboid segments | 391.1 long × 14 wide × 1 | 14 m wide; longer hammer-and-mud path. |
| 4 | Lower balance route × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C1-castle-gauntlet/Z04/floor` | cuboid segments | 391.1 long × 12 wide × 1 | 12 m wide; logs and moving decks. |
| 3 | Central high route × 1 | `plan.ramp-deck` | NEW | `C1-castle-gauntlet/Z03/bridge` | convex hull segments | 320.0 long × 6 wide × 0.7 | 6 m wide, deck +5 m from x=170 to 270; 40 m ramps. |
| 2 | Hammer × 3 | `candy.pendulum-hammer` | EXISTS — resize / configure | `C1-castle-gauntlet/Z02/hammer` | kinematic cuboids | Ø8 × 6 sweep envelope | 4 m sweep; staggered 3 / 4 / 5 s cycles. |
| 2 | Mud islands × 1 | `plan.mud-patch` | NEW | `C1-castle-gauntlet/Z02/mud` | cuboid surface | Ø8 × 0 | Mud 4.8 m/s; 6 m normal shoulder. |
| 6 | Mud islands × 1 | `plan.mud-patch` | NEW | `C1-castle-gauntlet/Z06/mud` | cuboid surface | Ø8 × 0 | Mud 4.8 m/s; 6 m normal shoulder. |
| 3 | Bridge jump × 1 | `plan.fall-volume` | NEW | `C1-castle-gauntlet/Z03/gap` | sensor below deck; no floor | 3 × 6 × 4 | 3 m edge gap, +0.375 m landing rise; 10 m run-up. |
| 7 | Bridge jump × 1 | `plan.fall-volume` | NEW | `C1-castle-gauntlet/Z07/gap` | sensor below deck; no floor | 3 × 6 × 4 | 3 m edge gap, -0.375 m landing rise; 10 m run-up. |
| 3 | Bridge seesaw × 2 | `candy.mech-seesaw` | EXISTS — resize / configure | `C1-castle-gauntlet/Z03/seesaw` | dynamic roundCuboid + hinge | 16 × 6 × 0.4 | ±3° tilt limit; end height excursion ≤0.42 m. |
| 4 | Rolling log × 3 | `plan.rolling-log` | NEW | `C1-castle-gauntlet/Z04/log` | kinematic cylinder | 0.8 × 10 × 0.8 | Ø0.8 m contact height; rolls across route every 5 s. |
| 5 | Transfer spine × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C1-castle-gauntlet/Z05/floor` | cuboid segments | 210.0 long × 8 wide × 1 | At ground level; cross under +5 m central bridge (4.3 m clearance). |
| 5 | CP1-U × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z05/cp` | sensor cuboid | 10 × 8 × 3 | Any CP1 gate advances the same checkpoint stage; remember chosen route. |
| 5 | CP1-H × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z05/cp` | sensor cuboid | 10 × 8 × 3 | Any CP1 gate advances the same checkpoint stage; remember chosen route. |
| 5 | CP1-L × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z05/cp` | sensor cuboid | 10 × 8 × 3 | Any CP1 gate advances the same checkpoint stage; remember chosen route. |
| 5 | Transfer ramp × 1 | `plan.ramp-deck` | NEW | `C1-castle-gauntlet/Z05/bridge` | convex hull segments | 46.0 long × 4 wide × 0.5 | 46 m walk raises 5 m; permits mid-course lane changes. |
| 5 | CP1-G × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z05/cp` | sensor cuboid | 8 × 5 × 3 | Ground-level checkpoint, underneath the high-route stage. |
| 6 | Ferry recess × 2 | `plan.fall-volume` | NEW | `C1-castle-gauntlet/Z06/gap` | sensor below deck; no floor | 7 × 9 × 4 | 7 m recess is NOT a jump; ride the platform. Fixed 3 m outer shoulder bypass. |
| 6 | Shuttle deck × 2 | `candy.moving-platform` | EXISTS — resize / configure | `C1-castle-gauntlet/Z06/moving` | kinematic cuboid | 5 × 7 × 0.5 | 5 m deck, ±1.5 m travel along route; dock gap ≤0.5 m. 4 s cycle. |
| 6 | Piston pinch × 2 | `neon.piston-block` | EXISTS — resize / configure | `C1-castle-gauntlet/Z06/piston` | kinematic roundCuboid | Ø6 × 2.3 sweep envelope | 3 m stroke; 4 m shoulders stay walkable. |
| 7 | Trap sprint × 3 | `plan.trap-tile` | NEW | `C1-castle-gauntlet/Z07/trap` | kinematic cuboid + sensor | 5 × 6 × 0.4 | Whole bridge width; 1 s warning / 2 s open / 4 s reset. |
| 8 | Gatehouse apron × 1 | `candy.floor-tile` | EXISTS — resize / configure | `C1-castle-gauntlet/Z08/floor` | cuboid segments | 40.0 long × 18 wide × 1 | Three routes merge to an 18 m apron; 8 m finish choke. |
| 8 | CP2 × 1 | `plan.respawn-pad` | NEW | `C1-castle-gauntlet/Z08/cp` | sensor cuboid | 6 × 18 × 3 | Respawn here after a fall; 3 s penalty. |
| 8 | Catch-up switch × 2 | `candy.mech-plate` | EXISTS — resize / configure | `C1-castle-gauntlet/Z08/switch` | roundCuboid + weight sensor | 2 × 2 × 0.28 | First bean holds door open for following crowd for 4 s. |
| 8 | Gatehouse door × 2 | `candy.mech-door` | EXISTS — resize / configure | `C1-castle-gauntlet/Z08/door` | cuboids + hinge | 1 × 5 × 3.5 | Paired 5 m doors; always-open 4 m central bypass. |
| 8 | Door link × 2 | `course.mechanisms.links` | EXISTS — course data | `C1-castle-gauntlet/Z08/link` | none (logic record) | 9.0 long × 0.15 wide × 0 | Switch → matching door; 4 s timer. |
| 8 | Finish × 1 | `candy.finish-arch` | EXISTS — resize / configure | `C1-castle-gauntlet/Z08/finish` | cuboid arch + sensor | 3 × 8 × 5 | 8 m finish arch, after the merge. |

## Numbered zones

1. **Crowd split.** Start boulevard: 24 m start, splits into three routes. Start grid: 60 spots; 1.8 × 1.6 m centres. CP0: Respawn here after a fall; 3 s penalty.
2. **Hammer garden.** Upper safe route: 14 m wide; longer hammer-and-mud path. Hammer: 4 m sweep; staggered 3 / 4 / 5 s cycles. Mud islands: Mud 4.8 m/s; 6 m normal shoulder.
3. **High bridge.** Central high route: 6 m wide, deck +5 m from x=170 to 270; 40 m ramps. Bridge jump: 3 m edge gap, +0.375 m landing rise; 10 m run-up. Bridge seesaw: ±3° tilt limit; end height excursion ≤0.42 m.
4. **Log marsh.** Lower balance route: 12 m wide; logs and moving decks. Rolling log: Ø0.8 m contact height; rolls across route every 5 s.
5. **Transfer spine.** Transfer spine: At ground level; cross under +5 m central bridge (4.3 m clearance). CP1-U: Any CP1 gate advances the same checkpoint stage; remember chosen route. CP1-H: Any CP1 gate advances the same checkpoint stage; remember chosen route. CP1-L: Any CP1 gate advances the same checkpoint stage; remember chosen route. Transfer ramp: 46 m walk raises 5 m; permits mid-course lane changes. CP1-G: Ground-level checkpoint, underneath the high-route stage.
6. **Second choice.** Mud islands: Mud 4.8 m/s; 6 m normal shoulder. Ferry recess: 7 m recess is NOT a jump; ride the platform. Fixed 3 m outer shoulder bypass. Shuttle deck: 5 m deck, ±1.5 m travel along route; dock gap ≤0.5 m. 4 s cycle. Piston pinch: 3 m stroke; 4 m shoulders stay walkable.
7. **Trap sprint.** Bridge jump: 3 m edge gap, -0.375 m landing rise; 10 m run-up. Trap sprint: Whole bridge width; 1 s warning / 2 s open / 4 s reset.
8. **Gatehouse merge.** Gatehouse apron: Three routes merge to an 18 m apron; 8 m finish choke. CP2: Respawn here after a fall; 3 s penalty. Catch-up switch: First bean holds door open for following crowd for 4 s. Gatehouse door: Paired 5 m doors; always-open 4 m central bypass. Door link: Switch → matching door; 4 s timer. Finish: 8 m finish arch, after the merge.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Upper / safe | 471.1 m | 5.7 m/s | 14–30 s | 97–113 s |
| Central / risk | 400.0 m | 5.7 m/s | 20–43 s | 90–113 s |
| Lower / balance | 471.1 m | 5.7 m/s | 18–34 s | 101–117 s |

Race: 150 s cap; first N finishers qualify (N open). Fall: last CP + 3 s; never elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.finish-arch`: `assets/candy/candy.finish-arch.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, jungle-crane-crossing.course.json, mech-lab.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.mech-door`: `assets/candy/candy.mech-door.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.mech-plate`: `assets/candy/candy.mech-plate.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, ice-slide-gates.course.json, mech-lab.course.json.
- `candy.mech-seesaw`: `assets/candy/candy.mech-seesaw.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.moving-platform`: `assets/candy/candy.moving-platform.asset.json`; current collider kinds: cuboid; examples: hub-plaza.course.json, obstacle-gallery.course.json, race-bean-dash.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `neon.piston-block`: `assets/neon/neon.piston-block.asset.json`; current collider kinds: roundCuboid; examples: neon-piston-alley.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: warning, delayed drop and reset policy for the drawn trap tiles. NEW: rolling-log asset and animation. Existing weight switch / timer / door links are reusable; the drawn shared-opening timer needs course configuration.

## Owner decisions

- Should switching routes at the transfer spine preserve the previous CP or activate CP1-G? Proposal: activate CP1-G.
- Approve shared 4 s door openings as the main catch-up mechanic?
