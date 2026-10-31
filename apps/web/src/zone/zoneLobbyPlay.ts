// Shared zone presentation, the real-time play loop and near/far counts.
import type { FarFeed } from '@royal-fiesta/game/net/farFeed'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import type { EmitterCommand } from '@royal-fiesta/game/audio/emitters'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import type { FeatureDraw, FeatureSound } from '@royal-fiesta/sim/features/feature'
import { planRound } from '@royal-fiesta/sim/match/rules'

/** Keep the disclosed room seed in the physics schedule and the ledger snapshot. */
export function zoneSlot(kind: 'race' | 'survival', seats: number, seed: number) {
  const plan = planRound(0, seats)
  return {
    kind, final: plan.final, finalRule: plan.final && kind === 'survival' ? 'lastStanding' as const : null,
    target: plan.target, playoff: false, roundIndex: 0, seed, teams: null, overtimeTicks: 0,
  }
}

export function discloseSeed(parent: HTMLElement, seed: number): () => void {
  const label = document.createElement('output')
  label.textContent = `Match seed: ${seed}`
  label.style.cssText = 'position: fixed; bottom: 8px; left: 12px; z-index: 10; color: white; background: #241535; padding: 4px 8px; font: 14px sans-serif;'
  parent.appendChild(label)
  return () => label.remove()
}

/** One pool per viewport, keyed within each feature rather than within a flattened draw list. */
export class ZoneFeatures {
  private domain: FiestaDomain | undefined
  private readonly scratch: FeatureDraw[] = []
  private readonly drawn = new Set<string>()
  private readonly registered = new Map<string, number>()
  private readonly pool = new Map<string, { asset: string; tint: number; instance: number }>()
  private readonly port: RenderPort
  private readonly assets: (id: string) => PrimsAsset

  constructor(port: RenderPort, assets: (id: string) => PrimsAsset) {
    this.port = port
    this.assets = assets
  }

  update(domain: FiestaDomain | undefined): void {
    if (domain !== this.domain) {
      this.dispose()
      this.domain = domain
    }
    this.drawn.clear()
    for (const feature of domain?.features ?? []) {
      this.scratch.length = 0
      feature.draw(this.scratch)
      for (let i = 0; i < this.scratch.length; i++) {
        const draw = this.scratch[i]
        const key = `${feature.id}#${i}`
        this.drawn.add(key)
        let entry = this.pool.get(key)
        if (entry === undefined || entry.asset !== draw.asset || entry.tint !== draw.tint) {
          if (entry !== undefined) this.port.destroyInstance(entry.instance)
          let asset = this.registered.get(draw.asset)
          if (asset === undefined) {
            asset = this.port.registerAsset(draw.asset, this.assets(draw.asset))
            this.registered.set(draw.asset, asset)
          }
          entry = { asset: draw.asset, tint: draw.tint,
            instance: this.port.createInstance(asset, draw.tint === 0 ? null : PALETTE[draw.tint - 1]) }
          this.pool.set(key, entry)
        }
        this.port.setTransform(entry.instance,
          [draw.t.x, draw.t.y, draw.t.z], [draw.r.x, draw.r.y, draw.r.z, draw.r.w], [draw.s.x, draw.s.y, draw.s.z])
        this.port.setVisible(entry.instance, draw.visible)
      }
    }
    for (const [key, entry] of this.pool) {
      if (!this.drawn.has(key)) this.port.setVisible(entry.instance, false)
    }
  }

  dispose(): void {
    for (const entry of this.pool.values()) this.port.destroyInstance(entry.instance)
    this.pool.clear()
    this.drawn.clear()
    this.scratch.length = 0
    this.domain = undefined
  }
}

/** Drain each viewed domain once, even when several split panes share it. */
export class ZoneFeatureAudio {
  private readonly scratch: FeatureSound[] = []
  private readonly commands: EmitterCommand[] = []
  private readonly loops = new Map<string, EmitterCommand>()
  private readonly seen = new Set<string>()
  private readonly domains = new Set<FiestaDomain>()
  private readonly audio: CourseAudio | undefined

