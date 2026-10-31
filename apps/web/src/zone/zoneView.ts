// One page runs a whole zone match: every peer is an in-process createZoneMatch over a shared NetSim,
// every local seat is driven by takeoverInput, and the viewed peer draws its own domains with SceneView.
// Seats in other peers' domains come from the display-only FAR stream through FarFeed/FarRenderer.
import { NetSim } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { Roster } from '@gamesaloon/rollback/zones'
import type { CourseDressing } from '@royal-fiesta/game/content'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import { takeoverInput } from '@royal-fiesta/game/net/takeoverBot'
import { createZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { FarRenderer } from '@royal-fiesta/game/render/farRender'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ProfileName, ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { zoneContent } from './zoneContent.ts'
import { discloseSeed, ZoneFeatures, ZoneFeatureAudio, zoneSlot } from './zoneLobbyPlay.ts'

const ZONE_PREFIX = '../../../../'
const SIDECARS = import.meta.glob<string>('../../../../courses/*.zones.json', {
  query: '?raw', import: 'default', eager: true,
})
const sidecarText = new Map<string, string>()
for (const key of Object.keys(SIDECARS)) {
  if (key.startsWith(ZONE_PREFIX)) sidecarText.set(key.slice(ZONE_PREFIX.length), SIDECARS[key])
}

export interface ZoneViewOptions {
  canvas: HTMLCanvasElement
  /** Machines in the match, each running its own zone session over the shared NetSim. */
  peers?: number
  /** Local seats per peer, 1..4. */
  seatsPerPeer?: number
  seed?: number
  profile?: ProfileName
  /** A match course from client/sources.ts; defaults to the first course that has a zones sidecar. */
  courseId?: string
  /** Peer whose domains the camera views; every other peer is simulated but not drawn. */
  localPeer?: number
  kind?: 'race' | 'survival'
  /** Place the seats at points spread along course.path instead of the start spawns. */
  spreadSpawns?: boolean
  /** Network conditions of the one NetSim. */
  net?: { rttMs?: number; jitterMs?: number; loss?: number }
  width?: number
  height?: number
  /** Fixture asset lookup; defaults to preloadAssets of the chosen course. */
  assets?: (name: string) => PrimsAsset
  /** The full normal-match character asset for SceneView. */
  character?: PrimsAsset
  /** The asset FarRenderer draws (and SceneView's fallback); assets('bean') when absent. */
  bean?: PrimsAsset
  /** Normal-match skin and animation graph for the near characters. */
  skinned?: SkinnedCharacter
  dressing?: CourseDressing
  /** Receives positional course-feature sounds; omitted sounds are drained and dropped. */
  courseAudio?: CourseAudio
  /** Builds the render port; normal SDF match content is loaded when absent. */
  createPort?: (target: RenderTarget) => Promise<RenderPort>
}

export interface ZoneView {
  readonly seed: number
  /** Steps every peer one page frame; also updates the near scene and the far feed. */
  frame(dtS: number): void
  render(): void
  /** Settles once the near characters' animation finished loading (they draw at rest until then). */
  ready(): Promise<void>
  capture(): Promise<Uint8Array | null>
  dispose(): void
}

function checkOptions(o: ZoneViewOptions): void {
  const peers = o.peers ?? 4
  const seats = o.seatsPerPeer ?? 2
  if (!Number.isInteger(peers) || peers < 1 || peers > 64) {
    refuse('zone', 'mountZoneView.peers', `${peers} is outside 1..64; pass the number of machines in the match`)
  }
  if (!Number.isInteger(seats) || seats < 1 || seats > 4) {
    refuse('zone', 'mountZoneView.seatsPerPeer', `${seats} is outside 1..4; pass the local seats of one peer`)
  }
  const local = o.localPeer ?? 0
  if (!Number.isInteger(local) || local < 0 || local >= peers) {
    refuse('zone', 'mountZoneView.localPeer', `${local} is outside 0..${peers - 1}; view one of the match peers`)
  }
}

function pickCourse(courses: readonly ResolvedCourse[], id: string | undefined): ResolvedCourse {
  if (id !== undefined) {
    const found = courses.find(c => c.id === id)
    if (found === undefined) {
      refuse('zone', 'mountZoneView.courseId', `'${id}' is not a match course for this profile; use one of: ${courses.map(c => c.id).join(', ')}`)
    }
    return found
  }
  // Zone mode needs a sidecar: prefer a course that has one instead of refusing on the first course.
  const zoned = courses.find(c => sidecarText.has(`courses/${c.id}.zones.json`))
  if (zoned === undefined) {
    refuse('zone', 'mountZoneView.courseId', 'no course of this profile has a zones sidecar; add courses/<courseId>.zones.json')
  }
  return zoned
}

function readSidecar(course: ResolvedCourse): Promise<ZonesFile> {
  return loadZonesFile(course.id, course, async path => {
    const text = sidecarText.get(path)
    if (text === undefined) refuse('zones', path, 'missing; add the sidecar (zone mode needs it, full-mesh mode does not)')
    return text
  })
}

// Keep distinct lanes within each peer's pack. Sampling walkable path nodes avoids
// spawning in the gaps, while skipping jump nodes keeps the capture on platforms.
function spreadAlongPath(course: ResolvedCourse, seats: number): ResolvedCourse {
  const path = course.path.filter(node => !node.jump)
  if (path.length === 0) return course
  const lanes = 4
  const spawns: SpawnPoint[] = []
  for (let seat = 0; seat < seats; seat++) {
    const row = Math.floor(seat / lanes)
    const node = path[Math.min(row, path.length - 1)]
    const ahead = path[Math.min(row + 1, path.length - 1)]
    const dx = ahead.p.x - node.p.x
    const dz = ahead.p.z - node.p.z
    const len = Math.hypot(dx, dz)
    const fx = len > 0 ? dx / len : 0
    const fz = len > 0 ? dz / len : 1
    const count = Math.min(lanes, seats - row * lanes)
    const lane = (seat % lanes - (count - 1) / 2) * 1.5
    spawns.push({
      t: { x: node.p.x + lane * fz, y: node.p.y, z: node.p.z - lane * fx },
      facing: { x: fx, z: fz },
    })
  }
  return { ...course, spawns }
}

function rosterOf(peers: number, seatsPerPeer: number): Roster {
  const peersList = []
  for (let peer = 0; peer < peers; peer++) {
    const seats = []
    for (let i = 0; i < seatsPerPeer; i++) seats.push(peer * seatsPerPeer + i)
    peersList.push({ peer, seats })
  }
  return { seatCount: peers * seatsPerPeer, peers: peersList, live: Array.from({ length: peers }, () => true) }
}

// SceneView reads a MatchSim-shaped view. This adapter maps roster seats onto the local peer's domains;
// a seat in no local domain is parked, so SceneView hides it and FarRenderer draws it instead.
class DomainSceneSim {
  tick = 0
  readonly setup: { playerCount: number }
  private readonly courseData: ResolvedCourse
  private readonly seatDomain: (FiestaDomain | undefined)[]
  private readonly state: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: -1,
  }
  private reference: FiestaDomain | null = null

  constructor(course: ResolvedCourse, seatCount: number) {
    this.courseData = course
    this.setup = { playerCount: seatCount }
    this.seatDomain = new Array<FiestaDomain | undefined>(seatCount).fill(undefined)
  }

  refresh(domains: readonly FiestaDomain[], tick: number): void {
    this.seatDomain.fill(undefined)
    this.reference = null
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i]
      if (this.reference === null) this.reference = domain
      const seats = domain.seats
      for (let s = 0; s < seats.length; s++) {
        const seat = seats[s]
        if (seat >= 0 && seat < this.seatDomain.length) this.seatDomain[seat] = domain
      }
    }
    this.tick = tick
  }

  holdsSeat(seat: number): boolean {
    return seat >= 0 && seat < this.seatDomain.length && this.seatDomain[seat] !== undefined
  }

  phase(out: MatchViewState): MatchViewState {
    out.tick = this.tick
    out.phase = Phase.playing
    out.courseIndex = 0
    return out
  }

  course(): ResolvedCourse {
    return this.courseData
  }

  character(p: number, out: CharacterView): CharacterView {
    const domain = this.seatDomain[p]
    if (domain === undefined) {
      out.pos.x = 0; out.pos.y = 0; out.pos.z = 0
      out.vel.x = 0; out.vel.y = 0; out.vel.z = 0
      out.facing.x = 0; out.facing.z = 1
      out.mode = CharMode.parked
      out.status = 0
      out.parked = true
      out.teleportTick = -1
      return out
    }
    const state = domain.state(p, this.state)
    out.pos.x = state.pos.x; out.pos.y = state.pos.y; out.pos.z = state.pos.z
    out.vel.x = state.vel.x; out.vel.y = state.vel.y; out.vel.z = state.vel.z
    out.facing.x = state.facing.x; out.facing.z = state.facing.z
    out.mode = state.mode
    out.status = domain.status(p)
    out.parked = state.mode === CharMode.parked
    out.teleportTick = state.teleportTick
    return out
  }

  obstacleCount(): number {
    return this.courseData.obstacles.length
  }

  obstacleSpec(i: number): ObstacleSpec {
    return this.courseData.obstacles[i]
  }

  obstaclePose(i: number, out: Pose): Pose {
    const domain = this.reference
    if (domain === null) return motionPose(this.courseData.obstacles[i], 0, 0, out)
    return domain.obstacles.pose(i, domain.tick, out)
  }

  // SceneView builds one instance per mechanism body from the item list (MatchSim has the same two calls).
  mechanismItemCount(): number {
    return this.reference?.mechanisms.spec()?.items.length ?? 0
  }

  mechanismItem(i: number): MechItem {
    const item = this.reference?.mechanisms.spec()?.items[i]
    if (item === undefined) throw new Error(`no mechanism item ${i}; pass a loaded item index`)
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const domain = this.reference
    return domain !== null && domain.mechanisms.bodyPose(domain.ctx, ref, out)
  }

  mechanismEvents(fromTick: number, out: MechEvent[]): number {
    const domain = this.reference
    return domain === null ? 0 : domain.mechanisms.events(fromTick, out)
  }

  signal(id: string): boolean {
    const domain = this.reference
    return domain !== null && domain.mechLogic.signal(id)
  }

  // SceneView wraps step() to observe each simulation tick; the zone session steps its own domains.
  step(_inputs: readonly PlayerInput[]): void {}
}

