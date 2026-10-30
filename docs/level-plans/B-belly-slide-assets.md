# B / Butterfly Freeway — drawn asset needs

Three banked hairpins, an elevated cut, rhythm jumps and a risky finishing chute.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Slide deck × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z01/ice` | cuboid segments | 170.0 long × 20 wide × 1 | Continuous descent; group friction proposed 0.06. |
| 3 | Slide deck × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z03/ice` | cuboid segments | 125.6 long × 16 wide × 1 | Banked 18° at turns; no step at segment joins. |
| 4 | Slide deck × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z04/ice` | cuboid segments | 115.0 long × 16 wide × 1 | Banked 18° at turns; no step at segment joins. |
| 5 | Slide deck × 2 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z05/ice` | cuboid segments | 125.6 long × 16 wide × 1; 115.0 long × 16 wide × 1 | Banked 18° at turns; no step at segment joins. |
| 6 | Slide deck × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z06/ice` | cuboid segments | 125.6 long × 16 wide × 1 | Banked 18° at turns; no step at segment joins. |
| 7 | Slide deck × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z07/ice` | cuboid segments | 184.7 long × 14 wide × 1 | Banked 18° at turns; no step at segment joins. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `B-belly-slide/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `B-belly-slide/Z01/cp` | sensor cuboid | 20 × 5 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Slidable mounds × 4 | `plan.slide-mound` | NEW | `B-belly-slide/Z02/mound` | convex hull | Ø4 × 0.3 | 0.3 m rounded crests; belly contact maintained. |
| 2 | Stroke boost lane × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `B-belly-slide/Z02/conveyor` | cuboid + surface velocity | 5 × 18 × 0.25 | 2 m/s carry; 5 m wide, peel off before the jumps. |
| 2 | J1 gap × 1 | `plan.fall-volume` | NEW | `B-belly-slide/Z02/gap` | sensor below deck; no floor | 20 × 3 × 4 | 3 m edge gap; 10 m approach + 8 m landing. |
| 2 | CP1 × 1 | `plan.respawn-pad` | NEW | `B-belly-slide/Z02/cp` | sensor cuboid | 20 × 5 × 3 | Respawn here after a fall; 3 s penalty. |
| 3 | Sky-cut × 1 | `plan.ramp-deck` | NEW | `B-belly-slide/Z03/bridge` | convex hull segments | 83.3 long × 4 wide × 0.6 | 4 m wide; entry +20.4 m, crest +23.4 m, exit +16.6 m. |
| 3 | J2 cut gap × 1 | `plan.fall-volume` | NEW | `B-belly-slide/Z03/gap` | sensor below deck; no floor | 3 × 4 × 4 | 3 m edge gap on level crest; straight 12 m take-off / landing. |
| 3 | CP2 × 1 | `plan.respawn-pad` | NEW | `B-belly-slide/Z03/cp` | sensor cuboid | 16 × 5 × 3 | Respawn here after a fall; 3 s penalty. |
| 4 | Must-jump ridge × 2 | `plan.jump-ridge` | NEW | `B-belly-slide/Z04/hurdle` | cuboid | 10 × 0.6 × 0.65 | 0.65 m high; 26 m spacing. Outer 3 m edges bypass it. |
| 4 | Stroke roller × 2 | `plan.slide-mound` | NEW | `B-belly-slide/Z04/mound` | convex hull | Ø4 × 0.3 | 0.3 m high; slide over, no jump needed. |
| 5 | Mud on outside bank × 2 | `plan.mud-patch` | NEW | `B-belly-slide/Z05/mud` | cuboid surface | Ø8 × 0 | Slow line adds steering grip; inside line stays ice. |
| 5 | Knife-edge bypass × 1 | `plan.ramp-deck` | NEW | `B-belly-slide/Z05/bridge` | convex hull segments | 90.0 long × 3.5 wide × 0.6 | 3.5 m lane; descends +14.2 to +10.8 m; level jump crest at +12.5 m. |
| 5 | J3 bypass gap × 1 | `plan.fall-volume` | NEW | `B-belly-slide/Z05/gap` | sensor below deck; no floor | 3.5 × 3.5 × 4 | 3.5 m same-height jump; 12 m landing on the straight. |
| 5 | CP3 × 1 | `plan.respawn-pad` | NEW | `B-belly-slide/Z05/cp` | sensor cuboid | 16 × 5 × 3 | Respawn here after a fall; 3 s penalty. |
| 5 | Duck-out sweeper × 2 | `candy.spinner-bar` | EXISTS — resize / configure | `B-belly-slide/Z05/spinner` | kinematic cuboids | Ø10 × 0.5 sweep envelope | 0.5 m bar at 0.8 m; jump or steer around its 10 m sweep. |
| 6 | Bank rollers × 2 | `plan.slide-mound` | NEW | `B-belly-slide/Z06/mound` | convex hull | Ø5 × 0.3 | 0.3 m high, slidable; steer with butterfly strokes. |
| 6 | Crest conveyor × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `B-belly-slide/Z06/conveyor` | cuboid + surface velocity | 12 × 4 × 0.25 | 2 m/s toward the exit; 18° bank. |
| 6 | CP4 × 1 | `plan.respawn-pad` | NEW | `B-belly-slide/Z06/cp` | sensor cuboid | 14 × 5 × 3 | Respawn here after a fall; 3 s penalty. |
| 7 | Recovery branch × 1 | `ice.floor-tile` | EXISTS — resize / configure | `B-belly-slide/Z07/ice` | cuboid segments | 143.0 long × 9 wide × 1 | 9 m wide, obstacle-free outer branch; rejoin before finish. |
| 7 | Timed ice flap × 3 | `plan.trap-tile` | NEW | `B-belly-slide/Z07/trap` | kinematic cuboid + sensor | 8 × 4 × 0.3 | 1 s warning, 2 s open / 4 s closed. 3 m side shoulders remain. |
| 7 | Risk-line boost × 1 | `plan.boost-lane` | NEW | `B-belly-slide/Z07/boost` | sensor cuboid | 4 × 10 × 1 | +20% for 2 s (NEW); points toward timed flaps. |
| 8 | Finish × 1 | `candy.finish-arch` | EXISTS — resize / configure | `B-belly-slide/Z08/finish` | cuboid arch + sensor | 3 × 14 × 5 | 14 m finish funnel; landings stay clear of the finish sensor. |

## Numbered zones

1. **Stroke launch.** Slide deck: Continuous descent; group friction proposed 0.06. Start grid: 60 spots; 1.6 × 1.8 m centres. CP0: Respawn here after a fall; 3 s penalty.
2. **Slalom & skip.** Slidable mounds: 0.3 m rounded crests; belly contact maintained. Stroke boost lane: 2 m/s carry; 5 m wide, peel off before the jumps. J1 gap: 3 m edge gap; 10 m approach + 8 m landing. CP1: Respawn here after a fall; 3 s penalty.
3. **Bank or sky-cut.** Slide deck: Banked 18° at turns; no step at segment joins. Sky-cut: 4 m wide; entry +20.4 m, crest +23.4 m, exit +16.6 m. J2 cut gap: 3 m edge gap on level crest; straight 12 m take-off / landing. CP2: Respawn here after a fall; 3 s penalty.
4. **Butterfly rhythm.** Slide deck: Banked 18° at turns; no step at segment joins. Must-jump ridge: 0.65 m high; 26 m spacing. Outer 3 m edges bypass it. Stroke roller: 0.3 m high; slide over, no jump needed.
5. **Mud-bank choice.** Slide deck: Banked 18° at turns; no step at segment joins. Mud on outside bank: Slow line adds steering grip; inside line stays ice. Knife-edge bypass: 3.5 m lane; descends +14.2 to +10.8 m; level jump crest at +12.5 m. J3 bypass gap: 3.5 m same-height jump; 12 m landing on the straight. CP3: Respawn here after a fall; 3 s penalty. Duck-out sweeper: 0.5 m bar at 0.8 m; jump or steer around its 10 m sweep.
6. **Second crest.** Slide deck: Banked 18° at turns; no step at segment joins. Bank rollers: 0.3 m high, slidable; steer with butterfly strokes. Crest conveyor: 2 m/s toward the exit; 18° bank. CP4: Respawn here after a fall; 3 s penalty.
7. **Final braid.** Slide deck: Banked 18° at turns; no step at segment joins. Recovery branch: 9 m wide, obstacle-free outer branch; rejoin before finish. Timed ice flap: 1 s warning, 2 s open / 4 s closed. 3 m side shoulders remain. Risk-line boost: +20% for 2 s (NEW); points toward timed flaps.
8. **Finish funnel.** Finish: 14 m finish funnel; landings stay clear of the finish sensor.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Main line | 961.6 m | 9 m/s | 12–25 s | 119–132 s |
| Both cuts | 837.7 m | 9 m/s | 18–35 s | 111–128 s |
| Recovery branch | 986.9 m | 8.5 m/s | 10–22 s | 126–138 s |

Race: 150 s cap; first N finishers qualify (N open). Fall: last CP + 3 s; never elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.finish-arch`: `assets/candy/candy.finish-arch.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, jungle-crane-crossing.course.json, mech-lab.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `ice.floor-tile`: `assets/ice/ice.floor-tile.asset.json`; current collider kinds: cuboid; examples: ice-slide-gates.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: butterfly-stroke propulsion and belly collision pose. Existing ice tuning does not implement this movement. NEW: timed speed pickup / boost effect and recharge policy. NEW: warning, delayed drop and reset policy for the drawn trap tiles.

## Owner decisions

- Belly-stroke propulsion and collision pose are NEW; accept projected 8.5–9 m/s average?
- Approve 18° banks, friction 0.06 and +20% short boosts as starting values?
