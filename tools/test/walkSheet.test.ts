import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { walkSheet } from '../walkSheet.ts'

test('walk sheet contains posed silhouettes in all six 1200x800 cells', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'walk-sheet-'))
  try {
    const file = join(dir, 'nested', 'phases.png')
    assert.deepEqual(await walkSheet(file), { width: 1200, height: 800, phases: [0, 0.25, 0.5] })
    const metadata = await sharp(file).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 1200)
    assert.equal(metadata.height, 800)
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const background = data.subarray(0, 4)
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
      // Check both silhouette regions, excluding labels and ground so decoration cannot pass.
      for (let view = 0; view < 2; view++) {
        let nonEmpty = false
        for (let y = row*400+80; y < row*400+320 && !nonEmpty; y++) {
          for (let x = col*400+view*200+10; x < col*400+view*200+190; x++) {
            const p = (y*info.width+x)*4
            if (!data.subarray(p,p+4).equals(background)) { nonEmpty = true; break }
          }
        }
        assert.ok(nonEmpty, `row ${row}, column ${col}, view ${view} contains a silhouette`)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
