// --build runs here; --capture belongs exclusively to the programmatic client-GPU executor.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodePng, unwrapOp } from '../../apps/headless/src/gpuRecord.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const destination = join(root, 'proofs/m19'), dist = join(root, 'out/m19-cheer-laugh')
const execution = join(destination, 'cheer-laugh-execution')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const exec = promisify(execFile)
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
  mkdirSync(execution, { recursive: true })
  const call = (...args) => run(process.execPath, [client, ...args])
  const publish = async dir => {
    const result = JSON.parse(await call('publish', dir))
    assert.equal(typeof result.page_ref, 'string'); return result.page_ref
  }
  const render = async (pageRef, label, input) => {
    const out = join(execution, label); mkdirSync(out, { recursive: true })
    const file = join(out, 'input.json'); json(file, input)
    await call('render', file, '--page-ref', pageRef, '-o', out)
    const record = join(out, 'result.json')
    const result = unwrapOp({ file: record, json: read(record) }, label === 'blank' ? 'ok' : 'hardware').out
    if (label !== 'blank') {
      assert.equal(result.hardware, true)
      assert.equal(result.renderer, 'raa')
      assert.equal(result.adapter.isFallbackAdapter, false)
      assert(!/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(result.adapter)))
      assert.equal(result.clip, input.clip); assert.equal(result.frames, input.frames)
      nonEmpty(join(out, `${input.clip}.png`), input.width, input.height)
    }
    return { out, result }
  }
  const blank = await render(await publish(join(dist, 'probe')), 'blank', {})
  assert.equal(blank.result.ok, true)
  const pageRef = await publish(dist)
  json(join(execution, 'published.json'), { pageRef })
  const remux = (input, output) => run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-c', 'copy', output])
  for (const clip of ['emote.cheer', 'emote.laugh']) {
    const small = { clip, width: 320, height: 180, fps: 30 }
    await render(pageRef, `${clip}-one-frame`, { ...small, frames: 1 })
    const two = await render(pageRef, `${clip}-two-frame`, { ...small, frames: 2 })
    assert(existsSync(join(two.out, `penguin-${clip}.webm`)), 'Missing two-frame video probe')
    await remux(join(two.out, `penguin-${clip}.webm`), join(two.out, 'seekable.webm'))
    const { out, result } = await render(pageRef, clip, { clip, width: 1280, height: 720, fps: 30, frames: 120 })
    assert.deepEqual(result.files, [`${clip}.png`, `penguin-${clip}.webm`, `${clip}-reference.png`])
    copyFileSync(join(out, `${clip}.png`), join(destination, `${clip}.png`))
    copyFileSync(join(out, `${clip}-reference.png`), join(destination, `${clip}-reference.png`))
    const video = join(destination, `penguin-${clip}.webm`)
    await remux(join(out, `penguin-${clip}.webm`), video)
    const media = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
    assert(media.streams.some(s => s.codec_type === 'video' && s.width === 1280 && s.height === 720))
    assert(Number(media.format.duration) >= 3.9, 'Four seconds of review media required')
    json(join(out, 'media.json'), media)
  }
  console.log('Cheer/laugh hardware videos returned under proofs/m19; judge and human review remain required')
}
assert(process.argv.includes('--build') || process.argv.includes('--capture'), 'Use --build or --capture')
if (process.argv.includes('--build')) await bundle()
if (process.argv.includes('--capture')) await capture()
