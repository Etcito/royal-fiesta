import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import { stepSoundId } from '../src/audio/catalog.ts'
import { CROWD_BED_ID } from '../src/audio/ids.ts'
import {
  BED_EXCITEMENT, BED_FADE_S, copySample, musicCue, newMatchSample, sampleMatch,
  type MatchSample, type PlayerSample, type SoundEvent, type Vec3,
} from '../src/audio/events.ts'
import { GameAudio, type LoopPort, type SoundPort } from '../src/audio/gameAudio.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8')
const R = await initRapier()

interface Played { id: string; pos?: Vec3; strength?: number }
interface LoopRecord { id: string; sets: [string, number][]; moves: Vec3[]; stops: number[] }

function recordingPort(): SoundPort & {
  played: Played[]
  started: string[]
  loops: LoopRecord[]
  listeners: unknown[]
} {
  const played: Played[] = []
  const started: string[] = []
  const loops: LoopRecord[] = []
  const listeners: unknown[] = []
  return {
    played,
    started,
    loops,
    listeners,
    play(id, o) { played.push({ id, pos: o?.pos, strength: o?.strength }) },
    startLoop(id) {
      started.push(id)
      const rec: LoopRecord = { id, sets: [], moves: [], stops: [] }
      loops.push(rec)
      const loop: LoopPort = {
        set(name, value) { rec.sets.push([name, value]) },
        move(pos) { rec.moves.push({ x: pos.x, y: pos.y, z: pos.z }) },
        stop(fadeS) { rec.stops.push(fadeS ?? 0) },
      }
      return loop
    },
    setListeners(ls) { listeners.push(ls) },
  }
}

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    mode: CharMode.ground, status: PlayerStatus.alive, grounded: true, footDown: 0,
    vel: { x: 0, y: 0, z: 0 }, pos: { x: 1, y: 0, z: 2 }, slideSpeed: 0, carry: 0, surface: 'normal',
    ...over,
  }
}

function frame(players: PlayerSample[], over: Partial<Omit<MatchSample, 'players'>> = {}): MatchSample {
  return { phase: Phase.playing, roundKind: 'race', final: false, world: 'candy', players, ...over }
}

async function loadCourses(): Promise<ResolvedCourse[]> {
  const entries: { path: string; json: unknown }[] = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, fixtureResolver(read), 'sprint')
}

