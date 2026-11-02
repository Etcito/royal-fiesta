import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSavedMeshes } from '../savedMeshes.ts'
import { mamaSource } from '../bricks.ts'
import { MESH_COMPATIBILITY } from '../../apps/web/src/sdf/meshCache.ts'

test('saved mesh guard lists every missing asset by id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-saved-mesh-'))
  try {
    mkdirSync(join(dir, 'assets/candy'), {recursive:true})
    mkdirSync(join(dir, 'courses'))
    for (const id of ['candy.banner', 'candy.cloud']) cpSync(new URL(`../../assets/candy/${id}.asset.json`, import.meta.url), join(dir, `assets/candy/${id}.asset.json`))
    await assert.rejects(checkSavedMeshes(dir), /Invalid saved meshes \(2\/2\):\ncandy.banner: missing.*\ncandy.cloud: missing/)
  } finally { rmSync(dir, { recursive:true, force:true }) }
})

test('saved mesh version matches the MAMA save contract', () => {
  const mama = mamaSource()
  if (mama.kind === 'absent') return
  const source = readFileSync(join(mama.dir, 'src/core/game/mesh-file.ts'), 'utf8')
  assert.ok(source.includes(`export const MESH_COMPATIBILITY = '${MESH_COMPATIBILITY}'`))
})
