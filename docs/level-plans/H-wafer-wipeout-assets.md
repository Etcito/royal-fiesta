# H / Wafer Wipeout — drawn asset needs

A single vanishing floor: preserve fresh islands or cross the crowded centre.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 2 | Wave-drop wafer × 32 | `plan.trap-tile` | NEW | `H-wafer-wipeout/Z02/trap` | kinematic cuboid + sensor | 6 × 6 × 0.4 | Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape. |
| 4 | Wave-drop wafer × 36 | `plan.trap-tile` | NEW | `H-wafer-wipeout/Z04/trap` | kinematic cuboid + sensor | 6 × 6 × 0.4 | Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape. |
| 3 | Wave-drop wafer × 12 | `plan.trap-tile` | NEW | `H-wafer-wipeout/Z03/trap` | kinematic cuboid + sensor | 6 × 6 × 0.4 | Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape. |
| 1 | Distributed start × 60 | `course.spawn` | EXISTS — course data | `H-wafer-wipeout/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 slots at 6 m spacing; spread a smaller lobby evenly. |
| 4 | Shrink clock × 1 | `plan.prompt-display` | NEW | `H-wafer-wipeout/Z04/screen` | none (display) | 16 × 3 × 3 | Wave preview shows the next ten cells. Seeded removals favour the centre first, then outer islands; no permanent refuge. |

## Numbered zones

1. **Distributed start.** Distributed start: 60 slots at 6 m spacing; spread a smaller lobby evenly.
2. **Fresh outer islands.** Wave-drop wafer: Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape.
3. **Contested crossing.** Wave-drop wafer: Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape.
4. **No safe camping.** Wave-drop wafer: Ten cells flash 4 s then drop: first at 18 s, then every 12 s until 20 remain. Thereafter one cell per 6 s. No floor underneath; plan a live adjacent escape. Shrink clock: Wave preview shows the next ten cells. Seeded removals favour the centre first, then outer islands; no permanent refuge.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Fresh-edge transfer | 96.0 m | 6 m/s | 2–4 s | 18–20 s |
| Centre intercept | 48.0 m | 6 m/s | 1–3 s | 9–11 s |

Elimination: fall below wafer = OUT, no CP or respawn. Target 90 s; stop at stage quota. 120 s cap uses survival policy in README.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.


## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. NEW: Stateful disappearing tiles — Warning, contact decay, reset or permanent removal; hex instancing / collider budget. NEW: warning, delayed drop and reset policy for the drawn trap tiles.

## Owner decisions

- Confirm 4 s warning waves, permanent holes and no player grabbing in elimination maps?
