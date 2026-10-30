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
| `@etcito/raa-assets-tools` | v0.1.0 | root dev dependency |

The three RAA packages (`@etcito/raa`, `@etcito/raa-sdfm` and `@etcito/raa-anim`) are not release
tarballs: they come from the pinned local build described below. A clean clone gets the release
packages from `npm ci`; `npm run bricks -- check` verifies that the GameSaloon packages resolve and
that the Rapier WASM initialises.

To update a release pin, change the tarball URL in the `package.json` that declares it, run
`npm install` from the repository root so `package-lock.json` follows, and commit both. Bump
`@etcito/raa` only to a published release. The commit message says why the pin moves (the fix or
the feature it brings).

## bricks.pins.json

MAMA, uaa and raa are private and have no tarballs, so they are pinned by commit instead.
`bricks.pins.json` is the one pin table (S15):

| Brick | Repository | Consumed as |
| --- | --- | --- |
| MAMA | `Etcito/MAMA` | `.bricks/MAMA` (Vite alias; see below) |
| uaa | `Etcito/uaa` | the `file:../uaa` package dependency |
| raa | `Etcito/raa` | `.bricks/RAA` (the pinned local brick; see below) |

```json
{
  "MAMA": { "repo": "Etcito/MAMA", "commit": "<40 lowercase hex>" },
  "UAA": { "repo": "Etcito/uaa", "commit": "<40 lowercase hex>" },
  "RAA": { "repo": "Etcito/raa", "commit": "<40 lowercase hex>" }
}
```

`readPins` (and `npm run bricks -- pins`) accepts the `MAMA`, `UAA` and `RAA` keys, a `repo` of the form
`owner/name` and a `commit` of 40 lowercase hex. Anything else is refused with its pointer, e.g.
`[bricks] bricks.pins.json#/UAA/commit: expected 40 lowercase hex, got "abc"; fix the UAA pin in bricks.pins.json`.

To update a pin:

1. take the commit from a real source, never by hand: `git -C ../MAMA rev-parse HEAD`,
   `git -C ../uaa rev-parse HEAD` or `git -C ../raa rev-parse HEAD` in a sibling checkout of the
   wanted revision, or the GitHub page of that commit;
2. write it into `bricks.pins.json` (2-space JSON, trailing newline);
3. run `npm run bricks -- pins`, then `npm run bricks -- fetch mama` (or `fetch uaa`, or
   `fetch raa`) and `npm run bricks -- check` (the MAMA line is PASS, not WARN);
4. commit the pins file alone, or with the change that needs it. The commit message says why the
   pin moves.

Any milestone that needs a newer MAMA, uaa or raa may update its pin.

## Resolving .bricks/MAMA

`.bricks/` is gitignored. `mamaSource()` is offline and synchronous (the Vite config calls it). It
resolves MAMA in this order (S15):

1. `.bricks/MAMA` exists: a symlink is a sibling, a directory is a clone. The commit is read from its
   `.git` files, without spawning git. A broken or unreadable symlink falls through to step 2;
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

## Resolving .bricks/RAA

RAA is consumed from a pinned local build: `npm run bricks -- fetch raa` provisions the checkout
and runs the brick build script; there is no environment switch and no release fallback in this
channel. `raaSource()` is offline: `.bricks/RAA` first (a symlink is a sibling, a directory is a
clone), then `$RF_BRICKS_DIR/raa` and `../raa`, then absent with a reason.

`fetchRaa` never checks out, resets or otherwise modifies a sibling, so uncommitted work there is
kept. It refuses a sibling whose HEAD is not the pin. Fetch links the sibling (or copies a
read-only sibling to `.bricks/RAA`) and runs `bash scripts/build-bricks.sh`; with no sibling it
clones the pin into `../raa` with the token and links it, removing `../raa` again on failure.

The build stages `dist/bricks/{raa,raa-sdfm,raa-anim}` and writes `dist/bricks/bricks.json`. Fetch
requires that manifest and the three directories and rejects a manifest whose `commit` differs from
the pin; when the build omits the commit, fetch writes the pinned one after checking HEAD.

`npm run bricks -- status` prints the MAMA, UAA and RAA lines plus the RAA manifest commit and
staged packages. It exits non-zero unless the RAA checkout, manifest commit and three package
directories match the pin.

## Token variables

A clone needs a GitHub token with read access to `Etcito/MAMA`, `Etcito/uaa` and `Etcito/raa`.
`githubToken()` takes it from `MAMA_TOKEN`, else `GH_TOKEN`, else `GITHUB_TOKEN`. Set it on the
build machine only (the shell that runs `fetch mama`, `fetch uaa` or `fetch raa`, or a CI secret);
it is never committed and never printed.

- It reaches git only through the environment of `git fetch`: `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader` and
  `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64 of x-access-token:<token>>`. It is never in an
  argv, a file, a log or the bundle.
- No child sees `MAMA_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`; `git init`, `git checkout`, `npm ci`
  and the brick build script run without the auth header.
- Every child line goes through `redact` (tools/guard.ts) with the token, its base64 form and every
  token variable before it is printed. A refusal names the failed step, never its output.
- Proof records and transcripts that include a fetch go through `redact` and then `leakScan` before
  they are committed (docs/private-assets.md, "Public leaks").

