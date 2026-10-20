// N piloted PlayFlows in one page or process over one LoopbackRelay: client 0 creates the hub, the others join its code.
// DOM-free and Node-API-free: the Node proof drives it with NullRenderPort.
// LoopbackRelay rate-limits on globalThis.performance.now(), so in Node and in the GPU op the caller must point
// performance.now at the same clock it passes as deps.now, or the relay and the flows disagree on time.
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import type { FlowDeps, FlowEvent } from '@royal-fiesta/game/hub/flow'
import type { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { compareHashLogs, ConfirmedHashLog } from '@royal-fiesta/game/net/metrics'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { refuse } from '@royal-fiesta/sim/refusal'
import { HubView } from './hubView.ts'

export type HubLoopDeps = Omit<FlowDeps, 'relayUrl' | 'ws' | 'hubCode' | 'name' | 'colour' | 'log'>
export interface HubLoopArt { assets: (name: string) => PrimsAsset; bean: PrimsAsset }

// PlayFlow runs the session frame itself and does not expose its alpha, so the match view draws the current tick.
const MATCH_ALPHA = 1

export class InPageHubLoop {
  readonly flows: PlayFlow[] = []
  readonly events: FlowEvent[] = []
  private readonly relay: LoopbackRelay
  private readonly deps: HubLoopDeps
  private readonly art: HubLoopArt
  private readonly clients: number
  private readonly ports: RenderPort[]
  private readonly portOf: RenderPort[] = []
  private readonly viewportOf: number[] = []
  private readonly hubViews: (HubView | null)[] = []
  private readonly sceneViews: (SceneView | null)[] = []
  private readonly viewedMatch: (NetMatch | null)[] = []
  private readonly hubShown: boolean[] = []
  private readonly seats: number[] = []
  private readonly returning: boolean[] = []
  private readonly back: boolean[] = []
  private readonly logs: ConfirmedHashLog[] = []
  private readonly local: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }

  constructor(R: RapierModule, clients: number, relay: LoopbackRelay, deps: HubLoopDeps, ports: RenderPort[], art: HubLoopArt) {
    if (!Number.isInteger(clients) || clients < 2 || clients > 4) {
      refuse('inpage', 'InPageHubLoop.clients', `${clients} is outside 2..4; a hub loop holds 2 to 4 clients`)
    }
    if (ports.length !== 1 && ports.length !== clients) {
      refuse('inpage', 'InPageHubLoop.ports', `has ${ports.length} ports for ${clients} clients; pass one shared port or one per client`)
    }
    this.relay = relay
    this.deps = { ...deps, R }
    this.art = art
    this.clients = clients
    const shared = ports.length === 1
    for (let k = 0; k < clients; k++) {
      this.portOf.push(shared ? ports[0] : ports[k])
      this.viewportOf.push(shared ? k : 0)
      this.hubViews.push(null)
      this.sceneViews.push(null)
      this.viewedMatch.push(null)
      this.hubShown.push(true)
      this.seats.push(0)
      this.returning.push(false)
      this.back.push(false)
      this.logs.push(new ConfirmedHashLog())
    }
    this.ports = [...new Set(ports)]
    this.spawn('new')
  }

  get done(): boolean {
    return this.flows.length === this.clients && this.back.every(b => b)
  }

  frame(dtS: number): void {
    this.relay.pump()
    const code = this.flows[0].hubCode
    if (code !== null && this.flows.length < this.clients) this.spawn(code)
    for (const f of this.flows) f.frame(dtS, null, 0)
    this.relay.pump()
    const now = this.deps.now()
    for (let k = 0; k < this.flows.length; k++) this.view(k, dtS, now)
    for (const p of this.ports) p.render()
  }

  // Compares the confirmed hashes of the clients' current (or last) matches.
  hashes(): { ticksCompared: number; mismatches: number } {
    const c = compareHashLogs(this.logs.slice(0, this.flows.length))
    return { ticksCompared: c.ticksCompared, mismatches: c.mismatches }
  }

  dispose(): void {
    for (let k = 0; k < this.flows.length; k++) {
      this.sceneViews[k]?.dispose()
      this.hubViews[k]?.dispose()
      this.sceneViews[k] = this.hubViews[k] = null
      this.flows[k].close()
    }
    this.relay.pump()
  }

  private spawn(hubCode: string): void {
    const k = this.flows.length
    const flow = new PlayFlow({
      ...this.deps, relayUrl: 'loopback', ws: this.relay.factory(), hubCode, name: `Bean ${k + 1}`, colour: k, pilot: true,
      log: ev => this.onEvent(k, ev),
    })
    this.flows.push(flow)
    void flow.start()
  }

  private onEvent(k: number, ev: FlowEvent): void {
    this.events.push(ev)
    if (ev.state === 'match' && typeof ev.detail.seat === 'number') this.seats[k] = ev.detail.seat
    if (ev.state === 'returning') this.returning[k] = true
    if (ev.state === 'hub' && this.returning[k]) this.back[k] = true
  }

  private view(k: number, dtS: number, now: number): void {
    const flow = this.flows[k]
    const match = flow.match
    if (match !== this.viewedMatch[k]) {
      this.sceneViews[k]?.dispose()
      this.sceneViews[k] = null
      this.viewedMatch[k] = match
      if (match !== null) {
        this.logs[k] = new ConfirmedHashLog()
        this.sceneViews[k] = new SceneView({
          port: this.portOf[k], viewport: this.viewportOf[k], localPlayer: this.seats[k], assets: this.art.assets, bean: this.art.bean,
        })
      }
    }
    const scene = this.sceneViews[k]
    if (match !== null && scene !== null) {
      this.logs[k].record(match.session)
      scene.update(match.sim, match.session.smoother, MATCH_ALPHA, dtS)
    }
    if (flow.state === 'connecting' || flow.state === 'failed') return
    let hub = this.hubViews[k]
    if (hub === null) {
      hub = this.hubViews[k] = new HubView(this.portOf[k], this.viewportOf[k], this.art.assets, this.art.bean, this.deps.plaza)
    }
    // Hidden while the match view is live in the same viewport; only flip on a change.
    if (this.hubShown[k] !== (scene === null)) hub.setVisible(this.hubShown[k] = scene === null)
    if (scene === null) hub.update(flow.hub.state(this.local), k, flow.remotes(now), flow.hub.tick, dtS)
  }
}