test('a headless bot match plays the right S16 movement and flow ids', async () => {
  const courses = await loadCourses()
  const sim = createMatchSim(R, netSetup(8, 1, 'sprint', courses))
  const neutral = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  const scratch: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  const sample = newMatchSample()
  const pairs: { event: SoundEvent; prev: MatchSample; next: MatchSample }[] = []
  const eliminations = new Set<number>()
  let footDowns = 0
  let prev: MatchSample | null = null
  const port = recordingPort()
  const audio = new GameAudio(port)
  try {
    for (let tick = 0; tick < 1800; tick++) {
      sim.step(neutral)
      sampleMatch(sim, sample, scratch)
      const next = copySample(sample, null)
      const played = audio.observe(sample)
      if (tick === 0) assert.equal(port.played.length, 0, 'the first frame plays no event')
      if (prev !== null) {
        for (const event of played) pairs.push({ event, prev, next })
        for (const p of next.players) if (p.footDown !== 0) footDowns++
        for (let p = 0; p < next.players.length; p++) {
          if (prev.players[p].status === PlayerStatus.alive && next.players[p].status === PlayerStatus.eliminated) {
            eliminations.add(p)
          }
        }
      }
      prev = next
    }
  } finally {
    sim.free()
  }

  const of = (id: string) => pairs.filter(({ event }) => event.id === id)
  const steps = pairs.filter(({ event }) => event.id.startsWith('move.step.'))
  const jumps = of('move.jump')
  const landings = [...of('move.land.soft'), ...of('move.land.hard')]
  const dives = of('move.dive')
  const eliminated = of('flow.eliminate')

  assert.ok(steps.length > 0, 'the match plays footsteps')
  assert.ok(jumps.length > 0, 'the match plays jumps')
  assert.ok(landings.length > 0, 'the match plays landings')
  assert.ok(dives.length > 0, 'the match plays dives')
  assert.ok(eliminated.length > 0, 'the match eliminates players')

  for (const { event, next } of steps) {
    const p = next.players[event.player]
    assert.notEqual(p.footDown, 0, `step event for player ${event.player} has footDown 0`)
    assert.equal(event.id, stepSoundId(p.surface, next.world))
  }
  assert.equal(port.played.filter((p) => p.id.startsWith('move.step.')).length, steps.length)
  assert.equal(footDowns, steps.length, 'one step sound per foot contact')

  for (const { event, prev: a, next } of jumps) {
    const before = a.players[event.player]
    const after = next.players[event.player]
    assert.equal(before.grounded, true, 'a jump starts on the ground')
    assert.equal(after.grounded, false, 'a jump ends in the air')
    assert.ok(after.vel.y > 0, 'a jump climbs')
  }

  for (const { event, prev: a, next } of landings) {
    const before = a.players[event.player]
    const after = next.players[event.player]
    assert.equal(before.grounded, false, 'a landing starts in the air')
    assert.equal(after.grounded, true, 'a landing ends on the ground')
    const impact = -before.vel.y
    assert.equal(event.id, impact < 9 ? 'move.land.soft' : 'move.land.hard')
  }

  for (const { event, prev: a, next } of dives) {
    assert.notEqual(a.players[event.player].mode, CharMode.dive)
    assert.equal(next.players[event.player].mode, CharMode.dive)
  }

  const eliminatedOnce = new Set<number>()
  for (const { event, prev: a, next } of eliminated) {
    assert.equal(a.players[event.player].status, PlayerStatus.alive)
    assert.equal(next.players[event.player].status, PlayerStatus.eliminated)
    assert.equal(eliminatedOnce.has(event.player), false, `player ${event.player} was eliminated twice`)
    eliminatedOnce.add(event.player)
  }
  assert.deepEqual([...eliminatedOnce].sort(), [...eliminations].sort())
})

test('a slide keeps one loop, sets its speed and stops when the slide ends', () => {
  const port = recordingPort()
  const audio = new GameAudio(port)
  audio.observe(frame([player()]))
  audio.observe(frame([player({ slideSpeed: 1.4 })]))
  const rec = port.loops.find((l) => l.id === 'move.slide')
  assert.ok(rec, 'a moving slide starts a loop')
  assert.deepEqual(rec.sets, [['speed', 1.4]])
  assert.equal(rec.moves.length, 1)
  audio.observe(frame([player({ slideSpeed: 2.2 })]))
  assert.deepEqual(rec.sets, [['speed', 1.4], ['speed', 2.2]])
  assert.equal(rec.moves.length, 2)
  assert.deepEqual(rec.stops, [])
  audio.observe(frame([player()]))
  assert.deepEqual(rec.stops, [0.15])
  assert.equal(port.started.filter((id) => id === 'move.slide').length, 1)
})

test('a belly stroke of +1.5 m/s plays move.swim once', () => {
  const port = recordingPort()
  const audio = new GameAudio(port)
  audio.observe(frame([player()]))
  const stroke = audio.observe(frame([player({ slideSpeed: 1.5 })]))
  assert.deepEqual(stroke.filter((e) => e.id === 'move.swim').map((e) => e.player), [0])
  const drift = audio.observe(frame([player({ slideSpeed: 2.5 })]))
  assert.equal(drift.some((e) => e.id === 'move.swim'), false)
})

