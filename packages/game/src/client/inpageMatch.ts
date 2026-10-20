// N rollback clients in one page or process over an in-page NetSim, each bound to its own SceneView.
// DOM-free and Node-API-free: Node tests and proofs drive it with NullRenderPort.
import { NetSim } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import { compareHashLogs, ConfirmedHashLog } from '../net/metrics.ts'
import { createNetMatch } from '../net/netMatch.ts'
import type { NetMatch } from '../net/netMatch.ts'
import { Pilot } from '../net/pilot.ts'
import { netSetup } from '../net/tuning.ts'
import type { PrimsAsset } from '../prims.ts'
import type { RenderPort } from '../render/port.ts'
import { SceneView } from '../render/sceneView.ts'

export interface InPageOptions {
  R: RapierModule; clients: number; seed: number; profile: ProfileName; courses: readonly ResolvedCourse[]
  ports: RenderPort[]; assets: (name: string) => PrimsAsset; bean: PrimsAsset
  net: { rttMs: number; jitterMs: number; loss: number }; pilots: boolean[]
}

export class InPageMatch {
  readonly matches: NetMatch[] = []
  readonly views: SceneView[] = []
  private readonly net: NetSim
  private readonly pilots: (Pilot | null)[] = []
  private readonly logs: ConfirmedHashLog[] = []
  private readonly ports: RenderPort[]

  constructor(o: InPageOptions) {
    const n = o.clients
    if (!Number.isInteger(n) || n < 1 || n > 4) refuse('inpage', 'InPageOptions.clients', `${n} is outside 1..4; in-page matches hold 1 to 4 clients`)
    if (o.pilots.length !== n) refuse('inpage', 'InPageOptions.pilots', `has ${o.pilots.length} entries for ${n} clients; pass one flag per client`)
    if (o.ports.length !== 1 && o.ports.length !== n) {
      refuse('inpage', 'InPageOptions.ports', `has ${o.ports.length} ports for ${n} clients; pass one shared port or one per client`)
    }
    const setup = netSetup(o.seed, n, o.profile, o.courses)
    this.net = new NetSim(n, { seed: o.seed, rttMs: o.net.rttMs, jitterMs: o.net.jitterMs, loss: o.net.loss })
    const shared = o.ports.length === 1 && n > 1
    try {
      for (let k = 0; k < n; k++) {
        this.matches.push(createNetMatch(o.R, { setup, localPeer: k, humanPeers: n }, this.net.transport(k)))
        this.pilots.push(o.pilots[k] ? new Pilot(k, o.seed) : null)
        this.logs.push(new ConfirmedHashLog())
        this.views.push(new SceneView({
          port: shared ? o.ports[0] : o.ports[k], viewport: shared ? k : 0, localPlayer: k, assets: o.assets, bean: o.bean,
        }))
      }
    } catch (e) {
      this.dispose()
      throw e
    }
    this.ports = [...new Set(o.ports)]
  }

  get done(): boolean {
    return this.matches.every(m => m.done)
  }

  frame(dtS: number, local?: (client: number, out: PlayerInput) => void): void {
    this.net.advance(dtS * 1000)
    for (let k = 0; k < this.matches.length; k++) {
      const m = this.matches[k]
      const pilot = this.pilots[k]
      const alpha = m.frame(dtS, out => {
        const i = out[0]
        if (pilot !== null) {
          pilot.sample(m.sim, i)
          return
        }
        // The session reuses its sample buffer, so reset it to neutral before the caller fills it.
        i.moveX = 0
        i.moveZ = 0
        i.jump = false
        i.dive = false
        i.grab = false
        local?.(k, i)
      })
      this.logs[k].record(m.session)
      this.views[k].update(m.sim, m.session.smoother, alpha, dtS)
    }
    for (const p of this.ports) p.render()
  }

  hashes(): { ticksCompared: number; mismatches: number } {
    if (this.logs.length < 2) return { ticksCompared: 0, mismatches: 0 }
    const c = compareHashLogs(this.logs)
    return { ticksCompared: c.ticksCompared, mismatches: c.mismatches }
  }

  dispose(): void {
    for (const v of this.views) v.dispose()
    for (const m of this.matches) m.dispose()
    this.views.length = 0
    this.matches.length = 0
  }
}
