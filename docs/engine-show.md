# Engine show: local build, serving and host acceptance

The engine show runs behind `?engine=1` on `game.html`, and on its dedicated page `engine-show.html`. This document records how to reproduce its local build, how to serve that build for the online harness, and how the host runs the online acceptance once on the browser machine. The matching commands are registered in `.nmc/commands.json`, and the programmatic card runs them. Nothing here is deployed: there is no public deploy target.

## 1. Replayable local build

These are the commands `g7-offline-bricks-build`, `g7-offline-scripts-build` and `g7-offline-web-build` run, in this order:

```
node --experimental-strip-types tools/egeBricks.ts build
node --experimental-strip-types tools/egeScripts.ts build --out out/ege
npm run build
```

1. The bricks build (`tools/egeBricks.ts build`, the same as `npm run ege:bricks`) builds the bricks that the scripts and web builds read.
2. The scripts build (`tools/egeScripts.ts build --out out/ege`, the same as `npm run ege:build`) compiles the game scripts into `out/ege`.
3. The web build (`npm run build`, which runs `npm run web:build`) runs the audio bake, the UI font bundle and the `@royal-fiesta/web` build into `apps/web/dist`, then `tools/cosmeticThumbs.ts`.

The six `g7-online-*` entries (`g7-online-unit-check`, `g7-online-check`, `g7-online-clean`, `g7-online-render`, `g7-online-fresh` and `g7-online-judge`) each have `g7-offline-web-build` upstream in their `after` chains, so `apps/web/dist` is built before any of them reads it. Of the `g7-offline-*` entries, `g7-offline-bricks-build` and `g7-offline-scripts-build` run before `g7-offline-web-build`, and each entry from `g7-offline-typecheck` on has it upstream.

## 2. Serving the build for the online harness

The server is `tools/play.ts` (`npm run play`), a Node `http` static server over `apps/web/dist`. `RF_PLAY_DIST` serves another directory instead.

- Port: 5191. `play.ts` defaults to 5173, which is not the relay origin, so pass `--port 5191` or set `RF_PLAY_PORT=5191`.
- Origin: `http://localhost:5191`. `docs/network.md` names it as the origin the production relay admits. It is also the default `--url` of `tools/onlineChromes.mjs`, `http://localhost:5191/game.html`.
- Bind: every interface by default, so a phone on the same network can open it. `RF_PLAY_HOST=127.0.0.1` keeps the server local.
- Build: unless `RF_PLAY_SKIP_BUILD=1` is set, `npm run play` runs the audio bake, the UI font bundle and the `@royal-fiesta/web` build before it serves. That is section 1 without the `tools/cosmeticThumbs.ts` step. To serve exactly the section 1 build, run section 1 first and start the server with `RF_PLAY_SKIP_BUILD=1` (a test seam that `tools/play.ts` reads).

```
npm run play -- --check --port 5191   # starts, probes game.html, play.html and the JS asset, then stops
npm run play -- --port 5191           # serves until stopped
RF_PLAY_SKIP_BUILD=1 npm run play -- --port 5191   # serves the apps/web/dist that section 1 built, without rebuilding it
```

`docs/network.md` also records that a localhost page gets a dev lobby that starts 10 s after the first player. Client 2 must report client 1's lobby id before the round starts. If it misses that window, client 2 never reports that lobby id, and the harness reports the failed `client 2 same lobby` wait with client 2's last state when the deadline passes.

## 3. Pages

- `http://localhost:5191/game.html?engine=1` runs the game on the engine backend. `selectGameBackend` in `apps/web/src/game/engineBackend.ts` accepts only `1` for the engine. An absent `engine` parameter or `engine=0` keeps the legacy game, and any other value, including an empty `engine=`, is refused.
- `http://localhost:5191/engine-show.html` is the dedicated page for the sixty-seat show. It runs in local mode with one human by default. `?mode=online` selects the online mode used by the online capture stage, and `humans` sets the human count (`apps/web/src/engineShow/main.ts:16-17`).

## 4. Host acceptance

Run this once on the host browser machine, against the build served in section 2:

```
node tools/onlineChromes.mjs --engine --clients 2 --bots 60 --late-client --background-client --until round-ended --url <served game.html URL> --server <relay>
```

With the origin above, `--url` is `http://localhost:5191/game.html`. `--server` is the production relay `wss://relay.etcito.com/ws`. Both are the defaults, and they can be passed explicitly.

Client 2 starts late. It is launched only after client 1 reports lobby-ready, and it must report client 1's lobby id before the round starts. Client 1 is hidden. Once both clients are in a match, the harness opens a blank tab in client 1's browser and activates it. Client 1 must read `visibility` `hidden`, and its tick must advance while it is hidden. The harness brings client 1 back to the foreground after the terminal condition. No throttling-disabling flags are passed.

