# P / Sugar Signals — drawn asset needs

Remember the tile symbols, choose a verified route, and return for the next prompt.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Safe home bank × 1 | `candy.floor-tile` | EXISTS — resize / configure | `P-sugar-signals/Z01/floor` | cuboid segments | 90 × 22 × 1 | Three 20-bean cohorts; personal matching goal. During reveal, stage freely at the bank lip; cross only after release. Bank never drops. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `P-sugar-signals/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 20 spots; 1.6 × 1.8 m centres. |
| 1 | HOME × 3 | `plan.respawn-pad` | NEW | `P-sugar-signals/Z01/cp` | sensor cuboid | 16 × 5 × 3 | Respawn to your cohort pad +3 s; the shared cycle clock never resets on a fall. |
| 2 | Memory tile × 54 | `plan.memory-tile` | NEW | `P-sugar-signals/Z02/memory` | stateful cuboid | 8 × 8 × 0.4 | 54 tiles; show symbols 4 s, hide 2 s, then 14 s to cross. Wrong tiles open after 0.5 s warning; correct routes are edge-connected. |
| 3 | Goal bank × 1 | `candy.floor-tile` | EXISTS — resize / configure | `P-sugar-signals/Z03/floor` | cuboid segments | 90 × 14 × 1 | Three 16 m goal zones; matching goal earns a point then returns you to HOME for next cycle. |
| 3 | Matching gate × 3 | `plan.objective-pad` | NEW | `P-sugar-signals/Z03/home` | sensor cuboid | 16 × 10 × 0.2 | Choose your personal prompted symbol. Wrong gate: no point, reset to HOME with 3 s penalty. |
| 4 | Symbol prompt × 1 | `plan.prompt-display` | NEW | `P-sugar-signals/Z04/screen` | none (display) | 24 × 4 × 3 | Three 20 s cycles; A/B/C personal prompts balance 20 beans per goal. Colour + shape + letter; three disjoint 8 m valid paths, each <=77 m including banks. |

## Numbered zones

1. **Safe start bank.** Safe home bank: Three 20-bean cohorts; personal matching goal. During reveal, stage freely at the bank lip; cross only after release. Bank never drops. Start grid: 20 spots; 1.6 × 1.8 m centres. HOME: Respawn to your cohort pad +3 s; the shared cycle clock never resets on a fall.
2. **Hidden route field.** Memory tile: 54 tiles; show symbols 4 s, hide 2 s, then 14 s to cross. Wrong tiles open after 0.5 s warning; correct routes are edge-connected.
3. **Matching goals.** Goal bank: Three 16 m goal zones; matching goal earns a point then returns you to HOME for next cycle. Matching gate: Choose your personal prompted symbol. Wrong gate: no point, reset to HOME with 3 s penalty.
4. **Prompt and recall.** Symbol prompt: Three 20 s cycles; A/B/C personal prompts balance 20 beans per goal. Colour + shape + letter; three disjoint 8 m valid paths, each <=77 m including banks.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Recalled direct path | 61.0 m | 6.5 m/s | 1–2 s | 10–11 s |
| Follow-the-crowd detour | 77.0 m | 6.5 m/s | 1–2 s | 13–14 s |

Logic / memory: 3 × 20 s = 60 s; rank by correct gates then total crossing time. Fall = HOME + 3 s, never elimination. No jump over a missing 8 m tile. Stage quota and final ties: README.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Reveal / hide / match phases — Pattern-safe routes, prompt displays, local penalties and ranked score. NEW: Stateful disappearing tiles — Warning, contact decay, reset or permanent removal; hex instancing / collider budget.

## Owner decisions

- Keep memory as a short score round with recovery, instead of instant-death guessing?
