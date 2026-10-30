# Community levels (SDF Modeler -> Etcito -> Royal Fiesta)

First slice: the owner publishes a level from SDF Modeler; Royal Fiesta lists and plays it. Owner key only, no player
accounts yet.

## Pack (packages/game/src/levelPack.ts)

One JSON: `{ manifest, files }`. `files` maps a path to the exact TEXT of the file: `courses/ugc-<id>.course.json` (one,
kind race or survival) and `assets/<world>/<id>.asset.json` (every asset the course uses, nothing else). No meshes: clients
rebuild them. `manifest` = `{format: 'etcito.level-pack', version, id, game, title, author, gameVersion, courseId,
contentHash, files: [{path, sha256, size}]}`. `contentHash` = sha256 of the sorted `path\nsha256\n` lines; `id` =
`<courseId>-<first 8 hex of contentHash>`, so an edited level is a new item and the hash is the version. `gameVersion`
(`LEVEL_GAME_VERSION`) is bumped when sim or validator semantics change.

## Etcito service (tools/levels/server.ts)

Behind `https://assets.etcito.com/levels` (nginx location, service `etcito-levels` on 127.0.0.1:9790, data in
`/var/lib/etcito-levels`). `GET /levels` (list), `GET /levels/<id>` (pack), `POST /levels` and `DELETE /levels/<id>`
(`Authorization: Bearer <write key>`). Every response carries `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin`. POST runs the strict validator (`validateLevelPack`: hashes, sizes, only
course and asset paths, no external URL, the game's own course and asset readers, every asset used, race or survival
only), caps a pack at 4 MB and the store at 200 levels. The write key is `LEVELS_WRITE_KEY` in `/etc/etcito-levels.env`
(root only); the owner's copy is an untracked file named by `ETCITO_LEVELS_KEY_FILE`. Deploy: `tools/levels/deploy.sh`.

## Publishing

`ETCITO_LEVELS_URL=https://assets.etcito.com/levels ETCITO_LEVELS_KEY_FILE=<file> npm run levels:publish -- <courseId>`
(SDF Modeler's "Publish to Etcito" builds the same pack).

## In the game

Only when the page has a levels base: `VITE_RF_LEVELS_URL` in the build ENVIRONMENT (never a committed file) or `?levels=`.
The title then shows "Community levels". A level plays with `?community=<id>` (optional `&chash=<64 hex>` pins the exact
version): the pack is downloaded, verified (`verifyLevelPack`) before any byte is used, and its files overlay the content
(apps/web/src/content/v1Data.ts `installContentOverlay`); the page then plays that course with bots. Shipped levels never
need Etcito.

## TODO

- Online matches: the host announces `{levelId, contentHash}` in the lobby descriptor, peers download, verify and refuse to
  ready on a mismatch (wavedash-ugc.md section 4). Not built.
- Reachability check (start to finish) and dynamic body or joint budgets in the strict validator.
- Player identity (is the Wavedash user id the same across SDF Modeler and Royal Fiesta? open probe), per-player write
  tokens, moderation.
