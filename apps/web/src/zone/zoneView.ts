// One page runs a whole zone match: every peer is an in-process createZoneMatch over a shared NetSim,
// every local seat is driven by takeoverInput, and the viewed peer draws its own domains with SceneView.
// Seats in other peers' domains come from the display-only FAR stream through FarFeed and share the same SceneView.
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
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CostumeSet, SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import type { ProfileName, ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { DomainSceneSim } from './domainSceneSim.ts'
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
  /** SceneView's fallback asset; assets('bean') when absent. */
  bean?: PrimsAsset
  /** Normal-match skin and animation graph for all characters. */
  skinned?: SkinnedCharacter
  costumes?: CostumeSet
  wardrobe?: (player: number) => CostumeSet | null | undefined
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
    costumes: options.costumes, wardrobe: options.wardrobe,
    // An overview along the course keeps the whole foreground pack and downstream FAR rows visible.
    camera: (focus, dt, clip) => spread ? {
      eye: [course.path[0].p.x, course.path[0].p.y + 5, course.path[0].p.z - 9],
      target: [course.path[0].p.x, course.path[0].p.y, course.path[0].p.z + 12],
      fovYDeg: 52, near: 0.1, far: 500,
    } : orbit.pose(focus, dt, clip),
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
    adapter.refresh(local.domains, local.stats.tick, feed)
    const domain = domainOf(local, roster.peers[localPeer].seats[0]) ?? undefined
    features.update(domain)
    featureAudio.frame([domain])
    scene.update(adapter as unknown as MatchSim, null, alpha, dtS)
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
      scene.dispose()
      for (let i = 0; i < matches.length; i++) matches[i].dispose()
      matches.length = 0
      port.dispose()
    },
  }
}
