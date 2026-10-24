# Bricks

Royal Fiesta is built on bricks that it never patches. A gap goes to `docs/brick-gaps.md` (rollback,
raa, raa-sdfm, MAMA, raa-assets-tools) or `docs/gamesaloon-gaps.md`. `tools/bricks.ts` is the only
place that locates a brick on disk.

## Release tarball dependencies

The public bricks are GitHub release tarballs, pinned by URL in the `package.json` that uses them
and locked in `package-lock.json`:

| Package | Release | Used by |
| --- | --- | --- |
| `@gamesaloon/rollback` | v0.1.0 | packages/sim, packages/game, apps/headless, apps/web |
| `@gamesaloon/rollback-rapier` | v0.1.0 | packages/sim, packages/game, apps/headless, apps/web |
| `@dimforge/rapier3d-deterministic-compat` | 0.21.0 (npm) | wherever Rapier is used |
| `@etcito/haa` | v0.1.1 | packages/game (audio) |
| `@etcito/raa` | v0.1.1 | apps/web (renderer) |
| `@etcito/raa-assets-tools` | v0.1.0 | root dev dependency |

`@etcito/raa-sdfm` (a release of the raa repository, with MAMA as its peer) joins apps/web from
milestone 3. A clean clone gets every one of them from `npm ci`: there is no sibling checkout, no
alias and no build step for them. `npm run bricks -- check` verifies that the GameSaloon packages
resolve and that the Rapier WASM initialises.

To update a release pin, change the tarball URL in the `package.json` that declares it, run
`npm install` from the repository root so `package-lock.json` follows, and commit both. Bump
`@etcito/raa` only to a published release. The commit message says why the pin moves (the fix or
the feature it brings).

## bricks.pins.json

MAMA and uaa are private and have no tarballs, so they are pinned by commit instead.
`bricks.pins.json` is the one pin table (S15):

| Brick | Repository | Consumed as |
| --- | --- | --- |
| MAMA | `Etcito/MAMA` | `.bricks/MAMA` (Vite alias; see below) |
| uaa | `Etcito/uaa` | the `file:../uaa` package dependency |

```json
{
  "MAMA": { "repo": "Etcito/MAMA", "commit": "<40 lowercase hex>" },
  "UAA": { "repo": "Etcito/uaa", "commit": "<40 lowercase hex>" }
}
```

`readPins` (and `npm run bricks -- pins`) accepts the `MAMA` and `UAA` keys, a `repo` of the form
`owner/name` and a `commit` of 40 lowercase hex. Anything else is refused with its pointer, e.g.
`[bricks] bricks.pins.json#/UAA/commit: expected 40 lowercase hex, got "abc"; fix the UAA pin in bricks.pins.json`.

To update a pin:

1. take the commit from a real source, never by hand: `git -C ../MAMA rev-parse HEAD` or
   `git -C ../uaa rev-parse HEAD` in a sibling checkout of the wanted revision, or the GitHub page
   of that commit;
2. write it into `bricks.pins.json` (2-space JSON, trailing newline);
3. run `npm run bricks -- pins`, then `npm run bricks -- fetch mama` (or `fetch uaa`) and
   `npm run bricks -- check` (the MAMA line is PASS, not WARN);
4. commit the pins file alone, or with the change that needs it. The commit message says why the
   pin moves.

Any milestone that needs a newer MAMA or uaa may update its pin.

## Resolving .bricks/MAMA

`.bricks/` is gitignored. `mamaSource()` is offline and synchronous (the Vite config calls it). It
resolves MAMA in this order (S15):

1. `.bricks/MAMA` exists: a symlink is a sibling, a directory is a clone. The commit is read from its
   `.git` files, without spawning git;
2. else a sibling at `$RF_BRICKS_DIR/MAMA`, then `../MAMA` (kind sibling; its HEAD is compared with
   the pin);
3. else absent, with a reason.