  constructor(audio?: CourseAudio) { this.audio = audio }

  frame(domains: readonly (FiestaDomain | undefined)[]): void {
    this.commands.length = 0
    this.seen.clear()
    this.domains.clear()
    for (const domain of domains) {
      if (domain === undefined || this.domains.has(domain)) continue
      this.domains.add(domain)
      this.scratch.length = 0
      const n = domain.drainFeatureSounds(this.scratch)
      for (let i = 0; i < n; i++) {
        const sound = this.scratch[i]
        const { x, y, z } = sound.pos
        const id = sound.loop ? `feature:${sound.key}` : `feature:${sound.id}@${x},${y},${z}`
        const command: EmitterCommand = {
          kind: sound.loop ? (this.loops.has(id) ? 'move' : 'start') : 'trigger',
          id, patch: sound.id, gain: 1, ref: 2, max: 60, loop: sound.loop,
          strength: sound.strength, rate: sound.rate, x, y, z,
        }
        if (sound.loop) {
          this.seen.add(id)
          this.loops.set(id, command)
        }
        this.commands.push(command)
      }
    }
    for (const [id, command] of this.loops) {
      if (this.seen.has(id)) continue
      this.commands.push({ ...command, kind: 'stop' })
      this.loops.delete(id)
    }
    this.audio?.apply(this.commands, this.commands.length)
  }

  dispose(): void {
    this.frame([])
  }
}

export interface PlayClock {
  /** Milliseconds, monotonic. */
  now(): number
  wait(ms: number): Promise<void>
}

export interface PlayTarget {
  frame(dtS: number): void
  readonly info: { readonly tick: number }
}

export interface PlayOptions {
  seconds: number
  /** Stop at this session tick, before `seconds` ends. */
  captureTick?: number
  frameMs: number
  maxDtS: number
  /** Started after the first frame (it creates the near characters); settles when they can be drawn. */
  load(): Promise<void>
  onPhase?: (phase: string) => void
}

/**
 * Frames the match on the page clock until `seconds` or `captureTick`, then waits for `load`. The match keeps framing
 * while `load` runs: a peer that stops framing sends nothing, and after lostAfterMs (3 s) of silence the other peers
 * drop it, which froze the whole room at the next epoch boundary.
 */
export async function playLobby(target: PlayTarget, options: PlayOptions, clock: PlayClock): Promise<void> {
  const phase = options.onPhase ?? (() => {})
  const started = clock.now()
  let last = started
  let loading: Promise<void> | undefined
  let loadError: { error: unknown } | undefined
  phase('ticking')
  do {
    await clock.wait(options.frameMs)
    if (loadError) throw loadError.error
    const now = clock.now()
    const dt = Math.min(options.maxDtS, Math.max(0, (now - last) / 1000))
    last = now
    target.frame(dt)
    if (loading === undefined) {
      phase('ticking (loading animations)')
      loading = options.load()
      loading.then(() => phase('ticking'), error => { loadError = { error } })
    }
  } while (clock.now() - started < options.seconds * 1000 && !(target.info.tick >= (options.captureTick ?? Infinity)))
  await loading
}

/** Near: live seats in the local domains (the last domain holding a seat supplies it). Far: finite FAR rows of the others. */
export function countNearFar(match: ZoneMatch, feed: FarFeed, tick: number, nearDomains = new Map<number, FiestaDomain>()):
  { near: number; far: number } {
  nearDomains.clear()
  for (const domain of match.domains) {
    for (const seat of domain.seats) nearDomains.set(seat, domain)
  }
  let near = 0
  for (const [seat, domain] of nearDomains) {
    if (domain.state(seat).mode !== CharMode.parked) near++
  }
  let far = 0
  for (const entry of feed.read(tick, seat => nearDomains.has(seat))) {
    if (Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z) && Number.isFinite(entry.yaw)) far++
  }
  return { near, far }
}
