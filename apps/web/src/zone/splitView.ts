// One browser peer in a relay zone room with a split screen: one canvas and one RAA port per local
// seat, and every local seat driven either by takeover bots or by its own keyboard/gamepad.
import { initRapier } from '@gamesaloon/rollback-rapier'
import { tuningHash } from '@gamesaloon/rollback/zones'
import { assignPads, LocalSeats } from '@royal-fiesta/game/client/localSeats'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import { takeoverInput } from '@royal-fiesta/game/net/takeoverBot'
import { createZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { globalZoneWsFactory, ZoneRelayClient } from '@royal-fiesta/game/net/zoneRelayClient'
import type { ZoneQueuePayload } from '@royal-fiesta/game/net/zoneRelayProtocol'
import { ZoneRelayTransport } from '@royal-fiesta/game/net/zoneRelayTransport'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { SplitScreenLayout, splitRects } from '@royal-fiesta/game/render/splitScreen'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { browserCourses } from '../client/sources.ts'
import { zoneContent } from './zoneContent.ts'
import { countNearFar, discloseSeed, ZoneFeatures, ZoneFeatureAudio, zoneSlot } from './zoneLobbyPlay.ts'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'

const ZONE_PREFIX = '../../../../'
const SIDECARS = import.meta.glob<string>('../../../../courses/*.zones.json', {
  query: '?raw', import: 'default', eager: true,
})
const sidecarText = new Map<string, string>()
for (const key of Object.keys(SIDECARS)) {
  if (key.startsWith(ZONE_PREFIX)) sidecarText.set(key.slice(ZONE_PREFIX.length), SIDECARS[key])
}

export type SplitViewDrive = 'bots' | 'devices'

export interface SplitViewOptions {
  /** The pane canvases are appended here; it becomes position:relative at width x height. */
  container: HTMLElement
  width: number
  height: number
  relayUrl: string
  /** Machines in the room, 2..64. */
  players: number
  /** Seats owned by this browser, 1..4: one pane each. */
  localSeats: number
  courseId: string
  name: string
  /** 'bots' drives every local seat with takeoverInput; 'devices' reads keyboard and gamepads. */
  drive?: SplitViewDrive
  courseAudio?: CourseAudio
  queueTimeoutMs?: number
  /** Called at each setup step (loading, connecting, queued, matched, scene, match). */
  onPhase?: (phase: string) => void
}

export interface SplitView {
  frame(dtS: number): void
  render(): void
  ready(): Promise<void>
  capture(): Promise<Uint8Array | null>
  readonly info: {
    peers: number
    seats: number
    localPeer: number
    seed: number
    tick: number
    near: number
    far: number
    viewports: number
  }
  /** The match's session counters: a stalled room is named by them. */
  readonly stats: ZoneMatch['stats']
  dispose(): void
}

function checkOptions(options: SplitViewOptions): number {
  let url: URL
  try { url = new URL(options.relayUrl) } catch {
    refuse('zone', 'mountSplitView.relayUrl', 'invalid relay URL; use ws:// or wss://')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    refuse('zone', 'mountSplitView.relayUrl', 'invalid relay protocol; use ws:// or wss://')
  }
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > 64) {
    refuse('zone', 'mountSplitView.players', 'room size must be 2..64; pass the number of peers')
  }
  if (!Number.isInteger(options.localSeats) || options.localSeats < 1 || options.localSeats > 4) {
    refuse('zone', 'mountSplitView.localSeats', 'local seats must be 1..4; pass this browser’s seat count')
  }
  if (options.drive !== undefined && options.drive !== 'bots' && options.drive !== 'devices') {
    refuse('zone', 'mountSplitView.drive', `'${String(options.drive)}' is neither bots nor devices; pass the input source`)
  }
  const timeoutMs = options.queueTimeoutMs ?? 240000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    refuse('zone', 'mountSplitView.queueTimeoutMs', 'invalid timer duration; use 1..2147483647 ms')
  }
  return timeoutMs
}

async function loadCourse(id: string) {
  const courses = await browserCourses('sprint')
  const course = courses.find(candidate => candidate.id === id)
  if (course === undefined) {
    refuse('zone', 'mountSplitView.courseId', `'${id}' is unknown; use one of: ${courses.map(c => c.id).join(', ')}`)
  }
  const zones = await loadZonesFile(course.id, course, async path => {
    const text = sidecarText.get(path)
    if (text === undefined) refuse('zones', path, 'missing; add the sidecar (zone mode needs it, full-mesh mode does not)')
    return text
  })
  return { course, zones }
}

