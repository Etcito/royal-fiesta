The playable game is `apps/web/game.html`. Navigation is the state machine in `packages/game/src/screens/nav.ts`. Escape always goes back, except on the loading screen. Errors are shown on the error screen, never only in the console.

| id | Screen | Reached by (UI) | Leave with | What it does |
|---|---|---|---|---|
| `title` | Title / main menu | A finished load; Escape from credits, settings, or error | Play (goes to the start screen), Play online, Settings, Credits (a build with a baked relay, VITE_RF_SERVER, has no separate Play online) | Play goes to the start screen; Play online, Settings and Credits open their screens. |
| `start` | Start menu | Play on title | Play to the lobby (or online in a baked-relay build), Shop (M9), Escape back to title | The pre-game menu: the own penguin with its worn cosmetics, 3 bins of OWNED items only, the palette, the inbox badge and the candy background. |
| `hub` | Lobby hub | Play on start | Nothing to press: the round starts by itself. WASD to walk, 1–4 to emote; Escape opens pause | A walkable 3D plaza. Offline: the lobby starts the zone show (vote → load → countdown → round → …); `?course=` keeps the single V1 match; a `?wait=` countdown (default 60 s) starts it, and Enter or the green pad start it early. Online: the hub enters a GameSaloon lobby by itself and shows its countdown and players (or the round being spectated) in the overlay; the server starts the round when its wait ends, with whoever is there plus bots. |
| `queue` | Matchmaking queue | Queue from the hub (in-page piloted clients and the exact-size queue only) | Escape cancels back to the hub | Shows players found n/8. |
| `lobbyChoice` | A lobby is open | Online, arriving while a lobby waits for players | No longer shown (the player is put in a lobby at once); kept in the navigation model for older servers. Was: Join this lobby, Spectate, New lobby | Shows the lobby's players, its countdown and the time left before the default. |
| `lobbyLive` | A round is on | Online, arriving while a lobby's round is played | No longer shown (a played lobby is never joined; the player lands in a new lobby; spectating is an explicit `spectate: true` request). Was: Spectate, New lobby | Spectating keeps the walkable hub with the round's players and status in the overlay; when that round ends the hub enters a lobby again. |
| `countdown` | Round intro | Match starts | Countdown completes to the round | Shows 3-2-1-GO and the round name; 3-2-1-GO runs only with the world loaded (the show holds the match while the level loads). |
| `round` | In-round HUD | Countdown completes | Round ends or player is eliminated | Shows round type, timer, qualified count, and alive count. |
| `vote` | Vote for the next round | A vote game event after a round | Arrows or the pad pick a candidate, Confirm votes; Escape pauses | The next round in the offline show: shows the three candidates and the vote cursor for 5 s; one click confirms and there is no cancel. The winning level loads in the background. |
| `spectate` | Spectating | You are eliminated | Round ends | Shows an ELIMINATED banner; camera follows a live bean and displays its name. |
| `elimShow` | Eliminated | An elimination game event, after the results | The show advances by itself; Enter skips after 1.5 s; Escape pauses | Shows which characters are eliminated this round, with a drop sound per character. Runs 6–8 s; reduced motion fades instead of throwing. |
| `result` | Round result | Round ends | Next round or final result | Lists qualified and eliminated beans with the round points and the show totals. |
| `podium` | Podium | Match ends; reused at the show end | Enter or Escape to hub; also returns by itself after 12 s | Shows the top 3 beans standing on a 3D podium, with their names. |
| `endScreen` | Champion | The podium of the final moves to the end screen | Continue or Escape leaves the game for the start screen | Shows the winner for 4 s with gold/silver/bronze crowns and the golden ticket. |
| `settings` | Settings | Title or pause | Escape returns to where you came from | Lets you rebind keys and adjust volume and quality. |
| `pause` | Pause | Escape in the hub or a match | Resume, Settings, Leave; Escape resumes | Leave goes from a match to the hub, or from the hub to title. |
| `error` | Disconnected / error | For example, Play online when the relay is unreachable, or a failed load | Retry, Back to title; Escape goes to title | Shows the error message. |
| `credits` | Credits | Credits on title | Escape goes back to title | Shows who made the game and the open-source bricks. |
| `loading` | Loading | Page load (or Retry after a failed load) | Only when the load ends: to the next screen, or to `error` | Shows the latest load progress: phase, done/total and label. |

## Show flow

The offline show runs in this order:

`start` → `hub` (lobby) → `vote` → load → `countdown` → `round` → `result` → `elimShow` → next `vote` … → `podium` → `endScreen` → `start`.

The vote picks the next level; that level loads while the vote is up, and the match is held (frozen) until the world is ready and 3-2-1-GO runs. Results, `elimShow`, the podium and the end screen hold it too.

Keyboard and gamepad: arrows / d-pad / stick move, Enter / A confirm, Esc / Start pause.

## Loading

The `loading` screen is shown while `GameContent.load` (packages/game/src/content.ts) runs. Its events:

| Event | Valid on | Result |
|---|---|---|
| `{kind: 'load', next}` | `title` or `error`, with no game running | Screen `loading`, `progress` = null, `loadNext` = next (`'title'` or `'hub'`); returns the `load` effect: the app calls `GameContent.load(profile, onProgress)`. |
| `{kind: 'progress', progress}` | `loading` | `nav.progress` = a copy of the latest `LoadProgress`; the screen stays `loading`. The menu line is `progressLine(nav.progress)` (`<phase> <done>/<total> <label>`). |
| `{kind: 'loaded'}` | `loading` | The load succeeded: `next` = `'title'` goes to the title menu; `'hub'` starts the hub (returns `startHub`). |
| `{kind: 'error', message}` | any | The load failed: screen `error` with the refusal message unchanged in `nav.error`. |

No silent skip:
- on `loading`, back, every action, game events and another `load` are ignored, and the screen has no button;
- `progress` and `loaded` do nothing outside `loading`, so a late report cannot change another screen;
- after a failed load, `contentReady()` is false and the title offers Retry, Settings and Credits but no Play. Retry, on the error screen or the title, enters `loading` again with the same `next`.
