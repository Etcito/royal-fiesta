# Bricks

The public bricks (`@gamesaloon/rollback`, `@gamesaloon/rollback-rapier`, `@etcito/raa`,
`@etcito/raa-assets-tools`) are release dependencies pinned in `package.json`. Nothing in this
repository patches them; gaps go to `docs/brick-gaps.md` and `docs/gamesaloon-gaps.md`.

## MAMA pin

MAMA is private and has no tarball. Its one pin lives in `bricks.pins.json`:

```json
{ "MAMA": { "repo": "Etcito/MAMA", "commit": "<40 lowercase hex>" } }
```

`tools/bricks.ts` reads that file (`readPins`) and refuses a repo that is not `owner/name` or a
commit that is not 40 lowercase hex, naming the pointer (`bricks.pins.json#/MAMA/commit`).

Resolution order when MAMA is needed:

1. `.bricks/MAMA` as a symlink to the sibling (a local checkout) or as a cloned directory;
2. `$RF_BRICKS_DIR/MAMA`, then `../MAMA`;
3. `npm run bricks -- fetch mama` clones the pinned commit from GitHub into `.bricks/MAMA`
   (gitignored) and runs `npm ci`;
4. otherwise MAMA is absent: the public clone still builds, and only the SDF loading path refuses
   with `MAMA not available: <reason>`.

`npm run bricks -- check` prints a MAMA line: PASS for a sibling or a clone, WARN when the sibling
HEAD differs from the pin, INFO when absent. WARN and INFO do not fail the check. `where MAMA`
prints the resolved directory.

## Token

`fetchMama` reads the token from `MAMA_TOKEN`, else `GH_TOKEN`, else `GITHUB_TOKEN`. It is passed to
git only through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` (an HTTP
`extraheader`), never through argv; child output is redacted with the token and the header. The
token is never written to a file, a log or the bundle.

## Local RAA override

By default Vite resolves the published `@etcito/raa` and `@etcito/raa-sdfm`. For unreleased RAA work
only:

`RF_RAA_LOCAL=1` is read by `vite.config.ts` through `raaLocal()`. It is active only when
`RF_RAA_LOCAL=1` and `brickDir('raa')` exists (`$RF_BRICKS_DIR/raa` or `../raa`); Vite then aliases
both packages to that checkout's built packages. It is never the default and never committed as
active. `npm run bricks -- check` prints a WARN with the directory when it is on and an INFO when it
is off.

## CLI

```sh
npm run bricks -- check
npm run bricks -- where <gamesaloon-public|raa-assets-tools|raa|MAMA>
npm run bricks -- fetch mama
npm run bricks -- pins
```

## Ported V0

The V0 bundle resolved its bricks through a local `tools/raaBuild.ts`. That file is not ported:
V0 uses the published brick versions above, and the only local override is `RF_RAA_LOCAL`.
