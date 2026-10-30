# J / Syrup Summit — drawn asset needs

A rising syrup clock pushes four terraces toward a contested high plateau.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Rising syrup × 1 | `plan.rising-slime` | NEW | `J-syrup-summit/Z01/slime` | moving kill sensor | 138 × 112 × 1 | Kill height starts -2 m; rises 0.10 m/s after 10 s. Touch = OUT. Surface shown below decks. |
| 1 | Terrace × 1 | `candy.floor-tile` | EXISTS — resize / configure | `J-syrup-summit/Z01/floor` | cuboid segments | 120 × 22 × 0.7 | Deck at +0 m; use continuous ramps, never mandatory high jumps. |
| 2 | Terrace × 2 | `candy.floor-tile` | EXISTS — resize / configure | `J-syrup-summit/Z02/floor` | cuboid segments | 36 × 18 × 0.7 | Deck at +3 m; use continuous ramps, never mandatory high jumps. |
| 3 | Terrace × 1 | `candy.floor-tile` | EXISTS — resize / configure | `J-syrup-summit/Z03/floor` | cuboid segments | 100 × 18 × 0.7 | Deck at +6 m; use continuous ramps, never mandatory high jumps. |
| 4 | Terrace × 3 | `candy.floor-tile` | EXISTS — resize / configure | `J-syrup-summit/Z04/floor` | cuboid segments | 16 × 14 × 0.7 | Deck at +9 m; use continuous ramps, never mandatory high jumps. |
| 2 | Outer ascent × 2 | `plan.ramp-deck` | NEW | `J-syrup-summit/Z02/bridge` | convex hull segments | 57.0 long × 10 wide × 0.7 | 10 m wide; +3 m per leg. Two independent lanes prevent a 60-bean queue. |
| 4 | Final climb × 2 | `plan.ramp-deck` | NEW | `J-syrup-summit/Z04/bridge` | convex hull segments | 23.0 long × 10 wide × 0.7 | 23 m horizontal / +3 m; both approaches reach top terrace. |
| 3 | Mid transfer × 1 | `plan.ramp-deck` | NEW | `J-syrup-summit/Z03/bridge` | convex hull segments | 80.0 long × 6 wide × 0.6 | 6 m cross-bridge at +3 m; switch away from the crowded ascent. |
| 2 | Climb hammer × 2 | `candy.pendulum-hammer` | EXISTS — resize / configure | `J-syrup-summit/Z02/hammer` | kinematic cuboids | Ø6 × 5 sweep envelope | 6 m sweep; 2 m clear passing shoulder. |
| 4 | Climb hammer × 2 | `candy.pendulum-hammer` | EXISTS — resize / configure | `J-syrup-summit/Z04/hammer` | kinematic cuboids | Ø6 × 5 sweep envelope | 6 m sweep; 2 m clear passing shoulder. |
| 4 | Sinking top segment × 2 | `plan.trap-tile` | NEW | `J-syrup-summit/Z04/trap` | kinematic cuboid + sensor | 8 × 14 × 0.7 | At 100 s flash 4 s, then sink. Two 8 m segments are the only top crosswalks; no static deck underneath. Choose your island early. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `J-syrup-summit/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 3 | Rise clock × 1 | `plan.prompt-display` | NEW | `J-syrup-summit/Z03/screen` | none (display) | 12 × 3 × 3 | Shows time until each terrace is submerged; no checkpoint pads. |

## Numbered zones

1. **Low meadow.** Rising syrup: Kill height starts -2 m; rises 0.10 m/s after 10 s. Touch = OUT. Surface shown below decks. Terrace: Deck at +0 m; use continuous ramps, never mandatory high jumps. Start grid: 60 spots; 1.6 × 1.8 m centres.
2. **Two climb lanes.** Terrace: Deck at +3 m; use continuous ramps, never mandatory high jumps. Outer ascent: 10 m wide; +3 m per leg. Two independent lanes prevent a 60-bean queue. Climb hammer: 6 m sweep; 2 m clear passing shoulder.
3. **Transfer terrace.** Terrace: Deck at +6 m; use continuous ramps, never mandatory high jumps. Mid transfer: 6 m cross-bridge at +3 m; switch away from the crowded ascent. Rise clock: Shows time until each terrace is submerged; no checkpoint pads.
4. **High refuge.** Terrace: Deck at +9 m; use continuous ramps, never mandatory high jumps. Final climb: 23 m horizontal / +3 m; both approaches reach top terrace. Climb hammer: 6 m sweep; 2 m clear passing shoulder. Sinking top segment: At 100 s flash 4 s, then sink. Two 8 m segments are the only top crosswalks; no static deck underneath. Choose your island early.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Left climb | 150.0 m | 5.8 m/s | 8–18 s | 34–44 s |
| Cross-over escape | 250.0 m | 6 m/s | 6–12 s | 48–54 s |

Elimination: syrup contact or fall below active surface = OUT. A dry lower terrace can catch a fall; no CP / respawn. 90–120 s target, quota stop; survival tie policy applies.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. NEW: Rising elimination surface — Moving kill height, readable rise clock and pillar tiers. NEW: Stateful disappearing tiles — Warning, contact decay, reset or permanent removal; hex instancing / collider budget. NEW: warning, delayed drop and reset policy for the drawn trap tiles.

## Owner decisions

- Keep rising syrup at 0.10 m/s, with terrace loss at 30 / 60 / 90 / 120 s?
