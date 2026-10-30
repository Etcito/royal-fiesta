import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildLevelPack, validateLevelPack, verifyLevelPack } from '../../packages/game/src/levelPack.ts'
import type { LevelPack } from '../../packages/game/src/levelPack.ts'
import { levelsHandler } from '../levels/server.ts'
import { packFromContent, publishPack } from '../levels/pack.ts'

const KEY = 'k'.repeat(40)

async function serve(): Promise<{ base: string; close: () => void }> {
  const handler = levelsHandler({ dir: mkdtempSync(join(tmpdir(), 'rf-levels-')), writeKey: KEY })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/levels`, close: () => server.close() }
}

test('a shipped course packs, validates strictly, publishes, lists and downloads with the same hash', async () => {
  const s = await serve()
  try {
    const pack = await packFromContent({ courseId: 'ice-slide-gates', title: 'Ice gates', author: 'tester' })
    await validateLevelPack(pack)
    const refused = await fetch(s.base, { method: 'POST', body: JSON.stringify(pack) })
    assert.equal(refused.status, 401)
    assert.equal(refused.headers.get('access-control-allow-origin'), '*')
    assert.equal(refused.headers.get('cross-origin-resource-policy'), 'cross-origin')
    const done = await publishPack(pack, { url: s.base, key: KEY })
    assert.equal(done.id, pack.manifest.id)
    assert.equal(done.existed, false)
    assert.equal((await publishPack(pack, { url: s.base, key: KEY })).existed, true)
    const list = await (await fetch(s.base)).json() as { levels: { id: string; contentHash: string }[] }
    assert.deepEqual(list.levels.map(l => [l.id, l.contentHash]), [[pack.manifest.id, pack.manifest.contentHash]])
    const got = await fetch(`${s.base}/${pack.manifest.id}`)
    assert.equal(got.headers.get('access-control-allow-origin'), '*')
    assert.equal(got.headers.get('cross-origin-resource-policy'), 'cross-origin')
    await verifyLevelPack(await got.json())
    assert.equal((await fetch(s.base, { method: 'OPTIONS' })).status, 204)
  } finally { s.close() }
})

test('the server refuses a tampered pack, a wrong key, an unused asset and an external URL', async () => {
  const s = await serve()
  try {
    const pack = await packFromContent({ courseId: 'ice-slide-gates' })
    const tampered: LevelPack = structuredClone(pack)
    const path = Object.keys(tampered.files)[1]
    tampered.files[path] = tampered.files[path] + ' '
    const r1 = await fetch(s.base, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify(tampered) })
    assert.equal(r1.status, 422)
    assert.match(((await r1.json()) as { reason: string }).reason, /size does not match|sha256/)
    const r2 = await fetch(s.base, { method: 'POST', headers: { Authorization: 'Bearer wrong-key-wrong-key-wrong-key' }, body: JSON.stringify(pack) })
    assert.equal(r2.status, 401)
    const unused = await buildLevelPack({
      title: 'x', author: 'y', courseId: pack.manifest.courseId,
      files: { ...pack.files, 'assets/common/common.extra.asset.json': pack.files[Object.keys(pack.files).find(p => p.startsWith('assets/'))!] },
    })
    await assert.rejects(validateLevelPack(unused))
    const url = await buildLevelPack({ title: 'x', author: 'y', courseId: pack.manifest.courseId, files: { ...pack.files, [path]: pack.files[path].replace('"name"', '"u":"https://example.com/x","name"') } })
    await assert.rejects(validateLevelPack(url))
  } finally { s.close() }
})
