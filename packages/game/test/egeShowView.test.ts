import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PreviewPose } from '@etcito/game-engine/preview'
import type { WorldState } from '@etcito/game-engine/world-state'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { Pose } from '@royal-fiesta/sim/vec'
import { EngineShowView } from '../src/ege/showView.ts'
import type { EngineViewReaders } from '../src/ege/showView.ts'
import type { EnginePresentationWorld, EngineShowPresentation, EngineShowSnapshot, EngineWorldRef } from '../src/ege/showTypes.ts'

interface FakeEngine {
  components: Record<string, Record<string, Record<string, number | number[]>>>
}

// The fake engine answers the two engine reads: a pose at [entity,0,0] and the components the world was built with.
const READERS: EngineViewReaders = {
  poses: (_engine, _world, ids) => ids.map(id => ({ t: [id, 0, 0], r: [0, 0, 0, 1], matrix: new Float32Array(16) }) as PreviewPose),
  state: engine => ({ tick: 0, components: (engine as unknown as FakeEngine).components, resources: {}, entities: [] }) as unknown as WorldState,
}

interface FakeSeat {
  roomSeat: number
  roundSeat: number
  inputSlot: number
  entity: number
}

function snapshot(seatOf: number[], overrides: Partial<EngineShowSnapshot> = {}): EngineShowSnapshot {
  return {
    tick: 10,
    round: 1,
    screen: 'playing',
    seatOf,
    alive: seatOf,
    candidates: [],
    results: [],
    champion: null,
    faults: 0,
    ...overrides,
  }
}

function emptyCharacter(mode: number = CharMode.ground): Record<string, number | number[]> {
  return { mode, timer: 0, stroke_timer: 0, slide_speed: 0, carry: 0, teleport_tick: 0, facing: [0, 1], ground_item: -1, ground_body: -1, ground_obstacle: -1 }
}

// Builds one physics world whose seats are entities 1000 + roomSeat; `parked` seats get the parked mode.
function world(seats: FakeSeat[], options: { incarnation?: number, world?: number, parked?: number[], course?: string, obstacleCount?: number } = {}): EnginePresentationWorld {
  const components: Record<string, Record<string, Record<string, number | number[]>>> = { character: {}, seat: {}, 'ege.velocity': {} }
  for (const seat of seats) {
    const mode = options.parked?.includes(seat.roomSeat) ? CharMode.parked : CharMode.ground
    components.character[String(seat.entity)] = emptyCharacter(mode)
    components.seat[String(seat.entity)] = { status: 1 }
    components['ege.velocity'][String(seat.entity)] = { lin: [0.5, 0, 0] }
  }
  const engine = { components } as unknown as FakeEngine
  const ref = { domain: 1, kind: 'seat', world: options.world ?? 7, binding: {}, timeline: { module: { engine } }, confirmedTick: 0, resimulating: false } as unknown as EngineWorldRef
  const obstacles = Array.from({ length: options.obstacleCount ?? 0 }, (_, i) => ({ spec: { id: `o${i}` } as never, entity: 500 + i }))
  return {
    ref,
    incarnation: options.incarnation ?? 1,
    scene: { index: (name: string) => (name === 'levers/gate' ? 900 : -1) } as never,
    seats: seats.map(seat => ({ ...seat })),
    entities: new Map(seats.map(seat => [seat.roomSeat, seat.entity])),
    obstacles,
    mechanisms: [],
    bodies: new Map([['item/body', 700]]),
    features: [],
    publishers: new Map(),
  } as unknown as EnginePresentationWorld
}

function presentation(worlds: EnginePresentationWorld[], course: unknown = null, tick = 10): EngineShowPresentation {
  return { showId: 'show-1', tick, round: 1, map: null, course: course as never, worlds }
}

function runtime(pres: () => EngineShowPresentation, snap: () => EngineShowSnapshot) {
  return { presentation: pres, snapshot: snap } as never
}

