# I / Honeycomb Heights — drawn asset needs

Three aligned hex floors: save your layer or drop early to claim the next.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Hex cell × 127 | `plan.hex-tile` | NEW | `I-honeycomb-heights/Z01/hex` | primitive compound approximation | 5.5 × 6.4 × 0.35 | Layer 1, elevation 12 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 0 m is diagram-only. |
| 2 | Hex cell × 127 | `plan.hex-tile` | NEW | `I-honeycomb-heights/Z02/hex` | primitive compound approximation | 5.5 × 6.4 × 0.35 | Layer 2, elevation 6 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 90 m is diagram-only. |
| 3 | Hex cell × 127 | `plan.hex-tile` | NEW | `I-honeycomb-heights/Z03/hex` | primitive compound approximation | 5.5 × 6.4 × 0.35 | Layer 3, elevation 0 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 180 m is diagram-only. |
| 1 | Hex start × 60 | `course.spawn` | EXISTS — course data | `I-honeycomb-heights/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 one-per-tile slots; 5 s grace before contact decay. |
| 4 | Layer timer × 1 | `plan.prompt-display` | NEW | `I-honeycomb-heights/Z04/screen` | none (display) | 18 × 3 × 3 | At 105 s start removing batches of 5 remaining cells every 6 s, each with 8 s warning. Last-standing tie rules apply. |

## Numbered zones

1. **Top layer / +12.** Hex cell: Layer 1, elevation 12 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 0 m is diagram-only. Hex start: 60 one-per-tile slots; 5 s grace before contact decay.
2. **Middle / +6.** Hex cell: Layer 2, elevation 6 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 90 m is diagram-only.
3. **Bottom / +0.** Hex cell: Layer 3, elevation 0 m. Radius 3.2 m; 127 cells; contact decay = max(1.5, 0.20 x entrants) s, fixed at round start. Panel x offset 180 m is diagram-only.
4. **Layer rules.** Layer timer: At 105 s start removing batches of 5 remaining cells every 6 s, each with 8 s warning. Last-standing tie rules apply.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Top-layer conserve | 66.4 m | 5 m/s | 2–5 s | 15–18 s |
| Lower-layer claim | 58.9 m | 5 m/s | 2–4 s | 14–16 s |

Elimination: drops between layers remain alive; below bottom layer = OUT, no respawn. Mid-round quota or FINAL last standing. Target 90–150 s; 150 s regulation then tie overtime.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.


## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. NEW: Stateful disappearing tiles — Warning, contact decay, reset or permanent removal; hex instancing / collider budget.

## Owner decisions

- Prioritise 381 independent tile states / collider instancing despite the current 96-obstacle course cap?
