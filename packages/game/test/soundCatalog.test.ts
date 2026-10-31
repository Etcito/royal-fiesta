import assert from 'node:assert/strict'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { CROWD_BED_ID } from '../src/audio/ids.ts'
import {
  BED_IDS, BUSES, MUSIC_CUES, SOUNDS, SOUND_GROUPS, WORLDS_AUDIO,
  musicId, soundDef, stepSoundId, type SoundDef,
} from '../src/audio/catalog.ts'

const MOVEMENT = [
  'move.step.candy', 'move.step.ice', 'move.step.jungle', 'move.step.neon',
  'move.step.stone', 'move.step.mud', 'move.jump', 'move.land.soft',
  'move.land.hard', 'move.dive', 'move.slide', 'move.swim', 'move.hit',
  'move.stun', 'move.wobble', 'move.grab', 'move.release', 'move.carry',
]
const MECH_ONESHOTS = [
  'mech.switch', 'mech.lever', 'mech.door', 'mech.spring', 'mech.hammer',
  'mech.seesaw', 'mech.log', 'mech.tile-warn', 'mech.tile-fall',
  'mech.boost', 'mech.launch', 'mech.door-break',
]
const MECH_LOOPS = ['mech.motor', 'mech.spinner', 'mech.conveyor', 'mech.laser', 'mech.slime']
const OBJECTS = ['obj.goal', 'obj.pickup', 'obj.bank', 'obj.capture', 'obj.steal', 'obj.tail', 'obj.crown']
const UI = ['ui.click', 'ui.hover', 'ui.back', 'ui.error', 'ui.buy', 'ui.ticket', 'ui.inbox']
const FLOW = [
  'flow.vote-tick', 'flow.vote-confirm', 'flow.count-tick', 'flow.count-go',
  'flow.round-start', 'flow.qualify', 'flow.eliminate', 'flow.elim-drop',
  'flow.win', 'flow.crown-gold', 'flow.crown-silver', 'flow.crown-bronze',
]
const WORLDS = ['candy', 'ice', 'jungle', 'neon']
const CUES = ['lobby', 'hub', 'race', 'survival', 'team', 'final', 'results', 'podium']
const MUSIC = WORLDS.flatMap(world => CUES.map(cue => `music.${world}.${cue}`))
const AMBIENCE = ['amb.candy', 'amb.ice', 'amb.jungle', 'amb.neon']

test('the exported buses, groups, worlds and cues match S16', () => {
  assert.deepEqual(BUSES, ['music', 'sfx', 'ui', 'ambience', 'crowd'])
  assert.deepEqual(SOUND_GROUPS, ['movement', 'world', 'flow', 'music'])
  assert.deepEqual(WORLDS_AUDIO, WORLDS)
  assert.deepEqual(MUSIC_CUES, CUES)
})

test('sound ids are unique and family ids match the dotted S16 pattern', () => {
  assert.equal(new Set(SOUNDS.map(sound => sound.id)).size, SOUNDS.length)
  for (const { id } of SOUNDS.filter(sound => sound.kind === 'family')) {
    assert.match(id, /^[a-z]+(\.[a-z0-9-]+)+$/)
  }
})

test('beds are explicitly listed, use plain ids and include the kept crowd bed', () => {
  assert.deepEqual(BED_IDS, ['crowd'])
  assert.ok(BED_IDS.includes(CROWD_BED_ID))
  for (const id of BED_IDS) assert.match(id, /^[a-z]+$/)
  const beds = SOUNDS.filter(sound => sound.kind === 'bed')
  assert.deepEqual(beds.map(sound => sound.id).sort(), [...BED_IDS].sort())
  for (const { id } of beds) assert.match(id, /^[a-z]+$/)
})

test('family and bed ids do not overlap, including family namespace prefixes', () => {
  const families = SOUNDS.filter(sound => sound.kind === 'family')
  for (const bed of BED_IDS) {
    assert.ok(families.every(({ id }) => id !== bed && !id.startsWith(`${bed}.`)))
  }
})

test('every expanded S16 event has exactly one row, with exactly 98 sound ids', () => {
  const expected = [
    ...MOVEMENT, ...MECH_ONESHOTS, ...MECH_LOOPS, ...OBJECTS, ...UI, ...FLOW,
    ...MUSIC, ...AMBIENCE, 'crowd',
  ]
  assert.equal(SOUNDS.length, 98)
  assert.deepEqual(SOUNDS.map(sound => sound.id).sort(), expected.sort())
  assert.deepEqual(SOUNDS.map(sound => sound.event).sort(), expected.sort())
  for (const event of expected) {
    const rows = SOUNDS.filter(sound => sound.event === event)
    assert.equal(rows.length, 1, event)
    assert.equal(rows[0]!.id, event)
    assert.ok(rows[0]!.kind === 'family' || rows[0]!.kind === 'bed')
  }
  for (const sound of SOUNDS) assert.equal(soundDef(sound.id), sound)
})