The milestone criterion is: "two clients and 58 bots play one full round with `?engine=1` and no desync is reported".

Flags, from contract `onlineChromes engine CLI`:

| Flag | Use in this run |
|---|---|
| `--engine` | Each client URL gets `engine=1`. Without it the older duration run runs, with `--seconds` (default 60). |
| `--clients 2` | Two human clients (1 to 4 allowed). |
| `--bots 60` | Total seats, sent as `bots=60`: two humans and 58 bots. |
| `--late-client` | Client 2 is launched after client 1's lobby-ready. |
| `--background-client` | Client 1 is genuinely hidden after the round starts. |
| `--until round-ended` | State-driven completion. `show-ended` waits for `podium-ready` and `hub-returned` instead. |
| `--deadline 900` | Overall budget in seconds (default 900). |
| `--url`, `--server` | The served page and the relay. |
| `--chrome`, `--port`, `--boot` | The Chrome binary (default `C:/Program Files/Google/Chrome/Application/chrome.exe`, or `CHROME`), client 1's debugging port (client 2 uses the next one; default 9341), and the extra seconds, on top of a fixed 30 s window, that a Chrome gets to open its page (default 30). |

The harness fails, printing the client name and its last state, when a transition reports an error, when a client's tick stops changing for 30 s once both clients are in a match, or when the deadline passes with a transition still missing.

### What counts as success

The run exits 0 only when every client passes the completion check:

- two humans and 58 bots (seats minus humans);
- zero reported desyncs and zero script faults;
- no error and no thrown runtime exception;
- one lobby id on every client;
- the `round-ended` signal and at least one completed round on every client.

A successful run ends with these lines. The second one must report both Chromes closed:

```
[harness] round-ended reached: ...
[harness] closed 2 owned Chromes
```

Exit codes: 0 success; 1 a failed, stalled or errored transition, a deadline or a signal; 2 invalid arguments. On every exit the harness kills only the Chromes it spawned. It sends SIGTERM, waits up to 5 s for each exit, sends SIGKILL only to a Chrome still running, and prints how many it closed. A live process or printed diagnostics alone is never success.

The run never happens in a model sandbox and never with software Chrome. It uses the physical GPU Chrome on the host browser machine.

## 5. Online capture stage

The programmatic card runs these entries from `.nmc/commands.json`: `g7-online-unit-check`, then `g7-online-check`, `g7-online-clean`, `g7-online-render`, `g7-online-fresh` and `g7-online-judge`. This document does not run them. The same CLI reproduces them:

```
node --experimental-strip-types tools/engineShowCapture.ts check --stage online --page apps/web/dist --out out/engine-show/online
node --experimental-strip-types tools/engineShowCapture.ts clean --stage online --page apps/web/dist --out out/engine-show/online
node --experimental-strip-types tools/engineShowCapture.ts render --stage online --page apps/web/dist --out out/engine-show/online
node --experimental-strip-types tools/engineShowCapture.ts fresh --stage online --page apps/web/dist --out out/engine-show/online
node --experimental-strip-types tools/engineShowCapture.ts judge --stage online --page apps/web/dist --out out/engine-show/online --budget-s 3300
```

- Inventory: `apps/web/public/engine-show/online.inventory.json`, with `engine-online-late-client-round.png`. The background-client-podium capture was withdrawn from M4 by the owner's directive of 2026-11-21 until the levels can be finished. The stage check accepts `online` because that inventory exists, and refuses a stage whose inventory is missing.
- Store: `NMC_CACHE_DIR/engine-show/online`. Without `NMC_CACHE_DIR` the store is `out/engine-show/online` (`captureStageStore` in `tools/engineCaptureJob.ts`). Captures are delivered under `out/engine-show/online`, which is ignored and never committed.
- `clean` allocates a new attempt and deletes no record or image.
- `render` copies the kept images into the new delivery directory, then renders only rows without a valid image for the current build and inventory row, failed rows first.
- A retained image is reused only when the build commit and the row identity (id, filename, args, require, description, held_constant) are unchanged, the image is non-empty and its job records parse. No hash is compared.
- `judge` scores each image with `python3 "$NMC_JUDGE_CLIENT"` at minimum score 6. It reuses a passing verdict only when the delivered image is byte-identical to the attempt's image and the description and held constants are unchanged.
- `ENGINE_SHOW_RERENDER_ALL=1` disables reuse, so every row is rendered again (`keptRows` in `tools/engineCaptureJob.ts`).
- `fresh` refuses a delivery whose selection or run record does not belong to the current attempt and build.
