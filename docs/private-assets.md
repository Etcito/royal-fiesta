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

## Fixtures

`fixtures/` contains small JSON only:

- every file is `.json`;
- at most 64 KiB per file;
- `assets/<name>.prims.json`, `courses/<id>.course.json` (invalid courses under
  `courses/invalid/`) and `golden/<name>.json`.

Fixtures are test data, not a delivery path for production assets. A model,
texture, audio clip or Wasm module never belongs in `fixtures/`.

## Guard rules

`tools/guard.ts` refuses, for every tracked or staged file:

- binary extensions such as `.glb`, `.gltf`, `.png`, `.jpg`, `.ktx2`, `.bin`,
  `.wasm`, `.zip`, `.mp3`, `.mp4`, `.fbx`, `.ttf`, `.woff2` and `.pdf`;
- a NUL byte in the first 8000 bytes;
- bytes that are not valid UTF-8;
- more than 256 KiB (262144 bytes), with `package-lock.json` exempt;
- `.prims.json`, `.course.json` or `.manifest.json` outside `fixtures/`;
- a non-JSON file under `fixtures/`, or one over 64 KiB.

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

Removing a file that is already tracked only takes effect after the deletion is
committed. Assets accidentally committed earlier must be removed from history,
not just deleted in a later commit, because the blob stays in the repository.
