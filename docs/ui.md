# Royal Fiesta UI (uaa)

The menus and the round HUD are drawn by uaa on a WebGPU canvas. The authored assets live in `ui/`, the screen document is `ui/screens.ui-doc.json`, and the proof is `scripts/proof/ui-screens.mjs`.

## Assets

Each widget drawing is one file, `ui/<id>.ui.json`, authored in SDF Modeler. Save it with `ui_asset_save` and `game_dir` so the file lands in `ui/`. The drawing stays editable and carries a baked render section that uaa reads.

`ui/assets.json` lists every asset id once, under `real` (final artwork) or `placeholder` (a stand-in still to be drawn). The proof checks that each `ui/*.ui.json` file appears in exactly one of the two lists.

To preview an asset in every state:

```
node --experimental-strip-types tools/uiPreview.ts <id> [state...]
```

The states are `normal`, `hover`, `pressed`, `disabled` and `focus`; with no state listed, every state of the file is written. PNGs go to `out/ui-preview/<id>.<state>.png`, composited on the sky blue of ref-1 for review.

## Font

The UI font is Fredoka 700, licensed under OFL-1.1, pinned to the fontsource release `fredoka@5.3.0`. `ui/fonts.json` is the font registry uaa reads: family, weight, the asset-store URL, sha256, byte length, licence and source. The URL is derived from the sha256.

The `.woff2` file is never committed. `tools/uiFont.ts` handles it:

- `fetch` downloads the file from the pinned source into `out/fonts`, and checks it against the registry.
- `upload` publishes it to the asset store through the `raa-assets` CLI from `@etcito/raa-assets-tools`. The credentials come only from the environment: `ASSET_STORE_SSH` and `ASSET_STORE_KEY`. They are never printed.
- `verify` fetches the registered URL and checks the sha256 and byte length.

Run it as `node --experimental-strip-types tools/uiFont.ts fetch|upload|verify [family]`.

## Screen document and widget ids

`ui/screens.ui-doc.json` (format `uaa.ui-doc` v1) holds one screen per id in `SCREENS` in `packages/game/src/screens/nav.ts`, and the round HUD is the `round` screen. The navigation state machine itself is unchanged; the screens only draw it.

Widget ids are lowercase kebab-case, because uaa ids allow no dots: `title`, `hint`, `line-<i>`, `row-<i>`, `act-<kebab action>`, `back`, and HUD widgets `hud-<name>`. Button `action` strings keep the names used in `nav.ts` and `menuModel.ts`.

`apps/web/src/ui/screenMap.ts` maps a menu model to the screen and widget props. Its test reads the doc and fails, naming the id, when a `SCREENS` id or a widget id or action string that the mapping uses is missing from its screen.

## Host layering

`apps/web/game.html` has `main#views` (the game canvases) and `div#screens` above it, which contains `canvas#ui`. The `#screens` layer passes pointer events through, so the game still takes input except where a uaa widget is clicked. `apps/web/src/ui/uaaHost.ts` creates the WebGPU renderer on `canvas#ui`.

There is no fallback. If the GPU or an asset is unavailable, the host rejects (for example `GPU_UNAVAILABLE`), and boot fails through the boot-error path with the uaa message. No DOM menu or Canvas2D substitute is drawn.

## Validation

uaa's validator checks every asset (`validateUiAsset`, with typed issues). Assets are kept under 256 KiB. The proof loads them with `loadUiAsset` and the document with `loadUiDoc`, which checks the asset ids the doc uses.

## Evidence (uiTour)

Captures are produced by a `uiTour` run on the GPU client, not in the sandbox. The tour drives the game with real clicks and keys, and records for each screen the inputs and the screen id the host reported. The PNGs go to `out/ui/<screen>.png`, which is untracked. The committed record is `proofs/ui/screens.json`: one entry per screen (12 screens plus the round HUD) with its inputs, capture path, sha256 and size.

Status: the `uiTour` script is not on this branch yet, so these captures do not exist yet. The proof reports the evidence as failing until they do.

## Proof

```
node scripts/proof/ui-screens.mjs [--only assets|screens|evidence|build]
```

It prints one `PASS` or `FAIL` line per check:

- `assets`: every `ui/*.ui.json` validates with uaa, and `ui/assets.json` lists the real and placeholder ids.
- `screens`: `ui/screens.ui-doc.json` loads, every `SCREENS` id has a screen, the `round` screen has HUD widgets, and every label font is in `ui/fonts.json` with an asset-store URL.
- `evidence`: `proofs/ui/screens.json` has one entry per screen and HUD, each with real inputs and a hash-matched PNG where one exists.
- `build`: `npm run web:build` succeeds and the bundle contains uaa's WebGPU renderer.
