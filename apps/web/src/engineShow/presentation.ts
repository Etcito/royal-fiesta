import type { ViewBuffer } from '@etcito/game-engine'
import { RenderBridge } from '@etcito/game-engine/render'
import type { RaaEngineView } from '@etcito/game-engine/render'
import { readShowViewState } from '@royal-fiesta/game/ege/worldRead'
import { showSchemaLayout } from '@royal-fiesta/game/ege/showState'
import { EngineFarView } from '@royal-fiesta/game/ege/showFar'
import type { EngineShowEffectSinks } from '@royal-fiesta/game/ege/showEffects'
import type {
  EnginePresentationWorld, EngineRoundResult, EngineShowObservation, EngineShowPresentation, EngineShowSnapshot,
} from '@royal-fiesta/game/ege/showTypes'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import type { GameScreen } from '@royal-fiesta/game/screens/nav'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { FinalRule, RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'

const TICK_RATE = 60
const VIEW_HEADER = 8
const PHYSICS_KINDS: ReadonlySet<string> = new Set(['seat', 'field', 'hub'])
const UNIT: Vec3T = [1, 1, 1]

/** Existing audio-pack cue for each engine presentation event name; other events play nothing. */
export const ENGINE_EVENT_SOUNDS: Readonly<Record<string, string>> = {
  finish: 'flow.qualify',
  eliminate: 'flow.eliminate',
  fall: 'move.land.hard',
  score: 'obj.pickup',
  team_score: 'obj.goal',
  possess: 'obj.steal',
  crown: 'obj.crown',
  match: 'flow.win',
}

/** The audio-pack boundary the sound sink plays through (BrowserSound.port satisfies it). */
export interface EngineAudioSink {
  play(id: string): unknown
}

/**
 * Builds the sinks handed only to EngineShowEffects: sound plays the mapped audio-pack cue once per confirmed
 * event, grant records the confirmed round result under its receipt. Nothing else calls these sinks.
 */
export function engineEffectSinks(audio: () => EngineAudioSink | null, grants: Map<string, EngineRoundResult>): EngineShowEffectSinks {
  return {
    sound(name) {
      const cue = ENGINE_EVENT_SOUNDS[name]
      if (cue !== undefined) audio()?.play(cue)
    },
    grant(receipt, result) {
      grants.set(receipt, result)
    },
  }
}

/** A ShowDirector-compatible screen model of the authoritative snapshot; no decision is recomputed. */
export interface EngineScreenModel {
  screen: GameScreen
  loading: boolean
  source: EngineShowSnapshot['screen']
  round: number
  map: string | null
  kind: RoundKind | null
  finalRule: FinalRule | null
  timer: string
  overtime: boolean
  alive: number
  qualified: number | null
  eliminated: number | null
  champion: number | null
  podium: readonly number[] | null
  hud: readonly string[]
}

const SCREEN_OF: Readonly<Record<EngineShowSnapshot['screen'], GameScreen>> = {
  vote: 'vote',
  loading: 'countdown',
  intro: 'countdown',
  playing: 'round',
  overtime: 'round',
  results: 'result',
  podium: 'podium',
  done: 'endScreen',
}

/** The confirmed podium: the snapshot's champion first, then its confirmed result's ranking; null until confirmed. */
export function confirmedPodium(snapshot: EngineShowSnapshot): number[] | null {
  const champion = snapshot.champion
  if (champion === null || champion < 0) return null
  const result = [...snapshot.results].reverse().find(item => item.champion === champion)
  if (result === undefined) return null
  return [champion, ...result.ranking.filter(seat => seat !== champion)].slice(0, 3)
}

/** PodiumStage tints by palette index; a room seat beyond the palette wraps through it. */
export function podiumPlayers(podium: readonly number[]): number[] {
  return podium.map(seat => seat % PALETTE.length)
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Tracks the observed start tick of each played round so the HUD timer shows the authored time cap counting down. */
export class EngineScreenTracker {
  private playRound = -1
  private playStart = 0

  update(snapshot: EngineShowSnapshot, presentation: Pick<EngineShowPresentation, 'map' | 'course'>, season: readonly SchedMap[], localSeat: number): EngineScreenModel {
    const playing = snapshot.screen === 'playing' || snapshot.screen === 'overtime'
    if (playing && this.playRound !== snapshot.round) {
      this.playRound = snapshot.round
      this.playStart = snapshot.tick
    }
    const last = snapshot.results[snapshot.results.length - 1] ?? null
    const map = presentation.map ?? last?.map ?? null
    const entry = season.find(item => item.id === map) ?? null
    const kind = entry?.kind ?? last?.kind ?? null
    const finalRule = entry?.finalRule ?? null
    const overtime = snapshot.screen === 'overtime'
    const limit = presentation.course?.timeLimitS ?? 0
    const elapsed = playing ? (snapshot.tick - this.playStart) / TICK_RATE : 0
    const timer = overtime ? 'OVERTIME' : playing ? clock(limit - elapsed) : clock(limit)
    const ended = snapshot.screen === 'results' || snapshot.screen === 'podium' || snapshot.screen === 'done'
    const qualified = ended && last !== null ? last.qualified.length : null
    const eliminated = ended && last !== null ? last.eliminated.length : null
    const podium = snapshot.screen === 'podium' || snapshot.screen === 'done' ? confirmedPodium(snapshot) : null
    const screen = SCREEN_OF[snapshot.screen] === 'round' && !snapshot.alive.includes(localSeat) ? 'spectate' : SCREEN_OF[snapshot.screen]
    const label = kind === null ? 'Round' : kind === 'final' && finalRule !== null ? `final (${finalRule})` : kind
    const hud = [
      `Round ${snapshot.round + 1}: ${label}${map === null ? '' : ` - ${map}`}`,
      `${snapshot.screen.toUpperCase()}  ${timer}`,
      qualified === null ? `Alive ${snapshot.alive.length}` : `Qualified ${qualified}  Eliminated ${eliminated}`,
    ]
    if (podium !== null) hud.push(`Champion: seat ${podium[0]}`)
    return {
      screen, loading: snapshot.screen === 'loading', source: snapshot.screen, round: snapshot.round, map, kind, finalRule,
      timer, overtime, alive: snapshot.alive.length, qualified, eliminated, champion: podium?.[0] ?? null, podium, hud,
    }
  }
}

/** Engine reads of a live presentation world; tests substitute them. */
export interface EnginePresentationReaders {
  tick(world: EnginePresentationWorld): number
  parked(world: EnginePresentationWorld, entities: readonly number[]): ReadonlySet<number>
}

export const ENGINE_PRESENTATION_READERS: EnginePresentationReaders = {
  tick: world => world.ref.timeline.module.engine.tick(world.ref.world),
  parked(world, entities) {
    const engine = world.ref.timeline.module.engine
    const characters = readShowViewState(engine, world.ref.world, showSchemaLayout(engine)).components.character ?? {}
    return new Set(entities.filter(entity => characters[String(entity)]?.mode === CharMode.parked))
  },
}

/** The stable room seats submitted to each renderer for one drawn frame, and the far records submitted. */
export interface EngineSeatSubmission {
  near: ReadonlySet<number>
  far: ReadonlySet<number>
  view: ViewBuffer
}

function filterView(view: ViewBuffer, keep: (seat: number) => boolean): ViewBuffer {
  const source = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength)
  const kept: number[] = []
  for (let i = 0; i < view.count; i++) {
    if (keep(source.getUint32(VIEW_HEADER + i * view.stride, true))) kept.push(i)
  }
  const bytes = new Uint8Array(VIEW_HEADER + kept.length * view.stride)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, kept.length, true)
  header.setUint32(4, view.stride, true)
  kept.forEach((index, n) => {
    const start = VIEW_HEADER + index * view.stride
    bytes.set(view.bytes.subarray(start, start + view.stride), VIEW_HEADER + n * view.stride)
  })
  return { count: kept.length, stride: view.stride, bytes }
}

