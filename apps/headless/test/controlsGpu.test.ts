import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { buildControlsRecord, checkPngs, checkPrerequisites, parseControlsInput, recordText, secretsFromEnv } from '../src/controlsGpu.ts'
import type { ControlsInput } from '../src/controlsGpu.ts'
import { repoRoot } from '../../../tools/bricks.ts'

const INPUT = parseControlsInput(readFileSync(join(repoRoot(), 'proofs/m15/controls.input.json'), 'utf8'))
const PNG = Buffer.from('not really a png, only bytes to hash')
const SHA = createHash('sha256').update(PNG).digest('hex')

function refusedWith(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => isRefusal(e) && re.test(e.message))
}

function opOutput(input: ControlsInput): Record<string, unknown> {
  return {
    renderer: 'raa',
    adapter: { vendor: 'nvidia', architecture: 'ada', description: 'RTX (compatibility)', software: false },
    software: false, pageRef: '/p/rev/', content: input.content, course: input.course,
    cases: input.cases.map(c => {
      const view = c.input === 'mouseRight' || c.input === 'rightStickRight'
      return {
        name: c.name, input: c.input, subject: view ? 'view' : 'character',
        device: c.input === 'mouseRight' ? 'pointer-lock-events' : c.input.startsWith('stick') || c.input === 'rightStickRight' ? 'synthetic-pad' : 'keyboard',
        beforeX: 640, afterX: 700, centreX: 640,
        captures: ['before', 'after'].map(w => ({ name: `${c.name}-${w}`, sha256: SHA, bytes: PNG.length, nonEmpty: true })),
      }
    }),
  }
}

test('controls.input.json: the declared controlsProbe example on v0 race-sprint', () => {
  assert.equal(INPUT.content, 'v0')
  assert.equal(INPUT.width, 1280)
  assert.equal(INPUT.height, 720)
  assert.equal(INPUT.course, 'race-sprint')
  assert.deepEqual(INPUT.cases.map(c => c.input), ['KeyD', 'ArrowRight', 'stickRight', 'KeyA', 'ArrowLeft', 'stickLeft', 'mouseRight', 'rightStickRight'])
  assert.ok(INPUT.cases.every(c => c.holdMs === 500))
  assert.equal(new Set(INPUT.cases.map(c => c.name)).size, 8)
})

