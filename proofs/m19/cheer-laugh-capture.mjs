// --build runs here; --capture belongs exclusively to the programmatic client-GPU executor.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodePng, unwrapOp } from '../../apps/headless/src/gpuRecord.ts'
import { frameName } from './clip-review-frames.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const destination = join(root, 'proofs/m19'), dist = join(root, 'out/m19-cheer-laugh')
const execution = join(destination, 'cheer-laugh-execution')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const exec = promisify(execFile)
// The transport can itself contain `ok`; inspect only its operation result, as in m18.
export function captureResult(envelope, key, file) {
  assert(envelope && Object.hasOwn(envelope, 'result'), 'GPU client result envelope missing')
  return unwrapOp({ file, json: envelope.result }, key).out
}
export function reviewInput(clip, frames) {
  assert(['emote.cheer', 'emote.laugh', 'waddle'].includes(clip))
  assert([1, 2, 120].includes(frames))
  assert(clip !== 'waddle' || frames === 1)
  return { clip, frames, width: frames === 120 ? 1280 : 320,
    height: frames === 120 ? 720 : 180, fps: 30,
    ...(frames > 1 ? { videoFormat: 'png-sequence' } : {}) }
}
export function sequenceEncodingArgs(input, result, directory, output) {
  assert.equal(input.videoFormat, 'png-sequence')
  assert.deepEqual(result.video, { format: 'png-sequence', pattern: 'frame-%04d.png', frames: input.frames, fps: input.fps })
  assert.deepEqual(result.files.filter(name => name.startsWith('frame-')),
    Array.from({ length: input.frames }, (_, i) => frameName(i)), 'Every GPU frame must be returned in order')
  return ['-y', '-v', 'error', '-framerate', String(input.fps), '-start_number', '0',
    '-i', join(directory, result.video.pattern), '-frames:v', String(input.frames),
    '-an', '-c:v', 'libvpx-vp9', '-threads', '1', '-pix_fmt', 'yuv420p', output]
}
async function run(command, args) {
  return (await exec(command, args, { cwd: root, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })).stdout
}
async function bundle() {
  const require = createRequire(import.meta.url), { build } = await import('vite')
  await build({ configFile: false, root, base: './', publicDir: false, logLevel: 'warn',
    resolve: { alias: ['@etcito/raa', '@etcito/raa-anim'].map(find => ({ find, replacement: require.resolve(find) })) },
    build: { outDir: dist, emptyOutDir: true, assetsInlineLimit: 0,
      rollupOptions: { input: join(destination, 'clip-review.mjs'), output: { entryFileNames: 'review.js' } } } })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Cheer and laugh review</title><script type="module" src="./review.js"></script>')
  json(join(dist, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  copyFileSync(join(root, 'assets/common/penguin.body.asset.json'), join(dist, 'penguin.body.asset.json'))
  json(join(dist, 'capture-source.json'), {
    sourceRevision: (await run('git', ['rev-parse', 'HEAD'])).trim(),
    assetRevision: (await run('git', ['log', '-1', '--format=%H', '--', 'assets/common/penguin.body.asset.json'])).trim(),
    assetPath: 'assets/common/penguin.body.asset.json',
    assetHash: read(join(dist, 'penguin.body.asset.json')).hash,
  })
  copyFileSync(join(destination, 'penguin-fall-dive.glb'), join(dist, 'penguin-fall-dive.glb'))
  copyFileSync('/refs/penguin-base-ortho.png', join(dist, 'penguin-base-ortho.png'))
  const probe = join(dist, 'probe'); mkdirSync(probe)
  json(join(probe, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  writeFileSync(join(probe, 'index.html'), '<script>window.nmcGpu={ops:{render:async()=>({json:{ok:true},files:[]})}}</script>')
  console.log(`Built ${dist}; no GPU job submitted`)
}
function nonEmpty(file, width, height) {
  const { data, channels } = decodePng(readFileSync(file), width, height, file)
  // Measure the central subject region, away from the video label and background margins.
  const colors = new Set()
  for (let y = Math.floor(height / 4); y < height * 3 / 4; y++) {
    for (let x = Math.floor(width / 4); x < width * 3 / 4; x++) {
      const i = (y * width + x) * channels
      colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
    }
  }
  assert(colors.size > 32, 'Capture lacks a shaded subject')
}
async function capture() {
  const client = process.env.NMC_GPU_CLIENT
  assert(client && existsSync(client), 'Run --capture on the programmatic client-GPU executor')
  const source = read(join(dist, 'capture-source.json'))
  mkdirSync(execution, { recursive: true })
  const call = (...args) => run(process.execPath, [client, ...args])
  const publish = async dir => {
    const result = JSON.parse(await call('publish', dir))
    assert.equal(typeof result.page_ref, 'string'); return result.page_ref
  }
  const render = async (pageRef, label, input) => {
    const out = join(execution, label); mkdirSync(out, { recursive: true })
    const file = join(out, 'input.json'); json(file, input)
    const submittedAt = new Date().toISOString()
    await call('render', file, '--page-ref', pageRef, '-o', out)
    const record = join(out, 'result.json')
    json(join(out, 'submission.json'), { operation: 'render', pageRef, input,
      source, submittedAt, returnedAt: new Date().toISOString(), result: 'result.json' })
    const result = captureResult(read(record), label === 'blank' ? 'ok' : 'hardware', record)
    if (label !== 'blank') {
      assert.equal(result.hardware, true)
      assert.equal(result.renderer, 'raa')
      assert.equal(result.adapter.isFallbackAdapter, false)
      assert(!/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(result.adapter)))
      assert.equal(result.clip, input.clip); assert.equal(result.frames, input.frames)
      if (input.clip !== 'waddle') {
        assert.equal(result.source?.sourceRevision, source.sourceRevision)
        assert.equal(result.source?.assetRevision, source.assetRevision)
      }
      nonEmpty(join(out, `${input.clip}.png`), input.width, input.height)
    }
    return { out, result }
  }
  const blank = await render(await publish(join(dist, 'probe')), 'blank', {})
  assert.equal(blank.result.ok, true)
  const pageRef = await publish(dist)
  json(join(execution, 'published.json'), { pageRef, source })
  const encode = async ({ out, result }, input, video) => {
    // ffmpeg encodes returned hardware-GPU PNGs; it never renders any geometry.
    await run('ffmpeg', sequenceEncodingArgs(input, result, out, video))
    const media = JSON.parse(await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', video]))
    assert(media.streams.some(s => s.codec_type === 'video' && s.width === input.width && s.height === input.height
      && Number(s.nb_read_frames) === input.frames), 'Encoded video must contain every returned GPU frame')
    assert(Number(media.format.duration) >= input.frames / input.fps - 0.01)
    json(join(out, 'media.json'), media)
  }
  for (const clip of ['emote.cheer', 'emote.laugh']) {
    await render(pageRef, `${clip}-one-frame`, reviewInput(clip, 1))
    const twoInput = reviewInput(clip, 2)
    const two = await render(pageRef, `${clip}-two-frame`, twoInput)
    await encode(two, twoInput, join(two.out, `penguin-${clip}.webm`))
    const input = reviewInput(clip, 120), capture = await render(pageRef, clip, input)
    const { out, result } = capture
    assert.deepEqual(result.files, [`${clip}.png`, ...Array.from({ length: 120 }, (_, i) => frameName(i)), `${clip}-reference.png`])
    copyFileSync(join(out, `${clip}.png`), join(destination, `${clip}.png`))
    copyFileSync(join(out, `${clip}-reference.png`), join(destination, `${clip}-reference.png`))
    const video = join(destination, `penguin-${clip}.webm`)
    await encode(capture, input, video)
  }
  // Retain the prescribed fresh mid-waddle capture and judge in this four-command queue.
  const waddleInput = { ...reviewInput('waddle', 1), width: 1280, height: 720 }
  const waddle = await render(pageRef, 'waddle', waddleInput)
  for (const file of ['waddle.png', 'waddle-reference.png']) copyFileSync(join(waddle.out, file), join(destination, file))
  await assemble()
  await judgeMidWaddle()
}
export const midWaddleJudgeArgs = ['proofs/m19/waddle.png', '--description',
  'In-game mid-waddle skinned penguin: rounded dark body, cream face and belly, two black eyes, orange beak and separate orange feet, long flippers attached at the shoulders. Match the silhouette, proportions and materials of /refs/penguin-base-ortho.png; the pose must remain coherent without detached parts or torn skin.',
  '--reference', '/refs/penguin-base-ortho.png', '--min-score', '6']
async function judgeMidWaddle() {
  const client = process.env.NMC_JUDGE_CLIENT
  assert(client && existsSync(client), 'Programmatic executor must provide NMC_JUDGE_CLIENT')
  const record = { command: ['python3', client, ...midWaddleJudgeArgs], at: new Date().toISOString() }
  try {
    const output = await run('python3', [client, ...midWaddleJudgeArgs])
    json(join(execution, 'mid-waddle-judge.json'), { ...record, exit: 0, output })
  } catch (error) {
    json(join(execution, 'mid-waddle-judge.json'), { ...record, exit: error.code, output: error.stdout, stderr: error.stderr })
    throw error
  }
}
async function assemble() {
  const clips = ['emote.cheer', 'emote.laugh'], videos = []
  const { source } = read(join(execution, 'published.json'))
  assert(source?.sourceRevision && source?.assetRevision, 'Missing capture source revisions')
  assert.equal(source.assetPath, 'assets/common/penguin.body.asset.json')
  for (const clip of clips) {
    const record = join(execution, clip, 'result.json')
    const result = captureResult(read(record), 'hardware', record)
    assert.equal(result.hardware, true)
    assert.equal(result.renderer, 'raa')
    assert.equal(result.adapter.isFallbackAdapter, false)
    assert(!/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(result.adapter)))
    assert.equal(result.clip, clip); assert.equal(result.frames, 120)
    assert.equal(result.fps, 30)
    assert.equal(result.source?.sourceRevision, source.sourceRevision)
    assert.equal(result.source?.assetRevision, source.assetRevision)
    nonEmpty(join(destination, `${clip}.png`), 1280, 720)
    assert(existsSync(join(destination, `${clip}-reference.png`)), 'Missing reference comparison')
    const video = join(destination, `penguin-${clip}.webm`)
    const media = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
    assert(media.streams.some(s => s.codec_type === 'video' && s.width === 1280 && s.height === 720))
    assert(Number(media.format.duration) >= 3.9)
    videos.push(video)
  }
  // Encode only returned client-GPU frames. This step never renders or substitutes poses.
  const file = join(destination, 'penguin-cheer-laugh.mp4')
  await run('ffmpeg', ['-y', '-v', 'error', '-threads', '1', '-i', videos[0], '-threads', '1', '-i', videos[1],
    '-filter_complex_threads', '1', '-filter_complex',
    '[0:v]fps=30,setpts=PTS-STARTPTS[v0];[1:v]fps=30,setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file])
  const media = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]))
  assert(media.streams.some(s => s.codec_name === 'h264' && s.width === 1280 && s.height === 720))
  assert(Number(media.format.duration) >= 7.8, 'Both complete review segments required')
  json(join(execution, 'combined-media.json'), media)
  const manifest = join(destination, 'cheer-laugh-media.json')
  json(manifest, { ...read(manifest), renderedReview: true, review: {
    file: 'proofs/m19/penguin-cheer-laugh.mp4', renderer: 'raa', hardware: true,
    source,
    seconds: Number(media.format.duration), bytes: Number(media.format.size), visualApproval: 'pending',
    clips: clips.map(clip => ({ name: clip, video: `proofs/m19/penguin-${clip}.webm`,
      capture: `proofs/m19/${clip}.png`, comparison: `proofs/m19/${clip}-reference.png`,
      execution: `proofs/m19/cheer-laugh-execution/${clip}/result.json` }))
  } })
  console.log('Wrote proofs/m19/penguin-cheer-laugh.mp4 from hardware captures; visual review remains required')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(['--build', '--capture', '--assemble'].some(flag => process.argv.includes(flag)), 'Use --build, --capture or --assemble')
  if (process.argv.includes('--build')) await bundle()
  if (process.argv.includes('--capture')) await capture()
  else if (process.argv.includes('--assemble')) await assemble()
}