function seatsOf(view: ViewBuffer): Set<number> {
  const source = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength)
  const seats = new Set<number>()
  for (let i = 0; i < view.count; i++) seats.add(source.getUint32(VIEW_HEADER + i * view.stride, true))
  return seats
}

/**
 * Feeds EngineFarView from each live physics entry's farSnapshot and partitions the drawn seats: near is exactly
 * EngineShowView.nearSeats() among the active mappings, far is every other active non-parked mapped seat.
 * An incarnation change or release clears the far view before the remaining live entries repopulate it.
 */
export class EngineSeatPresenter {
  private readonly far: EngineFarView
  private readonly readers: EnginePresentationReaders
  private incarnations = ''
  private released = new Set<number>()
  private stale = false
  private active = new Set<number>()
  private near = new Set<number>()

  constructor(readers: EnginePresentationReaders = ENGINE_PRESENTATION_READERS, far = new EngineFarView()) {
    this.readers = readers
    this.far = far
  }

  /** A post-tick observation feeds snapshots; a before-release observation only invalidates the departing worlds. */
  observe(observation: EngineShowObservation, near: ReadonlySet<number>): void {
    if (observation.kind === 'before-release') {
      for (const world of observation.presentation.worlds) this.released.add(world.incarnation)
      this.far.clear()
      this.incarnations = ''
      this.stale = true
      return
    }
    this.accept(observation.presentation, observation.snapshot, near)
  }