test('parseControlsInput refuses another size and unknown keys', () => {
  refusedWith(() => parseControlsInput(JSON.stringify({ ...INPUT, width: 1920 })), /1280x720/)
  refusedWith(() => parseControlsInput(JSON.stringify({ ...INPUT, extra: 1 })), /#\/extra: unknown key/)
  refusedWith(() => parseControlsInput('{'), /invalid JSON/)
})

test('buildControlsRecord: S17 record from the op json, with the published pageRef', () => {
  const rec = buildControlsRecord({ file: 'out/m15/result.json', json: { json: opOutput(INPUT), files: [] } }, INPUT, 'ref-1')
  assert.equal(rec.renderer, 'raa')
  assert.equal(rec.adapter, 'nvidia | ada | RTX (compatibility)')
  assert.equal(rec.software, false)
  assert.equal(rec.pageRef, 'ref-1')
  assert.equal(rec.content, 'v0')
  assert.equal(rec.cases.length, 8)
  assert.deepEqual(rec.cases.map(c => c.subject), ['character', 'character', 'character', 'character', 'character', 'character', 'view', 'view'])
  assert.equal(rec.cases[2].device, 'synthetic-pad')
  assert.deepEqual(rec.cases[0].captures[0], { name: 'key-d-before', sha256: SHA, bytes: PNG.length, nonEmpty: true })
})

test('buildControlsRecord refuses missing, reordered or mislabelled output', () => {
  const build = (out: Record<string, unknown>): unknown => buildControlsRecord({ file: 'r.json', json: out }, INPUT, 'ref')
  refusedWith(() => build({ ...opOutput(INPUT), renderer: 'null' }), /renderer/)
  refusedWith(() => build({ ...opOutput(INPUT), content: 'v1' }), /content/)
  refusedWith(() => build({ ...opOutput(INPUT), cases: (opOutput(INPUT).cases as unknown[]).slice(1) }), /7 cases for 8 inputs/)
  const swapped = (opOutput(INPUT).cases as unknown[]).slice().reverse()
  refusedWith(() => build({ ...opOutput(INPUT), cases: swapped }), /expected key-d\/KeyD/)
  const out = opOutput(INPUT)
  ;(out.cases as Record<string, unknown>[])[0].afterX = null
  refusedWith(() => build(out), /cases\/0\/afterX/)
  refusedWith(() => build({ ...opOutput(INPUT), adapter: { vendor: '', architecture: '', description: '', software: true } }), /labelled/)
})

test('checkPngs: every capture is in the output directory, byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'controls-gpu-'))
  try {
    const rec = buildControlsRecord({ file: 'r.json', json: opOutput(INPUT) }, INPUT, 'ref')
    refusedWith(() => checkPngs(rec, dir), /key-d-before\.png: is missing/)
    mkdirSync(join(dir, 'files'))
    for (const c of rec.cases) for (const k of c.captures) writeFileSync(join(dir, 'files', `${k.name}.png`), PNG)
    checkPngs(rec, dir)
    writeFileSync(join(dir, 'files', 'key-a-after.png'), 'other bytes')
    refusedWith(() => checkPngs(rec, dir), /key-a-after\.png: is 11 bytes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordText redacts env secrets and refuses a record that still leaks', () => {
  const token = 'nmc' + '-secret-' + 'x'.repeat(12)
  const secrets = secretsFromEnv({ NMC_GPU_TOKEN: token, NMC_GPU_URL: '' })
  assert.deepEqual(secrets, [token])
  const rec = buildControlsRecord({ file: 'r.json', json: { ...opOutput(INPUT) } }, INPUT, token)
  const text = recordText(rec, secrets)
  assert.ok(!text.includes(token))
  assert.ok(text.includes('"pageRef": "<redacted>"'))
  assert.ok(text.endsWith('}\n'))
  const leaky = buildControlsRecord({ file: 'r.json', json: opOutput(INPUT) }, INPUT, 'gh' + 'p_' + 'A'.repeat(36))
  refusedWith(() => recordText(leaky, []), /leakScan found/)
  refusedWith(() => recordText(rec, [], ['RTX (compat']), /leakScan found/)
})

test('checkPrerequisites names each missing piece', () => {
  refusedWith(() => checkPrerequisites({}, r => r), /NMC_GPU_CLIENT: is unset/)
  const dir = mkdtempSync(join(tmpdir(), 'controls-gpu-'))
  try {
    const client = join(dir, 'client.js')
    writeFileSync(client, '')
    const abs = (rel: string): string => join(dir, rel)
    refusedWith(() => checkPrerequisites({ NMC_GPU_CLIENT: client }, abs), /run npm run build/)
    mkdirSync(join(dir, 'apps/web/dist'), { recursive: true })
    writeFileSync(join(dir, 'apps/web/dist/game.html'), '')
    writeFileSync(join(dir, 'apps/web/dist/nmc.gpu.json'), JSON.stringify({ page: 'game.html', ops: ['gameCapture'] }))
    refusedWith(() => checkPrerequisites({ NMC_GPU_CLIENT: client }, abs), /does not list controlsProbe/)
    writeFileSync(join(dir, 'apps/web/dist/nmc.gpu.json'), JSON.stringify({ page: 'game.html', ops: ['controlsProbe'] }))
    refusedWith(() => checkPrerequisites({ NMC_GPU_CLIENT: client }, abs), /controls\.input\.json: is missing/)
    mkdirSync(join(dir, 'proofs/m15'), { recursive: true })
    writeFileSync(join(dir, 'proofs/m15/controls.input.json'), '{}')
    checkPrerequisites({ NMC_GPU_CLIENT: client }, abs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
