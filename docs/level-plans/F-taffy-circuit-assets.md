# F / Taffy Circuit — drawn asset needs

Two laps around a stadium; long safe bends compete with narrow inside cuts.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Stadium track × 1 | `candy.floor-tile` | EXISTS — resize / configure | `F-taffy-circuit/Z01/floor` | cuboid segments | 411.3 long × 16 wide × 1 | 16 m lane; clockwise, two laps. Gates south/east/north/west must occur in order. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `F-taffy-circuit/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 1 | LAP × 1 | `plan.respawn-pad` | NEW | `F-taffy-circuit/Z01/cp` | sensor cuboid | 5 × 16 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Bend hammer × 2 | `candy.pendulum-hammer` | EXISTS — resize / configure | `F-taffy-circuit/Z02/hammer` | kinematic cuboids | Ø8 × 5 sweep envelope | 8 m clear shoulder; 4 / 5 s cycles. |
| 3 | Balance straight × 1 | `candy.mech-seesaw` | EXISTS — resize / configure | `F-taffy-circuit/Z03/seesaw` | dynamic roundCuboid + hinge | 24 × 10 × 0.4 | ±2 degrees; each end moves 0.42 m. Fixed 3 m side shoulders; base deck is cut out below the moving plank. |
| 4 | Inside chord × 2 | `plan.ramp-deck` | NEW | `F-taffy-circuit/Z04/bridge` | convex hull segments | 87.7 long × 5 wide × 0.5 | 5 m wide; saves 38 m per bend, meets the same side gate stage. |
| 4 | Chord gap × 2 | `plan.fall-volume` | NEW | `F-taffy-circuit/Z04/gap` | sensor below deck; no floor | 5 × 3 × 4 | 3 m gap with 8 m clear run-out; avoid the cut if crowded. |
| 5 | E × 1 | `plan.respawn-pad` | NEW | `F-taffy-circuit/Z05/cp` | sensor cuboid | 30 × 8 × 3 | Ordered gate spans outer track and chord; saves lap, cannot increment by reversing. |
| 5 | N × 1 | `plan.respawn-pad` | NEW | `F-taffy-circuit/Z05/cp` | sensor cuboid | 8 × 8 × 3 | Ordered gate spans outer track and chord; saves lap, cannot increment by reversing. |
| 5 | W × 1 | `plan.respawn-pad` | NEW | `F-taffy-circuit/Z05/cp` | sensor cuboid | 30 × 8 × 3 | Ordered gate spans outer track and chord; saves lap, cannot increment by reversing. |
| 1 | Cloud / balloon decor × 1 | `candy.cloud` | EXISTS — resize / configure | `F-taffy-circuit/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |
| 1 | Cloud / balloon decor × 1 | `candy.hot-air-balloon` | EXISTS — resize / configure | `F-taffy-circuit/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |

## Numbered zones

1. **Rolling grid.** Stadium track: 16 m lane; clockwise, two laps. Gates south/east/north/west must occur in order. Start grid: 60 spots; 1.6 × 1.8 m centres. LAP: Respawn here after a fall; 3 s penalty. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only.
2. **Hammer bend.** Bend hammer: 8 m clear shoulder; 4 / 5 s cycles.
3. **Balance straight.** Balance straight: ±2 degrees; each end moves 0.42 m. Fixed 3 m side shoulders; base deck is cut out below the moving plank.
4. **Inside gamble.** Inside chord: 5 m wide; saves 38 m per bend, meets the same side gate stage. Chord gap: 3 m gap with 8 m clear run-out; avoid the cut if crowded.
5. **Lap gate.** E: Ordered gate spans outer track and chord; saves lap, cannot increment by reversing. N: Ordered gate spans outer track and chord; saves lap, cannot increment by reversing. W: Ordered gate spans outer track and chord; saves lap, cannot increment by reversing.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Two outside laps | 822.5 m | 7 m/s | 12–24 s | 130–142 s |
| Four inside chords | 670.9 m | 7 m/s | 20–35 s | 116–131 s |

Race: first stage quota qualifies; 150 s cap. Fall = last CP + 3 s. Timeout ranking and ties: see README. No fall elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.cloud`: `assets/candy/candy.cloud.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.hot-air-balloon`: `assets/candy/candy.hot-air-balloon.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.mech-seesaw`: `assets/candy/candy.mech-seesaw.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Ordered route / lap gates — Current highest-checkpoint-first code permits skipping; require explicit stage and lap state.

## Owner decisions

- Lock the race to two laps, with no final-lap speed bonus?
