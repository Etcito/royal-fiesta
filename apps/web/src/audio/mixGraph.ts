// The audio-mix graph: per-bus volume and duck gains feed one master gain and a limiter. It
// builds its nodes on the BaseAudioContext it is given (never a context of its own), which is
// what tools/test/audio-boundary.test.ts allows.
import { BUSES, type Bus } from '@royal-fiesta/game/audio/catalog'
import { BUS_GAIN_DB, dbToGain, LIMITER_CEILING_DB } from '@royal-fiesta/game/audio/mix/buses'
import { DUCK_RULES } from '@royal-fiesta/game/audio/mix/ducking'
import { parseBusVolumes, type BusVolumes } from '@royal-fiesta/game/audio/mix/volumes'

/** Seconds for setVolumes to approach its targets (S16). */
const VOLUME_TIME_CONSTANT_S = 0.05

export function createMixGraph(ctx: BaseAudioContext): {
  input(bus: Bus): AudioNode
  setVolumes(v: BusVolumes): void
  duck(id: string): void
  dispose(): void
} {
  const master = ctx.createGain()
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = LIMITER_CEILING_DB
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.1
  master.connect(limiter).connect(ctx.destination)

  const busGains = new Map<Bus, GainNode>()
  const duckGains = new Map<Bus, GainNode>()
  const nodes: AudioNode[] = [master, limiter]
  for (const bus of BUSES) {
    const gain = ctx.createGain()
    const duck = ctx.createGain()
    gain.gain.value = dbToGain(BUS_GAIN_DB[bus])
    gain.connect(duck).connect(master)
    busGains.set(bus, gain)
    duckGains.set(bus, duck)
    nodes.push(gain, duck)
  }

  return {
    input(bus: Bus): AudioNode {
      return busGains.get(bus)!
    },

    setVolumes(v: BusVolumes): void {
      const volumes = parseBusVolumes(v)
      const now = ctx.currentTime
      for (const bus of BUSES) {
        const target = dbToGain(BUS_GAIN_DB[bus]) * volumes[bus]
        busGains.get(bus)!.gain.setTargetAtTime(target, now, VOLUME_TIME_CONSTANT_S)
      }
    },

    duck(id: string): void {
      const now = ctx.currentTime
      for (const rule of DUCK_RULES) {
        if (!rule.trigger(id)) continue
        const gain = duckGains.get(rule.bus)!.gain
        gain.cancelScheduledValues(now)
        gain.linearRampToValueAtTime(dbToGain(-rule.depthDb), now + rule.attackS)
        gain.linearRampToValueAtTime(1, now + rule.attackS + rule.releaseS)
      }
    },

    dispose(): void {
      for (const node of nodes) node.disconnect()
    },
  }
}
