// The ice card's complete shell-free sequence. Other cards and judgeCard.ts stay unchanged.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { MatchSim } from '../packages/sim/src/match/matchSim.ts'
import { neutralInput } from '../packages/sim/src/input.ts'
import { iceAction, iceActionReady } from '../apps/web/src/game/iceCapture.ts'
import { loadAuthoredCourse } from './courseProbe.ts'
import { judgeCommands, pageRefOf, parseJudgeInput } from './judgeCard.ts'

const dir = 'out/judge/m4/'
const required = ['penguin.body', 'ice.slide-gate', 'ice.floe-platform', 'ice.floor-tile', 'ice.wall-block']
const parsed = parseJudgeInput(JSON.parse(readFileSync('.nmc/judge/m4.json', 'utf8')), '.nmc/judge/m4.json')
assert.ok('items' in parsed)
const item = parsed.items[1]!

async function preflight() {
  // Use the operation's own validator without a browser or GPU.
  const server = await createServer({ configFile: 'apps/web/anim-brick.vite.config.ts', configLoader: 'runner',
    server: { middlewareMode: true } })
  try {
    const { validateCapture } = await server.ssrLoadModule('/src/game/ops.ts')
    validateCapture(item.input)
    // One asset proves the no-saved-mesh MAMA path and the player's graph colour without a GPU.
    const { meshRequest } = await server.ssrLoadModule('/src/sdf/mama/worker.ts')
    const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
    const mesh = await meshRequest({ assetId: asset.id, hash: asset.hash, mesher: asset.mesher, document: asset.document })
    assert.ok(mesh.triangles > 0)
    assert.ok(mesh.data.groups.some((g: { parts: { skin?: unknown }[] }) => g.parts.some(p => p.skin !== undefined)),
      'the browser mesh payload must carry the penguin skin')
    const materials = mesh.data.materials
    for (const name of ['penguin-beak', 'penguin-belly', 'penguin-eye', 'penguin-plumage']) {
      assert.ok(materials.some((m: { name: string }) => m.name === name), name)
    }
    assert.ok(JSON.stringify(materials).includes('mat_instance_tint'), 'player colour must reach the penguin material')
    console.log(`[ice preflight] MAMA penguin: ${mesh.parts} parts, ${mesh.triangles} triangles, player-colour graph`)
  } finally { await server.close() }
  assert.equal(item.input.content, 'sdf')
  assert.equal(item.input.course, 'ice-slide-gates')
  assert.deepEqual(item.input.captureAt, ['playing'])
  const ice = await loadAuthoredCourse('ice-slide-gates')
  const survival = await loadAuthoredCourse('survival-sprint')
  assert.ok(ice.sim && survival.sim)
  assert.equal(ice.environment?.sky, 'snow')
  for (const id of required.slice(1)) assert.ok(ice.assetIds.includes(id), id)
  const sim = new MatchSim(await initRapier(), { seed: 7, playerCount: 8, humans: Array(8).fill(false),
    profile: 'sprint', courses: [ice.sim, survival.sim] })
  try {
    const inputs = Array.from({ length: 8 }, () => neutralInput())
    let action = null
    for (let tick = 0; tick < 600; tick++) {
      sim.step(inputs)
      action = iceAction(sim, ice.sim)
      if (iceActionReady(action)) break
    }
    assert.ok(iceActionReady(action), 'capture must reach a moving gate with at least four moving penguins')
    console.log('[ice preflight]', JSON.stringify(action))
  } finally { sim.free() }
}

async function run(args: string[], capture = false): Promise<string> {
  console.log('[ice step]', args.map(a => a === process.env.NMC_GPU_CLIENT ? '$NMC_GPU_CLIENT' :
    a === process.env.NMC_JUDGE_CLIENT ? '$NMC_JUDGE_CLIENT' : a).join(' '))
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`step exited ${code}`)))
  })
}

