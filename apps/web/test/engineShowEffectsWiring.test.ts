import assert from 'node:assert/strict'
import test from 'node:test'
import { EngineShowEffects } from '@royal-fiesta/game/ege/showEffects'
import type { EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import { engineEffectSinks } from '../src/engineShow/presentation.ts'

const LAYOUT = {
  format: 'ege.layout', version: 1, key: 1, components: [], resources: [],
  events: [{ id: 0, name: 'ege.contact', lane: 'presentation', size: 8, fields: [
    { name: 'other', type: 'u32', count: 1, offset: 0 },
    { name: 'started', type: 'u32', count: 1, offset: 4 },
  ] }],
  input: { axes: [], buttons: [], button_shift: 16 }, collision_groups: [], world_kinds: [],
}

function harness(entity: number) {
  const bytes = new TextEncoder().encode(JSON.stringify(LAYOUT))
  const payload = new Uint8Array(8)
  new DataView(payload.buffer).setUint32(4, 1, true)
  const engine = {
    exports: { ege_schema_layout: () => 0 }, check: () => undefined, resultBytes: () => bytes,
    events: () => ({ dropped: 0, records: [{ tick: 1, kind: 0, confirmed: true, repeat: false, entity, payload }] }),
  }
  const ref = {
    domain: 1, kind: 'seat', world: 3, binding: { resimulating: false }, timeline: { module: { engine } },
    confirmedTick: 10, resimulating: false,
  }
  // The page's real publisher setup: zone publishers only; entity 0 is a live scene entity without one.
  const world = { ref, incarnation: 1, entities: new Map([[0, 0], [1, 5]]), publishers: new Map([[5, 'show/publish/0/seat']]) }
  const runtime = {
    onPresentation: () => () => undefined,
    presentation: () => ({ showId: 's', tick: 0, round: 1, map: null, course: null, worlds: [world] }),
    snapshot: () => ({ results: [] }),
    worlds: () => [ref],
  } as unknown as EngineShowRuntime
  const played: string[] = []
  const sinks = engineEffectSinks(() => ({ play: (cue: string) => { played.push(cue) } }) as never, new Map())
  const sounds: string[] = []
  const effects = new EngineShowEffects(runtime, { sound: (name, p) => { sounds.push(name); sinks.sound(name, p) }, grant: () => undefined })
  return { effects, sounds }
}

test('a confirmed ege.contact on entity 0 drains without throwing and delivers once', () => {
  const { effects, sounds } = harness(0)
  effects.pump()
  effects.pump()
  assert.deepEqual(sounds, ['ege.contact'])
  assert.equal(effects.deliveryStats().repeatedSoundDeliveries, 0)
  effects.dispose()
})

test('an entity that is not a live scene entity is still reported', () => {
  const { effects } = harness(99)
  assert.throws(() => effects.pump(), /entity 99 has no publisher/)
  effects.dispose()
})
