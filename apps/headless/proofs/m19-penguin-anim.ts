// CPU checks/build run on the model card; --capture runs only on the GPU executor (Q4).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadRaaAnim } from '@etcito/raa-anim'
import { parseGameAsset } from '../../../packages/game/src/gameAsset.ts'
import { decodePng, pngNonEmpty, unwrapOp } from '../src/gpuRecord.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dist = join(root, 'out/m19-clip-review'), destination = join(root, 'proofs/m19')
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const exec = promisify(execFile)
async function run(command: string, args: string[]): Promise<string> {
  return (await exec(command, args, { cwd: root, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })).stdout
}
async function verify() {
  const asset = read(join(root, 'assets/common/penguin.body.asset.json'))
  await parseGameAsset(asset, 'assets/common/penguin.body.asset.json')
  const node = asset.document.nodes.penguin
  const prior = JSON.parse(await run('git', ['show', 'a73d1ce:assets/common/penguin.body.asset.json'])).document.nodes.penguin
  assert.deepEqual(node.rig, prior.rig, 'owner rig and bindings must remain intact')
  const priorNames = new Set(prior.clips.map((c: { name: string }) => c.name))
  assert.deepEqual(node.clips.filter((c: { name: string }) => priorNames.has(c.name)), prior.clips, 'preserve all prior clips')
  const { bindings, smooth, ...preset } = node.rig
  const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
  const poses = new Map<string, Float32Array>()
  try {
    for (const definition of node.clips) {
      const clip = api.loadClip(rig, JSON.stringify(definition))
      try {
        for (let tick = 0; tick <= definition.lengthTicks * 2; tick++) {
          const pose = api.sampleClip(clip, tick)
          assert.equal(pose.skin.length, 12 * 16); assert(pose.skin.every(Number.isFinite))
          assert(pose.rootDelta.every(n => n === 0), `${definition.name} must not move simulation`)
        }
        if (definition.name === 'fall') {
          const a = api.sampleClip(clip, 8).local, b = api.sampleClip(clip, 24).local
          for (const name of ['upper.l', 'upper.r']) {
            const start = preset.bones.findIndex((b: { name: string }) => b.name === name) * 10 + 3
            assert(a.slice(start, start + 4).some((v, i) => Math.abs(v - b[start + i]) > 0.1), 'fall flippers must move')
          }
          assert.deepEqual(api.sampleClip(clip, 0).skin, api.sampleClip(clip, definition.lengthTicks).skin)
        }
        if (definition.name === 'bellySlide' || definition.name === 'handPush') {
          assert.equal(definition.loop, true); assert.equal(definition.rootMotion, 'none')
          assert.deepEqual(api.sampleClip(clip, 0).skin, api.sampleClip(clip, definition.lengthTicks).skin, `${definition.name} loop seam`)
        }
        poses.set(definition.name, api.sampleClip(clip, 16).local)
      } finally { clip.free() }
    }
    const fall = poses.get('fall')!, dive = poses.get('dive')!
    assert(Math.abs(fall[3] - dive[3]) > 0.4, 'fall and dive body orientations must differ')
    assert(dive[8] > fall[8] + 0.08, 'dive must visibly extend the body')
    const slide = poses.get('bellySlide')!, push = poses.get('handPush')!
    assert(slide && push, 'bellySlide and handPush must load')
    for (const other of ['idle', 'waddle', 'run', 'jump', 'fall', 'dive', 'handPush']) {
      assert(slide.some((v, i) => Math.abs(v - poses.get(other)![i]) > 0.1), `bellySlide must differ from ${other}`)
    }
    assert(push.some((v, i) => Math.abs(v - poses.get('idle')![i]) > 0.1), 'handPush must differ from idle')
  } finally { rig.free() }
  console.log(`m19: all ${node.clips.length} clips sample incl. bellySlide and handPush; prior data preserved; fall flippers move; dive extends and pitches; no root motion`)
}
async function bundle() {
  const require = createRequire(import.meta.url)
  const { build } = await import('vite')
  await build({ configFile: false, root, base: './', publicDir: false, logLevel: 'warn',
    resolve: { alias: ['@etcito/raa', '@etcito/raa-anim'].map(find => ({ find, replacement: require.resolve(find) })) },
    build: { outDir: dist, emptyOutDir: true, assetsInlineLimit: 0,
      rollupOptions: { input: join(destination, 'clip-review.mjs'), output: { entryFileNames: 'review.js' } } } })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Penguin clip review</title><script type="module" src="./review.js"></script>')
  json(join(dist, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  copyFileSync(join(root, 'assets/common/penguin.body.asset.json'), join(dist, 'penguin.body.asset.json'))
  copyFileSync(join(destination, 'penguin-fall-dive.glb'), join(dist, 'penguin-fall-dive.glb'))
  copyFileSync('/refs/penguin-base-ortho.png', join(dist, 'penguin-base-ortho.png'))
  const probe = join(dist, 'probe'); mkdirSync(probe)
  json(join(probe, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  writeFileSync(join(probe, 'index.html'), '<script>window.nmcGpu={ops:{render:async()=>({json:{ok:true},files:[]})}}</script>')
  console.log(`m19: GPU bundle built at ${dist}`)
}
async function capture() {
  const option = (name: string) => process.argv[process.argv.indexOf(name) + 1]
  assert.equal(option('--clips'), 'fall,dive'); assert.equal(option('--seconds'), '4')
  assert.equal(option('--output'), 'proofs/m19')
  const client = process.env.NMC_GPU_CLIENT
  assert(client && existsSync(client), 'Q4 requires the programmatic GPU executor')
  const call = (...args: string[]) => run(process.execPath, [client, ...args])
  const publish = async (dir: string) => {
    const result = JSON.parse(await call('publish', dir))
    assert.equal(typeof result.page_ref, 'string'); return result.page_ref as string
  }
  const render = async (pageRef: string, label: string, input: object) => {
    const out = join(destination, 'fall-dive-execution', label); mkdirSync(out, { recursive: true })
    const file = join(out, 'input.json'); json(file, input)
    await call('render', file, '--page-ref', pageRef, '-o', out)
    const envelope = read(join(out, 'result.json'))
    // GPU transport wraps the operation; retain the unmodified record beside its files.
    const result = unwrapOp({ file: join(out, 'result.json'), json: envelope.result }, label === 'blank' ? 'ok' : 'hardware').out
    return { out, result }
  }
  const probe = await render(await publish(join(dist, 'probe')), 'blank', {})
  assert.equal(probe.result.ok, true)
  const pageRef = await publish(dist), small = { clip: 'fall', width: 320, height: 180, fps: 30 }
  const first = await render(pageRef, 'one-frame', { ...small, frames: 1 })
  assert.equal(first.result.hardware, true); assert.equal(first.result.frames, 1)
  assert(pngNonEmpty(decodePng(readFileSync(join(first.out, 'fall.png')), 320, 180, 'one-frame')))
  const second = await render(pageRef, 'two-frame', { ...small, frames: 2 })
  assert.equal(second.result.hardware, true); assert.equal(second.result.frames, 2)
  assert(existsSync(join(second.out, 'penguin-fall.webm')), 'two-frame video probe must encode a real file')
  const remux = (input: string, output: string) => run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-c', 'copy', output])
  // MediaRecorder's streaming WebM lacks seek/duration metadata. Remux without rendering or re-encoding.
  await remux(join(second.out, 'penguin-fall.webm'), join(second.out, 'seekable.webm'))
  for (const clip of ['fall', 'dive', 'waddle']) {
    const { out, result } = await render(pageRef, clip, { clip, width: 1280, height: 720, fps: 30, frames: clip === 'waddle' ? 1 : 120 })
    assert.equal(result.hardware, true); assert.equal(result.clip, clip)
    assert(Array.isArray(result.files))
    for (const file of result.files) {
      assert(typeof file === 'string' && /^[a-z.-]+$/.test(file)); copyFileSync(join(out, file), join(destination, file))
    }
    if (clip !== 'waddle') {
      await remux(join(out, `penguin-${clip}.webm`), join(destination, `penguin-${clip}.webm`))
      const media = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(destination, `penguin-${clip}.webm`)]))
      assert(media.streams.some((s: { codec_type: string }) => s.codec_type === 'video'))
      assert(Number(media.format.duration) >= 3.9, 'four-second clip review required')
      json(join(out, 'media.json'), media)
    }
  }
  console.log('m19: fall/dive GPU videos and waddle reference comparison returned; pending judge and human review')
}
await verify()
if (process.argv.includes('--build')) await bundle()
if (process.argv.includes('--capture')) await capture()