test('grabbing, releasing and carrying play once on entry', () => {
  const port = recordingPort()
  const audio = new GameAudio(port)
  audio.observe(frame([player()]))
  const grabbed = audio.observe(frame([player({ mode: CharMode.grabbing })]))
  assert.deepEqual(grabbed.map((e) => e.id), ['move.grab'])
  const held = audio.observe(frame([player({ mode: CharMode.grabbing })]))
  assert.deepEqual(held, [])
  const released = audio.observe(frame([player()]))
  assert.deepEqual(released.map((e) => e.id), ['move.release'])
  const carried = audio.observe(frame([player({ carry: 1 })]))
  assert.deepEqual(carried.map((e) => e.id), ['move.carry'])
  const stillCarried = audio.observe(frame([player({ carry: 2 })]))
  assert.deepEqual(stillCarried, [])
})

test('stun, hit and wobble follow the proximity rules', () => {
  const stunnedBy = (others: PlayerSample[]): string => {
    const port = recordingPort()
    const audio = new GameAudio(port)
    const self = player({ pos: { x: 0, y: 0, z: 0 } })
    audio.observe(frame([self, ...others]))
    const events = audio.observe(frame([player({ pos: { x: 0, y: 0, z: 0 }, mode: CharMode.stunned }), ...others]))
    return events.find((e) => e.player === 0)?.id ?? ''
  }
  const other = (x: number, mode: number = CharMode.ground): PlayerSample => player({ pos: { x, y: 0, z: 0 }, mode })
  assert.equal(stunnedBy([other(1.4)]), 'move.hit')
  assert.equal(stunnedBy([other(1.6)]), 'move.stun')
  assert.equal(stunnedBy([other(1.1, CharMode.grabbing)]), 'move.wobble')
  assert.equal(stunnedBy([other(1.3, CharMode.grabbing)]), 'move.hit')
})

test('the first frame plays nothing', () => {
  const port = recordingPort()
  const audio = new GameAudio(port)
  const events = audio.observe(frame([player({ mode: CharMode.dive, footDown: 1, vel: { x: 0, y: 5, z: 0 } })]))
  assert.deepEqual(events, [])
  assert.equal(port.played.length, 0)
})

test('music cues follow the screen and the phase, ambience plays and crowd follows the bed', () => {
  assert.equal(musicCue('lobby', null), 'music.candy.lobby')
  assert.equal(musicCue('match', frame([], { roundKind: 'survival' })), 'music.candy.survival')
  assert.equal(musicCue('match', frame([], { phase: Phase.done })), 'music.candy.podium')

  const lobbyPort = recordingPort()
  new GameAudio(lobbyPort).observe(frame([]), 'lobby')
  assert.ok(lobbyPort.started.includes('music.candy.lobby'))

  const port = recordingPort()
  const audio = new GameAudio(port)
  audio.observe(frame([], { roundKind: 'survival' }))
  assert.ok(port.started.includes('music.candy.survival'))
  assert.ok(port.started.includes('amb.candy'), 'a match in candy plays its ambience')
  const crowd = port.loops.find((l) => l.id === CROWD_BED_ID)
  assert.ok(crowd, 'a round starts the crowd bed')
  assert.deepEqual(crowd.sets.at(-1), ['excitement', BED_EXCITEMENT.survival])
  audio.observe(frame([], { roundKind: 'race', final: true }))
  assert.deepEqual(crowd.sets.at(-1), ['excitement', BED_EXCITEMENT.final])
  audio.observe(frame([], { roundKind: 'race' }))
  assert.deepEqual(crowd.sets.at(-1), ['excitement', BED_EXCITEMENT.race])
  assert.equal(port.started.filter((id) => id === CROWD_BED_ID).length, 1)
  audio.observe(frame([], { phase: Phase.roundEnd }))
  assert.deepEqual(crowd.stops, [BED_FADE_S])

  const donePort = recordingPort()
  const done = new GameAudio(donePort)
  done.observe(frame([], { phase: Phase.done }))
  done.observe(frame([], { phase: Phase.done }))
  assert.deepEqual(donePort.played.map((p) => p.id).filter((id) => id.startsWith('music.')), ['music.candy.podium'])
})
