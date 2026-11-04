import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSavedMeshes, mamaMeshCompatibility, prebuildSavedMeshes, savedMeshIssues } from '../savedMeshes.ts'
import { mamaSource } from '../bricks.ts'
import { decodeMesh, encodeMesh } from '../../apps/web/src/sdf/meshWire.ts'

// A content dir with candy.cloud whose saved mesh carries a stale key (made with an older MESH_COMPATIBILITY).
function staleCloud(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-saved-mesh-'))
  mkdirSync(join(dir, 'assets/candy'), { recursive: true })
  mkdirSync(join(dir, 'courses'))
  cpSync(new URL('../../assets/candy/candy.cloud.asset.json', import.meta.url), join(dir, 'assets/candy/candy.cloud.asset.json'))
  const saved = decodeMesh(new Uint8Array(readFileSync(new URL('../../assets/candy/candy.cloud.mesh', import.meta.url))))
  writeFileSync(join(dir, 'assets/candy/candy.cloud.mesh'), encodeMesh({ ...saved, key: 'f'.repeat(64) }))
  return dir
}

// Owner 2026-11-04: "stale meshes must be redone when we build". The prebuild step re-meshes a stale saved mesh
// (MeshBaker) into the content dir, then checks every saved mesh as before.
test('the build re-meshes a stale saved mesh, then checks it', async () => {
  const dir = staleCloud()
  try {
    assert.deepEqual((await savedMeshIssues(dir)).issues.map(i => [i.id, i.code]), [['candy.cloud', 'algorithm']])
    await prebuildSavedMeshes(dir, join(dir, 'cache'))
    assert.deepEqual((await savedMeshIssues(dir)).issues, [])
    await checkSavedMeshes(dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a saved mesh the build cannot re-mesh fails the build, naming the asset and why', async () => {
  const dir = staleCloud()
  const saved = process.env.RF_MESH_TIMEOUT_S
  try {
    process.env.RF_MESH_TIMEOUT_S = '0.001'
    await assert.rejects(prebuildSavedMeshes(dir, join(dir, 'cache')), /Invalid saved meshes \(1\/1\):\ncandy\.cloud: stale saved mesh.*the re-mesh failed: .*timed out/)
  } finally {
    if (saved === undefined) delete process.env.RF_MESH_TIMEOUT_S
    else process.env.RF_MESH_TIMEOUT_S = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

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
