# Network transports (M6)

Every transport implements `NetTransport` from `@gamesaloon/rollback`. The session never knows which one it runs on.

| Transport | File | Used for |
|---|---|---|
| `NetSim` | rollback brick (via `game/net/netMatch`) | tests, in-page captures, M5 proofs: simulated latency and loss, no sockets |
| `RelayTransport` | `packages/game/src/net/relayTransport.ts` | 2-4 humans over the GameSaloon relay (`relayClient.ts`) |
| `WebRtcTransport` | `packages/game/src/net/webrtcTransport.ts` | 4-8 humans over a data-channel mesh; the rooms server only signals |

The relay is simplest (one socket, no NAT) but caps at 4 seats. Use WebRTC for 5-8 players.

## S7 RB1 framing (relay)

Rollback packets travel as relay `act`s `{k:'rb', m:[[toMask, ch, b64], ...]}`. `toMask` has one bit per destination seat (seat = rollback peer id), `ch` is 0 fast and 1 reliable.

- `send` copies the data into a pending queue. `endFrame` (once per rendered frame) flushes every 2 frames (30 Hz).
- Packets with identical (ch, bytes) merge into one entry with an OR'd mask.
- Defaults: `flushEveryFrames` 2, `maxActBytes` 3800 (the whole `{t:'act',a:...}` frame string), `maxActsPerSec` 60, `maxActsPerMin` 3900. At most 500 entries per act. The 3800 stays under the server's 4096-byte limit and the 3900/min stays under the 4000/min cadence cap.
- A packet that does not fit alone is split into `{k:'rbf', id, i, n, to, ch, d}` fragments (u32 id). Receivers reassemble by (from, id) and drop incomplete sets after 5 s.
- Drop/defer policy over budget: the oldest pending fast packets are dropped (`stats.droppedFast`); reliable packets stay queued for the next flush (`stats.deferredReliable`).
- Receive keeps only entries whose mask has the self bit. Malformed acts are counted, never thrown. A peer is `closed` after `player_left` for its seat; all peers after the socket closes.
- `stats`: `acts`, `bytesOut`, `maxActBytes`, `fragments`, `droppedFast`, `deferredReliable`.
- The constructor refuses `selfPeer` outside 0..peerCount-1 and `peerCount` outside 2..4.

## S8 relay match, rooms signaling and mesh

Relay queue: each client opens its own socket and sends `{t:'queue', players:N, cadence:true, payload:{g:'royal-fiesta', v:1, name, c}}`. On `matched`: seat = `youAre` = rollback peer = player index, seed = `matched.seed`. If any `opps[i]` is not a Royal Fiesta payload, the client refuses ("matched with a non-Royal-Fiesta client"), sends `bye` and re-queues.

Rooms signaling (`roomsClient.ts`, `/ws`): `hello {v:1, game:'royal-fiesta-1', name}`, then `create`/`join` by code, then the owner sends `start`. `rooms.room.you` is the local peer id (`RoomsClient.room` is set before create/join resolve). The members of `started` give player index = rank and rollback peer = rooms peer id. `connect` refuses without a room, or when the local peer is not a started member (path `selfPeer`).

Mesh rules:
- The lower peer id makes the offer, exactly once. Anything else is refused.
- Two channels per pair: `fast` {ordered:false, maxRetransmits:0} and `reliable` {ordered:true}, binary messages.
- Signal data: `{kind:'offer'|'answer', sdp}`, `{kind:'ice', candidate, sdpMid, sdpMLineIndex}`, `{kind:'ice-end'}`.
- ICE servers come from `welcome.iceServers` unless overridden (loopback proofs pass `[]`).
- `connect` resolves when every channel to every member is open; after `timeoutMs` (15000) it refuses and lists the missing peers.
- Game data never goes through the rooms server.

## Timed lobbies (GameSaloon)

