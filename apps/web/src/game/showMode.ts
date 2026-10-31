import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { MAX_PEERS } from '@gamesaloon/rollback/zones'
import type { FarSink, Roster } from '@gamesaloon/rollback/zones'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { newModeBotMemory, modeBotInput } from '@royal-fiesta/game/net/modeBots'
import { createZoneFullMatch } from '@royal-fiesta/game/net/zoneFullMatch'
import type { ZoneFullMatch, ZoneFullRound } from '@royal-fiesta/game/net/zoneFullMatch'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import type { Action, GameScreen } from '@royal-fiesta/game/screens/nav'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import { levelOf } from '@royal-fiesta/sim/course'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { zoneContent } from '../zone/zoneContent.ts'
import { prepareZoneNetScene } from '../zone/zoneNetScene.ts'
import type { ZoneNetScene } from '../zone/zoneNetScene.ts'
import { ShowDirector } from './showDirector.ts'
import type { ShowFrame } from './showDirector.ts'
import { loadShowContent } from './showContent.ts'

const SHOW_SEATS_PER_PEER = 4

export interface ShowModeOptions {
  R: RapierModule
  views: HTMLElement
  seats: number
  seed: number
  localName: string
}

/** Owns the offline transport, simulation and round canvas; the app owns the stage. */
export class ShowMode {
  private full: ZoneFullMatch | null = null
  private readonly fulls: ZoneFullMatch[] = []
  private roster: Roster | null = null
  private director: ShowDirector | null = null
  private current: ShowFrame | null = null
  private scene: ZoneNetScene | null = null
  private index = -1
  private disposed = false
  private error: string | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly stages: { canvas: HTMLCanvasElement; display: string }[]
  private loopback: ZoneLoopback | null = null
  private readonly memories: ReturnType<typeof newModeBotMemory>[]
  private sampleTicks: number[] = []
  private readonly options: ShowModeOptions
  private sounds: string[] = []

  private constructor(options: ShowModeOptions) {
    this.options = options
    this.memories = []
    this.stages = Array.from(options.views.querySelectorAll('canvas'), canvas => ({ canvas, display: canvas.style.display }))
    this.canvas = options.views.ownerDocument.createElement('canvas')
    const dpr = options.views.ownerDocument.defaultView?.devicePixelRatio ?? 1
    this.canvas.width = Math.max(1, Math.round(options.views.clientWidth * dpr))
    this.canvas.height = Math.max(1, Math.round(options.views.clientHeight * dpr))
    this.canvas.dataset.show = 'true'
    this.canvas.style.display = 'none'
    options.views.appendChild(this.canvas)
  }

  static async create(options: ShowModeOptions): Promise<ShowMode> {
    const mode = new ShowMode(options)
    try {
      if (!Number.isInteger(options.seats) || options.seats < 2 || options.seats > 60) {
        refuse('game-web', 'showMode.seats', 'supply an integer from 2 to 60')
      }
      const peerCount = Math.ceil(options.seats / SHOW_SEATS_PER_PEER)
      if (peerCount > MAX_PEERS) {
        refuse('game-web', 'showMode.seats', `${peerCount} peers exceed the ${MAX_PEERS} transport limit`)
      }
      const peers = Array.from({ length: peerCount }, (_, peer) => ({ peer, seats: [] as number[] }))
      for (let seat = 0; seat < options.seats; seat++) peers[seat % peerCount].seats.push(seat)
      const roster: Roster = { seatCount: options.seats, peers, live: peers.map(() => true) }
      mode.roster = roster
      const measurements = Object.fromEntries(peers.map(({ peer }) =>
        [peer, { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }]))
      mode.loopback = new ZoneLoopback(peerCount, { seed: options.seed, rttMs: 0, jitterMs: 0, loss: 0 })
      mode.sampleTicks = peers.map(() => 0)
      const content = await loadShowContent('sprint')
      const seats = Array.from({ length: options.seats }, (_, seat) => seat)
      mode.memories.push(...seats.map(() => newModeBotMemory()))
      const farSink: FarSink = {
        far: (...args) => mode.scene?.feed.far(...args),
        sleep: (...args) => mode.scene?.feed.sleep(...args),
      }
      for (const { peer } of peers) {
        mode.fulls.push(createZoneFullMatch(options.R, {
          localPeer: peer, roster,
          seed: options.seed, courses: content.courses, zones: content.zones, season: content.season,
          profile: 'sprint', voteMs: 5000, intermissionMs: 12000,
          farSink: peer === 0 ? farSink : undefined, measurements,
        }, mode.loopback.transport(peer)))
      }
      mode.full = mode.fulls[0]
      mode.director = new ShowDirector(mode.full, content.info, seat => mode.name(seat), 0)
      mode.current = mode.director.step(null, 0)
    } catch (error) {
      mode.fail(error)
    }
    return mode
  }

  private name(seat: number): string { return seat === 0 ? this.options.localName : `Bot ${seat}` }
  get failure(): string | null { return this.error }
  get finished(): boolean { return this.current?.finished ?? false }
  get models(): ShowFrame | null { return this.current }
  screen(): GameScreen { return this.current?.screen ?? 'vote' }
  cues(): string[] { const sounds = this.sounds; this.sounds = []; return sounds }

