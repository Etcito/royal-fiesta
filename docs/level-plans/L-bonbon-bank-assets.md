# L / Bonbon Bank — drawn asset needs

Two teams carry sweets home; open flanks challenge a defended central crossing.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Scramble court × 1 | `candy.floor-tile` | EXISTS — resize / configure | `L-bonbon-bank/Z01/floor` | cuboid segments | 124 × 86 × 1 | Two teams of 30 maximum; usual 12v12. No team can block all three 12 m approaches. |
| 1 | Team bank × 2 | `plan.objective-pad` | NEW | `L-bonbon-bank/Z01/home` | sensor cuboid | 18 × 26 × 0.2 | Carry one sweet; drop within bank = team point. Bank stock may be stolen; newest deposit protected 3 s. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `L-bonbon-bank/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 30 spots; 1.6 × 1.8 m centres. |
| 1 | HOME × 2 | `plan.respawn-pad` | NEW | `L-bonbon-bank/Z01/cp` | sensor cuboid | 14 × 6 × 3 | Own team home; 3 s delay. Dropped object returns to centre after 8 s idle. |
| 2 | Carry sweet × 30 | `plan.carry-sweet` | NEW | `L-bonbon-bank/Z02/collect` | sensor ball | Ø1.3 × 1.3 | 30 objects total; all worth 1. Carry speed 6 m/s; no throw required. |
| 4 | Lane divider × 4 | `candy.wall-block` | EXISTS — resize / configure | `L-bonbon-bank/Z04/wall` | cuboid | 4 × 14 × 2 | 20 m central opening; 18 m outer flanks stay open. |
| 3 | Flank belt × 4 | `candy.conveyor-belt` | EXISTS — resize / configure | `L-bonbon-bank/Z03/conveyor` | cuboid + surface velocity | 12 × 6 × 0.3 | Mirrored halves feed toward centre at 2 m/s; no team-direction advantage. |
| 1 | Cloud / balloon decor × 1 | `candy.cloud` | EXISTS — resize / configure | `L-bonbon-bank/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |
| 1 | Cloud / balloon decor × 1 | `candy.hot-air-balloon` | EXISTS — resize / configure | `L-bonbon-bank/Z01/decor` | none | Ø5 × 5 | Non-colliding; outside playable edges. Seasonal skin only. |

## Numbered zones

1. **Team homes.** Scramble court: Two teams of 30 maximum; usual 12v12. No team can block all three 12 m approaches. Team bank: Carry one sweet; drop within bank = team point. Bank stock may be stolen; newest deposit protected 3 s. Start grid: 30 spots; 1.6 × 1.8 m centres. HOME: Own team home; 3 s delay. Dropped object returns to centre after 8 s idle. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only. Cloud / balloon decor: Non-colliding; outside playable edges. Seasonal skin only.
2. **Shared sweet pile.** Carry sweet: 30 objects total; all worth 1. Carry speed 6 m/s; no throw required.
3. **Flank thieves.** Flank belt: Mirrored halves feed toward centre at 2 m/s; no team-direction advantage.
4. **Centre pinch.** Lane divider: 20 m central opening; 18 m outer flanks stay open.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Central delivery | 94.0 m | 6 m/s | 4–8 s | 20–24 s |
| Flank steal loop | 276.7 m | 6 m/s | 3–8 s | 49–54 s |

Team collection: 120 s; most banked sweets wins, whole winning team qualifies. Falls = HOME + 3 s, carried sweet drops. Ties: README team overtime.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.cloud`: `assets/candy/candy.cloud.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.hot-air-balloon`: `assets/candy/candy.hot-air-balloon.asset.json`; current collider kinds: none; examples: candy-seesaw-run.course.json, hub-plaza.course.json, podium.course.json.
- `candy.wall-block`: `assets/candy/candy.wall-block.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, hub-plaza.course.json, mech-lab.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Carry / steal / deposit objects — One object per bean, loss/reset, protected homes, no permanent removal.

## Owner decisions

- Allow bank stealing, or protect all deposited sweets for a calmer team round?