function sixtySeats(): FakeSeat[] {
  return Array.from({ length: 60 }, (_, roomSeat) => ({ roomSeat, roundSeat: roomSeat, inputSlot: roomSeat === 20 ? 0 : roomSeat === 5 ? 1 : -1, entity: 1000 + roomSeat }))
}

function allSeats(): number[] {
  return Array.from({ length: 60 }, (_, i) => i)
}

describe('EngineShowView near membership', () => {
  it('selects humans first then bots in ascending room seat, leaving the rest far (sixty seats)', () => {
    const pres = presentation([world(sixtySeats())])
    const view = new EngineShowView(runtime(() => pres, () => snapshot(allSeats())), READERS)
    view.refresh(1)
    const near = [...view.nearSeats()].sort((a, b) => a - b)
    assert.equal(near.length, 8)
    assert.ok(near.includes(5))
    assert.ok(near.includes(20))
    assert.equal(view.nearSeats().size, 8)
    assert.deepEqual([...view.nearSeats()].slice(0, 2), [20, 5])
    assert.equal(60 - near.length, 52)
  })

  it('compacts survivors: eliminated seats are never near or far candidates', () => {
    const survivors = [3, 9, 12]
    const seats = survivors.map(roomSeat => ({ roomSeat, roundSeat: 0, inputSlot: -1, entity: 1000 + roomSeat }))
    const pres = presentation([world(seats)])
    const view = new EngineShowView(runtime(() => pres, () => snapshot(survivors)), READERS)
    view.refresh(1)
    assert.deepEqual([...view.nearSeats()], survivors)
  })

  it('refuses two live entities owning one stable room seat', () => {
    const a = world([{ roomSeat: 4, roundSeat: 0, inputSlot: -1, entity: 1004 }], { world: 1 })
    const b = world([{ roomSeat: 4, roundSeat: 0, inputSlot: -1, entity: 2004 }], { world: 2 })
    const view = new EngineShowView(runtime(() => presentation([a, b]), () => snapshot([4])), READERS)
    assert.throws(() => view.refresh(1), /owned by two live entities/)
  })

  it('has an empty near set and parked seats when no physics world is live', () => {
    const view = new EngineShowView(runtime(() => presentation([]), () => snapshot([])), READERS)
    view.refresh(1)
    assert.equal(view.nearSeats().size, 0)
    assert.equal(view.course(), null)
    assert.equal(view.obstacleCount(), 0)
    const out = view.character(0, { pos: { x: 9, y: 9, z: 9 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 }, mode: 0, status: 0, parked: false, teleportTick: 0, strokeTimer: 3 } as CharacterView)
    assert.equal(out.parked, true)
    assert.equal(out.strokeTimer, undefined)
  })

  it('returns a copy of the near set', () => {
    const pres = presentation([world([{ roomSeat: 1, roundSeat: 0, inputSlot: 0, entity: 1001 }])])
    const view = new EngineShowView(runtime(() => pres, () => snapshot([1])), READERS)
    view.refresh(1)
    const copy = view.nearSeats() as Set<number>
    copy.delete(1)
    assert.equal(view.nearSeats().has(1), true)
  })
})

