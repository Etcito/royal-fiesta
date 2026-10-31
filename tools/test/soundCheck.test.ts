import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { SOUND_GROUPS } from '../../packages/game/src/audio/catalog.ts'
import { MOVEMENT_FAMILIES } from '../../packages/game/src/audio/sounds/movement.ts'
import { WORLD_FAMILIES } from '../../packages/game/src/audio/sounds/world.ts'
import { FLOW_FAMILIES } from '../../packages/game/src/audio/sounds/flow.ts'
import { BED_FAMILIES, MUSIC_CUE_IDS } from '../../packages/game/src/audio/sounds/music.ts'
import { PICTURE_WIDTH, ROW_HEIGHT, soundCheck } from '../soundCheck.ts'

const rowsOf = (families: readonly { entries: readonly unknown[] }[]): number =>
  families.reduce((total, family) => total + family.entries.length, 0)

const EXPECTED_ROWS: Record<(typeof SOUND_GROUPS)[number], number> = {
  movement: rowsOf(MOVEMENT_FAMILIES),
  world: rowsOf(WORLD_FAMILIES),
  flow: rowsOf(FLOW_FAMILIES),
  music: MUSIC_CUE_IDS.length + rowsOf(BED_FAMILIES),
}

test('sound check renders every group without problems and draws one picture per group', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'rf-sound-check-'))
  try {
    const result = await soundCheck(outDir)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(result.groups.map(entry => entry.group), [...SOUND_GROUPS])
    for (const { group, picture } of result.groups) {
      assert.equal(picture, join(outDir, `${group}.png`))
      assert.ok(existsSync(picture), `${group} picture exists`)
      const metadata = await sharp(picture).metadata()
      assert.equal(metadata.format, 'png', group)
      assert.equal(metadata.width, PICTURE_WIDTH, group)
      assert.equal(metadata.height, EXPECTED_ROWS[group] * ROW_HEIGHT, group)
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