async function queueRoom(client: ZoneRelayClient, players: number, payload: ZoneQueuePayload, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        refuse('zone', 'mountSplitView.queue', `zone room of ${players} not filled after ${timeoutMs / 1000} s`)
      } catch (error) { reject(error) }
    }, timeoutMs)
  })
  try { await Promise.race([client.queue(players, payload), timeout]) }
  finally { clearTimeout(timer) }
}

export async function mountSplitView(options: SplitViewOptions): Promise<SplitView> {
  const timeoutMs = checkOptions(options)
  const drive = options.drive ?? 'bots'
  const rects = splitRects(options.localSeats, options.width, options.height)
  const phase = options.onPhase ?? (() => {})
  phase('loading course')
  const { course, zones } = await loadCourse(options.courseId)
  phase('loading content')
  const content = await zoneContent('sprint')
  phase('loading physics')
  const R = await initRapier()
  const client = new ZoneRelayClient(options.relayUrl, globalZoneWsFactory())
  const payload: ZoneQueuePayload = {
    g: 'royal-fiesta', v: 1, zones: 1,
    name: options.name, seats: options.localSeats, course: course.id,
    tuning: tuningHash(mergeZoneTuning(zones)),
    m: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
  }
  const canvases: HTMLCanvasElement[] = []
  const ports: RenderPort[] = []
  const features: ZoneFeatures[] = []
  const featureAudio = new ZoneFeatureAudio(options.courseAudio)
  let removeSeed: (() => void) | undefined
  let layout: SplitScreenLayout | undefined
  let match: ZoneMatch | undefined
  let removeInput: (() => void) | undefined
  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    removeSeed?.()
    for (const feature of features) feature.dispose()
    featureAudio.dispose()
    const remove = removeInput
    removeInput = undefined
    if (remove !== undefined) { try { remove() } catch { /* Keep the cleanup chain going. */ } }
    try { client.bye() } finally {
      try { match?.dispose() } finally {
        try { layout?.dispose() } finally {
          for (let i = 0; i < ports.length; i++) {
            try { ports[i].dispose() } catch { /* Keep the cleanup chain going. */ }
            canvases[i]?.remove()
          }
          try { client.close() } catch { /* Keep the cleanup chain going. */ }
          for (let i = 0; i < canvases.length; i++) canvases[i].remove()
        }
      }
    }
  }

  try {
    // Everything slow happens before queueing: the bots start simulating the moment the room fills,
    // and a peer silent for lostAfterMs while its panes mount is dropped by some peers and not others.
    phase('mounting scene')
    options.container.style.position = 'relative'
    options.container.style.width = `${options.width}px`
    options.container.style.height = `${options.height}px`
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i]
      const canvas = document.createElement('canvas')
      canvas.width = rect.width
      canvas.height = rect.height
      canvas.style.cssText = `position: absolute; left: ${rect.x}px; top: ${rect.y}px;`
      options.container.appendChild(canvas)
      canvases.push(canvas)
      ports.push(await content.createPort({
        canvas, width: rect.width, height: rect.height,
        viewports: [{ x: 0, y: 0, width: rect.width, height: rect.height }],
      }))
    }
    phase('connecting to relay')
    await client.connect()
    phase(`queued for a room of ${options.players}`)
    await queueRoom(client, options.players, payload, timeoutMs)
    const { localPeer, roster, measurements, seed } = client.room()
    phase(`matched peer ${localPeer} of ${roster.peers.length}`)
    const seats = roster.peers.find(peer => peer.peer === localPeer)!.seats
    const transport = new ZoneRelayTransport(client, localPeer, roster.peers.length, () => performance.now())
    const feed = new FarFeed()
    const kind = course.kind === 'survival' ? 'survival' : 'race'
    phase('creating match')
    const local = match = createZoneMatch(R, {
      localPeer, roster, course, zones, profile: PROFILES.sprint,
      kind, slot: zoneSlot(kind, roster.seatCount, seed),
      measurements, farSink: feed,
    }, transport)
    const view = layout = new SplitScreenLayout({
      ports, localSeats: seats, course, seatCount: roster.seatCount, feed,
      assets: content.assets, bean: content.bean, character: content.character,
      skinned: content.skinned, dressing: content.dressing,
    })

    for (const port of ports) features.push(new ZoneFeatures(port, content.assets))
    removeSeed = discloseSeed(options.container, seed)
    const viewedDomains: (FiestaDomain | undefined)[] = []
    function updateFeatures(): void {
      const domains = local.domains
      for (let i = 0; i < seats.length; i++) {
        const domain = domains.find(candidate => candidate.seats.includes(seats[i]))
        viewedDomains[i] = domain
        features[i].update(domain)
      }
      featureAudio.frame(viewedDomains)
    }
    const memories = seats.map(() => newMemory())
    const held = new Set<string>()
    let devices: LocalSeats | undefined
    let padsKey = ''
    function readPads(): void {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
      const snapshots = navigator.getGamepads()
      const connected: number[] = []
      for (let i = 0; i < snapshots.length; i++) if (snapshots[i] !== null) connected.push(i)
      const key = connected.join(',')
      if (devices === undefined || key !== padsKey) {
        padsKey = key
        devices = new LocalSeats(assignPads(seats.length, connected))
        for (const code of held) devices.key(code, true)
      }
      for (let i = 0; i < snapshots.length; i++) {
        const pad = snapshots[i]
        if (pad !== null) devices.pad(i, pad)
      }
    }
    if (drive === 'devices' && typeof window !== 'undefined') {
      const onKeyDown = (event: KeyboardEvent): void => {
        held.add(event.code)
        devices?.key(event.code, true)
      }
      const onKeyUp = (event: KeyboardEvent): void => {
        held.delete(event.code)
        devices?.key(event.code, false)
      }
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      removeInput = () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
      }
      readPads()
    }

    let sampleTick = 0
    function sample(out: PlayerInput[]): void {
      for (let i = 0; i < seats.length; i++) {
        const seat = seats[i]
        if (devices !== undefined && devices.hasDevice(i)) {
          devices.sample(i, view.facing(i), out[i])
          continue
        }
        const domain = local.domains.find(candidate => candidate.seats.includes(seat))
        if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
        else takeoverInput(course, memories[i], domain.state(seat), sampleTick, out[i])
      }
      sampleTick++
    }

    const info = {
      peers: roster.peers.length, seats: roster.seatCount, localPeer, seed,
      tick: 0, near: 0, far: 0, viewports: rects.length,
    }
    const nearDomains = new Map<number, FiestaDomain>()
    function updateInfo(): void {
      info.tick = local.stats.tick
      const counts = countNearFar(local, feed, info.tick, nearDomains)
      info.near = counts.near
      info.far = counts.far
    }

    async function capture(): Promise<Uint8Array | null> {
      if (disposed) return null
      const shots: Uint8Array[] = []
      for (let i = 0; i < ports.length; i++) {
        const png = await ports[i].capture()
        if (png === null || png.length === 0) return null
        shots.push(png)
      }
      const composite = new OffscreenCanvas(options.width, options.height)
      const ctx = composite.getContext('2d')
      if (ctx === null) refuse('zone', 'mountSplitView.capture', 'no 2D context; run the split view in a browser with canvas 2D')
      for (let i = 0; i < shots.length; i++) {
        const image = await createImageBitmap(new Blob([shots[i] as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
        const rect = rects[i]
        ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height)
        image.close()
      }
      const blob = await composite.convertToBlob({ type: 'image/png' })
      return new Uint8Array(await blob.arrayBuffer())
    }

    view.update(local, 0, 0)
    updateFeatures()
    updateInfo()
    return {
      info,
      stats: local.stats,
      frame(dtS) {
        if (disposed) return
        if (devices !== undefined) {
          readPads()
          for (let i = 0; i < seats.length; i++) {
            if (!devices.hasDevice(i)) continue
            const look = devices.look(i)
            view.look(i, look.x, look.y, dtS)
          }
        }
        const alpha = local.frame(dtS, sample)
        transport.flush()
        view.update(local, alpha, dtS)
        updateFeatures()
        updateInfo()
      },
      render: () => { if (!disposed) view.render() },
      ready: () => view.ready(),
      capture,
      dispose,
    }
  } catch (error) {
    try { dispose() } catch { /* Preserve the setup refusal if cleanup also fails. */ }
    throw error
  }
}
