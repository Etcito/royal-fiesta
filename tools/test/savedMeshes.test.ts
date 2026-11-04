import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSavedMeshes, mamaMeshCompatibility } from '../savedMeshes.ts'
import { mamaSource } from '../bricks.ts'

test('saved mesh guard lists every missing asset by id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-saved-mesh-'))
  try {
    mkdirSync(join(dir, 'assets/candy'), {recursive:true})
    mkdirSync(join(dir, 'courses'))
    for (const id of ['candy.banner', 'candy.cloud']) cpSync(new URL(`../../assets/candy/${id}.asset.json`, import.meta.url), join(dir, `assets/candy/${id}.asset.json`))
    await assert.rejects(checkSavedMeshes(dir), /Invalid saved meshes \(2\/2\):\ncandy.banner: missing.*\ncandy.cloud: missing/)
  } finally { rmSync(dir, { recursive:true, force:true }) }
})

test('the saved mesh key follows the pinned MAMA; Royal Fiesta holds no copy of MESH_COMPATIBILITY', async () => {
  const mama = mamaSource()
  if (mama.kind === 'absent') return
  const source = readFileSync(join(mama.dir, 'src/core/game/mesh-file.ts'), 'utf8')
  const declared = /export const MESH_COMPATIBILITY = '([^']+)'/.exec(source)?.[1]
  assert.ok(declared, 'MAMA core/game/mesh-file.ts declares MESH_COMPATIBILITY')
  // The Node mesher reads MAMA's built dist: equal to the source unless MAMA needs npm run build.
  assert.equal(await mamaMeshCompatibility(), declared)
  const web = new URL('../../apps/web/src/', import.meta.url).pathname
  for (const file of readdirSync(web, { recursive: true }).map(String).filter(f => f.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(join(web, file), 'utf8'), /MESH_COMPATIBILITY\s*=/, `apps/web/src/${file} holds a copy of MAMA's MESH_COMPATIBILITY`)
  }
})
