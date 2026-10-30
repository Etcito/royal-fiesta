# E / Sugar Sprint — drawn asset needs

Three door lanes, changing conveyor choices and a generous final run-out.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Sprint boulevard × 1 | `candy.floor-tile` | EXISTS — resize / configure | `E-sugar-sprint/Z01/floor` | cuboid segments | 300 × 64 × 1 | 64 m total width; three 16 m lanes; no single-door crowd funnel. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `E-sugar-sprint/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `E-sugar-sprint/Z01/cp` | sensor cuboid | 5 × 60 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Real / fake panel × 12 | `plan.fake-door` | NEW | `E-sugar-sprint/Z02/fake` | stateful cuboid | 1 × 6 × 3 | Two 6 m panels per bank; at least one yields. Wrong panel: at most 2 s detour. |
| 2 | Bank infill × 8 | `candy.wall-block` | EXISTS — resize / configure | `E-sugar-sprint/Z02/wall` | cuboid | 1 × 4 × 3; 1 × 10 × 3 | 3 m wall fills between door banks; choose a panel rather than walk around the entire bank. |
| 2 | CP1 × 1 | `plan.respawn-pad` | NEW | `E-sugar-sprint/Z02/cp` | sensor cuboid | 6 × 60 × 3 | Respawn here after a fall; 3 s penalty. |
| 3 | Forward belt × 2 | `candy.conveyor-belt` | EXISTS — resize / configure | `E-sugar-sprint/Z03/conveyor` | cuboid + surface velocity | 42 × 10 × 0.3 | 2 m/s; central 12 m corridor stays normal. Swap lanes between belts. |
| 3 | Reverse belt × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `E-sugar-sprint/Z03/conveyor` | cuboid + surface velocity | 24 × 10 × 0.3 | Opposes run by 2 m/s; side shoulders open. |
| 4 | Optional 3 m jump × 2 | `plan.fall-volume` | NEW | `E-sugar-sprint/Z04/gap` | sensor below deck; no floor | 3 × 14 × 4 | 3 m gap; 12 m approach, 20 m landing; central bypass never has a gap. |
| 4 | CP2 × 1 | `plan.respawn-pad` | NEW | `E-sugar-sprint/Z04/cp` | sensor cuboid | 6 × 60 × 3 | Respawn here after a fall; 3 s penalty. |
| 5 | Finish × 1 | `candy.finish-arch` | EXISTS — resize / configure | `E-sugar-sprint/Z05/finish` | cuboid arch + sensor | 3 × 48 × 5 | All route stages required. |
| 1 | Cloud / balloon decor × 1 | `candy.cloud` | EXISTS — resize / configure | `E-sugar-sprint/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |
| 1 | Cloud / balloon decor × 1 | `candy.hot-air-balloon` | EXISTS — resize / configure | `E-sugar-sprint/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |

## Numbered zones

1. **Wide launch.** Sprint boulevard: 64 m total width; three 16 m lanes; no single-door crowd funnel. Start grid: 60 spots; 1.6 × 1.8 m centres. CP0: Respawn here after a fall; 3 s penalty. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only.
2. **Door roulette.** Real / fake panel: Two 6 m panels per bank; at least one yields. Wrong panel: at most 2 s detour. Bank infill: 3 m wall fills between door banks; choose a panel rather than walk around the entire bank. CP1: Respawn here after a fall; 3 s penalty.
3. **Conveyor braid.** Forward belt: 2 m/s; central 12 m corridor stays normal. Swap lanes between belts. Reverse belt: Opposes run by 2 m/s; side shoulders open.
4. **Last leap.** Optional 3 m jump: 3 m gap; 12 m approach, 20 m landing; central bypass never has a gap. CP2: Respawn here after a fall; 3 s penalty.
5. **Finish spread.** Finish: All route stages required.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Sprint lane | 285.0 m | 7 m/s | 7–13 s | 48–54 s |
| No-jump middle | 287.5 m | 6.8 m/s | 5–12 s | 47–54 s |

Race: first stage quota qualifies; 60 s cap. Fall = last CP + 3 s. Timeout ranking and ties: see README. No fall elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.cloud`: `assets/candy/candy.cloud.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.finish-arch`: `assets/candy/candy.finish-arch.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, jungle-crane-crossing.course.json, mech-lab.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.hot-air-balloon`: `assets/candy/candy.hot-air-balloon.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.wall-block`: `assets/candy/candy.wall-block.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, hub-plaza.course.json, mech-lab.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Ordered route / lap gates — Current highest-checkpoint-first code permits skipping; require explicit stage and lap state. NEW: Real / fake doors — Seeded breakable versus solid panels, with readable feedback.

## Owner decisions

- Is a forgiving 60 s opener desirable, with progress ranking at the cap?