  /** Before drawing after a release, repopulate from the remaining live entries; otherwise nothing changes. */
  refill(presentation: EngineShowPresentation, snapshot: EngineShowSnapshot, near: ReadonlySet<number>): void {
    if (this.stale) this.accept(presentation, snapshot, near)
  }

  /** The seats this frame submits; throws when a stable seat would be drawn by both renderers. */
  submission(): EngineSeatSubmission {
    const near = new Set([...this.near].filter(seat => this.active.has(seat)))
    const view = filterView(this.far.read(near), seat => this.active.has(seat) && !near.has(seat))
    const far = seatsOf(view)
    for (const seat of far) {
      if (near.has(seat)) throw new Error(`engine-show: seat ${seat} was submitted to both the near and far renderers`)
    }
    return { near, far, view }
  }

  /** Released incarnations still remembered; bounded by the worlds the runtime lists, never by the rounds played. */
  get releasedCount(): number { return this.released.size }

  clear(): void {
    this.far.clear()
    this.incarnations = ''
    this.active = new Set()
    this.near = new Set()
  }

  private accept(presentation: EngineShowPresentation, snapshot: EngineShowSnapshot, near: ReadonlySet<number>): void {
    // An incarnation the runtime no longer lists can never come back: forget it, so the set holds only listed worlds.
    const listed = new Set(presentation.worlds.map(world => world.incarnation))
    for (const incarnation of this.released) if (!listed.has(incarnation)) this.released.delete(incarnation)
    const worlds = presentation.worlds.filter(world => PHYSICS_KINDS.has(world.ref.kind) && !this.released.has(world.incarnation))
    const key = worlds.map(world => `${world.ref.domain}:${world.incarnation}`).join(',')
    if (key !== this.incarnations) this.far.clear()
    this.incarnations = key
    this.stale = false
    const roster = new Set(snapshot.seatOf)
    const active = new Map<number, number>()
    for (const world of worlds) {
      this.far.accept(world.ref.domain, this.readers.tick(world), world.farSnapshot())
      const parked = this.readers.parked(world, world.seats.map(seat => seat.entity))
      for (const seat of world.seats) {
        if (!roster.has(seat.roomSeat) || parked.has(seat.entity)) continue
        if (active.has(seat.roomSeat) && active.get(seat.roomSeat) !== world.incarnation) {
          throw new Error(`engine-show: seat ${seat.roomSeat} is mapped by two live worlds`)
        }
        active.set(seat.roomSeat, world.incarnation)
      }
    }
    this.active = new Set(active.keys())
    this.near = new Set(near)
  }
}

/**
 * The far penguin RenderBridge path: the unchanged engine RenderBridge draws EngineFarView records through a
 * RaaEngineView adapter that instances the existing far penguin mesh (zoneContent's bean) on the render port.
 */
export function farPenguinBridge(port: RenderPort, bean: PrimsAsset): Pick<RenderBridge, 'sync' | 'dispose' | 'instances'> {
  const asset = port.registerAsset('zone-far-bean', bean)
  const colors: Vec3T[] = []
  const nodes = new Map<number, number | null>()
  let next = 1
  const raa: RaaEngineView = {
    primitiveMesh: () => 0,
    addMaterial(desc) {
      return colors.push([desc.color[0], desc.color[1], desc.color[2]]) - 1
    },
    addNode() {
      nodes.set(next, null)
      return next++
    },
    addInstance(node, _mesh, material) {
      const instance = port.createInstance(asset, colors[material] ?? null)
      nodes.set(node, instance)
      return instance
    },
    setTransforms(ids, trs) {
      for (let i = 0; i < ids.length; i++) {
        const instance = nodes.get(ids[i])
        if (instance === null || instance === undefined) continue
        const o = i * 10
        port.setTransform(instance, [trs[o], trs[o + 1], trs[o + 2]], [trs[o + 3], trs[o + 4], trs[o + 5], trs[o + 6]], UNIT)
      }
    },
    setVisible: (instance, visible) => port.setVisible(instance, visible),
    removeNode(node) {
      const instance = nodes.get(node)
      nodes.delete(node)
      if (instance !== null && instance !== undefined) port.destroyInstance(instance)
      if (node !== 1) return
      for (const [, other] of nodes) if (other !== null) port.destroyInstance(other)
      nodes.clear()
    },
  }
  return new RenderBridge(raa)
}
