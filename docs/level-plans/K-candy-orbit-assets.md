# K / Candy Orbit — drawn asset needs

Counter-rotating rings, a jump-bar arena and alternating laser / block sweeps.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Slime below arena × 1 | `plan.rising-slime` | NEW | `K-candy-orbit/Z01/slime` | moving kill sensor | Ø114 × 1 | Below deck; fall = OUT. Contact with a laser also eliminates. |
| 1 | Rotating ring × 1 | `plan.rotating-ring` | NEW | `K-candy-orbit/Z01/ring` | kinematic segmented cuboids | 270.2 long × 14 wide × 0.7 | Radius 43 m / width 14 m; opposite directions, one revolution per 90 s. |
| 2 | Rotating ring × 1 | `plan.rotating-ring` | NEW | `K-candy-orbit/Z02/ring` | kinematic segmented cuboids | 157.1 long × 16 wide × 0.7 | Radius 25 m / width 16 m; opposite directions, one revolution per 70 s. |
| 3 | Stationary transfer × 4 | `plan.ramp-deck` | NEW | `K-candy-orbit/Z03/bridge` | convex hull segments | 18.0 long × 8 wide × 0.7 | Four 8 m flush spokes bridge the 3 m ring separation. Seams <=0.25 m; transfers do not rotate. |
| 1 | Ring start × 60 | `course.spawn` | EXISTS — course data | `K-candy-orbit/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 slots, 4.5 m arc spacing; starts static for 5 s. |
| 2 | Low jump bar × 1 | `candy.spinner-bar` | EXISTS — resize / configure | `K-candy-orbit/Z02/spinner` | kinematic cuboids | Ø64 × 0.45 sweep envelope | Low bar centre 0.55 m, thickness 0.45 m; top 0.775 m. Independent phases must leave a clear jump window. |
| 2 | High jump bar × 1 | `candy.spinner-bar` | EXISTS — resize / configure | `K-candy-orbit/Z02/spinner` | kinematic cuboids | Ø64 × 0.45 sweep envelope | High bar centre 2.5 m, thickness 0.45 m; underside 2.275 m clears standing beans. Phase offset 60 degrees in this snapshot. |
| 4 | Gapped laser sweep × 4 | `plan.laser-sweep` | NEW | `K-candy-orbit/Z04/laser` | swept sensor | 11.0 long × 0.35 wide × 0.35; 22.0 long × 0.35 wide × 0.35 | 3 gaps, each 8 m; 2 s telegraph. Sweep +z at 4 m/s. Contact = OUT; not a jump test. |
| 4 | Block wave snapshot × 3 | `plan.sweep-block` | NEW | `K-candy-orbit/Z04/block` | kinematic cuboids | 12 × 3 × 2.4 | Alternate with laser, never overlap phases; pushes toward edge. 22 m openings between blocks. |

## Numbered zones

1. **Outer ring.** Slime below arena: Below deck; fall = OUT. Contact with a laser also eliminates. Rotating ring: Radius 43 m / width 14 m; opposite directions, one revolution per 90 s. Ring start: 60 slots, 4.5 m arc spacing; starts static for 5 s.
2. **Inner ring.** Rotating ring: Radius 25 m / width 16 m; opposite directions, one revolution per 70 s. Low jump bar: Low bar centre 0.55 m, thickness 0.45 m; top 0.775 m. Independent phases must leave a clear jump window. High jump bar: High bar centre 2.5 m, thickness 0.45 m; underside 2.275 m clears standing beans. Phase offset 60 degrees in this snapshot.
3. **Transfer spokes.** Stationary transfer: Four 8 m flush spokes bridge the 3 m ring separation. Seams <=0.25 m; transfers do not rotate.
4. **Sweep lanes.** Gapped laser sweep: 3 gaps, each 8 m; 2 s telegraph. Sweep +z at 4 m/s. Contact = OUT; not a jump test. Block wave snapshot: Alternate with laser, never overlap phases; pushes toward edge. 22 m openings between blocks.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Outer quarter lap | 67.5 m | 6 m/s | 2–5 s | 13–16 s |
| Inner escape | 75.3 m | 6 m/s | 2–5 s | 15–18 s |

Elimination: fall into slime OR laser contact = OUT, no respawn. Blocks/bars only knock. 90–120 s target; stop at quota. 120 s regulation + survival overtime if needed.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. NEW: Rotating annular floor — Segmented moving ring carries players; not merely a rotating hazard bar. NEW: Laser / block / paired-bar patterns — Telegraph, contact semantics and safe traversable patterns; motion primitives can be reused.

## Owner decisions

- Ship laser and block phases together, or start with rings plus paired bars?