describe('EngineShowView character views', () => {
  it('copies pose, velocity and optional detail for near seats and clears them for far seats', () => {
    const seats = Array.from({ length: 9 }, (_, roomSeat) => ({ roomSeat, roundSeat: roomSeat, inputSlot: roomSeat === 2 ? 0 : -1, entity: 1000 + roomSeat }))
    const pres = presentation([world(seats)])
    const view = new EngineShowView(runtime(() => pres, () => snapshot(seats.map(seat => seat.roomSeat))), READERS)
    view.refresh(0.5)
    assert.equal(view.nearSeats().has(8), false)
    const near = view.character(2, blank())
    assert.equal(near.parked, false)
    assert.equal(near.pos.x, 1002)
    assert.equal(near.vel.x, 0.5)
    assert.equal(near.strokePhase !== undefined, true)
    assert.equal(near.strokeStart, 0.5)
    const far = view.character(8, blank())
    assert.equal(far.parked, true)
    assert.equal(far.strokeTimer, undefined)
    assert.equal(far.slideAir, undefined)
    assert.equal(far.surface, undefined)
  })

  it('refuses invalid seat indices', () => {
    const view = new EngineShowView(runtime(() => presentation([]), () => snapshot([])), READERS)
    view.refresh(1)
    assert.throws(() => view.character(60, blank()), /outside 0\.\.59/)
    assert.throws(() => view.character(-1, blank()), /outside 0\.\.59/)
  })

  it('reads a replaced incarnation after refresh instead of the departing one', () => {
    const first = world([{ roomSeat: 0, roundSeat: 0, inputSlot: 0, entity: 1000 }], { incarnation: 1 })
    const second = world([{ roomSeat: 0, roundSeat: 0, inputSlot: 0, entity: 3000 }], { incarnation: 2 })
    let current = presentation([first])
    const view = new EngineShowView(runtime(() => current, () => snapshot([0])), READERS)
    view.refresh(1)
    assert.equal(view.character(0, blank()).pos.x, 1000)
    current = presentation([second], null, 11)
    view.refresh(1)
    assert.equal(view.character(0, blank()).pos.x, 3000)
  })
})

describe('EngineShowView course, mechanisms and phase', () => {
  it('refuses invalid obstacle indices and leaves an absent mechanism body output unchanged', () => {
    const course = { mechanisms: { items: [{ id: 'item', bodies: [{ id: 'other' }] }] }, obstacles: [] }
    const pres = presentation([world([], { obstacleCount: 0 })], course)
    const view = new EngineShowView(runtime(() => pres, () => snapshot([])), READERS)
    view.refresh(1)
    assert.throws(() => view.obstacleSpec(0), /outside/)
    const out: Pose = { t: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0, w: 1 } }
    const before = JSON.stringify(out)
    assert.equal(view.mechanismBodyPose({ item: 0, body: 0 } as never, out), false)
    assert.equal(JSON.stringify(out), before)
    assert.equal(view.mechanismItemCount(), 1)
  })

  it('maps confirmed results to the podium and copies the stable winner', () => {
    const result = { index: 0, map: 'm', course: 'c', kind: 'race', final: true, playoff: false, endTick: 9, reason: 'target', ranking: [7, 3, 9, 1], qualified: [7], eliminated: [], points: [3, 2, 1, 0], teamScores: [], champion: 7 }
    const snap = snapshot([7, 3, 9, 1], { screen: 'podium', results: [result] as never, champion: 7 })
    const view = new EngineShowView(runtime(() => presentation([]), () => snap), READERS)
    view.refresh(1)
    const out = view.phase({ podium: [] } as unknown as MatchViewState)
    assert.equal(out.phase, Phase.podium)
    assert.equal(out.winner, 7)
    assert.deepEqual(out.podium, [7, 3, 9])
    assert.equal(out.qualifiedCount, 1)
  })

  it('refuses use after dispose and clears the near set', () => {
    const pres = presentation([world([{ roomSeat: 2, roundSeat: 0, inputSlot: 0, entity: 1002 }])])
    const view = new EngineShowView(runtime(() => pres, () => snapshot([2])), READERS)
    view.refresh(1)
    assert.equal(view.nearSeats().size, 1)
    view.dispose()
    assert.equal(view.nearSeats().size, 0)
    assert.throws(() => view.refresh(1), /was disposed/)
  })
})

function blank(): CharacterView {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    facing: { x: 0, z: 0 },
    mode: 0,
    status: 0,
    parked: false,
    teleportTick: 0,
    strokeTimer: 1,
    strokePhase: 1,
    strokeStart: 1,
    slideSpeed: 1,
    carry: 1,
    surface: 'ice',
    slideAir: true,
  }
}
