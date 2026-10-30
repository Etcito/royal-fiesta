# Etcito build (build-alone)

Ported from the V0 M13 build-alone (the bundle's `scripts/fresh-clone-build.sh`), on release dependencies: no
kong step, no RAA build, no vendored rollback copy and no private build tool. It proves that a clean checkout
builds the Wavedash bundle with only npm, the MAMA and uaa pins and a token from the environment (QB13).

It needs network (the uaa and MAMA clones, `npm ci`), so it runs only from a programmatic card. Milestone 4 runs it; the
milestone that adds it does not.

## Usage

```
npm run etcito:build -- [--from <git URL or path>] [--out <dir>] [--record <file>]
```

- `--from`: a git URL (`https://`, `ssh://`, `git@host:owner/repo.git`, ...) or the path of a royal-fiesta
  checkout. Default `.` (with `npm run`, the repository root). A path that does not exist is refused before
  anything runs: `[bricks] <from>: not found; pass --from a git URL or the path of an existing royal-fiesta
  checkout`.
- `--out`: where the bundle is copied. Default `out/etcito-build` (untracked).
- `--record`: write the S17 record there, normally `proofs/m18/etcito-build.json`.

Relative paths are resolved from the current directory. The API is
`etcitoBuild({ from, out, record? }): Promise<number>` in tools/etcitoBuild.ts. It returns 0 when every step
passed, and 1 otherwise.

## Steps

All steps run in a temporary folder. The clone sits in a folder of its own, so its `../MAMA` never exists and
the uaa clone is the fresh `<work>/uaa` sibling it fetches.

1. A clean checkout:
   - for a path: `git clone --quiet --no-local <from> <clone>`. It takes the committed HEAD: uncommitted changes
     are not built, so commit first;
   - for a URL: `git clone --quiet --depth 1 <from> <clone>`. No token is used, because royal-fiesta is public.
2. `npm run bricks -- fetch uaa` (docs/bricks.md): it makes the `uaa` sibling of the clone (`<work>/uaa`)
   the pinned commit of `bricks.pins.json`, with the env token when it has to clone, and builds its `dist`
   when it is missing. The step runs before `npm ci`, because the root `@etcito/uaa` is `file:../uaa`.
3. `npm ci`.
4. `npm run bricks -- fetch mama` (docs/bricks.md):
   - with `$RF_BRICKS_DIR/MAMA`, it links that sibling;
   - otherwise it clones the pinned commit of `bricks.pins.json` from GitHub with the env token.
5. `npm run build`: audio bake, then the Vite build into `apps/web/dist`.
6. `npm run wavedash -- --skip-build`: packWavedash in the clone. It writes `out/wavedash-build/` there
   (docs/wavedash.md: layout and `rf-build.json`, whose `mama` names the source and commit).

The first step that fails stops the build. Its output names the failing step:
`[bricks] <step>: exited <code>; see the output above`. Each step has a timeout: 10 min for the clone and the
pack, 30 min for the uaa fetch, `npm ci`, the MAMA fetch and the build.

After the last step:
- the clone's `out/wavedash-build/upload/` and `wavedash.toml` replace those in `--out`. Nothing else in
  `--out` is touched;
- the temporary folder is removed. The uaa and MAMA clones are removed with it.

## Environment

| Variable | Use |
|---|---|
| `MAMA_TOKEN`, else `GH_TOKEN`, else `GITHUB_TOKEN` | The token for the uaa and MAMA clones. Only the two bricks steps see it, and tools/bricks.ts passes it to git through `GIT_CONFIG_*` env only. Every other step runs without these variables. |
| `RF_BRICKS_DIR` | Kept, for the sibling route (`$RF_BRICKS_DIR/MAMA`). A record needs a GitHub clone, so leave it unset for a record run. |
| `RF_RAA_LOCAL`, `GAMESALOON_DIR`, `RF_WAVEDASH_DIST`, `RF_PLAY_SKIP_BUILD`, `RF_PLAY_DIST` | Removed for every step. The build uses release dependencies only, with no test seam. |
| `VITE_RF_SERVER` | Optional build-time default relay, for example `VITE_RF_SERVER=wss://relay.example.invalid/ws npm run etcito:build -- ...` (placeholder host). Set it in the environment of the command only, never in a file. Every step inherits it; the page build uses it as the fallback after `?server=` for the title's Play online only (Play stays offline with bots), and `rf-build.json` records only `defaultServer: true`, never the URL. Unset, Play online says it needs a relay. See docs/wavedash.md, "Relay URL in the frame". |

`GIT_TERMINAL_PROMPT=0` makes a git step fail at once instead of asking for credentials. `NO_COLOR=1` keeps the
log free of colour codes.

## Log

Each child's stdout and stderr is split into lines. Each line is cleaned before it is printed or kept:

- `redact` (tools/guard.ts) replaces with `<redacted>`:
  - the token values;
  - their `x-access-token:<token>` base64 form (the git auth header);
  - every env value of 8 characters or more whose name contains TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH or
    PROXY;
  - the user info of a `--from` URL.
- Paths are replaced by labels:
  - the clone by `<clone>`;
  - the temporary folder by `<work>`;
  - this repository by `<repo>`;
  - a `--from` path by `<from>`;
  - the home folder (and any home-shaped path) by `~`.
- Colour codes and carriage-return redraws are removed.

The log never contains the token. A step prints `$ <cmd>` first and `== <cmd> exit=<code>` at the end.

## Record (`--record`, S17)

`proofs/m18/etcito-build.json`:

```json
{
  "commit": "<40 hex: HEAD of the clone>",
  "mama": { "source": "cloned", "commit": "<40 hex: the pinned commit, as cloned>" },
  "steps": [{ "cmd": "npm ci", "exit": 0, "tail": ["<last 40 cleaned lines>"] }],
  "bundleFiles": ["assets/...", "game.html", "rf-build.json"]
}
```

- `steps` holds one entry per step that ran, in order (clone, uaa, ci, bricks, build, pack). `cmd` and `tail` are
  cleaned as in "Log", and `tail` has at most 40 lines.
- `bundleFiles` is the sorted list of files under `upload/`, with forward slashes, as packWavedash returns it.
- The record is written only when:
  - every step passed;
  - MAMA was cloned from GitHub. A sibling is refused: `[bricks] <record>: MAMA resolved as sibling, the record
    needs the GitHub clone at the pin; unset RF_BRICKS_DIR, set MAMA_TOKEN and run again`;
  - `leakScan` finds nothing in the redacted JSON. Each hit is printed masked
    (`[guard] <record>: leakScan <pattern> ...`), and the record is not written.
- JSON is 2-space indented with a trailing newline (ARCHITECTURE 1.8).

## What it does not do

- It reads no Wavedash or Etcito key, and it pushes and publishes nothing. Pushing the bundle is the publisher's
  step (docs/wavedash.md, R5).
- It does not replay uncommitted files onto the clone (the V0 script did). The build is exactly the checked-out
  commit.

The Wavedash step also packs runtime game content under `upload/content/` using
`RF_CONTENT_DIR` (the repository root by default). The plain web build has no
game data. This bundled copy goes away when the CDN serves the content root.