game.html and play.html use `PlayFlow` with `matchmaking: 'lobby'` (gamesaloon `docs/lobby.md`). As soon as the hub is up, and again after each round, the match socket sends `{t:'lobby_enter', game:'royal-fiesta', seats:?party, cadence:true, payload:{g, v, name, c}}`. No pad and no key are needed.
- `lobby_state` (player): the hub overlay shows `Lobby n/4 - round starts in s`. The server starts the round after its wait (`LOBBY_WAIT_MS`, 60 s) or when the lobby is full. Players get the usual `matched`, with `players` = the number of humans (1-4). `netSetup`, `RelayTransport` and `createNetMatch` use `matched.players`, and bots take the other places of the 8.
- `lobby_choice`: screen `lobbyChoice` (join / spectate / new) or `lobbyLive` (spectate / new). Unanswered for `LOBBY_CHOICE_MS` (10 s), the client picks join on a waiting lobby, else new.
- Spectating (`lobby_state` with role spectator, then `lobby_watch` and `lobby_act`): the client is never a rollback peer. It runs no session and shows the round's players and status in the hub overlay. `lobby_closed` makes it enter again.
- A server without lobbies answers nothing. After `LOBBY_FALLBACK_MS` (3 s) the client sends the exact-size `queue` on the same socket.
- `LoopbackRelay({ lobby: { waitMs } })` mirrors the lobby extension for tests (`packages/game/test/flow.test.ts`, the `lobby:` tests). Pure logic: `packages/game/src/hub/lobby.ts`.

## The 8-seat refusal

`RelayClient.queue(8, ...)` throws before sending anything (a `RefusalError` message, verbatim):

```
[relay] queue.players: GameSaloon relay seats are capped at 4 (MAX_PLAYERS in gamesaloon src/relay/protocol.ts) and an out-of-range queue is silently ignored by the server; use the WebRTC transport for 5-8 players
```

## LoopbackRelay

`packages/game/src/net/loopbackRelay.ts` is an in-memory GameSaloon relay that mirrors `src/relay/hub.ts` message by message (create, join, queue, act, ack, bye, rates, payload validation, `opp_*`). It serves a `WsFactory`, so `RelayClient` runs on it unchanged. It is used by unit tests and by in-page hubs, because the GPU browser cannot reach a server in the sandbox.

The `loopback-conformance` check runs one scripted scenario (create 4 seats, 3 joins, acts before and after full, ack, bye) on the real server and on LoopbackRelay, and requires identical per-client sequences of message types. It proves the loopback matches the hub's message flow. It does not prove timing, rate-limit wall behaviour or anything about WebRTC.

## How to run

Unit tests (no network needed):

```
npm test
node --experimental-strip-types --test packages/game/test/relayTransport.test.ts
node --experimental-strip-types --test packages/game/test/webrtcTransport.test.ts
node --experimental-strip-types --test packages/game/test/loopbackRelay.test.ts
node --experimental-strip-types --test apps/headless/test/rtcNode.test.ts
```

Proof against a local GameSaloon (real time, cases run sequentially):

```
node --experimental-strip-types apps/headless/proofs/m6-transports.ts [--only <regex>] [--full]
```

Checks: `relay-4`, `webrtc` (4 and 8 clients), `relay-8-refused`, `loopback-conformance`. Report lines give rollback ms (p99, mean), resims and acts/s per case.

Setup:
- The proof starts a server from the gamesaloon-public checkout. Locate it with `GAMESALOON_DIR` (the checkout itself) or `RF_BRICKS_DIR` (the parent directory of the sibling repos); otherwise the sibling of this repo is used. `npm run bricks -- check` verifies this.
- Run `npm ci in gamesaloon-public` once (the server needs its `ws` dependency; the proof refuses with that fix if it is missing). Run `npm ci` in gamesaloon-rollback too, for Rapier.
- node-datachannel loopback: use `iceServers: []` and a `bindAddress`. Measured in the sandbox (only `lo`), libdatachannel gathers no candidate without one, so `nodeRtcBackend()` defaults to `bindAddress: '127.0.0.1'` (`DEFAULT_BIND` in `apps/headless/src/rtcNode.ts`). Pass `{ bindAddress, portRange: [begin, end] }` to override. Call `closeNodeRtc()` at the end or the process will not exit.
