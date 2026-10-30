# Pass 2 review — 31 October 2026

Planning review only. All 18 PNGs were opened and visually inspected. Changed sheets were rendered again with the requested Chromium flags and inspected again. This is not a gameplay or 60-player simulation result.

| Sheets | Review / corrections |
|---|---|
| A, B, C1, C2, D | Retained the pitch, butterfly slide, diamond routes, alternating rings and continuous spiral. Checked scales, labels, profiles and jump notes. Season quotas resolve their original N-open labels; A's tournament tie override is explicit in README. |
| E | Added actual wall infill between real/fake door panels; corrected the legend to distinguish these from linked mechanism doors. Three independent door banks remain. |
| F | Checkpoint outlines expose both shortcut gaps; side gates cover outer and inner routes. Added lap arrows and seesaw tilt profile. |
| G | Shortcuts now genuinely save 30 m per gallery. Added direction arrows, separated final/CP labels and documented the stacked world coordinates and height-gated exits. |
| H | Spread 60 starts across the field. Replaced implausibly rapid full-lobby contact depletion with warned removal waves, slowing when only 20 tiles remain. |
| I | Checked all three 127-cell layers, 60 starts and the 6 m descent section. Moved the timer clear of the zone badge; contact lifetime scales with entry count. |
| J | Removed static support underneath the sinking upper crosswalks. Corrected the transfer route to stay on the drawn ramps/terraces. |
| K | Drew both low/high bars and their floating cross sections with actual clearances. Laser gaps, block openings and four ring transfers are visible. |
| L | Mirrored conveyor directions so neither team receives a directional advantage. Corrected centre-opening width and one-sweet steal scoring. |
| M | Ground rotation passes below the flat high deck, with 2.3 m clearance; it no longer intersects a low ramp. |
| N | High-cache route goes out and back on real spurs; no imaginary bridge between their ends. High-deck failure and ground traversal are distinguished. |
| O | Moved all starts clear of juke walls; drew all 30 initial tail assignments. Outlined HOME triggers retain visible starts; loop belts now support the loop direction. |
| P | Closed the unintended start-bank gap, drew three HOME/cohort pads and balanced personal goals. The example detour fits the 14 s crossing allowance; a fall never restarts the shared clock. |
| Q | Kept three climb choices; corrected shoulder-width wording and drew a grid with enough equal-front-row positions for six finalists. Crown grab is distinct from C2/D's ordinary finish pads. |

Generator checks passed: 60 spawn records per map, populated zone/feature links, valid route estimates and preserved spiral topology. An additional geometry check found no new-map spawn/wall overlaps; minimum new-map spawn separation is at least 1.6 m. SVG text bounding boxes stayed inside all 18 sheets. All 18 SVG/PNG pairs and matching needs tables exist; PNG dimensions match each SVG width and height +90 px. Regenerating the SVGs, needs tables and README produced byte-identical text.

Asset existence and course references were checked read-only in `<repo>`. Rendering logs and temporary review scripts are confined to `<scratch>/`. No game repository edits, asset builds, commits, pushes or recursive removals were performed.

Unresolved by drawings: crowd flow, physics feel, hazard fairness and actual round durations require later implementation/play. In particular, I exceeds the current independent-obstacle budget, K needs safe composed patterns and ring carry, and B needs a new belly controller. The owner decisions in README remain proposals.
