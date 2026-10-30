# M / Gummy Grounds — drawn asset needs

Three capture gardens on two flanks and a high bridge; pressure one, rotate to another.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Open arena × 1 | `candy.floor-tile` | EXISTS — resize / configure | `M-gummy-grounds/Z01/floor` | cuboid segments | 132 × 106 × 1 | 2 teams, 30 slots each. Four 12 m paths around the central bridge. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `M-gummy-grounds/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 30 spots; 1.6 × 1.8 m centres. |
| 1 | HOME × 2 | `plan.respawn-pad` | NEW | `M-gummy-grounds/Z01/cp` | sensor cuboid | 14 × 7 × 3 | Own side, 3 s respawn delay; no capture allowed from spawn pad. |
| 2 | Capture garden × 1 | `plan.objective-pad` | NEW | `M-gummy-grounds/Z02/home` | sensor cuboid | 24 × 18 × 0.2 | Hold uncontested for 3 s to capture; 1 point/s. Any opponent pauses capture and scoring. |
| 3 | Capture garden × 1 | `plan.objective-pad` | NEW | `M-gummy-grounds/Z03/home` | sensor cuboid | 24 × 18 × 0.2 | Hold uncontested for 3 s to capture; 1 point/s. Any opponent pauses capture and scoring. |
| 4 | Raised centre × 1 | `plan.ramp-deck` | NEW | `M-gummy-grounds/Z04/bridge` | convex hull segments | 80.0 long × 14 wide × 0.7 | 25 m approach ramps rise 3 m; central deck at +3 m. Open routes underneath. |
| 4 | Bridge capture × 1 | `plan.objective-pad` | NEW | `M-gummy-grounds/Z04/home` | sensor cuboid | 24 × 14 × 0.2 | Same 1 point/s as gardens. Height gives sightlines, not bonus scoring. |
| 2 | Garden sweeper × 1 | `candy.spinner-bar` | EXISTS — resize / configure | `M-gummy-grounds/Z02/spinner` | kinematic cuboids | Ø8 × 0.5 sweep envelope | 8 m sweep, wide bypass; knocks but does not eliminate. |
| 3 | Garden sweeper × 1 | `candy.spinner-bar` | EXISTS — resize / configure | `M-gummy-grounds/Z03/spinner` | kinematic cuboids | Ø8 × 0.5 sweep envelope | 8 m sweep, wide bypass; knocks but does not eliminate. |

## Numbered zones

1. **Team bases.** Open arena: 2 teams, 30 slots each. Four 12 m paths around the central bridge. Start grid: 30 spots; 1.6 × 1.8 m centres. HOME: Own side, 3 s respawn delay; no capture allowed from spawn pad.
2. **Lower garden.** Capture garden: Hold uncontested for 3 s to capture; 1 point/s. Any opponent pauses capture and scoring. Garden sweeper: 8 m sweep, wide bypass; knocks but does not eliminate.
3. **Upper garden.** Capture garden: Hold uncontested for 3 s to capture; 1 point/s. Any opponent pauses capture and scoring. Garden sweeper: 8 m sweep, wide bypass; knocks but does not eliminate.
4. **Bridge control.** Raised centre: 25 m approach ramps rise 3 m; central deck at +3 m. Open routes underneath. Bridge capture: Same 1 point/s as gardens. Height gives sightlines, not bonus scoring.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Garden rotation | 77.1 m | 6.5 m/s | 3–6 s | 15–18 s |
| Bridge attack | 102.0 m | 6.5 m/s | 2–4 s | 18–20 s |

Team hold: 120 s; highest cumulative zone-seconds wins, whole team qualifies. Falls = HOME + 3 s. No automatic trailing-team score bonus. Team ties: README.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Capture and hold scoring — Capture timer, contested state and team score accrual.

## Owner decisions

- Use equal scoring for all three gardens to keep every rotation viable?
