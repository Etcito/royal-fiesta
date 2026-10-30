# A / Big Ball Borough — drawn asset needs

30 v 30 football with contested flanks and a clear central passing corridor.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Pitch × 1 | `candy.floor-tile` | EXISTS — resize / configure | `A-football/Z01/floor` | cuboid segments | 104 × 60 × 1 | 104 × 60 m; central corridor stays clear. |
| 1 | Halfway line × 1 | `plan.pitch-lines` | NEW | `A-football/Z01/mark` | none | 60.0 long × 0.18 wide × 0 |  |
| 1 | Centre circle × 1 | `plan.pitch-lines` | NEW | `A-football/Z01/mark` | none | Ø18 × 0 |  |
| 1 | Ball × 1 | `plan.big-ball` | NEW | `A-football/Z01/ball` | dynamic ball | Ø6 × 6 | Ø6 m; proposed 240 kg. Reset here after goals, out-of-bounds or 12 s stuck (2 s pause). |
| 2 | Goal × 2 | `plan.goal-frame` | NEW | `A-football/Z02/goal` | cuboid frame + goal sensor | 8 × 16 × 8 | 16 m mouth × 8 m clear height; ball fully crosses line to score. |
| 2 | Goal area × 2 | `plan.pitch-lines` | NEW | `A-football/Z02/gate` | none | 16 × 30 × 0 | 16 × 30 m keeper zone; no exclusive goalkeeper. |
| 2 | End wall × 4 | `candy.wall-block` | EXISTS — resize / configure | `A-football/Z02/wall` | cuboid | 22.0 long × 1 wide × 4 | 4 m high; opening only at goal mouth. |
| 2 | Touchline wall × 6 | `candy.wall-block` | EXISTS — resize / configure | `A-football/Z02/wall` | cuboid | 11.0 long × 1 wide × 4; 58.0 long × 1 wide × 4 | 4 m high; bean portals connect to side lanes. |
| 3 | Start grid × 60 | `course.spawn` | EXISTS — course data | `A-football/Z03/spawn` | none (spawn record) | Ø0.8 × 1.7 | 30 spots; 1.6 × 1.8 m centres. |
| 3 | HOME × 2 | `plan.respawn-pad` | NEW | `A-football/Z03/cp` | sensor cuboid | 12 × 6 × 3 | Own team respawn; 3 s. Spawn staggered within the pad. |
| 5 | Bean flank × 2 | `candy.floor-tile` | EXISTS — resize / configure | `A-football/Z05/floor` | cuboid segments | 92.0 long × 8 wide × 1 | 8 m lane; 2–3 m portals exclude the Ø6 m ball. |
| 5 | Portal posts × 16 | `candy.wall-block` | EXISTS — resize / configure | `A-football/Z05/wall` | cuboid | 1 × 1 × 3 | Three openings: 2 m / 3 m / 2 m; bean traffic only. |
| 5 | Shared boost × 2 | `plan.boost-lane` | NEW | `A-football/Z05/boost` | sensor cuboid | 6 × 6 × 1 | Contested pickup: +25% run for 2 s; 6 s recharge (NEW). |
| 3 | Trailing-team boost × 4 | `plan.boost-lane` | NEW | `A-football/Z03/boost` | sensor cuboid | 4 × 4 × 1 | Active only for the losing team; +25% run for 2 s (NEW). |
| 4 | Sticky wing × 4 | `plan.mud-patch` | NEW | `A-football/Z04/mud` | cuboid surface | 9 × 5 × 0 | Mud speed = 4.8 m/s; central passing remains open. |
| 4 | Wing conveyor × 4 | `candy.conveyor-belt` | EXISTS — resize / configure | `A-football/Z04/conveyor` | cuboid + surface velocity | 4 × 10 × 0.5 | 2 m/s toward midfield; cross or ride it. |
| 6 | Rebound wedge × 4 | `plan.slide-mound` | NEW | `A-football/Z06/mound` | convex hull | 6 × 4 × 0.6 | Rubber; 0.6 m rise over 4 m. Bank the ball or jump the wedge. |
| 7 | Wing sweeper × 2 | `candy.spinner-bar` | EXISTS — resize / configure | `A-football/Z07/spinner` | kinematic cuboids | Ø8 × 0.5 sweep envelope | 8 m bar; 10 s rotation. Knocks, no elimination. |

## Numbered zones

1. **Kick-off & passing.** Pitch: 104 × 60 m; central corridor stays clear. Halfway line:  Centre circle:  Ball: Ø6 m; proposed 240 kg. Reset here after goals, out-of-bounds or 12 s stuck (2 s pause).
2. **Goal mouths.** Goal: 16 m mouth × 8 m clear height; ball fully crosses line to score. Goal area: 16 × 30 m keeper zone; no exclusive goalkeeper. End wall: 4 m high; opening only at goal mouth. Touchline wall: 4 m high; bean portals connect to side lanes.
3. **Teams & recovery.** Start grid: 30 spots; 1.6 × 1.8 m centres. HOME: Own team respawn; 3 s. Spawn staggered within the pad. Trailing-team boost: Active only for the losing team; +25% run for 2 s (NEW).
4. **Wing decisions.** Sticky wing: Mud speed = 4.8 m/s; central passing remains open. Wing conveyor: 2 m/s toward midfield; cross or ride it.
5. **Side-lane duel.** Bean flank: 8 m lane; 2–3 m portals exclude the Ø6 m ball. Portal posts: Three openings: 2 m / 3 m / 2 m; bean traffic only. Shared boost: Contested pickup: +25% run for 2 s; 6 s recharge (NEW).
6. **Rebound corners.** Rebound wedge: Rubber; 0.6 m rise over 4 m. Bank the ball or jump the wedge.
7. **Sweeper pockets.** Wing sweeper: 8 m bar; 10 s rotation. Knocks, no elimination.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Direct attack | 52.0 m | 8 m/s | 0–0 s | 6.5–6.5 s |
| Wing attack | 71.6 m | 8 m/s | 1–3 s | 10–12 s |
| Bean flank | 152.0 m | 8 m/s | 2–5 s | 21–24 s |

Match: 120 s, most goals wins; tied → 20 s golden goal, then shared draw (proposal). Goals reset both teams.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `candy.wall-block`: `assets/candy/candy.wall-block.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, hub-plaza.course.json, mech-lab.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: team football, dynamic ball tuning, goals, score reset and team-only recovery boosts. NEW: timed speed pickup / boost effect and recharge policy.

## Owner decisions

- Approve 120 s + 20 s golden goal and shared draws?
- Ball Ø6 m / 240 kg and losing-team boost need feel tuning.
