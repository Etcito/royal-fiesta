# Card 8951 · M5 race captures

## Review evidence

Render 16236 produced the five rows on Royal Fiesta `9729d62040fc001c6cc10fa5fa8f14d4df39b24a`. Execution 16240's render step reported `kept 5, rendering 0`. Its selection, per-row result and PNG basenames identify the images submitted to the judge. The Sugar Sprint PNG is present in both render archives, including the 16240 copy. That resolves the missing image reported in the earlier review. The 16252 verdicts came from a different build, `f4a4bed12fd5`, still using the original capture ticks. Neither judge run evaluated the landed `e451777d6b7016d11062504bffbaca1e78291446`.

All five original criteria, medians, panel scores and complete observations are attached. The only shortening is the host directory preceding each PNG basename. The minimum is 6 throughout. [Judge 16240](16240-verdicts.txt)

| Inventory row | PNG from render 16236, reused in 16240 | Score | Focus and tick judged |
| --- | --- | ---: | --- |
| m5-sugar-sprint-door-bank | engine-round-sugar-sprint-door-bank-doors-standing-across-lane.png | 4 | doors-west, 600 |
| m5-diamond-citadel-rolling-logs | engine-round-diamond-citadel-logs-rolling-down-slope.png | 5 | rolling-log-1, 400 |
| m5-butterfly-boost-lane | engine-round-butterfly-freeway-boost-lane-strip-on-track.png | 3 | boost-shared, 600 |
| m5-spiral-launch-pad | engine-round-spiral-launch-pad-and-tile-field.png | 4 | launchpad-1, 600 |
| m5-yard-a-swim-marker | engine-round-yard-swim-pool-and-marker-disc.png | 2 | yard-pool, 400 |

## Source and capture state

All five runs used sprint, seed 7, eight live seats and one viewport. The camera in `packages/game/src/ege/sceneSim.ts` looks along +Z from 14 m behind and 9 m above the selected feature. The page, runner facts and inventory checker now resolve both a feature kind and an exact instance through the same function. The optional inventory run path supplies ordinary controller inputs to seat zero. The round starts at its course spawn and the seven bots use the existing brain.

- **Sugar Sprint.** The PNG shows runners pressed against intact panels. The root reported zero changed visuals at 600. The straight input left seat zero at x −15.2, z 59.10, outside the breakable west panel centred at x −9.1. The bots approached the solid centre panels. The recovered pair supports steering seat zero through the west opening. At 600 the west door at (−9.1, 1.5, 60) is open and seat zero is beyond it at z 65.10. Decision 7556's restored seed, tick, criterion and held constants are retained.
- **Diamond Citadel.** At 400 the log had moved, seat zero was parked at (0, −500, 0), and the distant figures were too small to identify. The 16242 repair moved the capture to 950. Its measurements still put the bots about 47–50 m away because the bot path runs along the centre route while the logs cross the lower branch. Seat zero's original +Z input also ran off the start. The revised input turns at the split onto the authored lower track. At 950 the runner is at (82.77, 0.85, −43.00), moving at (5.73, 0, −5.54) m/s, 5.64 m horizontally from the moving ten-metre log. The original rolling-towards-runners criterion and motion check apply.
- **Butterfly Freeway.** At 600 the local runner was at z 71.42 while the lane was centred at z 108.095. The earlier change to 885 catches the crossing. The purple block in the image came from rendering the entire 6 × 2 × 6 m trigger as a conveyor. The placed belt now uses the conveyor asset's 0.25 m collider half-height and carries the active tint on its centre stripe. At 885 seats 2, 3 and 6 are boosted over the belt, moving at about 9.6 m/s. The trigger, acceleration, duration and cooldown retain their course values.
- **Spiral of Mischief.** At 600 the first pad was visible, seat zero was parked, and the judge could not distinguish a tile field. The earlier 250-tick frame brought bots to the first pad, but the inventory then excluded the tiles from scoring. The first pad is at (0, 0.8, 0). The course puts the tiles at x 23, z 36, 52 and 68 on an elevated section. The camera now follows the second pad at (22, 15.25, 60). Seat zero runs up the course to (21.997, 15.796, 59.739) at 3636, directly over the disc between the tiles. The tile field is again scored. A focused regression test exercises this row using the engine and its actual player inputs.
- **Yard A.** The original pool camera missed the marker. The landed repair focuses the marker at 261 and identifies the apparent blue channel as the candy-blue pad with a yellow rim of `yard-floor-a` in `fixtures/ege/ege-yard-a.course.json` and `assets/candy/candy.floor-tile.asset.json`. The pale-green pool is the separate swim-volume draw in `packages/game/src/ege/features/swimVolume.ts`. These fixture details remain in the held constants. Driving seat zero to the marker keeps it touched while the bots swim. At 261 the marker has one touch and seats 2, 5, 6 and 7 have the swimming flag. The active marker uses the touch tint from `scripts/ege/features/marker.as.ts`.

Each original verdict identifies a missing action, actor, view or feature shape. In particular, the uncertain identity of Diamond's distant figures accompanies a framing and route discrepancy. No original image qualifies for an identity-only rejudge. Card 8900 owns the five fresh GPU images at the corrected revision. Card 8901 remains on operator hold.

## Recovered test output

Both broad comparisons used `node --experimental-strip-types --test 'apps/web/test/*.test.ts'` in place, with the same dependency links and sibling locations. The execution events preserve the actual runner summaries, failing names and set comparisons. The intermediate out-of-tree copy from 16248 had different module and sibling resolution and was discarded. The pre-repair tree and the later addendum's starting tree are listed separately.

| Execution and source | Test | Exit | Total | Passed | Failed |
| --- | --- | ---: | ---: | ---: | ---: |
| 16248, original pre-repair 9729d62040fc001c6cc10fa5fa8f14d4df39b24a | broad | 1 | 500 | 490 | 10 |
| 16253, pre-addendum f55a6d0e4f950dcf1dfa80629a55f955512e2082 | broad | 1 | 500 | 490 | 10 |
| 16248 and 16253, corrected contents of 0866389546c6708d3c5e3fad4f7bf009b3ee9509 | broad | 1 | 500 | 490 | 10 |
| 16248 and 16253, same corrected contents | focused capture test | 0 | 9 | 9 | 0 |

Execution 16253 ran the corrected broad command again after it had restored the corrected inventory. Its tool result 53 compares that run to the saved pre-addendum output. Execution 16248's result 106 compares the original pre-repair source in the same worktree to the corrected run. In both comparisons zero names appeared and zero disappeared. All ten full names are in the attachments. The runner's “failing tests” heading is excluded from the count. The focused invocation was `node --experimental-strip-types --test tools/test/engineRoundCapture.test.ts`. [Execution 16253 runner output](16253-runner.txt) · [Execution 16248 runner output](16248-runner.txt)