## The local RAA channel

RAA is the pinned local brick: the game reads the packages built from the `RAA` checkout in
`bricks.pins.json`, through `.bricks/RAA`. The channel is unconditional: there is no environment
variable that switches it on or off, and a release build, a proof and the clean clone all see the
same pin. Work that needs an RAA change lands in RAA, is pinned here, and is built by
`npm run bricks -- fetch raa`; it is never patched in this repository. `tools/m17SdfMatch.ts`
validates the same channel before the SDF tour: `apps/web/package.json` must use
`file:../../../raa/dist/bricks/raa-sdfm`, and the RAA checkout and manifest commit must equal the
pin. `raaLocal()` stays exported for the legacy Vite alias and the m11-m13 proofs only; the
fetch/status workflow and the m17 check do not read it.

The managed, read-only `../raa` staging must record its actual build commit in
`dist/bricks/bricks.json#/commit`. The historical `bricks.raa.lock.json` is not a
substitute for that manifest provenance and is not read by the validation code.
No sibling build or write is performed by the M18 capture queue.

The required `commit` is `91b335289fb48d59e9221e0cdf8b39cc1bc18e8e`.
Both the M18 fetch proof and `tools/m17SdfMatch.ts` read it through `raaBricks()`;
neither accepts a repository-side lock as build provenance. Environment provisioning must
stage the pinned checkout and write its actual build commit in `dist/bricks/bricks.json`
before releasing the capture queue. A missing manifest commit or a mismatched HEAD is
not repaired by changing the proof's expected value or relabelling another build.

`.nmc/commands.json` builds the game before calling
`node tools/anim-brick-capture.mjs --built`. The writer packs content, then invokes
`node "$NMC_GPU_CLIENT" publish <directory>` and
`node "$NMC_GPU_CLIENT" render <input.json> --page-ref <published-ref> -o <output>`
with argument arrays and a 60-second limit per client call. Publishing supplies the
server-managed page hosting; no local HTTP server is needed. It first runs a blank
transport probe, then the real `game.html` at one frame, then the full game capture.
The transport delegates to the game's `animBrick` operation. The validated result is
written to `proofs/m18/brick-browser.json`, followed by the unchanged five-label proof.
This is execution/non-empty evidence, not a judged visual change; no image judge is used.

## CLI

```sh
npm run bricks -- check                # GameSaloon packages, Rapier, the MAMA and RAA lines
npm run bricks -- status               # every pin, plus the RAA manifest commit and staged packages
npm run bricks -- where <gamesaloon-public|raa-assets-tools|raa|MAMA>
npm run bricks -- fetch mama           # link or clone .bricks/MAMA, print its kind and commit
npm run bricks -- fetch uaa            # link or clone ../uaa at the pin, build it, print its kind and commit
npm run bricks -- fetch raa            # link or clone ../raa at the pin, build dist/bricks, check the manifest
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
| raaBuild and the sibling alias roots in `apps/web/vite.config.ts` | keep-base (web-client) | main's config: `virtual:rf-mama`, and the pinned local RAA channel |
| `apps/web/aliases.json` (`@raa/engine` to a sibling) | keep-base (raa-port) | `import ... from '@etcito/raa'` |
| `scripts/fresh-clone-build.sh` | drop (wavedash) | `npm ci` and `npm run build` |
| the `raa:build` script and `file:` sibling dependencies in `package.json` | not ported (workspace) | the release URLs in `package.json` |
| `vendor/gamesaloon-rollback/` | keep-base (wavedash) | the `@gamesaloon/rollback*` release tarballs |
| `repoRoot` from tools/bricks.ts (m11, m14, controlsProbe, previewWavedash, storeCache) | take | unchanged on main |
| `brickDir('raa')` in the m7-web and m8-hub proofs | keep-base (m7-proof, m8-proof) | `brickDir('raa')` locates the pinned local channel and returns null when absent |
| `brickDir('gamesaloon-rollback')` | no target | not a brick name: the rollback packages are releases |
| `linkBricks` | no target | the only links are `.bricks/MAMA` (`fetch mama`), `.bricks/UAA` (`fetch uaa`) and `.bricks/RAA` (`fetch raa`) |

### Shared mesh cache

`npm run play` bakes content meshes in the background and checks live content for changes.
`npm run meshes:bake` runs the same baker alone, using `RF_CONTENT_DIR` and the resolved MAMA
commit and raa-sdfm version. It runs three assets at a time with a 300 second limit per asset;
set `RF_MESH_JOBS` and `RF_MESH_TIMEOUT_S` to change these limits. Successes and refusals persist
in the ignored `.cache/meshes` folder (`RF_MESH_CACHE_DIR` overrides it); delete a key's `.failed`
file to retry a refusal. After forcibly killing a baker, remove its abandoned `.lock` files before retrying. Browsers check IndexedDB first, then `<content root>/meshes/<key>`:
200 supplies a versioned binary mesh, 202 waits for the server, 422 supplies a refusal reason,
and 404 or an unavailable service falls back to local meshing. Old browser failures do not hide
server successes. Missing meshes still leave the asset undrawn and allow the title to load.
`content:pack` includes cached successful meshes for a static content host.
