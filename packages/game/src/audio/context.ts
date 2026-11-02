// The only game module that constructs a browser audio context. Media is baked on the server.
import { refuse } from '@royal-fiesta/sim/refusal'
import { SOUNDS, type Bus } from './catalog.ts'
import type { LoopPort, SoundPort } from './gameAudio.ts'
import type { Vec3 } from './events.ts'
import { spatialFor, type ListenerPose } from './mix/listeners.ts'
import { DUCK_RULES } from './mix/ducking.ts'
import type { BusVolumes } from './mix/volumes.ts'

export interface MixPort {
  input(bus: Bus): AudioNode
  setVolumes(v: BusVolumes): void
  duck(id: string): void
  dispose(): void
}

let mixFactory: ((ctx: BaseAudioContext) => MixPort) | undefined
export function setMixFactory(f: (ctx: BaseAudioContext) => MixPort): void { mixFactory = f }

export interface BrowserAudioOptions {
  manifestUrl: string
  maxListeners?: 1 | 2 | 3 | 4
}

export interface BrowserSound {
  readonly ctx: BaseAudioContext
  readonly mix: MixPort
  readonly output: AudioNode
  readonly port: SoundPort
  readonly media?: MediaFactory
  readonly soundsLoaded: number
  close(): Promise<void>
}

interface ManifestSound {
  id: string
  bus: Bus
  mode: 'oneshot' | 'loop'
  files: string[]
  patch: null
  strengthInput?: boolean
  loopStart?: number
  loopEnd?: number
  control?: { name: string; values: number[]; default: number }
}

export interface MediaPlayer {
  set(name: string, value: number): void
  restart(): void
  dispose(): void
}
export type MediaFactory = (id: string, output: AudioNode, inputs?: Record<string, number>, loop?: boolean) => Promise<MediaPlayer>

async function read(url: string | URL): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) refuse('audio', String(url), `HTTP ${response.status}`)
  return response
}

