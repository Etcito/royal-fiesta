import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { readAuthored } from '../authored.ts'
import { mamaSource, repoRoot } from '../bricks.ts'
import { buildContentIndex, contentPath } from '../content.ts'
import { parseGameAsset, type GameAsset } from '../../packages/game/src/gameAsset.ts'
import { loadCourseV1, type ResolvedGameAsset } from '../../packages/game/src/courseV1.ts'

const root = repoRoot()
const read = (path: string) => JSON.parse(readFileSync(contentPath(path, root), 'utf8'))
const authored = readAuthored(root).files.filter(path => path.endsWith('.asset.json'))

// Use the same MAMA checkout as Vite, never a copied list of accepted parameters.
// Missing MAMA is a failed prerequisite, not silently skipped content coverage.
async function mamaModule(path: string) {
  const source = mamaSource(root)
  assert.notEqual(source.kind, 'absent', 'authored render validation requires MAMA')
  if (source.kind === 'absent') throw new Error(source.reason)
  const file = join(source.dir, 'dist', path)
  assert.ok(existsSync(file), `built MAMA module required: ${file}`)
  return import(pathToFileURL(file).href)
}

test('authored material graphs validate every node parameter and build through MAMA', async () => {
  const { analyzeMaterialGraph } = await mamaModule('core/material-graph/graph.js')
  const { readSdfm, buildMaterial } = await mamaModule('sdfm.js')
  const errors: string[] = []
  for (const path of authored) {
    const asset = read(path)
    const doc = readSdfm(asset.document)
    for (const [id, material] of Object.entries(asset.document.materials ?? {})) {
      // Analysis includes unused nodes, which compilation can prune.
      const analysis = analyzeMaterialGraph(material, id)
      for (const issue of analysis.issues) {
        if (issue.severity === 'error') errors.push(`${path} ${issue.path}: ${issue.message}`)
      }
      const built = buildMaterial(doc, id)
      if (built.error || !built.graph) errors.push(`${path}#${id}: ${JSON.stringify(built.error)}`)
    }
  }
  assert.deepEqual(errors, [])
})

function checkParts(asset: GameAsset, parts: readonly string[], where: string): void {
  const nodes = asset.document.nodes as Record<string, { id: string; kind: string; asset?: unknown; children?: string[] }>
  // meshByParts emits names from direct children of asset groups, including hidden colliders.
  const names = new Set(Object.values(nodes).filter(n => n.kind === 'group' && n.asset)
    .flatMap(n => n.children ?? []).filter(id => nodes[id]?.id === id))
  for (const part of parts) assert.ok(names.has(part), `${where}: unknown renderer part '${part}' in ${asset.id}`)
}

test('authored assets and loaded course obstacles reference renderer-addressable parts', async () => {
  const index = buildContentIndex()
  const assets = new Map<string, ResolvedGameAsset>()
  for (const entry of index.assets) {
    const json = read(entry.path)
    const asset = await parseGameAsset(json, entry.path)
    assets.set(asset.id, { asset, source: { path: entry.path, json } })
    if (authored.includes(entry.path)) {
      for (const body of asset.physics?.bodies ?? []) checkParts(asset, body.parts, `${entry.path} body ${body.id}`)
    }
  }
  const resolver = { async resolve(id: string) {
    const resolved = assets.get(id)
    assert.ok(resolved, `missing course asset ${id}`)
    return resolved
  } }
  for (const entry of index.courses) {
    const course = await loadCourseV1(read(entry.path), entry.path, resolver)
    // These resolved body.parts are precisely what loadObstacles passes to setPartFilter.
    for (const item of course.sim?.mechanisms?.items ?? []) {
      const { asset } = await resolver.resolve(item.asset)
      for (const body of item.bodies) checkParts(asset, body.parts ?? [], `${entry.path} obstacle ${item.id} body ${body.id}`)
    }
  }
  const gate = (await resolver.resolve('ice.slide-gate')).asset
  checkParts(gate, ['post_left', 'post_right'], 'slide gate posts')
  assert.throws(() => checkParts(gate, ['missing_post'], 'negative fixture'), /unknown renderer part 'missing_post'/)
})
