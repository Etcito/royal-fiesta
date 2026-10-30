# O / Ribbon Runners — drawn asset needs

Tail carriers choose speed on the outer loop or risky turns through the centre.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Chase court × 1 | `candy.floor-tile` | EXISTS — resize / configure | `O-ribbon-runners/Z01/floor` | cuboid segments | 114 × 86 × 1 | 60 slots; 1 tail per 2 players. Tail holders glow; no hidden ownership. |
| 1 | Chase slot × 60 | `course.spawn` | EXISTS — course data | `O-ribbon-runners/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 dispersed starts; 10 m horizontal, at least 4 m vertical spacing; clear of juke walls. |
| 4 | Initial tail × 30 | `plan.tail` | NEW | `O-ribbon-runners/Z04/tail` | sensor / attachment | Ø1.3 × 1 | 30 initial attachments, assigned to alternate slots. 1 m grab transfer; 2 s re-steal immunity. Fewer players: floor(n/2) tails. |
| 3 | Juke wall × 4 | `candy.wall-block` | EXISTS — resize / configure | `O-ribbon-runners/Z03/wall` | cuboid | 18 × 6 × 2.4 | 2.4 m high; open corners give 8 m+ bypasses. No dead-end hiding bays. |
| 2 | Escape belt × 2 | `candy.conveyor-belt` | EXISTS — resize / configure | `O-ribbon-runners/Z02/conveyor` | cuboid + surface velocity | 36 × 6 × 0.3 | 2 m/s carry; both ends open. Pursuer may cut through central 20 m corridor. |
| 1 | HOME × 2 | `plan.respawn-pad` | NEW | `O-ribbon-runners/Z01/cp` | sensor cuboid | 10 × 10 × 3 | Respawn at nearest neutral pad + 3 s; tail goes to nearest non-holder, hold timer paused while out. |

## Numbered zones

1. **Distributed chase.** Chase court: 60 slots; 1 tail per 2 players. Tail holders glow; no hidden ownership. Chase slot: 60 dispersed starts; 10 m horizontal, at least 4 m vertical spacing; clear of juke walls. HOME: Respawn at nearest neutral pad + 3 s; tail goes to nearest non-holder, hold timer paused while out.
2. **Loop escape.** Escape belt: 2 m/s carry; both ends open. Pursuer may cut through central 20 m corridor.
3. **Crossing risk.** Juke wall: 2.4 m high; open corners give 8 m+ bypasses. No dead-end hiding bays.
4. **Tail ownership.** Initial tail: 30 initial attachments, assigned to alternate slots. 1 m grab transfer; 2 s re-steal immunity. Fewer players: floor(n/2) tails.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Carrier outer loop | 340.0 m | 7 m/s | 2–6 s | 51–55 s |
| Pursuer intercept | 96.0 m | 7 m/s | 1–3 s | 15–17 s |

Hunt: 90 s cumulative tail-hold score, top stage quota qualifies. Ties: current holder, then earliest last acquisition, then seed. Falls = neutral HOME + 3 s; tail transfers. No elimination on contact.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.wall-block`: `assets/candy/candy.wall-block.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, hub-plaza.course.json, mech-lab.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Tail possession / transfer — Transfer authority, immunity, hold-time score; player grab exists already.

## Owner decisions

- Use cumulative hold time, rather than last-second possession deciding everything?
