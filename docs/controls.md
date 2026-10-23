# Controls

These are the controls of the player pages: game.html, and the online room page that comes with the wavedash port.
Keys are matched by physical key (`KeyboardEvent.code`), so the same keys work on QWERTY and AZERTY layouts.

This file is ported from the V0 M14 controls doc. The V0 text described a mirrored camera: mouse-right and
right-stick-right turned the view left, and the keyboard right vector was (fz, 0, -fx). The handedness rule
below replaces it (ARCHITECTURE 1.6).

## Handedness rule

RAA and the game view are right-handed, as in raa-math `look_at_rh`. For a camera forward f = (fx, 0, fz) on the
ground, screen-right is

    r = (-fz, 0, fx)

Looking along +Z, screen-right is **-X**.

- Only `packages/game/src/client/cameraBasis.ts` computes r (`cameraBasis`, `basisFromFacing`). Every keyboard,
  gamepad, mouse and camera path uses it; no copy exists elsewhere.
- Move input right (D, ArrowRight, left stick x > 0) moves the character toward r, to the right of the screen.
  `stickToWorld(x, y, basis)` = r·x + f·y.
- Positive horizontal look input (mouse dx > 0 under pointer lock, right stick x > 0) turns the view right: the
  forward rotates toward the current r (`yawTurn(f, amount > 0)`).
- The orbit camera keeps the sim's yaw convention (forward = (sin yaw, cos yaw), yaw 0 faces +Z). Because r is
  -(df/dyaw), a right turn lowers the yaw. The camera never applies that sign itself: every turn goes through
  `yawTurn`.

## Move

| Direction | Keys (defaults, rebindable) | Also always active |
| --- | --- | --- |
| Forward | W (`KeyW`) | `ArrowUp` |
| Back | S (`KeyS`) | `ArrowDown` |
| Left | A (`KeyA`) | `ArrowLeft` |
| Right | D (`KeyD`) | `ArrowRight` |

- ZQSD also works: `KeyZ` is forward and `KeyQ` is left, unless the player has rebound another action onto that
  key. `KeyS` and `KeyD` are shared by both layouts.
- Gamepad (standard mapping), left stick: stick x = `axes[0]`, stick y = `-axes[1]` (the pad reports up as
  negative, so pushing up gives forward). Dead zone 0.15 per axis. A centred stick leaves keyboard movement in
  effect.
- Movement is camera-relative: the (x, y) move goes through `stickToWorld` with the orbit camera's basis, then
  into the world-space PlayerInput.
- Typing in a text field never moves the character.

## Actions

| Action | Keyboard (default, rebindable) | Gamepad (standard mapping) |
| --- | --- | --- |
| Jump | Space | button 0 |
| Dive | Shift (`ShiftLeft`) | button 1 |
| Grab | E (`KeyE`) | button 2 |
| Emotes 1-4 | Digit1 to Digit4 (not rebindable) | - |
| Pause / menu | Esc (not rebindable) | Start (button 9) |

On menus, gamepad button 0 also selects.

## Camera

Third-person orbit camera (`packages/game/src/render/orbitCamera.ts`). Its yaw and pitch are local to the
client.

- Mouse, with pointer lock: click on the game to lock the pointer; Esc releases it (the browser does this). Only
  the deltas of a locked pointer turn the camera. mouse dx > 0 turns the view right; mouse up looks up.
- Gamepad right stick: x = `axes[2]`, y = `axes[3]`, dead zone 0.15. Stick right turns the view right; stick up
  (negative `axes[3]`) looks up.
- Invert Y (setting, default off) flips the vertical look of both the mouse and the right stick. Nothing inverts
  the horizontal look.
- If pointer lock does not work in the Wavedash frame, the mouse camera does not work there and there is NO
  fallback (owner decision: no drag-to-orbit); the right stick still turns the camera.

### Values the code uses

| Value | Constant | Number |
| --- | --- | --- |
| Mouse sensitivity | `MOUSE_RAD_PER_PX` | 0.0005 rad per pixel per step; setting 1-10, default 5 (0.0025 rad/px) |
| Stick sensitivity | `STICK_RAD_S` | 0.6 rad/s per step at full tilt; setting 1-10, default 5 (3 rad/s) |
| Stick dead zone | `STICK_DEADZONE` | 0.15 |
| Pitch limits | `PITCH_MIN`, `PITCH_MAX` | -0.25 rad to 1.2 rad (clamped); yaw is free and wraps to (-π, π] |
| Default pitch | `DEFAULT_PITCH` | atan2(2.8, 7) ≈ 0.38 rad |
| Distance | `ORBIT_DISTANCE` | sqrt(7² + 2.8²) ≈ 7.54 m from eye to target |
| Target height | `TARGET_HEIGHT` | 1.2 m above the character |
| Lens | pose | vertical FOV 60°, near 0.1, far 500 |

There is no smoothing: the pose follows the yaw and pitch directly. At the default pitch the pose equals the
proof pages' `followCamera` (eye 7 m behind and 2.8 m above the target).

## Settings rows

Stored in localStorage under `royal-fiesta.settings` (an opaque-origin frame without localStorage uses the
defaults in memory):

- Mouse sensitivity, 1-10, default 5.
- Stick sensitivity, 1-10, default 5.
- Invert Y, default off.
- Key rebinding for forward, back, left, right, jump, dive and grab. Esc, Enter and Digit1-4 are reserved; a key
  already bound to another action is refused with a message.

## Esc in the online room

On the online room page an Esc keydown leaves the session, except when that Esc only released the pointer lock:
if the pointer was locked at keydown, or the lock was released within the last 150 ms (`UNLOCK_ESC_MS`), the room
stays. A later Esc leaves as before.

## Rollback note

The camera yaw is local to each client and never enters the sim or the snapshot. It rotates the move vector from
camera space to world space before the input is quantised (S1), so peers receive only the world-space move plus
buttons; determinism and the rollback proofs are unchanged.

## Testing

- `packages/game/test/cameraBasis.test.ts`: for 8 yaws, player + r projects right of the player through a CPU
  `look_at_rh` + perspective.
- `packages/game/test/orbitCamera.test.ts`: camera-relative moves, pitch clamps, and for 8 start yaws one positive
  mouse or right-stick step turns the forward toward the old r and moves a centred world marker to screen-left.
- The gamepad is tested by unit test only: CDP cannot fake a gamepad.
