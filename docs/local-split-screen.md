# Local split screen

`game.html?players=2` reserves two LOCAL human seats in the in-page game. `?local=2` is an alias; `players` wins when both are present. Integers 1..4 are accepted; other values produce a console refusal.

Use `game.html?course=s1-c1-diamond-citadel&players=4` to open a course with four viewports following four different penguins. Add `&bots=12` to use the offline show with twelve penguins total (four humans and eight bots). The total roster must include every human. Without `bots`, course rounds keep their existing eight-penguin roster.

No join presses are required. Seat k uses the k-th connected gamepad in browser order. P1 uses the keyboard when no pad is connected; remaining empty seats stay human and wait for pads. Connecting/disconnecting pads refreshes this ordinal assignment. Without `players`/`local`, the first device used claims P1 even when the course already started; later seats still join in the hub with Start.

`clients` means separate network clients/canvases, and `party` configures network party size. Neither is a synonym for local humans.
