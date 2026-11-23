import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { legacyLevel } from '@royal-fiesta/sim/course'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'
import { EngineShowEffects } from '../src/ege/showEffects.ts'
import { applyLocalScript, formatScriptDiagnostic, localSwapState, releaseLocalSwap } from '../src/ege/localSwap.ts'
import { createEngineShow } from '../src/ege/showRuntime.ts'
import type { EngineShowConfig, EngineShowRuntime, EngineWorldRef } from '../src/ege/showTypes.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'
import type { RfScriptFile, ScriptPublication } from '../../../tools/egeScripts.ts'

const ROOT = new URL('../../../', import.meta.url)
const readRepoJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const readRepoText = async (path: string): Promise<string> => readFileSync(new URL(path, ROOT), 'utf8')
const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const schemaKey = schemaLayout(engine).key
const otherSchemaText = (() => {
  const schema = JSON.parse(schemaText) as { components: unknown[] }
  schema.components.push({ name: 'swap_probe', fields: [{ name: 'value', type: 'u32' }] })
  return `${JSON.stringify(schema, null, 2)}\n`
})()

const assetResolver: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readRepoJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}

async function loadShowCourse(id: string): Promise<{ course: CourseV1; assets: Map<string, ResolvedGameAsset> }> {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(readRepoJson(path), path, assetResolver)
  const assets = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) assets.set(assetId, await assetResolver.resolve(assetId))
  return { course, assets }
}

