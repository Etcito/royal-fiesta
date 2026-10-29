# Private assets policy

Royal Fiesta keeps assets out of git. The repository holds source code and small
JSON fixtures only.

## Where assets live

Assets live in the content-addressed asset store at
[https://assets.etcito.com](https://assets.etcito.com). An object is addressed by
the SHA-256 of its bytes:

```
https://assets.etcito.com/objects/<first 2 hex of sha256>/<sha256>
```

Logical names are grouped in manifests. A manifest is itself an object, fetched
by its own hash, with this shape:

```json
{
  "format": "raa.manifest",
  "version": 0,
  "entries": {
    "<logical name>": {
      "sha256": "<64 hex>",
      "size": 1234,
      "type": "application/vnd.raa.prims+json",
      "version": 0
    }
  }
}
```

Every downloaded object is verified against its sha256 and size; a mismatch is
refused. Courses with `"assetsManifest": null` read `fixtures/assets/<name>.prims.json`
instead, so the game runs before the store is populated.

## The game never writes the store

The game and its proofs only read the store. Write access belongs to the
`raa-assets-tools` CLI, which uses `ASSET_STORE_SSH` and `ASSET_STORE_KEY`.
Never put credentials in the repository, a fixture or a proof record.

## UI logo delivery

`ui/logo.json` pins the source format (`png` or `svg`), SHA-256, byte length and
dimensions. To stage a
new logo before publication, update that registry and run:

```sh
node --experimental-strip-types tools/uiLogo.ts stage <source.png-or-svg>
```

The verified original waits at `out/ui-store/objects/<first 2 hex>/<sha256>` for
publication with `raa-assets-tools`. Staging also copies it to
`apps/web/public/images/<sha256>.<format>`. Both are ignored by Git. The web build
verifies the staged or bundled source, or downloads and verifies the pinned
object from the asset store when neither exists. It generates a full-resolution
AVIF with alpha using pinned Sharp/libvips: quality 85, effort 4, 8-bit, 4:4:4
chroma. `images/logo-build.json` records the source/output sizes, hashes and
encoder versions. The derived AVIF also waits under its own content-addressed
key in `out/ui-store/objects/` for optional publication.

The game loads the AVIF for a PNG source. There is no existing browser-format
fallback pattern, so it does not silently load the PNG instead. A future SVG
can use `format: "svg"` in the registry: the same loader decodes that SVG directly
for the WebGPU logo pass, and the build still produces an AVIF for comparison.
Like the UI font, the delivered images ship beside the page so the GPU client
needs no network.
Keep the original transparency and proportions; do not embed image bytes in
source or JSON.

## Fixtures

`fixtures/` contains small JSON only:

- every file is `.json`;
- at most 64 KiB per file;
- `assets/<name>.prims.json`, `courses/<id>.course.json` (invalid courses under
  `courses/invalid/`) and `golden/<name>.json`.

Fixtures are test data, not a delivery path for production assets. A model,
texture, audio clip or Wasm module never belongs in `fixtures/`.

## Saved meshes and audio

The SDF Modeler asset save writes a saved mesh next to each asset as
`assets/<world>/<id>.mesh` (the S24 meshWire encoding). It is a local cache: the
file is untracked (`*.mesh` in `.gitignore`) and is never committed. The game
lookup order is memory/IndexedDB cache, then the `.mesh` file, then browser MAMA
meshing; `content:pack` copies the file into the content root when it exists.

Audio patches are `audio/<id>.haa.json`. They live only under `audio/` or as a
small test fixture under `fixtures/`, never under `assets/` or `courses/`.

## Guard rules

`tools/guard.ts` refuses, for every tracked or staged file:

- binary extensions such as `.glb`, `.gltf`, `.png`, `.jpg`, `.ktx2`, `.bin`,
  `.wasm`, `.zip`, `.mp3`, `.mp4`, `.fbx`, `.ttf`, `.woff2`, `.pdf` and `.mesh`
  (the saved mesh);
- a NUL byte in the first 8000 bytes;
- bytes that are not valid UTF-8;
- more than 256 KiB (262144 bytes), with `package-lock.json` exempt; files
  under `assets/` may reach 2,200,000 bytes;
- data files outside their folders (rule `asset-outside-fixtures`):
  `.prims.json` and `.manifest.json` only under `fixtures/`; `.course.json`
  under `fixtures/` or `courses/`; `.asset.json` under `fixtures/` or directly in
  `assets/<world>/` (world `candy`, `ice`, `jungle`, `neon` or `common`);
  `.ui.json` under `ui/`; `.haa.json` under `fixtures/` or `audio/`;
- a non-JSON file under `fixtures/`, or one over 64 KiB;
- a public leak in any UTF-8 file (rule `public-leak`, see below).

## Public leaks

The repository is public. The `public-leak` rule runs `leakScan` on every file
that decodes as UTF-8 and reports:

- absolute home or root paths: a home directory under `/home` or `/Users`, the
  root user's home, or a Windows profile folder (`<drive>:\Users`);
- private-network IPv4 addresses (10/8, 172.16/12, 192.168/16); loopback and
  the any-address are allowed;
- internal host names: a dotted name ending in `.internal`, `.corp`, `.lan`,
  `.local` or `.intranet`, at a host position (line start, after a space, `//`,
  `@` or a quote), so code such as `f(this.local)` does not hit;
- token shapes: GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`
  followed by 20 or more token characters), private-key blocks (`BEGIN …
  PRIVATE KEY`), AWS access keys (`AKIA`/`ASIA` plus 16 characters) and Slack
  tokens (`xoxb-`, `xoxp-` and similar);
- every comma-separated substring of the environment variable `RF_GUARD_DENY`.

The violation line names the pattern and the line number and shows a short
excerpt in which the match is replaced by `<pattern>`; the matched text is never
printed. `tools/guard.ts` and `tools/test/guard.test.ts` are exempt because they
spell out the patterns (the tests build their token-shaped strings at run time).

`RF_GUARD_DENY` holds what only your machine knows, for example your user name,
machine name or a private server address. Set it in your shell profile or CI
secrets, never in a committed file: the list itself would be the leak. It is
read each time the guard runs and is never printed.

Proof records and transcripts (`proofs/mN/*.json`, command tails, logs) go
through `redact(text, secrets)` first, which replaces every known secret (tokens,
server URLs, temporary paths) with `<redacted>`. They are then checked with
`leakScan` before they are written or committed; a hit is a defect to fix in the
producer, never something to hide by editing the record.

A hit in a tracked file is either a real leak (remove it, and rotate the secret
if it was a credential) or a false positive (tighten the pattern in
`tools/guard.ts` and add the case to its tests). Never weaken a pattern only to
pass a file that really leaks.

## The pre-commit hook

`npm install` runs the `prepare` script, which runs
`git config core.hooksPath .githooks`. The hook `.githooks/pre-commit` then runs
the guard on the staged files of every commit:

```sh
#!/bin/sh
exec node --experimental-strip-types tools/guard.ts --staged
```

If your checkout already existed before `prepare` ran, run
`npm run prepare` once, or configure the path manually with the command above.

## Checking and fixing violations

Run the guard over all tracked files with:

```sh
npm run guard
```

It prints `guard: <n> files checked, <m> violations` followed by one
`<path>: <rule>: <detail>` line per violation and exits 1 when there is any
violation.

On a violation:

- **binary-ext / asset-outside-fixtures**: remove the file from git and upload
  it to the asset store with `raa-assets-tools`; reference it by its manifest
  hash or, for tests, move small JSON under `fixtures/`.
- **nul-byte / not-utf8**: the file is not text. Store it in the asset store, or
  re-save it as UTF-8 if it was meant to be source or JSON.
- **too-large / fixture-too-large**: split the data, shrink the fixture, or move
  the asset to the store. Never force-add it and never edit the limits to make
  a violation pass.
- **fixture-not-json**: fixtures are JSON only; convert or move the file.
- **public-leak**: see "Public leaks" above.

Removing a file that is already tracked only takes effect after the deletion is
committed. Assets accidentally committed earlier must be removed from history,
not just deleted in a later commit, because the blob stays in the repository.
