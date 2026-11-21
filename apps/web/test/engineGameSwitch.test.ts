import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { onlineMeasurements } from '@royal-fiesta/game/ege/onlineState'
import type { EngineShowConfig, EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { onlineRoster } from '@royal-fiesta/game/net/onlineMatch'
import type { ZoneMatched } from '@royal-fiesta/game/net/zoneRelayProtocol'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { RefusalError } from '../../../packages/sim/src/refusal.ts'
import { loadEngineBackend, selectGameBackend } from '../src/game/engineBackend.ts'
import type { EngineBackendLoaders } from '../src/game/engineBackend.ts'
import type { AuthoredShow, PublishedEngine } from '../src/engineShow/page.ts'

const identity = { backend: 'engine' as const, schemaKey: 11, moduleKey: 'module-a' }
const authored = {
  courses: [], plaza: { id: 'hub-plaza' }, assets: new Map(), zones: new Map(), season: [],
  zoneContent: {}, podium: {},
} as unknown as AuthoredShow
const published = { engine: {}, identity, scriptBytes: new ArrayBuffer(0) } as unknown as PublishedEngine

function loaders(over: Partial<EngineBackendLoaders> = {}): EngineBackendLoaders {
  return { publication: async () => published, authored: async () => authored, ...over }
}

function refusal(error: unknown, path: string): boolean {
  assert.ok(error instanceof RefusalError)
  assert.equal(error.area, 'game-web')
  assert.equal(error.path, path)
  return true
}

test('the selector keeps legacy for absent or engine=0 and refuses every other explicit value', () => {
  assert.equal(selectGameBackend(new URLSearchParams('')), 'legacy')
  assert.equal(selectGameBackend(new URLSearchParams('engine=0')), 'legacy')
  assert.equal(selectGameBackend(new URLSearchParams('engine=1')), 'engine')
  for (const query of ['engine=2', 'engine=', 'engine=1&engine=0']) {
    assert.throws(() => selectGameBackend(new URLSearchParams(query)), error => refusal(error, 'query.engine'))
  }
  for (const query of ['server=relay', 'bots=3', 'test=1']) {
    assert.equal(selectGameBackend(new URLSearchParams(query)), 'legacy')
  }
})

test('preparation stays pending until both loaders settle and a rejection propagates with no fallback', async () => {
  let release: (value: PublishedEngine) => void = () => {}
  const pending = new Promise<PublishedEngine>(resolve => { release = resolve })
  let settled = false
  const waiting = loadEngineBackend(loaders({ publication: () => pending })).then(backend => {
    settled = true
    return backend
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(settled, false)
  release(published)
  const backend = await waiting
  assert.equal(backend.identity.moduleKey, 'module-a')
  await assert.rejects(
    loadEngineBackend(loaders({ publication: async () => { throw new Error('publication is unavailable') } })),
    /publication is unavailable/,
  )
})

test('the show configuration makes exactly the first room seats human', async () => {
  const backend = await loadEngineBackend(loaders())
  const config = backend.config({ seed: 9, humans: 2, seats: 60, testMode: false })
  assert.equal(config.humans.length, 60)
  assert.deepEqual(config.humans.flatMap((human, roomSeat) => (human ? [roomSeat] : [])), [0, 1])
  assert.equal(config.seed, 9)
  assert.equal(config.identity.moduleKey, 'module-a')
  assert.throws(() => backend.config({ seed: 0, humans: 9, seats: 60, testMode: false }), error => refusal(error, 'options'))
  assert.throws(() => backend.config({ seed: 0, humans: 1, seats: 61, testMode: false }), error => refusal(error, 'options'))
})

test('the flow backend refuses a plaza with a different id', async () => {
  const backend = await loadEngineBackend(loaders())
  const flow = backend.flowBackend({ seats: 60, testMode: false })
  assert.throws(() => flow.createHub({ id: 'other-plaza' } as ResolvedCourse, 0), error => refusal(error, 'flow.plaza'))
})

test('the flow backend passes localPeer, roster and seed to the online factory', async () => {
  const seen: {
    config: EngineShowConfig
    network: { localPeer: number; roster: Roster; transport: GroupTransport; measurements: ReturnType<typeof onlineMeasurements> }
  }[] = []
  const onlineShow: NonNullable<EngineBackendLoaders['onlineShow']> = async (config, network) => {
    seen.push({ config, network })
    return {} as EngineShowRuntime
  }
  const backend = await loadEngineBackend(loaders({ onlineShow }))
  const flow = backend.flowBackend({ seats: 60, testMode: true })
  const transport = { rtt: {} }
  const matched = { t: 'matched', seed: 77, hostStarts: true, youAre: 1, token: 'tok', players: 2, opps: [] } as ZoneMatched
  await flow.createMatch(matched, transport as never)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].config.seed, 77)
  assert.equal(seen[0].config.testMode, true)
  assert.equal(seen[0].network.localPeer, 1)
  assert.deepEqual(seen[0].network.roster, onlineRoster(2, 60))
  assert.equal(seen[0].network.transport, transport)
  assert.deepEqual(seen[0].network.measurements, onlineMeasurements(onlineRoster(2, 60)))
})

test('the backend module imports no legacy simulation authority', () => {
  const source = readFileSync(new URL('../src/game/engineBackend.ts', import.meta.url), 'utf8')
  for (const module of [
    '@royal-fiesta/sim/match/matchSim',
    '@royal-fiesta/sim/zones/fiestaDomain',
    '@royal-fiesta/sim/zones/ledger',
    '@royal-fiesta/sim/bots',
  ]) {
    assert.equal(source.includes(module), false, `engineBackend.ts imports ${module}`)
  }
})
