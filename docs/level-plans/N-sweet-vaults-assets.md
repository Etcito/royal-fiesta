# N / Sweet Vaults — drawn asset needs

A wide-open treasure park with safe ground caches and exposed high-value spurs.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Treasure meadow × 1 | `candy.floor-tile` | EXISTS — resize / configure | `N-sweet-vaults/Z01/floor` | cuboid segments | 132 × 104 × 1 | Free routing; 60 players spread among 24 caches. Pickups bank instantly. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `N-sweet-vaults/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 1 | HOME × 1 | `plan.respawn-pad` | NEW | `N-sweet-vaults/Z01/cp` | sensor cuboid | 24 × 7 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Ground cache × 18 | `plan.sweet-token` | NEW | `N-sweet-vaults/Z02/collect` | sensor ball | Ø2 × 2 | 18 caches: 1 point, 6 s shared respawn. Collected points survive a fall. |
| 3 | Vault ramp × 3 | `plan.ramp-deck` | NEW | `N-sweet-vaults/Z03/bridge` | convex hull segments | 67.0 long × 4 wide × 0.6 | 40 m rises 3 m; 4 m exposed lane, with ground detours always open. |
| 3 | High cache × 6 | `plan.sweet-token` | NEW | `N-sweet-vaults/Z03/collect` | sensor ball | Ø2.4 × 2.4 | 6 caches: 3 points, 12 s shared respawn. Wait or rotate to fresh ground caches. |
| 3 | Vault gap × 3 | `plan.fall-volume` | NEW | `N-sweet-vaults/Z03/gap` | sensor below deck; no floor | 4 × 3 × 4 | 3 m gap at constant +3 m height; 10 m approach and 12 m landing. Falling from a vault triggers HOME +3 s; ground walkers below do not trigger it. |
| 4 | Meadow sweeper × 2 | `candy.spinner-bar` | EXISTS — resize / configure | `N-sweet-vaults/Z04/spinner` | kinematic cuboids | Ø8 × 0.5 sweep envelope | 8 m sweep. Go around it or gamble on a shorter cache loop. |

## Numbered zones

1. **Shared start.** Treasure meadow: Free routing; 60 players spread among 24 caches. Pickups bank instantly. Start grid: 60 spots; 1.6 × 1.8 m centres. HOME: Respawn here after a fall; 3 s penalty.
2. **Ground caches.** Ground cache: 18 caches: 1 point, 6 s shared respawn. Collected points survive a fall.
3. **High vaults.** Vault ramp: 40 m rises 3 m; 4 m exposed lane, with ground detours always open. High cache: 6 caches: 3 points, 12 s shared respawn. Wait or rotate to fresh ground caches. Vault gap: 3 m gap at constant +3 m height; 10 m approach and 12 m landing. Falling from a vault triggers HOME +3 s; ground walkers below do not trigger it.
4. **Cross-park decisions.** Meadow sweeper: 8 m sweep. Go around it or gamble on a shorter cache loop.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Ground harvest | 134.0 m | 6.5 m/s | 3–6 s | 24–27 s |
| High-value circuit | 338.0 m | 6 m/s | 6–10 s | 62–66 s |

Collection: 120 s, highest banked points fill stage quota. Falls = HOME + 3 s; keep score. Tie uses earliest last scoring pickup, then disclosed seed. No fall elimination.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: Season rules / selection / results — Stage eligibility, quotas, seeded anti-repeat bags, ties and survivor-grid presentation. EXTEND: Spread checkpoint + penalty — Existing immediate respawn becomes spread respawn with 3 s delay; ordered stages where required. NEW: Collectible scoring / regeneration — Authoritative pickup, value, cooldown, banked score and timed ranking.

## Owner decisions

- Keep shared pickup cooldowns, or use per-player caches for less contest?