export async function mountZoneView(options: ZoneViewOptions): Promise<ZoneView> {
  checkOptions(options)
  if (options.createPort === undefined) {
    options = { ...options, ...await zoneContent(options.profile ?? 'sprint') }
  }
  const peers = options.peers ?? 4
  const seatsPerPeer = options.seatsPerPeer ?? 2
  const localPeer = options.localPeer ?? 0
  const seed = options.seed ?? 1
  const profile = options.profile ?? 'sprint'
  const seatCount = peers * seatsPerPeer

  const courses = await browserCourses(profile)
  const picked = pickCourse(courses, options.courseId)
  const zones = await readSidecar(picked)
  const spread = options.spreadSpawns === true
  const course = spread ? spreadAlongPath(picked, seatCount) : picked
  // A spread course owns one spawn per seat; the untouched course keeps its own spawn assignment.
  const spawnIndices = spread ? Array.from({ length: seatCount }, (_, seat) => seat) : undefined
  const kind = options.kind ?? (picked.kind === 'survival' ? 'survival' : 'race')

  const R = await initRapier()
  const roster = rosterOf(peers, seatsPerPeer)
  const measurements: Record<number, {
    cpuMs: number; bandwidthKbps: number; latencyMs: number; spareSlots: number
  }> = {}
  for (let peer = 0; peer < peers; peer++) {
    measurements[peer] = { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }
  }

  const assets = options.assets ?? await preloadAssets([course], browserAssetResolver())
  const bean = options.bean ?? assets('bean')
  const character = options.character ?? bean

  const width = Math.max(1, options.width ?? options.canvas.width)
  const height = Math.max(1, options.height ?? options.canvas.height)
  const target: RenderTarget = { canvas: options.canvas, width, height, viewports: [{ x: 0, y: 0, width, height }] }
  const port = await options.createPort!(target)

  const loopback = new ZoneLoopback(peers, {
    seed,
    rttMs: options.net?.rttMs ?? 60,
    jitterMs: options.net?.jitterMs ?? 5,
    loss: options.net?.loss ?? 0,
  })
  const feed = new FarFeed()
  const memories = Array.from({ length: seatCount }, () => newMemory())
  const matches: ZoneMatch[] = []
  const samplers: ((out: PlayerInput[]) => void)[] = []
  let disposed = false

  function domainOf(match: ZoneMatch, seat: number): FiestaDomain | null {
    const domains = match.domains
    for (let i = 0; i < domains.length; i++) {
      if (domains[i].seats.indexOf(seat) >= 0) return domains[i]
    }
    return null
  }

  try {
    for (let peer = 0; peer < peers; peer++) {
      const seats = roster.peers[peer].seats
      let tick = 0
      const match = createZoneMatch(R, {
        localPeer: peer,
        roster,
        course,
        zones,
        profile: PROFILES[profile],
        kind,
        slot: zoneSlot(kind, seatCount, seed),
        measurements,
        spawnIndices,
        farSink: peer === localPeer ? feed : undefined,
      }, loopback.transport(peer))
      matches.push(match)
      // One reused sampler per peer: every local seat is a takeoverInput brain tick. The counter is
      // monotonic across rollbacks and domain handoffs, like the zoneMatch test's sample tick.
      samplers.push(out => {
        for (let i = 0; i < seats.length; i++) {
          const domain = domainOf(match, seats[i])
          if (domain === null) decodeInput(NEUTRAL_CODE, out[i])
          else takeoverInput(course, memories[seats[i]], domain.state(seats[i]), tick, out[i])
        }
        tick++
      })
    }
  } catch (error) {
    for (let i = 0; i < matches.length; i++) matches[i].dispose()
    port.dispose()
    throw error
  }

  const adapter = new DomainSceneSim(course, seatCount)
  const features = new ZoneFeatures(port, assets)
  const featureAudio = new ZoneFeatureAudio(options.courseAudio)
  const removeSeed = discloseSeed(options.canvas.parentElement ?? document.body, seed)
  const orbit = new OrbitCamera()
  orbit.reset(0)
  const scene = new SceneView({
    port, viewport: 0, localPlayer: roster.peers[localPeer].seats[0], assets, bean,
    character, skinned: options.skinned, dressing: options.dressing,
    // An overview along the course keeps the whole foreground pack and downstream FAR rows visible.
    camera: (focus, dt, clip) => spread ? {
      eye: [course.path[0].p.x, course.path[0].p.y + 5, course.path[0].p.z - 9],
      target: [course.path[0].p.x, course.path[0].p.y, course.path[0].p.z + 12],
      fovYDeg: 52, near: 0.1, far: 500,
    } : orbit.pose(focus, dt, clip),
  })
  const far = new FarRenderer({
    port, bean, feed, holdsLocalSeat: seat => adapter.holdsSeat(seat),
  })

  function frame(dtS: number): void {
    if (disposed) return
    loopback.advance(dtS * 1000)
    let alpha = 0
    for (let peer = 0; peer < matches.length; peer++) {
      const a = matches[peer].frame(dtS, samplers[peer])
      if (peer === localPeer) alpha = a
    }
    const local = matches[localPeer]
    adapter.refresh(local.domains, local.stats.tick)
    const domain = domainOf(local, roster.peers[localPeer].seats[0]) ?? undefined
    features.update(domain)
    featureAudio.frame([domain])
    scene.update(adapter as unknown as MatchSim, null, alpha, dtS)
    far.update(local.stats.tick)
  }

  return {
    seed,
    frame,
    render: () => port.render(),
    ready: () => scene.animationReady(),
    capture: () => port.capture(),
    dispose() {
      if (disposed) return
      disposed = true
      removeSeed()
      features.dispose()
      featureAudio.dispose()
      far.dispose()
      scene.dispose()
      for (let i = 0; i < matches.length; i++) matches[i].dispose()
      matches.length = 0
      port.dispose()
    },
  }
}
