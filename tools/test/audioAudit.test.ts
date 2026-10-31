import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { FIESTA_FAMILIES } from '../../packages/game/src/audio/pack/index.ts'
import { auditAudio } from '../audioAudit.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** The patch ids of every audio/*.haa.json (the file stem is the patch id). */
function patchIds(): string[] {
  return readdirSync(join(root, 'audio'))
    .filter((name) => name.endsWith('.haa.json'))
    .sort()
    .map((name) => name.slice(0, -'.haa.json'.length))
}

test('the audit renders every pack variant and every patch variant to measured WAVs', async () => {
  const out = mkdtempSync(join(tmpdir(), 'rf-audio-audit-'))
  try {
    const rows = await auditAudio(out, () => {})
    const packRows = FIESTA_FAMILIES.reduce((count, family) => count + family.variants, 0)
    assert.equal(rows.length, packRows + 1 + patchIds().length * 3)

    for (const family of FIESTA_FAMILIES) {
      const variants = rows.filter((row) => row.engine === 'haa-0.1' && row.id === family.id)
      assert.equal(variants.length, family.variants, `${family.id} has one row per variant`)
    }
    assert.equal(rows.filter((row) => row.engine === 'haa-0.1' && row.id === 'crowd').length, 1)
    for (const id of patchIds()) {
      const variants = rows.filter((row) => row.engine === 'haa-0.2' && row.id === id)
      assert.equal(variants.length, 3, `${id} renders variants 0..2`)
    }

    for (const row of rows) {
      assert.ok(statSync(row.file).size > 0, `${row.id} wrote a non-empty WAV`)
      const { stats } = row
      for (const value of [stats.frames, stats.sampleRate, stats.peakDbfs, stats.rmsDbfs, stats.dc]) {
        assert.ok(Number.isFinite(value), `${row.id} has finite stats`)
      }
      assert.equal(stats.nonFinite, 0, `${row.id} has no non-finite samples`)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