`npm run bricks -- fetch mama` (`fetchMama`) makes `.bricks/MAMA` and prints the resulting kind and
commit (`MAMA cloned <commit>`):

1. a sibling exists: it (re)links `.bricks/MAMA` to it, and runs `npm ci` there when its
   `node_modules` is missing;
2. else, with a token: in a fresh `.bricks/MAMA` it runs `git init`,
   `git fetch --depth 1 https://github.com/<repo>.git <commit>`, `git checkout FETCH_HEAD` and
   `npm ci`. If any step fails, `.bricks/MAMA` is removed again, so a half clone is never resolved;
3. else it refuses:
   `[bricks] MAMA: not found; clone Etcito/MAMA next to this repository or set MAMA_TOKEN on the build machine`.

`npm run bricks -- check` prints one MAMA line: PASS for a sibling at the pin or a clone, WARN when
the sibling HEAD differs from the pin, INFO when absent. WARN and INFO never fail the check.
`npm run bricks -- where MAMA` prints the resolved directory.

When MAMA is resolved, Vite aliases `@etcito/mama/*` to `.bricks/MAMA/src/*` and the virtual module
`virtual:rf-mama` resolves to the real implementation. When it is absent (a public clone),
`virtual:rf-mama` is the typed stub `apps/web/src/mamaAbsent.ts`: typecheck, test, build and smoke
still pass, and only the SDF loading path refuses at run time with `MAMA not available: <reason>`.
There is no fallback to another content source. The gap is recorded in `docs/brick-gaps.md#mama`.

## Resolving ../uaa

The game imports uaa as `file:../uaa`, so the checkout must be the sibling itself; a `.bricks/UAA`
clone would not resolve the package exports (`dist/uaa.js`, `dist/webgpu.js`). `uaaSource()` is
offline and synchronous:

1. `.bricks/UAA` exists: a symlink is a sibling, a directory is a clone (HEAD read from its git
   files);
2. else the `../uaa` sibling;
3. else absent, with a reason.

`npm run bricks -- fetch uaa` (`fetchUaa`) makes the sibling and `.bricks/UAA`:

1. `../uaa` exists at the pinned commit: it (re)links `.bricks/UAA` to it. A sibling at another
   commit is refused (`expected the pin <commit>`); check out the pin or update `bricks.pins.json`;
2. else, with a token: in `../uaa` it runs `git init`, `git fetch --depth 1
   https://github.com/<repo>.git <commit>`, `git checkout FETCH_HEAD`, then links `.bricks/UAA`.
   If any step fails, `../uaa` is removed again, so a half clone is never used;
3. else it refuses:
   `[bricks] UAA: not found; clone Etcito/uaa next to this repository or set MAMA_TOKEN, GH_TOKEN or GITHUB_TOKEN on the build machine`.

When `../uaa/dist` is missing, fetch runs `npm ci` and `npm run build` in `../uaa` (for a sibling
and for a fresh clone), so the `file:../uaa` exports resolve. Every failed step is a refusal that
names the step and the fix.

## Token variables

The clone of either private repository needs a GitHub token with read access to `Etcito/MAMA` and
`Etcito/uaa`. `githubToken()` takes it from `MAMA_TOKEN`, else `GH_TOKEN`, else `GITHUB_TOKEN`.

- Set it on the build machine only: the shell of the machine that runs `fetch mama` or `fetch uaa`, or a CI secret.
  It is never committed (no `.env` file, script, record or doc carries it) and never printed.
- It reaches git only through the environment of `git fetch`: `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader` and
  `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64 of x-access-token:<token>>`. It is never in an
  argv, a file, a log or the bundle.
- No child sees `MAMA_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`. `git init`, `git checkout` and `npm ci`
  run without the auth header.
- Every line a child prints goes through `redact([token, its base64 form])` (tools/guard.ts) before
  it is printed. A refusal names the failed step, never its output.
