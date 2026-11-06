import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mamaSource, repoRoot } from './bricks.ts'

interface UiAssetApi {
  parseUiAsset(text: string): { drawing: unknown }
  buildUiAssetFile(drawing: unknown, game: string): { file: unknown; dropped: unknown[] }
  serializeUiAsset(file: unknown): string
}

export async function loadUiAssetApi(root: string): Promise<UiAssetApi> {
  try {
    const source = mamaSource(root)
    if (source.kind === 'absent') throw new Error(source.reason)
    const specifier = pathToFileURL(join(source.dir, 'dist/core/svgplus/ui-asset.js')).href
    const api = await import(specifier)
    for (const name of ['parseUiAsset', 'buildUiAssetFile', 'serializeUiAsset']) {
      if (typeof api[name] !== 'function') throw new Error(`MAMA dist lacks ${name}`)
    }
    return api
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`MAMA not available: ${reason}; run npm run bricks -- fetch mama and build MAMA`)
  }
}

export function bakeUiAsset(root: string, id: string, api: UiAssetApi): void {
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(id)) throw new Error(`invalid UI asset id: ${id}`)
  const path = join(root, 'ui', `${id}.ui.json`)
  const { drawing } = api.parseUiAsset(readFileSync(path, 'utf8'))
  const { file, dropped } = api.buildUiAssetFile(drawing, 'royal-fiesta')
  const text = api.serializeUiAsset(file)
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
  for (const item of dropped) console.warn(`Dropped: ${JSON.stringify(item)}`)
  console.log(`Baked ui/${id}.ui.json (${Buffer.byteLength(text)} bytes)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const id = process.argv[2]
    if (!id || process.argv.length !== 3) throw new Error('usage: node --experimental-strip-types tools/uiAssetBake.ts <id>')
    const root = repoRoot()
    bakeUiAsset(root, id, await loadUiAssetApi(root))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