function checkRows(
  ids: string[], properties: Omit<SoundDef, 'event' | 'id' | 'kind' | 'source'>,
  kind: SoundDef['kind'] = 'family',
): void {
  for (const id of ids) {
    assert.deepEqual(soundDef(id), {
      event: id, id, kind, ...properties,
      source: `audio/${id}.${id.startsWith('music.') ? 'arr' : 'haa'}.json`,
    }, id)
  }
}

test('every row has its S16 group, bus, mode, variants, spatial flag, source and input', () => {
  checkRows(MOVEMENT.filter(id => id !== 'move.slide'), {
    group: 'movement', bus: 'sfx', mode: 'oneshot', variants: 8, spatial: true, input: null,
  })
  checkRows(['move.slide'], {
    group: 'movement', bus: 'sfx', mode: 'loop', variants: 1, spatial: true, input: 'speed',
  })
  checkRows(MECH_ONESHOTS, {
    group: 'world', bus: 'sfx', mode: 'oneshot', variants: 8, spatial: true, input: null,
  })
  checkRows(MECH_LOOPS, {
    group: 'world', bus: 'sfx', mode: 'loop', variants: 1, spatial: true, input: 'rate',
  })
  checkRows(OBJECTS, {
    group: 'world', bus: 'sfx', mode: 'oneshot', variants: 4, spatial: true, input: null,
  })
  checkRows([...UI, ...FLOW.filter(id => id !== 'flow.elim-drop')], {
    group: 'flow', bus: 'ui', mode: 'oneshot', variants: 4, spatial: false, input: null,
  })
  checkRows(['flow.elim-drop'], {
    group: 'flow', bus: 'ui', mode: 'oneshot', variants: 8, spatial: false, input: null,
  })
  for (const world of WORLDS) {
    for (const cue of CUES) {
      checkRows([`music.${world}.${cue}`], {
        group: 'music', bus: 'music', mode: ['results', 'podium'].includes(cue) ? 'oneshot' : 'loop',
        variants: 1, spatial: false, input: null,
      })
    }
  }
  checkRows(AMBIENCE, {
    group: 'music', bus: 'ambience', mode: 'loop', variants: 1, spatial: false, input: null,
  })
  checkRows(['crowd'], {
    group: 'music', bus: 'crowd', mode: 'loop', variants: 1, spatial: false, input: 'excitement',
  }, 'bed')
})

test('step sounds follow ice and mud surfaces, otherwise the world, with common using stone', () => {
  for (const world of [...WORLDS, 'common']) {
    assert.equal(stepSoundId('ice', world), 'move.step.ice')
    assert.equal(stepSoundId('mud', world), 'move.step.mud')
    const expected = `move.step.${world === 'common' ? 'stone' : world}`
    for (const surface of ['normal', 'rubber']) {
      assert.equal(stepSoundId(surface, world), expected)
      assert.equal(soundDef(stepSoundId(surface, world)).group, 'movement')
    }
  }
})

test('musicId resolves every world and cue to its catalog entry', () => {
  for (const world of WORLDS) {
    for (const cue of CUES) {
      const id = musicId(world, cue)
      assert.equal(id, `music.${world}.${cue}`)
      assert.equal(soundDef(id).bus, 'music')
    }
  }
})

test('unknown sound ids refuse with the prescribed diagnostic', () => {
  for (const id of ['x', '', 'move.step.rubber', 'music.common.race', 'toString', '__proto__']) {
    assert.throws(() => soundDef(id), {
      name: 'RefusalError', message: `[audio] soundDef: unknown sound id '${id}'; add it to SOUNDS (S16)`,
    })
    assert.throws(() => soundDef(id), RefusalError)
  }
})

test('unknown worlds and music cues refuse, including with an overriding step surface', () => {
  for (const world of ['unknown', '', 'Candy', 'toString']) {
    for (const surface of ['normal', 'ice', 'mud']) {
      assert.throws(() => stepSoundId(surface, world), RefusalError)
    }
    assert.throws(() => musicId(world, 'race'), RefusalError)
  }
  assert.throws(() => musicId('common', 'race'), RefusalError)
  for (const cue of ['unknown', '', 'Race', 'toString']) {
    assert.throws(() => musicId('candy', cue), RefusalError)
  }
})
