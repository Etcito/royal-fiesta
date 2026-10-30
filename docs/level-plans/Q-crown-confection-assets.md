# Q / Crown Confection — drawn asset needs

Three uphill routes converge on a wide crown apron with a reliable checkpoint.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Final launch × 1 | `candy.floor-tile` | EXISTS — resize / configure | `Q-crown-confection/Z01/floor` | cuboid segments | 40 × 42 × 1 | 60-capacity special-event grid; normal final has 6 evenly spaced front-row slots. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `Q-crown-confection/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.8 × 1.6 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `Q-crown-confection/Z01/cp` | sensor cuboid | 5 × 40 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Outer ascent × 2 | `plan.ramp-deck` | NEW | `Q-crown-confection/Z02/bridge` | convex hull segments | 245.0 long × 12 wide × 0.7 | Two 12 m ramps; +12 m over 245 m. 4 m total shoulder space around each hammer. |
| 2 | Crown hammer × 4 | `candy.pendulum-hammer` | EXISTS — resize / configure | `Q-crown-confection/Z02/hammer` | kinematic cuboids | Ø8 × 5 sweep envelope | 8 m sweep; 4 / 5 s cycles. Wait or take the risky centre. |
| 3 | Direct climb × 1 | `plan.ramp-deck` | NEW | `Q-crown-confection/Z03/bridge` | convex hull segments | 209.0 long × 6 wide × 0.7 | 6 m spine; +12 m over 209 m. 3 m gaps have <=0.18 m landing rise. |
| 3 | Spine leap × 2 | `plan.fall-volume` | NEW | `Q-crown-confection/Z03/gap` | sensor below deck; no floor | 3 × 6 × 4 | 3 m edge gap +0.18 m rise; ideal reach 5.80 m, design centre span 3.8 m. |
| 3 | Uphill headwind × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `Q-crown-confection/Z03/conveyor` | cuboid + surface velocity | 24 × 6 × 0.3 | 2 m/s reverse belt; gaps have 16 m normal approach beyond it. |
| 4 | Crown apron × 1 | `candy.floor-tile` | EXISTS — resize / configure | `Q-crown-confection/Z04/floor` | cuboid segments | 36 × 34 × 0.8 | At +12 m. 34 m apron width lets finalists fan out after the merge; no physical crown camping wall. |
| 4 | CP1 × 1 | `plan.respawn-pad` | NEW | `Q-crown-confection/Z04/cp` | sensor cuboid | 5 × 28 × 3 | Respawn here after a fall; 3 s penalty. |
| 4 | Grab crown × 1 | `plan.grab-crown` | NEW | `Q-crown-confection/Z04/crown` | sensor ball | Ø2 × 2 | Centre +1.0 m above apron; within 1 m grab range. Crown static; contact alone never wins. |
| 1 | Cloud / balloon decor × 1 | `candy.cloud` | EXISTS — resize / configure | `Q-crown-confection/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |
| 1 | Cloud / balloon decor × 1 | `candy.hot-air-balloon` | EXISTS — resize / configure | `Q-crown-confection/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |

## Numbered zones

1. **Fair final grid.** Final launch: 60-capacity special-event grid; normal final has 6 evenly spaced front-row slots. Start grid: 60 spots; 1.8 × 1.6 m centres. CP0: Respawn here after a fall; 3 s penalty. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only.
2. **Safe outer climb.** Outer ascent: Two 12 m ramps; +12 m over 245 m. 4 m total shoulder space around each hammer. Crown hammer: 8 m sweep; 4 / 5 s cycles. Wait or take the risky centre.
3. **Risk spine.** Direct climb: 6 m spine; +12 m over 209 m. 3 m gaps have <=0.18 m landing rise. Spine leap: 3 m edge gap +0.18 m rise; ideal reach 5.80 m, design centre span 3.8 m. Uphill headwind: 2 m/s reverse belt; gaps have 16 m normal approach beyond it.
4. **Crown approach.** Crown apron: At +12 m. 34 m apron width lets finalists fan out after the merge; no physical crown camping wall. CP1: Respawn here after a fall; 3 s penalty. Grab crown: Centre +1.0 m above apron; within 1 m grab range. Crown static; contact alone never wins.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Outer climb | 300.0 m | 6.5 m/s | 5–10 s | 51–56 s |
| Direct spine | 264.0 m | 6.2 m/s | 6–15 s | 49–58 s |

FINAL: first valid crown GRAB wins. Falls = last CP + 3 s; no elimination. 60 s target; 90 s regulation then 30 s crown overtime. Exact ties / no grab: README.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.cloud`: `assets/candy/candy.cloud.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.hot-air-balloon`: `assets/candy/candy.hot-air-balloon.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Ordered route / lap gates — Current highest-checkpoint-first code permits skipping; require explicit stage and lap state. NEW: Crown grab objective — Within existing 1 m range, visible reachable crown and authoritative winner arbitration.

## Owner decisions

- Keep crown static and reachable from the apron, avoiding a random final jump window?
