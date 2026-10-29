// Transport parsing only: these fixtures are not GPU evidence and submit no jobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { captureResult, reviewInput, sequenceEncodingArgs, midWaddleJudgeArgs } from './cheer-laugh-capture.mjs'
import { captureFrameSequence, frameName } from './clip-review-frames.mjs'

test('blank probe requires the operation result, not transport success', () => {
  assert.throws(() => captureResult({ ok: true, result: { json: { error: 'page failed' } } }, 'ok', 'fixture'),
    /no object with "ok"/)
  assert.equal(captureResult({ ok: true, result: { json: { ok: false } } }, 'ok', 'fixture').ok, false)
  assert.equal(captureResult({ result: { json: { ok: true }, files: [] } }, 'ok', 'fixture').ok, true)
})

test('hardware evidence comes from the operation inside the transport', () => {
  const operation = { hardware: false, renderer: 'raa' }
  assert.equal(captureResult({ hardware: true, result: { json: operation } }, 'hardware', 'fixture'), operation)
  assert.throws(() => captureResult({ hardware: true }, 'hardware', 'fixture'), /result envelope missing/)
  assert.throws(() => captureResult({ hardware: true, result: {} }, 'hardware', 'fixture'),
    /no object with "hardware"/)
})

test('two-frame probe returns both PNGs without a MediaRecorder size or duration gate', async () => {
  const input = reviewInput('emote.cheer', 2), sampled = []
  const sequence = await captureFrameSequence(input, async sample => {
    sampled.push(sample)
    // Transport fixture only, not rendered evidence. Tiny blobs must still be returned.
    return new Blob(['png fixture'], { type: 'image/png' })
  })
  assert.deepEqual(sampled, [{ frame: 0, tick: 0, side: false }, { frame: 1, tick: 0, side: true }])
  assert.deepEqual(sequence.files.map(f => f.name), ['frame-0000.png', 'frame-0001.png'])
  const args = sequenceEncodingArgs(input, { video: sequence.video, files: sequence.files.map(f => f.name) }, '/gpu-return', '/review.webm')
  assert.equal(args[args.indexOf('-framerate') + 1], '30')
  assert.equal(args[args.indexOf('-frames:v') + 1], '2')
  assert.equal(args[args.indexOf('-i') + 1], '/gpu-return/frame-%04d.png')
  assert.equal(args.at(-1), '/review.webm')
})

test('full review samples the complete gesture from each camera and uses explicit four-second timing', async () => {
  for (const clip of ['emote.cheer', 'emote.laugh']) {
    const input = reviewInput(clip, 120), sampled = []
    const sequence = await captureFrameSequence(input, async sample => {
      sampled.push(sample); return new Blob(['fixture'], { type: 'image/png' })
    })
    assert.equal(input.width, 1280); assert.equal(input.height, 720)
    assert.equal(input.frames / input.fps, 4)
    assert.equal(sequence.files.length, 120)
    assert.deepEqual(sampled[59], { frame: 59, tick: 118, side: false })
    assert.deepEqual(sampled[60], { frame: 60, tick: 0, side: true })
    assert.deepEqual(sampled[119], { frame: 119, tick: 118, side: true })
    const result = { video: sequence.video, files: sequence.files.map(f => f.name) }
    assert.doesNotThrow(() => sequenceEncodingArgs(input, result, '/gpu-return', '/review.webm'))
    assert.throws(() => sequenceEncodingArgs(input, { ...result, files: result.files.slice(1) }, '/gpu-return', '/review.webm'), /Every GPU frame/)
    assert.throws(() => sequenceEncodingArgs(input, { ...result, video: { ...result.video, fps: 60 } }, '/gpu-return', '/review.webm'))
  }
})

test('missing readback fails instead of returning empty review media', async () => {
  await assert.rejects(captureFrameSequence(reviewInput('emote.laugh', 2), async () => new Blob([], { type: 'image/png' })), /Missing GPU PNG frame 0/)
  assert.equal(frameName(119), 'frame-0119.png')
})

test('four-command queue retains both emote judges and the prescribed mid-waddle judge', () => {
  const queue = JSON.parse(readFileSync(new URL('../../.nmc/commands.json', import.meta.url)))
  assert.deepEqual(queue.map(c => c.name), ['m19-cheer-laugh-bundle', 'm19-cheer-laugh-video', 'm19-cheer-judge', 'm19-laugh-judge'])
  const earlier = new Set()
  for (const entry of queue) {
    assert(!earlier.has(entry.name)); assert.equal(typeof entry.command, 'string')
    for (const dependency of entry.after ?? []) assert(earlier.has(dependency), dependency)
    earlier.add(entry.name)
  }
  for (const judge of queue.slice(2)) assert(judge.command.endsWith('--reference /refs/penguin-base-ortho.png --min-score 6'))
  assert.deepEqual(midWaddleJudgeArgs, ['proofs/m19/waddle.png', '--description',
    'In-game mid-waddle skinned penguin: rounded dark body, cream face and belly, two black eyes, orange beak and separate orange feet, long flippers attached at the shoulders. Match the silhouette, proportions and materials of /refs/penguin-base-ortho.png; the pose must remain coherent without detached parts or torn skin.',
    '--reference', '/refs/penguin-base-ortho.png', '--min-score', '6'])
})
