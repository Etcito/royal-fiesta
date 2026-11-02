Run from this clone, with Node 24 and no GPU or servers:

```sh
node --import ./scripts/bots/local-imports.mjs --experimental-strip-types scripts/bots/measure.ts > after.json
node --import ./scripts/bots/local-imports.mjs --experimental-strip-types --test packages/game/test/courseBots.test.ts packages/game/test/modeBots.test.ts packages/sim/test/bots.test.ts
```

`local-imports.mjs` resolves workspace imports into this clone. This matters when
node_modules is a symlink to another checkout: otherwise tests silently exercise
that checkout's packages.

The measurement runs eight bots on every playable course using the show's
FiestaDomain, modeBotInput, real asset collisions, mechanisms and features. It
records parking and catch-volume teleportation before poses are overwritten.
Each event includes bot id, tick (60 Hz), reason, position, waypoint cursor and
feature target. Survival modes have no finish slab. Crown completion is a crown
event, separate from finish-slab qualification. Remaining live racers at the
course cap timed out; their end poses/cursors are retained. Hazard knockbacks
ending below the plane are classified by the terminal kill plane, not guessed
from the earlier contact.

All bots share one physics domain to measure controller/geometry behavior;
network repartitioning is outside this harness. Domain schedule seed is zero,
spawn assignment is seats 0..7, and controllers do not consume random input.
`BOT_COURSES=id,id` selects courses. `BOT_DEBUG=1` prints the final controller cache. `BOT_TRACE=1` (through `8`)
prints that seat’s pose, velocity, input, route cursor and feature target every
30 ticks to stderr for crossing diagnostics.

For baseline comparison, capture HEAD's source into a temporary directory:

```sh
mkdir -p /tmp/bot-baseline
for name in modeBots takeoverBot; do
  git show HEAD:packages/game/src/net/$name.ts > /tmp/bot-baseline/$name.ts
done
for name in brain courseRead routes crossing; do
  git show HEAD:packages/sim/src/bots/$name.ts > /tmp/bot-baseline/$name.ts
done
BOT_BASELINE=/tmp/bot-baseline node --import ./scripts/bots/local-imports.mjs --experimental-strip-types scripts/bots/measure.ts > ../before.json
```

This reads Git only. No checkout, reset, index write, live-repo edit or server
restart is needed. The baseline loader substitutes source at its original URL,
so relative imports and the course/asset data stay identical.

For isolated crossing diagnostics (one character, settled on the actual support):

```sh
node --import ./scripts/bots/local-imports.mjs --experimental-strip-types scripts/bots/probe-crossings.ts
```

This sweeps starting positions and jump/dive timing at Tidal's first ramp and
Hammer Hill's finish. It reports attempts, crossings, and the highest capsule
centre reached. These selected trajectories are not an exhaustive reachability
proof: Tidal's reverse ramp admits narrow side-entry and exit jumps that this
simple sweep does not implement. A successful probe is also not a full-course
finish. Keep the full eight-seat measurement as the acceptance check.
