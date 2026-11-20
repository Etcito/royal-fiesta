import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Diagnostic } from '@etcito/game-engine-compile'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { decodeEvents, readWorldState } from '@etcito/game-engine/world-state'
import { collectRfScripts, compileRfScripts, formatRfDiagnostic, rfCompiler } from '../egeScripts.ts'

test('collects AssemblyScript files in byte order', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-scripts-'))
  try {
    for (const name of ['b/x.as.ts', 'a_b/q.as.ts', 'a/y.as.ts', 'a/z.ts']) {
      const file = join(root, 'scripts/ege', name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, name)
    }
    assert.deepEqual(collectRfScripts(root).map(file => file.name), ['a/y.as.ts', 'a_b/q.as.ts', 'b/x.as.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formats user, generated and SDK diagnostic paths', () => {
  const diagnostic: Diagnostic = { file: 'lib/vec.as.ts', line: 3, column: 5, endLine: 3, endColumn: 6, severity: 'error', code: 'EGE1001', message: 'm' }
  assert.equal(formatRfDiagnostic(diagnostic), 'scripts/ege/lib/vec.as.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'components.gen.ts' }), 'generated/components.gen.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'ege/query.ts' }), 'sdk/query.ts:3:5 EGE1001 m')
})

test('compiles an added override and retains its diagnostics', async () => {
  const result = await compileRfScripts({ overrides: [{ name: 'probe/bad.as.ts', text: 'let x: f32 = 0;' }] })
  assert.ok(result.files.includes('probe/bad.as.ts'))
  assert.ok(result.diagnostics.some(d => d.code === 'EGE1001' && d.file === 'probe/bad.as.ts' && d.line === 1))
})

test('compiles and loads the real round scripts and checks exported numeric helpers', async () => {
  const schemaText = readFileSync(new URL('../../ege.schema.json', import.meta.url), 'utf8')
  const result = await compileRfScripts()
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
  assert.ok(result.wasm)

  const engine = await loadEngine()
  engine.setSchema(schemaText)
  await loadScript(engine, result.wasm, { name: 'rf-scripts' })

  const module = await WebAssembly.compile(result.wasm as Uint8Array<ArrayBuffer>)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const exported = new Set(WebAssembly.Module.exports(module).map(item => item.name))
  for (const name of ['degToRad', 'ticksOf', 'inBox']) assert.ok(exported.has(name), `${name} export`)
  const degToRad = instance.exports.degToRad as (value: number) => number
  const ticksOf = instance.exports.ticksOf as (value: number) => number
  const inBox = instance.exports.inBox as (...values: number[]) => number
  assert.equal(degToRad(180), Math.PI)
  assert.equal(degToRad(90), Math.PI / 2)
  assert.equal(ticksOf(0.5), 30)
  assert.equal(ticksOf(1.0), 60)
  assert.equal(inBox(0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5), 1)
  assert.equal(inBox(0, 0, 0, 1, 1, 1, 1.5, 0, 0), 0)
})

const PROBE_FILE = 'probe/show_events.as.ts'
const PROBE_TEXT = `import { tick } from 'ege'
import { CrownEvent, EliminateEvent, FallEvent, FinishEvent, GateEvent, MatchEvent, PossessEvent, ProgressEvent, ScoreEvent, TeamScoreEvent } from '../components.gen'
import { recordShowEvent } from '../lib/show_events.as'

export function rf_events_probe(): void {
  const now = tick()
  if (now == 0) {
    recordShowEvent(GateEvent.ID, 0, 0, 5, 2)
    recordShowEvent(ProgressEvent.ID, 0, 0, 1234, 0)
    recordShowEvent(FallEvent.ID, 0, 0, 65535, 0)
    recordShowEvent(ScoreEvent.ID, 1, 1, 7, 0)
    recordShowEvent(ScoreEvent.ID, 1, 1, -3, 0)
    recordShowEvent(PossessEvent.ID, 3, 1, 1, 0)
    recordShowEvent(MatchEvent.ID, 4, 1, 2, 30)
    recordShowEvent(CrownEvent.ID, 1, 1, 17, 0)
    recordShowEvent(EliminateEvent.ID, 2, 2, 321, 0)
    recordShowEvent(TeamScoreEvent.ID, 5, 1, 4, 0)
  } else if (now == 1) {
    recordShowEvent(TeamScoreEvent.ID, 5, 1, -1, 0)
  } else if (now == 2) {
    recordShowEvent(FinishEvent.ID, 0, 0, 123, 3)
  }
}
`

function probeSchema(): string {
  const schema = JSON.parse(readFileSync(new URL('../../ege.schema.json', import.meta.url), 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: unknown[] }[]
  }
  schema.world_kinds.push({
    name: 'show_events_probe',
    players: 8,
    schedule: [{
      system: 'rf.events.probe',
      kind: 'script',
      reads: ['show_result_a', 'show_result_b', 'show_team_contribution', 'feature'],
      writes: ['show_result_a', 'show_result_b', 'show_team_contribution'],
      emits: ['finish', 'fall', 'eliminate', 'gate', 'progress', 'score', 'team_score', 'possess', 'crown', 'match'],
    }],
  })
  return JSON.stringify(schema)
}

const SEAT_RESULT = (seat: number) => ({
  show_result_a: {
    seat, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1,
    route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
  },
  show_result_b: {
    hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
    out_tick: -1, out_sub: -1, team: -1, opening_rank: 0,
  },
})

function probeScene(withResults: boolean) {
  const seats = withResults
    ? [SEAT_RESULT(0), SEAT_RESULT(1), SEAT_RESULT(2)].map((components) => ({ components }))
    : [{ components: {} }, { components: {} }, { components: {} }]
  return {
    format: 'ege.scene' as const,
    version: 1 as const,
    world_kind: 'show_events_probe',
    seed: 3,
    entities: [
      ...seats,
      { components: { feature: { kind: 19, index: 3, salt: 0 } } },
      { components: { feature: { kind: 10, index: 4, salt: 0 } } },
      { components: { feature: { kind: 14, index: 7, salt: 0 } } },
    ],
  }
}

let probeWasm: Promise<Uint8Array> | null = null

async function compiledProbe(): Promise<Uint8Array> {
  probeWasm ??= (async () => {
    const files = [...collectRfScripts(), { name: PROBE_FILE, text: PROBE_TEXT }]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    const result = await (await rfCompiler()).compile(files, probeSchema())
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm as Uint8Array
  })()
  return probeWasm
}

async function probeWorld(withResults: boolean) {
  const engine = await loadEngine()
  engine.setSchema(probeSchema())
  const module = await loadScript(engine, await compiledProbe(), { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  const world = engine.createWorld(probeScene(withResults))
  return { engine, module, layout, world, scene: probeScene(withResults) }
}

const NEUTRAL_INPUTS = [0, 0, 0, 0, 0, 0, 0, 0]

test('recordShowEvent keeps the G6 payload and updates the cumulative show rows', async () => {
  const { engine, module, layout, world } = await probeWorld(true)
  const host = new ScriptHost(module)
  host.stepTick(world, NEUTRAL_INPUTS)
  host.stepTick(world, NEUTRAL_INPUTS)
  host.stepTick(world, NEUTRAL_INPUTS)
  assert.equal(module.faultCount, 0)

  const events = decodeEvents(engine.events(world, 0, engine.tick(world)).records, layout)
  assert.deepEqual(events.map((event) => event.kind), [
    'gate', 'progress', 'fall', 'score', 'score', 'possess', 'match', 'crown', 'eliminate', 'team_score',
    'team_score', 'finish',
  ])
  assert.deepEqual(events[0].fields, { seat: 0, stage: 5, lap: 2 })
  assert.deepEqual(events[1].fields, { seat: 0, distance_mm: 1234 })
  assert.deepEqual(events[2].fields, { seat: 0, crossing: 65535 })
  assert.deepEqual(events[3].fields, { seat: 1, a: 7, b: 0 })
  assert.deepEqual(events[4].fields, { seat: 1, a: -3, b: 0 })
  assert.deepEqual(events[5].fields, { seat: 1, a: 1, b: 0 })
  assert.deepEqual(events[6].fields, { seat: 1, a: 2, b: 30 })
  assert.deepEqual(events[7].fields, { seat: 1, a: 17, b: 0 })
  assert.deepEqual(events[8].fields, { seat: 2, crossing: 321 })
  assert.deepEqual(events[9].fields, { team: 1, a: 4, b: 0 })
  assert.deepEqual(events[10].fields, { team: 1, a: -1, b: 0 })
  assert.deepEqual(events[11].fields, { seat: 0, crossing: 123, lap: 3 })
  assert.deepEqual(events.map((event) => event.entity), [0, 0, 0, 1, 1, 3, 4, 1, 2, 5, 5, 0])

  const state = readWorldState(engine, world, layout)
  const [first, second, third] = state.entities
  assert.deepEqual(state.components.show_result_a[first], {
    seat: 0, status: 2, finish_tick: 2, finish_sub: 123, lap: 3, stage: 5,
    route_mm: 1234, falls: 1, score: 0, last_score_tick: -1,
  })
  const one = state.components.show_result_a[second]
  assert.equal(one.status, 2)
  assert.equal(one.finish_tick, 0)
  assert.equal(one.finish_sub, 17)
  assert.equal(one.score, 4)
  assert.equal(one.last_score_tick, 0)
  const oneB = state.components.show_result_b[second]
  assert.equal(oneB.possessing, 1)
  assert.equal(oneB.last_acquire_tick, 0)
  assert.equal(oneB.matches, 2)
  assert.equal(oneB.cross_ticks, 30)
  const two = state.components.show_result_a[third]
  assert.equal(two.status, 3)
  const twoB = state.components.show_result_b[third]
  assert.equal(twoB.out_tick, 0)
  assert.equal(twoB.out_sub, 321)

  const contributions = Object.values(state.components.show_team_contribution)
  assert.equal(contributions.length, 1)
  assert.deepEqual(contributions[0], { owner: 5, feature: 7, team: 1, value: 3, tick: 1 })
})

test('recordShowEvent is absence-safe in a G6 world and replay restores the cumulative state', async () => {
  const bare = await probeWorld(false)
  const bareHost = new ScriptHost(bare.module)
  bareHost.stepTick(bare.world, NEUTRAL_INPUTS)
  assert.equal(bare.module.faultCount, 0)
  assert.equal(bare.engine.events(bare.world, 0, bare.engine.tick(bare.world)).records.length, 10)
  const bareState = readWorldState(bare.engine, bare.world, bare.layout)
  assert.equal(bareState.entities.length, 6)
  assert.deepEqual(Object.keys(bareState.components.show_team_contribution), [])
  assert.deepEqual(Object.keys(bareState.components.show_result_a), [])

  const a = await probeWorld(true)
  const b = await probeWorld(true)
  const hostA = new ScriptHost(a.module)
  const hostB = new ScriptHost(b.module)
  hostA.stepTick(a.world, NEUTRAL_INPUTS)
  hostA.stepTick(a.world, NEUTRAL_INPUTS)
  hostB.stepTick(b.world, NEUTRAL_INPUTS)
  hostB.stepTick(b.world, NEUTRAL_INPUTS)
  b.engine.restore(b.world, a.engine.snapshot(a.world))
  hostA.stepTick(a.world, NEUTRAL_INPUTS)
  hostB.stepTick(b.world, NEUTRAL_INPUTS)
  assert.equal(a.module.faultCount, 0)
  assert.equal(b.module.faultCount, 0)

  const stateA = readWorldState(a.engine, a.world, a.layout)
  const stateB = readWorldState(b.engine, b.world, b.layout)
  assert.equal(stateA.tick, 3)
  assert.deepEqual(stateB, stateA)
})