const raceLoaded = await loadShowCourse('s1-f-taffy-circuit')
const hubLoaded = await loadShowCourse('hub-plaza')
const race = raceLoaded.course
const hub = hubLoaded.course
// An in-memory copy with a short authored cap: a race closes when the ledger sees capTick = intro +
// round_ticks (scripts/ege/show/ledger.as.ts:665-674 sets REASON_TIME_CAP for kind 0 at that cap), and
// scripts/ege/show/clock.as.ts:276-280 enters results once the result row exists. testMode shortens only
// presentation, so round-closure tests need a deliberately short gameplay cap instead of 570 s.
const fastLevel = { ...(race.sim!.level ?? legacyLevel(race.sim!)), timeCapTicks: 240, overtimeTicks: 0 }
const fastRace = { ...race, sim: { ...race.sim!, level: fastLevel } } as CourseV1
const allAssets = new Map([...raceLoaded.assets, ...hubLoaded.assets])
const zones = new Map<string, ZonesFile>()
for (const course of [race, hub]) {
  zones.set(course.id, await loadZonesFile(course.id, course.sim!, readRepoText))
}
const season = [
  { id: 'F', course: 0, kind: 'race', finalRule: null, stages: ['R1', 'R2', 'R3'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const satisfies readonly SchedMap[]
const humans = Array.from({ length: 60 }, (_, seat) => seat === 0)

const NEUTRAL = 32639
const JUMP = NEUTRAL | 0x10000
const neutral = (): number => NEUTRAL
const jump = (): number => JUMP

type ScriptBytes = Uint8Array<ArrayBuffer>

async function compileSet(files: RfScriptFile[], schema: string): Promise<ScriptBytes> {
  const result = await (await rfCompiler()).compile(files, schema)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
  assert.ok(result.wasm)
  return result.wasm as ScriptBytes
}

/** Replaces one on-disk script's text in memory; the file on disk is never written. */
function overridden(name: string, from: string, to: string): RfScriptFile[] {
  return collectRfScripts().map(file => {
    if (file.name !== name) return file
    assert.ok(file.text.includes(from), `${name} lacks the substring to replace`)
    return { name, text: file.text.replace(from, to) }
  })
}

function memo(build: () => Promise<ScriptBytes>): () => Promise<ScriptBytes> {
  let pending: Promise<ScriptBytes> | undefined
  return () => {
    pending ??= build()
    return pending
  }
}

const baseBytes = memo(() => compileSet(collectRfScripts(), schemaText))
const jumpBytes = memo(() => compileSet(
  overridden('character/constants.as.ts', 'export const CHAR_JUMP_SPEED: f64 = 7.5', 'export const CHAR_JUMP_SPEED: f64 = 15.0'),
  schemaText,
))
/**
 * Renames one wasm export in place without changing its length, so section sizes stay valid. The compiler
 * rejects a script whose `rf_character_pre` export is absent, so the missing-export module is the valid
 * module with that export name changed inside the wasm export section.
 */
const missingBytes = memo(async () => {
  const from = new TextEncoder().encode('rf_character_pre')
  const to = new TextEncoder().encode('rf_character_prX')
  const bytes = (await baseBytes()).slice() as ScriptBytes
  const at = bytes.findIndex((_, index) => from.every((value, offset) => bytes[index + offset] === value))
  assert.ok(at >= 0, 'the compiled module has no rf_character_pre export to rename')
  bytes.set(to, at)
  return bytes
})
const otherBytes = memo(() => compileSet(collectRfScripts(), otherSchemaText))

function publication(revision: number, moduleKey = `m${revision}`, extra: Partial<ScriptPublication> = {}): ScriptPublication {
  return { revision, moduleKey, schemaKey, wasmUrl: 'test', diagnostics: [], ...extra }
}

async function startRuntime(over: Partial<EngineShowConfig> = {}): Promise<EngineShowRuntime> {
  return createEngineShow({
    engine, schemaText, scriptBytes: await baseBytes(), seed: 7, testMode: true,
    identity: { backend: 'engine', schemaKey, moduleKey: 'build' },
    courses: [race, hub], assets: allAssets, zones, season, humans,
    ...over,
  })
}

/** Steps (voting whenever the screen is vote) until done(); fails with the screen it stopped on. */
function stepUntil(runtime: EngineShowRuntime, done: () => boolean, label: string, dt = 8 / 60, limit = 6000): void {
  for (let frame = 0; frame < limit && !done(); frame++) {
    const snapshot = runtime.snapshot()
    if (snapshot.screen === 'vote' && snapshot.candidates.length > 0 && snapshot.seatOf.includes(0)) runtime.vote(0, 0)
    runtime.frame(dt, neutral)
  }
  assert.ok(done(), `${label}: stopped on screen ${runtime.snapshot().screen}`)
}

function playing(runtime: EngineShowRuntime): void {
  stepUntil(runtime, () => runtime.snapshot().screen === 'playing', 'reach playing')
}

/** Room seat 0's engine position, decoded from the far stream of the physics world that holds it. */
function seatZeroPosition(runtime: EngineShowRuntime): readonly [number, number, number] {
  for (const world of runtime.presentation().worlds) {
    const bytes = world.farSnapshot()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint16(0, true)
    for (let i = 0; i < count; i++) {
      const at = 2 + i * 60
      if (view.getUint32(at, true) !== 1) continue
      return [view.getFloat64(at + 4, true), view.getFloat64(at + 12, true), view.getFloat64(at + 20, true)]
    }
  }
  assert.fail('room seat 0 has no far record')
}

function modulesOf(runtime: EngineShowRuntime): unknown[] {
  return runtime.worlds().map(ref => ref.timeline.module)
}

function generationsOf(runtime: EngineShowRuntime): number[] {
  return runtime.worlds().map(ref => ref.timeline.generation)
}

/** Every live timeline still runs the module and generation captured before the call. */
function assertTimelinesUnchanged(runtime: EngineShowRuntime, modules: readonly unknown[], generations: readonly number[]): void {
  const refs = runtime.worlds()
  assert.equal(refs.length, modules.length)
  refs.forEach((ref, index) => {
    assert.ok(ref.timeline.module === modules[index], `world ${ref.world} changed its module`)
    assert.equal(ref.timeline.generation, generations[index], `world ${ref.world} changed its generation`)
  })
}

test('an online show refuses script reload before any world is swapped', async () => {
  const fake = {
    identity: { backend: 'engine', schemaKey, moduleKey: 'build' },
    mode: 'online',
    worlds: () => [],
    dispose() {},
  }
  const runtime = fake as unknown as EngineShowRuntime
  const result = await applyLocalScript(runtime, publication(1), await baseBytes())
  assert.equal(result.applied, false)
  assert.equal(result.generation, 1)
  assert.match(result.error ?? '', /online/)
  assert.equal(localSwapState(runtime).generation, 1)
})

test('a publication with a compile error refuses and keeps every timeline module', async () => {
  const runtime = await startRuntime()
  try {
    const modules = modulesOf(runtime)
    const generations = generationsOf(runtime)
    const error = { file: 'show/clock.as.ts', line: 3, column: 5, code: 'TS2304', message: 'x', severity: 'error' }
    const result = await applyLocalScript(
      runtime, publication(1, 'm1', { diagnostics: [error as ScriptPublication['diagnostics'][number]] }), await baseBytes(),
    )
    assert.equal(result.applied, false)
    assert.match(result.error ?? '', /has compile errors; the running module is kept/)
    assert.ok(result.error?.includes('scripts/ege/show/clock.as.ts:3:5 TS2304 x'))
    assertTimelinesUnchanged(runtime, modules, generations)
  } finally {
    runtime.dispose()
  }
})

test('a schema key that differs from the running show refuses without loading a module', async () => {
  const runtime = await startRuntime()
  try {
    const modules = modulesOf(runtime)
    const generations = generationsOf(runtime)
    const result = await applyLocalScript(runtime, publication(1, 'm1', { schemaKey: schemaKey + 1 }), await baseBytes())
    assert.equal(result.applied, false)
    assert.match(result.error ?? '', /compiled for schema key/)
    assert.match(result.error ?? '', /schema changes need a local restart/)
    assertTimelinesUnchanged(runtime, modules, generations)
  } finally {
    runtime.dispose()
  }
})

test('bytes compiled against another schema refuse as a restart at the loader, with no timeline changed', async () => {
  const runtime = await startRuntime()
  try {
    const modules = modulesOf(runtime)
    const generations = generationsOf(runtime)
    const result = await applyLocalScript(runtime, publication(1), await otherBytes())
    assert.equal(result.applied, false)
    assert.match(result.error ?? '', /compiled for another schema/)
    assert.match(result.error ?? '', /schema changes need a local restart/)
    assertTimelinesUnchanged(runtime, modules, generations)
  } finally {
    runtime.dispose()
  }
})

test('bytes that are not a script module refuse as could not be loaded and keep the running module', async () => {
  const runtime = await startRuntime()
  try {
    const modules = modulesOf(runtime)
    const generations = generationsOf(runtime)
    const result = await applyLocalScript(runtime, publication(1), Uint8Array.of(0, 1, 2, 3))
    assert.equal(result.applied, false)
    assert.match(result.error ?? '', /could not be loaded/)
    assert.match(result.error ?? '', /the running module is kept/)
    assertTimelinesUnchanged(runtime, modules, generations)
  } finally {
    runtime.dispose()
  }
})

test('a missing export refuses in the physics world, names it, and leaves every timeline unchanged', async () => {
  const runtime = await startRuntime()
  try {
    playing(runtime)
    const refs = runtime.worlds()
    const physics = refs.filter(ref => ref.kind === 'seat' || ref.kind === 'field')
    const rules = refs.find(ref => ref.kind === 'global')
    assert.ok(physics.length > 0 && rules !== undefined)
    for (const ref of physics) {
      assert.ok(engine.schedule(ref.world).some(entry => entry.system === 'rf.character.pre'))
    }
    assert.ok(!engine.schedule(rules.world).some(entry => entry.system === 'rf.character.pre'))
    const modules = modulesOf(runtime)
    const generations = generationsOf(runtime)
    const result = await applyLocalScript(runtime, publication(1), await missingBytes())
    assert.equal(result.applied, false)
    assert.match(result.error ?? '', /does not serve world \d+ \((seat|field)\)/)
    assert.match(result.error ?? '', /rf_character_pre/)
    assert.match(result.error ?? '', /rf\.character\.pre/)
    assert.match(result.error ?? '', /no timeline was changed/)
    assertTimelinesUnchanged(runtime, modules, generations)
  } finally {
    runtime.dispose()
  }
})

test('a valid jump edit applies between frames: one shared module, preserved state and bytes, generation 2', async () => {
  const runtime = await startRuntime()
  try {
    playing(runtime)
    for (let frame = 0; frame < 30; frame++) runtime.frame(1 / 60, neutral)
    const before = modulesOf(runtime)
    const worldBytes = runtime.worlds().map(ref => engine.snapshot(ref.world))
    const stateBefore = runtime.snapshot()
    const result = await applyLocalScript(runtime, publication(1, 'jump'), await jumpBytes())
    assert.deepEqual(result, { applied: true, generation: 2, error: null })
    const refs = runtime.worlds()
    const applied = refs[0].timeline.module
    for (const module of before) assert.ok(module !== applied)
    for (const ref of refs) assert.ok(ref.timeline.module === applied)
    refs.forEach((ref, index) => assert.deepEqual(engine.snapshot(ref.world), worldBytes[index]))
    assert.deepEqual(runtime.snapshot(), stateBefore)
    const state = localSwapState(runtime)
    assert.equal(state.generation, 2)
    assert.equal(state.revision, 1)
    assert.equal(state.moduleKey, 'jump')
  } finally {
    runtime.dispose()
  }
})

test('a twin runtime shows the swapped jump rises higher than the unswapped twin over the next ticks', async () => {
  const swapped = await startRuntime()
  const twin = await startRuntime()
  try {
    playing(swapped)
    playing(twin)
    assert.equal(swapped.worlds().length, twin.worlds().length)
    swapped.worlds().forEach((ref, index) => {
      assert.equal(engine.worldEqual(ref.world, twin.worlds()[index].world), true)
    })
    const result = await applyLocalScript(swapped, publication(1, 'jump'), await jumpBytes())
    assert.equal(result.applied, true)
    const jumpRise = (runtime: EngineShowRuntime): number => {
      const start = seatZeroPosition(runtime)[1]
      let top = start
      runtime.frame(1 / 60, jump)
      top = Math.max(top, seatZeroPosition(runtime)[1])
      for (let tick = 0; tick < 90; tick++) {
        runtime.frame(1 / 60, neutral)
        top = Math.max(top, seatZeroPosition(runtime)[1])
      }
      return top - start
    }
    const swappedRise = jumpRise(swapped)
    const twinRise = jumpRise(twin)
    assert.ok(twinRise > 0, 'the unswapped twin did not rise')
    assert.ok(swappedRise > 1.5 * twinRise, `swapped rise ${swappedRise} is not above 1.5 x twin rise ${twinRise}`)
  } finally {
    swapped.dispose()
    twin.dispose()
  }
})

test('stale and superseded results refuse or lose, and disposed modules throw on validateFor', async () => {
  const runtime = await startRuntime()
  try {
    const world = runtime.worlds()[0].world
    assert.equal((await applyLocalScript(runtime, publication(5), await baseBytes())).applied, true)
    const applied5 = runtime.worlds()[0].timeline.module
    const stale = await applyLocalScript(runtime, publication(4), await baseBytes())
    assert.equal(stale.applied, false)
    assert.match(stale.error ?? '', /not newer/)
    const bytes = await baseBytes()
    const [late, newest] = await Promise.all([
      applyLocalScript(runtime, publication(6), bytes),
      applyLocalScript(runtime, publication(7), bytes),
    ])
    assert.equal(late.applied, false)
    assert.match(late.error ?? '', /superseded by revision 7/)
    assert.equal(newest.applied, true)
    assert.equal(newest.generation, 3)
    assert.throws(() => applied5.validateFor(world))
  } finally {
    runtime.dispose()
  }
})

test('effects are delivered once across a mid-round swap and the runtime reports no faults', async () => {
  const runtime = await startRuntime({ courses: [fastRace, hub], plan: [60, 2] })
  try {
    playing(runtime)
    const sounds = new Map<string, number>()
    const grants = new Map<string, number>()
    const effects = new EngineShowEffects(runtime, {
      sound: name => sounds.set(name, (sounds.get(name) ?? 0) + 1),
      grant: receipt => grants.set(receipt, (grants.get(receipt) ?? 0) + 1),
    })
    for (let frame = 0; frame < 20; frame++) runtime.frame(1 / 60, neutral)
    assert.equal((await applyLocalScript(runtime, publication(1, 'jump'), await jumpBytes())).applied, true)
    stepUntil(runtime, () => runtime.snapshot().screen === 'results', 'reach the first confirmed result', 1 / 60, 3000)
    for (const count of grants.values()) assert.equal(count, 1)
    assert.deepEqual(effects.deliveryStats(), { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 })
    assert.equal(runtime.snapshot().faults + localSwapState(runtime).faults, 0)
    effects.dispose()
  } finally {
    runtime.dispose()
  }
})

test('the swapped module runs the next round physics world at its first post-tick observation', async () => {
  const runtime = await startRuntime({ courses: [fastRace, hub], plan: [60, 2] })
  try {
    playing(runtime)
    assert.equal((await applyLocalScript(runtime, publication(1, 'jump'), await jumpBytes())).applied, true)
    const applied = runtime.worlds()[0].timeline.module
    stepUntil(runtime, () => runtime.snapshot().screen === 'results', 'reach the first confirmed result', 1 / 60, 3000)
    const known = new Set<unknown>(runtime.worlds().map(ref => ref.timeline))
    const isNew = (ref: EngineWorldRef): boolean => ref.kind !== 'global' && !known.has(ref.timeline)
    stepUntil(runtime, () => runtime.worlds().some(isNew), 'reach the next round physics world', 1 / 60, 3000)
    const fresh = runtime.worlds().filter(isNew)
    assert.ok(fresh.length > 0)
    for (const ref of fresh) assert.ok(ref.timeline.module === applied)
  } finally {
    runtime.dispose()
  }
})

test('releasing a disposed runtime disposes the applied module once and stays idempotent', async () => {
  const runtime = await startRuntime()
  const result = await applyLocalScript(runtime, publication(1, 'jump'), await jumpBytes())
  assert.equal(result.applied, true)
  const world = runtime.worlds()[0].world
  const applied = runtime.worlds()[0].timeline.module
  runtime.dispose()
  releaseLocalSwap(runtime)
  releaseLocalSwap(runtime)
  assert.throws(() => applied.validateFor(world))
  const state = localSwapState(runtime)
  assert.equal(state.generation, 2)
  assert.equal(state.revision, 1)
  assert.equal(state.moduleKey, 'jump')
})

test('formatScriptDiagnostic matches the script tools path mapping for each source family', () => {
  const sample = (file: string) => ({ file, line: 3, column: 5, code: 'TS2304', message: 'x' })
  for (const file of ['components.gen.ts', 'ege/engine.ts', 'show/clock.as.ts']) {
    const d = sample(file) as Parameters<typeof formatRfDiagnostic>[0]
    assert.equal(formatScriptDiagnostic(sample(file)), formatRfDiagnostic(d))
  }
  assert.equal(formatScriptDiagnostic(sample('show/clock.as.ts')), 'scripts/ege/show/clock.as.ts:3:5 TS2304 x')
})
