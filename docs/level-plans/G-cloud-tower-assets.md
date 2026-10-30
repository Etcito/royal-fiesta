# G / Cloudstack Tower — drawn asset needs

Three stacked ramp galleries; exploded top views keep the vertical routes readable.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Ascending gallery × 1 | `plan.ramp-deck` | NEW | `G-cloud-tower/Z01/bridge` | convex hull segments | 240.0 long × 10 wide × 0.7 | Panel 1: subtract 0 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `G-cloud-tower/Z01/cp` | sensor cuboid | 10 × 10 × 3 | Trigger at gallery EXIT height only (+12 / +24 m); base passes below it. Respawn into next gallery. |
| 1 | Outer hammer × 1 | `candy.pendulum-hammer` | EXISTS — resize / configure | `G-cloud-tower/Z01/hammer` | kinematic cuboids | Ø6 × 5 sweep envelope | 6 m sweep; inside passing shoulder 2 m. |
| 1 | Uphill belt × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `G-cloud-tower/Z01/conveyor` | cuboid + surface velocity | 18 × 5 × 0.3 | 2 m/s assist; 5 m normal shoulder. |
| 4 | Steeper cut × 3 | `plan.ramp-deck` | NEW | `G-cloud-tower/Z04/bridge` | convex hull segments | 75.0 long × 4 wide × 0.6 | Skip 30 m of gallery 1; 75 m ramp rises 5.25 m. Optional 4 m lane. / Skip 30 m of gallery 2; 75 m ramp rises 5.25 m. Optional 4 m lane. / Skip 30 m of gallery 3; 75 m ramp rises 5.25 m. Optional 4 m lane. |
| 4 | Cut ridge × 3 | `plan.jump-ridge` | NEW | `G-cloud-tower/Z04/hurdle` | cuboid | 4 × 0.6 × 0.65 | 0.65 m rise; 12 m approach and 12 m run-out. |
| 2 | Ascending gallery × 1 | `plan.ramp-deck` | NEW | `G-cloud-tower/Z02/bridge` | convex hull segments | 240.0 long × 10 wide × 0.7 | Panel 2: subtract 90 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. |
| 2 | CP1 × 1 | `plan.respawn-pad` | NEW | `G-cloud-tower/Z02/cp` | sensor cuboid | 10 × 10 × 3 | Trigger at gallery EXIT height only (+12 / +24 m); base passes below it. Respawn into next gallery. |
| 2 | Outer hammer × 1 | `candy.pendulum-hammer` | EXISTS — resize / configure | `G-cloud-tower/Z02/hammer` | kinematic cuboids | Ø6 × 5 sweep envelope | 6 m sweep; inside passing shoulder 2 m. |
| 2 | Uphill belt × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `G-cloud-tower/Z02/conveyor` | cuboid + surface velocity | 18 × 5 × 0.3 | 2 m/s assist; 5 m normal shoulder. |
| 3 | Ascending gallery × 1 | `plan.ramp-deck` | NEW | `G-cloud-tower/Z03/bridge` | convex hull segments | 240.0 long × 10 wide × 0.7 | Panel 3: subtract 180 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. |
| 3 | Outer hammer × 1 | `candy.pendulum-hammer` | EXISTS — resize / configure | `G-cloud-tower/Z03/hammer` | kinematic cuboids | Ø6 × 5 sweep envelope | 6 m sweep; inside passing shoulder 2 m. |
| 3 | Uphill belt × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `G-cloud-tower/Z03/conveyor` | cuboid + surface velocity | 18 × 5 × 0.3 | 2 m/s assist; 5 m normal shoulder. |
| 1 | Start apron × 1 | `candy.floor-tile` | EXISTS — resize / configure | `G-cloud-tower/Z01/floor` | cuboid segments | 28 × 12 × 0.6 | At +0 m only; third-panel finish is at +36 m. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `G-cloud-tower/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 3 | Tower finish × 1 | `candy.finish-arch` | EXISTS — resize / configure | `G-cloud-tower/Z03/finish` | cuboid arch + sensor | 4 × 10 × 5 | Top of third ramp: +36 m; CP0 then CP1 required. |

## Numbered zones

1. **Lower gallery / +0–12.** Ascending gallery: Panel 1: subtract 0 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. CP0: Trigger at gallery EXIT height only (+12 / +24 m); base passes below it. Respawn into next gallery. Outer hammer: 6 m sweep; inside passing shoulder 2 m. Uphill belt: 2 m/s assist; 5 m normal shoulder. Start apron: At +0 m only; third-panel finish is at +36 m. Start grid: 60 spots; 1.6 × 1.8 m centres.
2. **Middle / +12–24.** Ascending gallery: Panel 2: subtract 90 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. CP1: Trigger at gallery EXIT height only (+12 / +24 m); base passes below it. Respawn into next gallery. Outer hammer: 6 m sweep; inside passing shoulder 2 m. Uphill belt: 2 m/s assist; 5 m normal shoulder.
3. **Upper / +24–36.** Ascending gallery: Panel 3: subtract 180 m from drawn x to stack in world. 240 m ramp rises 12 m; same x/z at entry and exit, different heights. Outer hammer: 6 m sweep; inside passing shoulder 2 m. Uphill belt: 2 m/s assist; 5 m normal shoulder. Tower finish: Top of third ramp: +36 m; CP0 then CP1 required.
4. **Catch-up links.** Steeper cut: Skip 30 m of gallery 1; 75 m ramp rises 5.25 m. Optional 4 m lane. / Skip 30 m of gallery 2; 75 m ramp rises 5.25 m. Optional 4 m lane. / Skip 30 m of gallery 3; 75 m ramp rises 5.25 m. Optional 4 m lane. Cut ridge: 0.65 m rise; 12 m approach and 12 m run-out.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Three full galleries | 720.0 m | 6.8 m/s | 10–25 s | 116–131 s |
| Three steep cuts | 630.0 m | 6.8 m/s | 14–24 s | 107–117 s |

Race: first stage quota qualifies; 150 s cap. Fall = last CP + 3 s. Timeout ranking and ties: see README. No fall elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.finish-arch`: `assets/candy/candy.finish-arch.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, jungle-crane-crossing.course.json, mech-lab.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Ordered route / lap gates — Current highest-checkpoint-first code permits skipping; require explicit stage and lap state.

## Owner decisions

- Accept exploded floor plans for a 36 m tower, with 12 m floor-to-floor separation (11.3 m underside clearance)?