function record() {
  const envelope = JSON.parse(readFileSync(`${dir}item-1/result.json`, 'utf8'))
  const result = envelope.result
  assert.equal(result.renderer, 'raa')
  assert.equal(result.software, false)
  assert.equal(result.adapter.software, false)
  assert.equal(result.content, 'sdf', 'a v1 stand-in capture cannot prove this card')
  const report = result.report
  assert.equal(report.content, 'sdf')
  for (const id of required) {
    assert.ok(!report.failed.includes(id), `${id} failed browser meshing`)
    const line = report.meshed.find((line: string) => line.startsWith(`${id}|`))
    assert.ok(line, `${id} is absent from the loaded mesh set`)
    const [, mesher, parts, triangles] = line.split('|')
    assert.notEqual(mesher, 'failed')
    assert.ok(Number(parts) > 0 && Number(triangles) > 0, `${id} must contain real triangles`)
  }
  const event = result.events.find((e: { what: string }) => e.what.startsWith('ice-action '))
  assert.ok(event, 'capture has no mechanism/runner state')
  const action = JSON.parse(event.what.slice('ice-action '.length))
  assert.ok(iceActionReady(action))
  const png = `${dir}ice-slide-gates.png`
  copyFileSync(`${dir}ice-slide-gates-playing.png`, png)
  mkdirSync('proofs/m4', { recursive: true })
  writeFileSync('proofs/m4/ice-slide-gates.json', JSON.stringify({ renderer: result.renderer,
    adapter: result.adapter, pageRef: result.pageRef, capture: png, action,
    meshes: report.meshed.filter((line: string) => required.some(id => line.startsWith(`${id}|`))) }, null, 2) + '\n')
}

await preflight()
if (!process.argv.includes('--preflight')) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}input-1.json`, JSON.stringify(item.input, null, 2) + '\n')
  let pageRef = ''
  const gpu = process.env.NMC_GPU_CLIENT
  assert.ok(gpu, 'NMC_GPU_CLIENT is unset')
  // Probe transport before publishing the real page. No browser is launched by this script.
  const probe = `${dir}blank-probe/`
  mkdirSync(probe, { recursive: true })
  writeFileSync(`${probe}nmc.gpu.json`, JSON.stringify({ page: 'index.html', ops: ['probe'] }))
  writeFileSync(`${probe}index.html`, '<script>window.nmcGpu={ops:{probe:async()=>({json:{ok:true},files:[]})}}</script>')
  writeFileSync(`${dir}blank-input.json`, '{}')
  const blankRef = pageRefOf(await run(['node', gpu, 'publish', probe], true))
  await run(['node', gpu, 'probe', `${dir}blank-input.json`, '--page-ref', blankRef, '-o', `${dir}blank-result/`])
  assert.equal(JSON.parse(readFileSync(`${dir}blank-result/result.json`, 'utf8')).result.ok, true)
  const commands = judgeCommands(parsed, dir, '', 1)
  for (const args of commands) {
    if (args[2] === 'gameCapture') {
      const small = `${dir}one-frame-input.json`
      writeFileSync(small, JSON.stringify({ ...item.input, width: 64, height: 64 }))
      await run(['node', gpu, 'gameCapture', small, '--page-ref', pageRef, '-o', `${dir}one-frame/`])
      const result = JSON.parse(readFileSync(`${dir}one-frame/result.json`, 'utf8')).result
      assert.equal(result.renderer, 'raa')
      assert.equal(result.software, false)
      assert.equal(result.captures.length, 1)
    }
    if (args[0] === 'python3') {
      // Refresh the exact image the corrective card judges, before invoking the unchanged judge.
      record()
      args[2] = `${dir}ice-slide-gates.png`
    }
    const actual = args.map(arg => {
      if (arg === '$PAGE_REF') return pageRef
      if (arg === '$NMC_GPU_CLIENT' || arg === '$NMC_JUDGE_CLIENT') {
        const value = process.env[arg.slice(1)]
        assert.ok(value, `${arg} is unset`)
        return value
      }
      return arg
    })
    const publish = args[2] === 'publish'
    const output = await run(actual, publish)
    if (publish) pageRef = pageRefOf(output)
  }
}
