import { encodeInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { HubRuntime } from './hub.ts'
import type { EngineShowRuntime } from './showTypes.ts'

const AREA = 'ege-hub-flow'
const TICK_S = 1 / 60
const MAX_TICKS = 8
const EPSILON = 1e-9

export type EngineHubFlowState = 'hub' | 'loading' | 'show' | 'returning' | 'failed'

/**
 * Readiness gate between the engine hub and one engine show. Today it frames the hub at 60 Hz, prepares one show
 * through `startShow` (the page's existing show preparation), frames the show until the frame after screen 'done',
 * then disposes it and respawns the hub at `HubRuntime.spawn`. `start` reports preparation failure only through
 * `state()` and `error()`; a cancelled (disposed) preparation disposes its late runtime and never reaches 'show'.
 * The hub it receives is the one `createEngineHub` (packages/game/src/ege/hub.ts:479 createEngineHub) builds.
 * Handoff: 'Hub page integration: the engine-show page starts in the engine hub and runs shows through EngineHubFlow'
 * constructs `new EngineHubFlow(hub, startShow)` and calls `start`, `frame`, `state`, `error` and `dispose` on it.
 * Today the constructor takes ownership of the hub, `start` runs `startShow` exactly once, and `frame` steps the hub
 * only in 'hub', 'loading' and 'failed'.
 * Handoff: 'Hub capture scenarios and command registration' calls `EngineHubFlow.start(): Promise<void>` and
 * `EngineHubFlow.state(): 'hub' | 'loading' | 'show' | 'returning' | 'failed'`, reached through the page's
 * `EngineShowHostApi.flow()`. Today `start` prepares the show through the page's existing show preparation, and
 * `state` reports 'show' only after a successful preparation.
 */
export class EngineHubFlow {
  private readonly hub: HubRuntime
  private readonly startShow: () => Promise<EngineShowRuntime>
  private phase: EngineHubFlowState = 'hub'
  private failure: string | null = null
  private show: EngineShowRuntime | null = null
  private showDone = false
  private accumulator = 0
  private disposed = false

  constructor(hub: HubRuntime, startShow: () => Promise<EngineShowRuntime>) {
    this.hub = hub
    this.startShow = startShow
  }

  async start(): Promise<void> {
    if (this.disposed || (this.phase !== 'hub' && this.phase !== 'failed')) {
      refuse(AREA, 'EngineHubFlow.start', `cannot start from '${this.phase}'; start only from 'hub' or 'failed'`)
    }
    this.phase = 'loading'
    this.failure = null
    let preparation: Promise<EngineShowRuntime>
    try {
      preparation = this.startShow()
    } catch (value) {
      preparation = Promise.reject(value)
    }
    try {
      const runtime = await preparation
      if (this.disposed) {
        runtime.dispose()
        return
      }
      this.show = runtime
      this.showDone = false
      this.phase = 'show'
    } catch (value) {
      if (this.disposed) return
      this.failure = value instanceof Error ? value.message : String(value)
      this.phase = 'failed'
    }
  }

  frame(dtS: number, input: PlayerInput): void {
    if (!Number.isFinite(dtS) || dtS < 0) {
      refuse(AREA, 'EngineHubFlow.frame(dtS)', `dtS must be finite and >= 0, got ${dtS}; pass the elapsed seconds of the frame`)
    }
    if (this.disposed) return
    if (this.phase === 'hub' || this.phase === 'loading' || this.phase === 'failed') {
      this.stepHub(dtS, input)
      return
    }
    if (this.phase === 'show') {
      const show = this.show
      if (show === null) return
      if (this.showDone) {
        show.dispose()
        this.show = null
        this.hub.respawn(this.hub.spawn)
        this.accumulator = 0
        this.phase = 'returning'
        return
      }
      show.frame(dtS, () => encodeInput(input))
      this.showDone = show.snapshot().screen === 'done'
      return
    }
    this.phase = 'hub'
  }

  state(): EngineHubFlowState {
    return this.phase
  }

  error(): string | null {
    return this.failure
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const show = this.show
    this.show = null
    if (show !== null) show.dispose()
    this.hub.free()
  }

  private stepHub(dtS: number, input: PlayerInput): void {
    this.accumulator += dtS
    let ticks = 0
    while (this.accumulator + EPSILON >= TICK_S && ticks < MAX_TICKS) {
      this.hub.step(input)
      this.accumulator -= TICK_S
      ticks++
    }
    if (ticks === MAX_TICKS) this.accumulator = 0
    if (this.accumulator < 0) this.accumulator = 0
  }
}
