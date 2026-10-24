import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  SKY_BLUE,
  artworkId,
  compositeOnSkyBlue,
  decodePng,
  encodePng,
  parseArgs,
  previewFile,
  previewInput,
  previewPath,
  resolveStates,
  sdfmDir,
  statesOf,
} from '../uiPreview.ts'

const FILE = {
  render: {
    states: {
      normal: [],
      hover: 'normal',
      pressed: [],
      disabled: 'normal',
      focus: [],
    },
  },
}

test('parseArgs takes an id and defaults to every state of the file', () => {
  assert.deepEqual(parseArgs(['button.inflatable']), { id: 'button.inflatable', states: [] })
  assert.deepEqual(parseArgs(['button.inflatable', 'pressed', 'hover', 'pressed']), {
    id: 'button.inflatable',
    states: ['pressed', 'hover'],
  })
})

test('parseArgs refuses a missing or invalid id', () => {
  assert.throws(() => parseArgs([]), /missing <id>/)
  assert.throws(() => parseArgs(['../escape']), /invalid id/)
  assert.throws(() => parseArgs(['button']), /invalid id/)
  assert.throws(() => parseArgs(['Button.inflatable']), /invalid id/)
  assert.throws(() => parseArgs(['--help']), /unknown option/)
})

test('parseArgs refuses an unknown state', () => {
  assert.throws(() => parseArgs(['button.inflatable', 'Normal']), /unknown state 'Normal'/)
  assert.throws(() => parseArgs(['button.inflatable', 'active']), /normal, hover, pressed, disabled, focus/)
})

test('statesOf lists the states of the file, normal first', () => {
  assert.deepEqual(statesOf(FILE), ['normal', 'hover', 'pressed', 'disabled', 'focus'])
  assert.deepEqual(statesOf({ render: { states: { hover: [], normal: [], focus: [] } } }), ['normal', 'hover', 'focus'])
  assert.deepEqual(statesOf({ states: { hover: {}, focus: {} } }), ['normal', 'hover', 'focus'])
  assert.deepEqual(statesOf({}), ['normal'])
})

test('resolveStates uses the requested states or the file default', () => {
  assert.deepEqual(resolveStates(FILE, []), ['normal', 'hover', 'pressed', 'disabled', 'focus'])
  assert.deepEqual(resolveStates(FILE, ['focus']), ['focus'])
})

test('the artwork id and the preview input follow SDF Modeler', () => {
  assert.equal(artworkId('button.inflatable'), 'button_inflatable')
  assert.equal(artworkId('hud.round-timer'), 'hud_round_timer')
  assert.deepEqual(previewInput('button.inflatable', 'pressed'), {
    id: 'button_inflatable',
    state: 'pressed',
    scale: 4,
    background: 'transparent',
  })
})

test('output names are out/ui-preview/<id>.<state>.png', () => {
  assert.equal(SKY_BLUE, '#8fd3ff')
  assert.equal(previewPath('button.inflatable', 'pressed'), 'out/ui-preview/button.inflatable.pressed.png')
  assert.equal(previewFile('/repo', 'button.inflatable', 'pressed'), resolve('/repo', 'out/ui-preview/button.inflatable.pressed.png'))
})

test('sdfmDir finds the read-only <card>-ro-sdfm peer and prefers SDFM_DIR', () => {
  const saved = { SDFM_DIR: process.env.SDFM_DIR, RF_BRICKS_DIR: process.env.RF_BRICKS_DIR }
  delete process.env.SDFM_DIR
  delete process.env.RF_BRICKS_DIR
  try {
    const base = mkdtempSync(join(tmpdir(), 'rf-ui-preview-'))
    const repo = join(base, 'game')
    const peer = join(base, '5012-ro-sdfm')
    mkdirSync(repo, { recursive: true })
    mkdirSync(join(peer, 'bin'), { recursive: true })
    writeFileSync(join(peer, 'bin', 'sdfm.mjs'), '')
    assert.equal(sdfmDir(repo), peer)
    const pinned = join(base, 'pinned')
    mkdirSync(join(pinned, 'bin'), { recursive: true })
    writeFileSync(join(pinned, 'bin', 'sdfm.mjs'), '')
    process.env.SDFM_DIR = pinned
    assert.equal(sdfmDir(repo), pinned)
  } finally {
    for (const key of ['SDFM_DIR', 'RF_BRICKS_DIR'] as const) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('the RGBA8 PNG codec round-trips one pixel', () => {
  const img = { width: 1, height: 1, data: new Uint8Array([12, 34, 56, 78]) }
  const back = decodePng(encodePng(img))
  assert.equal(back.width, 1)
  assert.equal(back.height, 1)
  assert.deepEqual([...back.data], [12, 34, 56, 78])
})

test('the transparent preview is composited onto the sky blue', () => {
  const data = new Uint8Array([
    0, 0, 0, 0,
    255, 0, 0, 255,
    255, 255, 255, 128,
    12, 34, 56, 0,
  ])
  const out = compositeOnSkyBlue(decodePng(encodePng({ width: 2, height: 2, data })))
  assert.deepEqual([...out.data.subarray(0, 4)], [0x8f, 0xd3, 0xff, 255])
  assert.deepEqual([...out.data.subarray(4, 8)], [255, 0, 0, 255])
  const edge = out.data.subarray(8, 12)
  assert.equal(edge[3], 255)
  assert.ok(edge[0] > 0x8f && edge[1] > 0xd3 && edge[2] === 0xff, 'half white lightens the sky')
  assert.deepEqual([...out.data.subarray(12, 16)], [0x8f, 0xd3, 0xff, 255])
})
