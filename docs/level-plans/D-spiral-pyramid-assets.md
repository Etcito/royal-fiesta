# D / Spiral of Mischief — drawn asset needs

One continuous square spiral, with narrower upper turns and visible chutes back to earlier ramp sections.

Planning only. All dimensions below are proposed **full collider / footprint dimensions in metres**, not visual bounds or scale factors. A path size is centreline length × width × deck thickness. Motion envelopes are explicitly identified. Existing models may require resizing and new course wiring. NEW IDs are names for proposed work, not created files.

Spawn and link records are data, not mesh assets. Counts refer to plotted groups / assemblies, not a final tile procurement count. CP pads are trigger volumes above the deck with several respawn positions, not narrow checkpoint arches.

| Zone | Drawn element / count | ID | Exists or NEW | Role group | Proposed collider kind | Size / motion envelope (m) | Drawn behaviour |
|---|---|---|---|---|---|---|---|
| 1 | Spiral ramp × 1 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z01/floor` | cuboid segments | 53.0 long × 12 wide × 0.7 | Continuous ascending deck; 12 m width in this section. |
| 2 | Spiral ramp × 1 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z02/floor` | cuboid segments | 96.0 long × 10 wide × 0.7 | Continuous ascending deck; 10 m width in this section. |
| 3 | Spiral ramp × 1 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z03/floor` | cuboid segments | 96.0 long × 10 wide × 0.7 | Continuous ascending deck; 10 m width in this section. |
| 4 | Spiral ramp × 2 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z04/floor` | cuboid segments | 80.0 long × 10 wide × 0.7; 80.0 long × 8 wide × 0.7 | Continuous ascending deck; 10 m width in this section. / Continuous ascending deck; 8 m width in this section. |
| 5 | Spiral ramp × 1 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z05/floor` | cuboid segments | 64.0 long × 8 wide × 0.7 | Continuous ascending deck; 8 m width in this section. |
| 6 | Spiral ramp × 2 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z06/floor` | cuboid segments | 64.0 long × 8 wide × 0.7; 48.0 long × 8 wide × 0.7 | Continuous ascending deck; 8 m width in this section. |
| 7 | Spiral ramp × 5 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z07/floor` | cuboid segments | 48.0 long × 6 wide × 0.7; 32.0 long × 6 wide × 0.7; 16.0 long × 6 wide × 0.7 | Continuous ascending deck; 6 m width in this section. |
| 1 | Start apron × 1 | `candy.floor-tile` | EXISTS — resize / configure | `D-spiral-pyramid/Z01/floor` | cuboid segments | 24 × 16 × 1 | 24 × 16 m; feeds the 12 m first ramp. |
| 1 | Start grid × 60 | `course.spawn` | EXISTS — course data | `D-spiral-pyramid/Z01/spawn` | none (spawn record) | Ø0.8 × 1.7 | 60 spots; 1.6 × 1.8 m centres. |
| 1 | CP0 × 1 | `plan.respawn-pad` | NEW | `D-spiral-pyramid/Z01/cp` | sensor cuboid | 4 × 12 × 3 | Respawn here after a fall; 3 s penalty. |
| 2 | Outer hammers × 2 | `candy.pendulum-hammer` | EXISTS — resize / configure | `D-spiral-pyramid/Z02/hammer` | kinematic cuboids | Ø8 × 6 sweep envelope | 4 m sweep; 3 m inner passing edge. 4 s / 5 s cycles. |
| 3 | Hollow bay H1 × 1 | `plan.fall-volume` | NEW | `D-spiral-pyramid/Z03/gap` | sensor below deck; no floor | 12 × 6 × 4 | 12 m long void; remaining 4 m inner ledge is walkable. |
| 3 | H1 inner ledge × 1 | `plan.ramp-deck` | NEW | `D-spiral-pyramid/Z03/bridge` | convex hull segments | 20.0 long × 4 wide × 0.6 | 4 m wide. Hollow cannot be jumped lengthwise. |
| 3 | CP1 × 1 | `plan.respawn-pad` | NEW | `D-spiral-pyramid/Z03/cp` | sensor cuboid | 5 × 10 × 3 | Respawn here after a fall; 3 s penalty. |
| 4 | West pushers × 2 | `neon.piston-block` | EXISTS — resize / configure | `D-spiral-pyramid/Z04/piston` | kinematic roundCuboid | 4 × 3 × 2.25 | 3 m lateral stroke; 3 m shoulder during extension. |
| 4 | Reverse conveyor × 1 | `candy.conveyor-belt` | EXISTS — resize / configure | `D-spiral-pyramid/Z04/conveyor` | cuboid + surface velocity | 14 × 4 × 0.5 | Opposes ascent at 2 m/s; 4 m normal passing strip. |
| 4 | CP2 × 1 | `plan.respawn-pad` | NEW | `D-spiral-pyramid/Z04/cp` | sensor cuboid | 4 × 8 × 3 | Respawn here after a fall; 3 s penalty. |
| 5 | Trap staircase × 3 | `plan.trap-tile` | NEW | `D-spiral-pyramid/Z05/trap` | kinematic cuboid + sensor | 8 × 4 × 0.3 | Whole width; 1 s warning, then opens for 2 s. Routes below catch falls. |
| 6 | Hollow bay H2 × 1 | `plan.fall-volume` | NEW | `D-spiral-pyramid/Z06/gap` | sensor below deck; no floor | 12 × 4 × 4 | 12 m long cutout; 4 m lower-edge ledge remains. |
| 6 | H2 inner ledge × 1 | `plan.ramp-deck` | NEW | `D-spiral-pyramid/Z06/bridge` | convex hull segments | 20.0 long × 4 wide × 0.6 | 4 m passing ledge; two beans comfortably side-by-side. |
| 6 | Upper seesaw × 1 | `candy.mech-seesaw` | EXISTS — resize / configure | `D-spiral-pyramid/Z06/seesaw` | dynamic roundCuboid + hinge | 6 × 14 × 0.4 | ±3° tilt; end excursion 0.37 m. 2 m total side shoulder. |
| 6 | CP3 × 1 | `plan.respawn-pad` | NEW | `D-spiral-pyramid/Z06/cp` | sensor cuboid | 8 × 4 × 3 | Respawn here after a fall; 3 s penalty. |
| 7 | Crown sweepers × 2 | `candy.spinner-bar` | EXISTS — resize / configure | `D-spiral-pyramid/Z07/spinner` | kinematic cuboids | Ø5 × 0.5 sweep envelope | 5 m diameter; jump 0.5 m bar or wait for opening. |
| 7 | Crown jump × 1 | `plan.fall-volume` | NEW | `D-spiral-pyramid/Z07/gap` | sensor below deck; no floor | 3 × 6 × 4 | 3 m gap, +0.10 m rise; 9 m approach + 8 m landing. |
| 7 | Crown finish × 1 | `plan.crown-finish` | NEW | `D-spiral-pyramid/Z07/finish` | cuboid platform + sensor | 12 × 12 × 0.7 | 12 × 12 m at +24 m; CP2 required, CP3 optional via UP2. |
| 8 | Catch chute × 5 | `plan.catch-chute` | NEW | `D-spiral-pyramid/Z08/catch` | convex hull segments | 98.0 long × 3 wide × 0.5; 16.0 long × 3 wide × 0.5; 14.0 long × 3 wide × 0.5 | H1 → base; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T1 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T2 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T3 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / H2 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. |
| 8 | Catch landing × 5 | `plan.catch-chute` | NEW | `D-spiral-pyramid/Z08/catch` | convex hull segments | Ø4 × 0.5 | Ø4 m, on lower ramp. Roll out toward uphill flow. |
| 8 | Shortcut pad × 2 | `candy.bounce-pad` | EXISTS — resize / configure | `D-spiral-pyramid/Z08/bounce` | cylinder + launch sensor | Ø3 × 0.3 | UP1: RECOVERY ONLY after saving CP2 and then falling. Target 16 m away / +12.2 m; launch (horizontal 8, vertical 26.1) m/s (NEW). / UP2: Target 16 m away / +6.9 m; launch (horizontal 8, vertical 23.4) m/s (NEW). |
| 8 | Shortcut landing × 2 | `plan.launch-target` | NEW | `D-spiral-pyramid/Z08/bounce` | cylinder + launch sensor | Ø5 × 0.5 | UP1: Ø5 m receiving deck; missed shot falls to catch or CP. / UP2: Ø5 m receiving deck; missed shot falls to catch or CP. |
| 8 | Launch trajectory × 2 | `plan.directed-launch` | NEW | `D-spiral-pyramid/Z08/link` | none (logic record) | 16.0 long × 0.2 wide × 0 | UP1: directed launch, not a walkable bridge. / UP2: directed launch, not a walkable bridge. |

## Numbered zones

1. **Apron & first turn.** Spiral ramp: Continuous ascending deck; 12 m width in this section. Start apron: 24 × 16 m; feeds the 12 m first ramp. Start grid: 60 spots; 1.6 × 1.8 m centres. CP0: Respawn here after a fall; 3 s penalty.
2. **Hammer edge.** Spiral ramp: Continuous ascending deck; 10 m width in this section. Outer hammers: 4 m sweep; 3 m inner passing edge. 4 s / 5 s cycles.
3. **Hollow gallery.** Spiral ramp: Continuous ascending deck; 10 m width in this section. Hollow bay H1: 12 m long void; remaining 4 m inner ledge is walkable. H1 inner ledge: 4 m wide. Hollow cannot be jumped lengthwise. CP1: Respawn here after a fall; 3 s penalty.
4. **Piston turn.** Spiral ramp: Continuous ascending deck; 10 m width in this section. / Continuous ascending deck; 8 m width in this section. West pushers: 3 m lateral stroke; 3 m shoulder during extension. Reverse conveyor: Opposes ascent at 2 m/s; 4 m normal passing strip. CP2: Respawn here after a fall; 3 s penalty.
5. **Tile switchback.** Spiral ramp: Continuous ascending deck; 8 m width in this section. Trap staircase: Whole width; 1 s warning, then opens for 2 s. Routes below catch falls.
6. **Balance ledge.** Spiral ramp: Continuous ascending deck; 8 m width in this section. Hollow bay H2: 12 m long cutout; 4 m lower-edge ledge remains. H2 inner ledge: 4 m passing ledge; two beans comfortably side-by-side. Upper seesaw: ±3° tilt; end excursion 0.37 m. 2 m total side shoulder. CP3: Respawn here after a fall; 3 s penalty.
7. **Crown approach.** Spiral ramp: Continuous ascending deck; 6 m width in this section. Crown sweepers: 5 m diameter; jump 0.5 m bar or wait for opening. Crown jump: 3 m gap, +0.10 m rise; 9 m approach + 8 m landing. Crown finish: 12 × 12 m at +24 m; CP2 required, CP3 optional via UP2.
8. **Up / down links.** Catch chute: H1 → base; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T1 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T2 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / T3 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. / H2 → outer; lower enclosed chute, no elimination. Re-enter lower ramp; latest CP kept for out-of-bounds. Catch landing: Ø4 m, on lower ramp. Roll out toward uphill flow. Shortcut pad: UP1: RECOVERY ONLY after saving CP2 and then falling. Target 16 m away / +12.2 m; launch (horizontal 8, vertical 26.1) m/s (NEW). / UP2: Target 16 m away / +6.9 m; launch (horizontal 8, vertical 23.4) m/s (NEW). Shortcut landing: UP1: Ø5 m receiving deck; missed shot falls to catch or CP. / UP2: Ø5 m receiving deck; missed shot falls to catch or CP. Launch trajectory: UP1: directed launch, not a walkable bridge. / UP2: directed launch, not a walkable bridge.

## Route estimates

Distances are calculated from the same sampled centrelines used by the drawing. They are horizontal path lengths; elevation profiles state the rise separately. Times use distance / assumed effective speed + a stated allowance for crowding and mechanisms. They are design estimates, not a claim about tested gameplay. A non-elimination fall additionally costs backtracking + the 3 s respawn delay; elimination maps instead use their explicit OUT rule.

| Route | Distance | Effective speed | Obstacle / queue allowance | Estimated time |
|---|---:|---:|---:|---:|
| Full spiral | 725.0 m | 6.8 m/s | 12–26 s | 119–133 s |
| Upper cut only | 533.0 m | 6.8 m/s | 17–31 s | 95–109 s |

Race: 150 s cap; first N qualify. Chutes return beans downhill; out-of-bounds = latest CP + 3 s. No death.

## Source audit

Verified against `packages/sim/src/character/constants.ts`, `packages/sim/src/world.ts`, asset collision manifests and real course references. `EXISTS` means the ID exists, not that the redesigned level or all its rules are implemented.

- `candy.bounce-pad`: `assets/candy/candy.bounce-pad.asset.json`; current collider kinds: cylinder; examples: hub-plaza.course.json, obstacle-gallery.course.json, race-bean-dash.course.json.
- `candy.conveyor-belt`: `assets/candy/candy.conveyor-belt.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-sprint.course.json.
- `candy.floor-tile`: `assets/candy/candy.floor-tile.asset.json`; current collider kinds: cuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json, obstacle-gallery.course.json.
- `candy.mech-seesaw`: `assets/candy/candy.mech-seesaw.asset.json`; current collider kinds: roundCuboid; examples: candy-seesaw-run.course.json, mech-lab.course.json.
- `candy.pendulum-hammer`: `assets/candy/candy.pendulum-hammer.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `candy.spinner-bar`: `assets/candy/candy.spinner-bar.asset.json`; current collider kinds: cuboid; examples: obstacle-gallery.course.json, race-bean-dash.course.json, race-hammer-hill.course.json.
- `neon.piston-block`: `assets/neon/neon.piston-block.asset.json`; current collider kinds: roundCuboid; examples: neon-piston-alley.course.json.

## Behaviour and authoring work

- Every role group above exposes friction / surface, dimensions, motion speed and period, enabled state and links in the Level panel. Checkpoints expose stage, spawn spread and penalty. No values are intended to be hardcoded.


Local behaviour work: Recovery and respawn timing are proposed course rules. NEW: warning, delayed drop and reset policy for the drawn trap tiles. NEW: lower catch chutes and directed launches; the UP1 recovery permission checks saved CP2 and a subsequent fall.

## Owner decisions

- Approve UP1 as recovery-only: CP2 must already be saved, then the bean must fall? UP2 remains available to all.
- Approve physical lower chutes plus CP respawn only for out-of-bounds falls?