  frame(dtS: number, action: Action | null, human: PlayerInput): void {
    if (this.disposed || this.error !== null || this.full === null || this.director === null) return
    const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
    try {
      this.current = this.director.step(action, dt * 1000)
      this.sounds.push(...this.current.sounds)
      this.loadRound()
      if (!this.current.hold && !this.finished) {
        this.loopback!.advance(dt * 1000)
        for (let peer = 0; peer < this.fulls.length; peer++) {
          this.fulls[peer].frame(dt, (round, out) => this.sample(peer, round, out, human))
        }
        // Start loading on the vote result, before the next animation frame.
        if (this.full.round !== null && this.full.round.plan.index !== this.index) {
          this.current = this.director.step(null, 0)
          this.sounds.push(...this.current.sounds)
          this.loadRound()
        }
      }
      const visible = ['countdown', 'round', 'spectate'].includes(this.screen())
      this.canvas.style.display = visible ? '' : 'none'
      for (const stage of this.stages) stage.canvas.style.display = visible ? 'none' : stage.display
      const round = this.full.round
      if (visible && this.scene !== null && round !== null && round.plan.index === this.index) {
        this.scene.update(round.match, 1, dt)
        this.scene.render()
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private sample(peer: number, round: ZoneFullRound, out: PlayerInput[], human: PlayerInput): void {
    for (let i = 0; i < round.localSeats.length; i++) {
      const seat = round.localSeats[i]
      const roomSeat = round.seatOf[seat]
      if (roomSeat === 0) { Object.assign(out[i], human); continue }
      const domain = round.match.domains.find(domain => domain.seats.includes(seat))
      if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
      else modeBotInput(domain, this.memories[roomSeat], seat, this.sampleTicks[peer], out[i])
    }
    this.sampleTicks[peer]++
  }

  private loadRound(): void {
    const round = this.full?.round
    if (round == null || round.plan.index === this.index) return
    this.index = round.plan.index
    this.scene?.dispose()
    this.scene = null
    this.sampleTicks.fill(0)
    for (let i = 0; i < this.memories.length; i++) this.memories[i] = newModeBotMemory()
    void this.prepare(round)
  }

  private async prepare(round: ZoneFullRound): Promise<void> {
    const index = round.plan.index
    try {
      const content = await zoneContent('sprint')
      const prepared = await prepareZoneNetScene({
        canvas: this.canvas, course: round.plan.course, createPort: content.createPort,
        assets: content.assets, bean: content.bean,
        character: content.character, skinned: content.skinned, dressing: content.dressing,
      })
      if (this.disposed || this.error !== null || this.index !== index) { prepared.dispose(); return }
      const local = round.seatOf.indexOf(0)
      const scene = prepared.attach(round.seatOf.length, local >= 0 ? local : (round.localSeats[0] ?? 0))
      this.scene = scene
      // Mount the near scene before waiting for its animation assets.
      scene.update(round.match, 1, 0)
      await scene.ready()
      if (!this.disposed && this.error === null && this.index === index) this.director?.worldReady(index)
    } catch (error) {
      if (!this.disposed && this.index === index) this.fail(error)
    }
  }

  /** Round seats are compacted after each cut; never query domain seat 0 blindly. */
  private humanDomain() {
    const round = this.full?.round
    if (round == null) return null
    const seat = round.seatOf.indexOf(0)
    if (seat < 0) return null
    const domain = round.match.domains.find(domain => domain.seats.includes(seat))
    return domain === undefined ? null : { round, seat, domain }
  }

  hud() {
    const local = this.humanDomain()
    if (local === null) return null
    const { round, seat, domain } = local
    const duration = Math.min(levelOf(round.plan.course).timeCapTicks, roundTicks(round.plan.course, PROFILES.sprint))
    const intro = PROFILES.sprint.introTicks
    let alive = 0
    let qualified = 0
    const ledger = round.match.currentLedger
    for (let other = 0; other < round.seatOf.length; other++) {
      const owner = round.match.domains.find(candidate => candidate.seats.includes(other))
      const status = ledger?.status(other) ?? owner?.status(other) ?? PlayerStatus.alive
      if (status === PlayerStatus.alive) alive++
      if (status === PlayerStatus.qualified) qualified++
    }
    const view: MatchViewState = {
      tick: domain.tick, phase: domain.tick < intro ? Phase.intro : Phase.playing,
      phaseTicksLeft: Math.max(0, intro - domain.tick), roundIndex: round.plan.index,
      roundKind: round.plan.kind === 'race' || round.plan.kind === 'survival' ? round.plan.kind : null,
      final: round.plan.final, courseIndex: round.plan.courseIndex,
      roundTicksLeft: Math.max(0, duration - Math.max(0, domain.tick - intro)),
      alive, qualifiedCount: qualified, target: round.plan.target, winner: -1, podium: [],
    }
    return {
      view, names: round.seatOf.map(roomSeat => this.name(roomSeat)), roundTicks: duration,
      seat, name: this.name(0), status: domain.status(seat), tick: domain.tick,
      round: round.plan.index, kind: round.plan.kind, final: round.plan.final,
      target: round.plan.target, entrants: round.seatOf.length,
      result: round.match.currentLedger?.result ?? null,
    }
  }

  listener(): ListenerPose | null {
    const local = this.humanDomain()
    if (local === null) return null
    const state = local.domain.state(local.seat)
    return { x: state.pos.x, y: state.pos.y, z: state.pos.z, fx: state.facing.x, fz: state.facing.z }
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error)
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const full of this.fulls) full.dispose()
    this.fulls.length = 0
    this.full = null
    // ZoneLoopback has no dispose hook; kill its transports and release the network.
    for (const peer of this.roster?.peers ?? []) this.loopback?.net.kill(peer.peer)
    this.loopback = null
    this.scene?.dispose()
    this.scene = null
    this.canvas.remove()
    for (const stage of this.stages) stage.canvas.style.display = stage.display
  }
}
