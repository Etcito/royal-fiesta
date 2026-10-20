# GameSaloon gaps

What Royal Fiesta works around. GameSaloon is read-only for this project; each section says what could be added in GameSaloon's own chain.

## Relay 4-seat cap
- Game today: relay matches take 2-4 humans. `RelayClient.queue/create/join` refuse other counts (`RELAY_MAX_PLAYERS = 4`); 5-8 players go over WebRTC. Networked matches always have 8 characters, the rest are bots.
- GameSaloon: `MAX_PLAYERS = 4` in `src/relay/protocol.ts`; an out-of-range queue is silently ignored.
- Could add: a per-game `maxPlayers` (up to 8), and an `error` reply for an out-of-range queue instead of silence.

## JSON-only acts of at most 4 KiB
- Game today: RB1 base64-encodes binary rollback packets, so size grows by about 4/3. Acts stay <= 3800 chars, with coalescing by (ch, bytes) and `rbf` fragments for bigger packets.
- GameSaloon: `MAX_MSG_BYTES = 4 * 1024` and JSON text only (`src/relay/protocol.ts`), plus act limits `MAX_ACT_KEYS`, `MAX_ACT_ITEMS`, `MAX_ACT_DEPTH`.
- Could add: binary WebSocket frames (or a `bin` act type) with a limit of 16 KiB or more for cadence rooms.

## 20/90 msg/s and the per-minute caps
- Game today: a 60 Hz game flushes at 30 Hz with a budget of 60 acts/s and 3900/min. Over budget it drops the oldest fast packets and defers reliable ones.
- GameSaloon: `RATE_PER_SEC = 20`, `RATE_PER_MIN = 400`, `CADENCE_RATE_PER_SEC = 90`, `CADENCE_RATE_PER_MIN = 4000`. The cadence rates apply only after `matched`, and only to seats that queued with `cadence: true`.
- Could add: cadence for private `create`/`join` rooms (the hub uses them at the low rate), and a per-game rate profile.

## Quick queue keyed by player count and cadence only
- Game today: the payload `{g:'royal-fiesta', v:1}` is validated on `matched` after the fact. A mismatch makes the client refuse, `bye` and re-queue, which wastes the match.
- GameSaloon: `hub.ts` waits in lists keyed `${players}|${cadence ? 1 : 0}`.
- Could add: a `game` (and version) field on `queue` that is part of the key, so unrelated games never match each other.

## Kart-shaped rooms LocalPlayer and settings
- Game today: it sends `build:{characterId:'bean', bodyId:'c<colour>', wheelId:'none', gliderId:'none'}`, abusing the build ids to carry the colour, and takes the default room settings.
- GameSaloon: `KartBuildIds` and `LocalPlayer` in `src/protocol.ts`; `RoomSettings = {kind:'cup'|'track', cupId, trackId, cc: 50|100|150|200, items}` (PROTOCOL.md).
- Could add: opaque per-game `build` and `settings` objects (a bounded JSON blob validated by a per-game schema).

## No hub/lobby directory
- Game today: the walkable hub is a relay private room found by code, with at most 4 occupants. There is no list of hubs and no way to browse.
- GameSaloon: the relay has `create`/`join` by code and the quick queue only. The rooms `list` returns lobbies of the same `game`, but those are racing lobbies, not persistent spaces.
- Could add: a public room directory on the relay (list, join by id, occupancy) and persistent shared spaces with an occupancy cap.

## No 5-8 player matchmaking
- Game today: 5-8 players meet through a rooms code (create/join/start) and then play over a WebRTC mesh. There is no quick match for them.
- GameSaloon: the rooms protocol holds up to 8 peers (`maxHumans: 8`) but only forwards `signal`; the server never relays race data (PROTOCOL.md "No relay"). Rooms are joined by code or listed; there is no queue.
- Could add: a rooms queue (match N peers by game into a room and start it), and optionally a data fallback through the server when a peer cannot connect over WebRTC.
