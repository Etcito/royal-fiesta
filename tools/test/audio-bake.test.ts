import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bakeAudio } from '../bake-audio.ts'
import { FIESTA_SOUNDS } from '../../packages/game/src/audio/ids.ts'
import { CROWD_FAMILIES } from '../../packages/game/src/audio/pack/index.ts'

test('the headless bake writes a manifest with every family the game plays, and the files it names', () => {
  const out = mkdtempSync(join(tmpdir(), 'rf-audio-bake-'))
  try {
    const manifest = bakeAudio(out, () => {})
    const ids = new Set(manifest.families.map((f) => f.id))
    for (const id of Object.values(FIESTA_SOUNDS)) assert.ok(ids.has(id), `manifest lacks ${id}`)
    for (const family of CROWD_FAMILIES) assert.ok(ids.has(family.id), `manifest lacks ${family.id}`)
    for (const entry of manifest.families) {
      assert.ok(statSync(join(out, entry.file)).size > 0, `${entry.file} is empty`)
    }
    const onDisk = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { families: { id: string }[] }
    assert.deepEqual(onDisk.families.map((f) => f.id), manifest.families.map((f) => f.id))
    assert.ok(existsSync(join(out, 'haa-processors.js')), 'the HAA worklet is copied next to the manifest')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