- Proof records and transcripts that include a fetch go through `redact` and then `leakScan` before
  they are committed (docs/private-assets.md, "Public leaks").

## Local RAA override

By default Vite resolves the published `@etcito/raa` (and `@etcito/raa-sdfm`). For unreleased RAA
work only, `RF_RAA_LOCAL=1` makes `apps/web/vite.config.ts` alias both packages to the built
packages of `brickDir('raa')` (`$RF_BRICKS_DIR/raa`, else `../raa`), found by the package names under
its `packages/` folder:

```sh
RF_RAA_LOCAL=1 npm run build
```

- It is never the default, and it is never committed as active (not in a `package.json` script, a
  workflow or an env file). Release builds, proofs and the clean clone run without it.
- `raaLocal()` is active only when `RF_RAA_LOCAL=1` and the raa brick exists.
  `npm run bricks -- check` prints a WARN with the directory when it is active, and an INFO when it is
  off; Vite prints the same warning when it builds with it.
- Work that needs an RAA change lands in RAA, ships as an RAA release, and comes here as a pin
  update. It is never patched here.

## CLI

```sh
npm run bricks -- check                # GameSaloon packages, Rapier, the MAMA line, the RF_RAA_LOCAL line
npm run bricks -- where <gamesaloon-public|raa-assets-tools|raa|MAMA>
npm run bricks -- fetch mama           # link or clone .bricks/MAMA, print its kind and commit
npm run bricks -- fetch uaa            # link or clone ../uaa at the pin, build it, print its kind and commit
npm run bricks -- pins                 # print the validated bricks.pins.json
```

## Ported V0 usage

The V0 bundle (M9..M14) built RAA out of tree with `tools/raaBuild.ts` and located bricks through
its own `tools/bricks.ts`. Main has no `tools/raaBuild.ts`: everything goes through the release path
above. Per `docs/v0-port.md`:

| V0 usage | Port | Release path on main |
| --- | --- | --- |
| `tools/raaBuild.ts` and `tools/test/raaBuild.test.ts` | drop (raa-port) | `@etcito/raa` release tarball; no build step |
| raaBuild step in the m11, m12 and m13 proofs | take+rewrite (v0-port-records) | the step is removed; the pages bundle `@etcito/raa` |
| raaBuild step in `tools/play.ts` | take+rewrite (local-play) | `npm run play` builds against the release |
| raaBuild step in `tools/packageWavedash.ts` and its test | take+rewrite (wavedash) | the Wavedash build uses the release |
| `RAA_PIN` (a raaBuild commit) in `tools/wavedashCheck.ts` and its test | take+rewrite (wavedash) | the `@etcito/raa` release version |
| raaBuild and the sibling alias roots in `apps/web/vite.config.ts` | keep-base (web-client) | main's config: releases, `virtual:rf-mama`, and `RF_RAA_LOCAL` as the only local alias |
| `apps/web/aliases.json` (`@raa/engine` to a sibling) | keep-base (raa-port) | `import ... from '@etcito/raa'` |
| `scripts/fresh-clone-build.sh` | drop (wavedash) | `npm ci` and `npm run build` |
| the `raa:build` script and `file:` sibling dependencies in `package.json` | not ported (workspace) | the release URLs in `package.json` |
| `vendor/gamesaloon-rollback/` | keep-base (wavedash) | the `@gamesaloon/rollback*` release tarballs |
| `repoRoot` from tools/bricks.ts (m11, m14, controlsProbe, previewWavedash, storeCache) | take | unchanged on main |
| `brickDir('raa')` in the m7-web and m8-hub proofs | keep-base (m7-proof, m8-proof) | main reads `@etcito/raa`; `brickDir('raa')` serves only the local override and returns null when absent |
| `brickDir('gamesaloon-rollback')` | no target | not a brick name: the rollback packages are releases |
| `linkBricks` | no target | the only links are `.bricks/MAMA` (`fetch mama`) and `.bricks/UAA` (`fetch uaa`) |