/** Deterministic shuffle bags, with no adjacent repeat across bag boundaries. */
function variants(id: string, files: string[]): () => string {
  let seed = 2166136261
  for (const c of id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0
  let bag: string[] = []
  let last: string | undefined
  return () => {
    if (!bag.length) {
      bag = [...new Set(files)]
      for (let i = bag.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const j = seed % (i + 1)
        ;[bag[i], bag[j]] = [bag[j], bag[i]]
      }
      if (bag.length > 1 && bag[bag.length - 1] === last) {
        ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
      }
    }
    last = bag.pop()!
    return last
  }
}

export async function openBrowserAudio(o: BrowserAudioOptions): Promise<BrowserSound> {
  if (!mixFactory) refuse('audio', 'mix', 'no mix factory registered')
  const ctx = new AudioContext()
  let mix: MixPort
  let entries: ManifestSound[]
  const pageBase = document.baseURI
  const manifestUrl = new URL(o.manifestUrl, pageBase)
  try {
    mix = mixFactory(ctx)
    const manifest = await (await read(manifestUrl)).json()
    if (manifest.format !== 'royal-fiesta.audio' || manifest.version !== 1 || !Array.isArray(manifest.sounds)) {
      refuse('audio', o.manifestUrl, 'expected an S17 sounds manifest')
    }
    entries = manifest.sounds
    await ctx.resume()
  } catch (error) {
    mix!?.dispose()
    await ctx.close()
    throw error
  }
  const sounds = new Map(entries.map(entry => [entry.id, entry]))
  const definitions = new Map(SOUNDS.map(def => [def.id, def]))
  const picks = new Map(entries.map(entry => [entry.id, variants(entry.id, entry.files)]))
  const buffers = new Map<string, Promise<AudioBuffer>>()
  let listeners: ListenerPose[] = []
  let closed = false
  const shots = new Set<() => void>()
  const loops = new Set<() => void>()
  const mediaDisposals = new Set<() => void>()
  function buffer(file: string): Promise<AudioBuffer> {
    let pending = buffers.get(file)
    if (!pending) {
      pending = read(new URL(file, manifestUrl)).then(r => r.arrayBuffer()).then(bytes => ctx.decodeAudioData(bytes))
      buffers.set(file, pending)
    }
    return pending
  }
  const media: MediaFactory = async (id, output, inputs = {}, loop) => {
    const def = sounds.get(id)
    if (!def?.files.length) throw new Error(`no baked media for ${id}`)
    const decoded = await Promise.all(def.files.map(buffer))
    if (closed) throw new Error(`audio closed while loading ${id}`)
    const control = def.control
    let value = control ? inputs[control.name] ?? control.default : 0
    const strength = ctx.createGain()
    strength.gain.value = def.strengthInput ? inputs.gain ?? 1 : 1
    strength.connect(output)
    let layers: { source: AudioBufferSourceNode; gain: GainNode }[] = []
    let disposed = false
    function weights(smooth = true) {
      const values = control?.values
      const v = values ? Math.min(values.at(-1)!, Math.max(values[0], value)) : 0
      let lower = 0
      if (values) for (let i = 0; i < values.length; i++) if (values[i] <= v) lower = i
      if (lower < 0) lower = 0
      const upper = values ? Math.min(lower + 1, values.length - 1) : 0
      const t = values && upper !== lower ? (v - values[lower]) / (values[upper] - values[lower]) : 0
      for (const [i, layer] of layers.entries()) {
        const weight = control ? (i === lower ? 1 - t : i === upper ? t : 0) : (i === 0 ? 1 : 0)
        if (smooth) layer.gain.gain.setTargetAtTime(weight, ctx.currentTime, 0.04)
        else layer.gain.gain.value = weight
      }
    }
    function stop() {
      for (const layer of layers) { layer.source.stop(); layer.source.disconnect(); layer.gain.disconnect() }
      layers = []
    }
    function restart() {
      if (disposed) return
      stop()
      // One-shot variants use the first bake here, as the old course patch used seed zero.
      const files = control ? decoded : decoded.slice(0, 1)
      layers = files.map(decoded => {
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        source.buffer = decoded
        source.loop = loop ?? def!.mode === 'loop'
        source.loopStart = def!.loopStart ?? 0
        source.loopEnd = def!.loopEnd ?? decoded.duration
        source.connect(gain).connect(strength)
        return { source, gain }
      })
      weights(false)
      const when = ctx.currentTime
      for (const layer of layers) layer.source.start(when)
    }
    restart()
    const dispose = () => {
      if (disposed) return
      disposed = true
      stop()
      strength.disconnect()
      mediaDisposals.delete(dispose)
    }
    mediaDisposals.add(dispose)
    return {
      set(name, next) {
        if (disposed) return
        if (name === 'gain' && def!.strengthInput) strength.gain.value = next
        if (name === control?.name) { value = next; weights() }
      },
      restart,
      dispose,
    }
  }
  function routing(id: string, bus: Bus, strength = 1, initial?: Vec3) {
    const gain = ctx.createGain()
    const pan = ctx.createStereoPanner()
    const fade = ctx.createGain()
    gain.connect(pan).connect(fade).connect(mix.input(bus))
    let pos = initial
    const update = () => {
      const spatial = definitions.get(id)?.spatial && pos
        ? spatialFor(pos, listeners, { ref: 2, max: 40 }) : { gain: 1, pan: 0 }
      gain.gain.value = strength * spatial.gain
      pan.pan.value = spatial.pan
    }
    update()
    return { gain, fade, update, move(p: Vec3) { pos = p; update() },
      dispose() { gain.disconnect(); pan.disconnect(); fade.disconnect() } }
  }
  const spatialUpdates = new Set<() => void>()
  const port: SoundPort = {
    play(id, options = {}) {
      const def = sounds.get(id)
      if (closed || !def || def.mode !== 'oneshot' || !def.files.length) return
      const file = picks.get(id)!()
      // Start loading the entire variant set on its first use; share in-flight decodes.
      const ready = Promise.all(def.files.map(buffer))
      let cancelled = false
      let source: AudioBufferSourceNode | undefined
      let route: ReturnType<typeof routing> | undefined
      const dispose = () => {
        cancelled = true
        source?.stop()
        source?.disconnect()
        route?.dispose()
        shots.delete(dispose)
      }
      shots.add(dispose)
      if (shots.size > 48) shots.values().next().value!()
      void ready.then(async () => {
        const decoded = await buffer(file)
        if (cancelled || closed) return
        route = routing(id, def.bus, options.strength ?? 1, options.pos)
        source = ctx.createBufferSource()
        source.buffer = decoded
        if (id.startsWith('move.step.')) source.playbackRate.value = 0.92 + 0.16 * (options.strength ?? 1)
        source.connect(route.gain)
        source.onended = () => { source?.disconnect(); route?.dispose(); shots.delete(dispose) }
        source.start()
        mix.duck(id)
      }).catch(error => { dispose(); console.warn(`sound ${id} failed`, error) })
    },
    startLoop(id, options = {}): LoopPort | null {
      const def = sounds.get(id)
      if (closed || !def || def.mode !== 'loop') return null
      const route = routing(id, def.bus, 1, options.pos)
      spatialUpdates.add(route.update)
      let player: MediaPlayer | undefined
      let stopped = false
      let disposed = false
      let duckTimer: ReturnType<typeof setInterval> | undefined
      let fadeTimer: ReturnType<typeof setTimeout> | undefined
      const inputs = new Map<string, number>()
      const dispose = () => {
        if (disposed) return
        disposed = stopped = true
        clearInterval(duckTimer)
        clearTimeout(fadeTimer)
        player?.dispose()
        route.dispose()
        spatialUpdates.delete(route.update)
        loops.delete(dispose)
      }
      loops.add(dispose)
      const start = async () => {
        player = await media(id, route.gain, Object.fromEntries(inputs), true)
        if (stopped) { player.dispose(); return }
        for (const [name, value] of inputs) player.set(name, value)
        mix.duck(id)
        if (DUCK_RULES.some(rule => rule.trigger(id))) duckTimer = setInterval(() => mix.duck(id), 250)
      }
      void start().catch(error => { dispose(); console.warn(`loop ${id} failed`, error) })
      return {
        set(name, value) { if (!stopped) { inputs.set(name, value); player?.set(name, value) } },
        move(pos) { if (!stopped) route.move(pos) },
        stop(fadeS = 0) {
          if (stopped) return
          stopped = true
          clearInterval(duckTimer)
          const duration = Math.max(0, fadeS)
          if (!duration) { dispose(); return }
          const now = ctx.currentTime
          route.fade.gain.cancelScheduledValues(now)
          route.fade.gain.setValueAtTime(route.fade.gain.value, now)
          route.fade.gain.linearRampToValueAtTime(0, now + duration)
          fadeTimer = setTimeout(dispose, duration * 1000)
        },
      }
    },
    setListeners(ls) {
      listeners = ls.slice(0, o.maxListeners ?? 4).map(l => ({
        pos: { x: l.x, y: l.y, z: l.z }, forward: { x: l.fx, y: 0, z: l.fz },
      }))
      for (const update of spatialUpdates) update()
    },
  }
  return {
    ctx, mix, media, output: mix.input('sfx'), port, soundsLoaded: entries.length,
    async close() {
      if (closed) return
      closed = true
      for (const dispose of shots) dispose()
      for (const dispose of loops) dispose()
      for (const dispose of mediaDisposals) dispose()
      mix.dispose()
      await ctx.close()
    },
  }
}
