/**
 * Shell probe of the engine branch: records the ordered signals and the last show values that the online
 * harness reads through window.rfEngine. Pure state; it never drives the shell.
 */
import { engineOnlineStats } from '@royal-fiesta/game/ege/onlineState'
import type { EngineShowRuntime, EngineShowSnapshot } from '@royal-fiesta/game/ege/showTypes'
import type { EnginePageState } from '../engineShow/page.ts'

/** The copied state the harness reads: the page state plus the shell's flow, lobby and visibility fields. */
export interface EngineShellState extends EnginePageState {
  flow: string
  lobbyId: string | null
  lobbyMembers: number
  visibility: 'visible' | 'hidden'
  online: boolean
}

/** One shell frame as sent to EngineShellProbe.observe, with the show live for this frame or null. */
export interface EngineProbeFrame {
  screen: string
  flow: string
  ready: boolean
  error: string | null
  moduleKey: string
  seats: number
  humans: number
  hubPresented: boolean
  hubFaults: number
  show: EngineShowRuntime | null
  lobbyId: string | null
  lobbyMembers: number
  visibility: 'visible' | 'hidden'
  online: boolean
}

/** The window.rfEngine handle: copied state, the ordered signals and the play action. */
export interface EngineShellHandle {
  state(): EngineShellState
  signals(): readonly string[]
  play(): boolean
}

const EMPTY_FRAME: EngineProbeFrame = {
  screen: '', flow: '', ready: false, error: null, moduleKey: '', seats: 0, humans: 0, hubPresented: false,
  hubFaults: 0, show: null, lobbyId: null, lobbyMembers: 0, visibility: 'visible', online: false,
}
const HUB_FLOWS = new Set(['hub', 'queued', 'choosing', 'watching'])
const SHOW_FLOWS = new Set(['show', 'match', 'podium', 'returning'])

/**
 * Handoff: Game switch share 7/8: offline engine start, hub, show, podium and return in the shell takes the probe
 * from EngineShellProbe.observe and installEngineProbe. Today EngineShellProbe.observe(frame) keeps the ordered
 * signal list and the last show values (round, tick, completedRounds, desyncs and showFaults, which the state
 * adds to frame.hubFaults); installEngineProbe(target, handle) sets target.rfEngine and returns its uninstall.
 * State passed: one EngineProbeFrame per shell frame and per NetPump background step; the handle's play() is
 * supplied by the caller.
 */
export class EngineShellProbe {
  private frame: EngineProbeFrame = EMPTY_FRAME
  private readonly list: string[] = []
  private readonly lobbies = new Set<string>()
  private show: EngineShowRuntime | null = null
  private pageReady = false
  private hubReady = false
  private seenShow = false
  private hubReturned = false
  private roundReady = false
  private podiumReady = false
  private results = 0
  private values = { round: 0, tick: 0, showFaults: 0, completedRounds: 0, desyncs: 0 }

  /** Records the signals of one frame in their order of occurrence and keeps the last show values. */
  observe(frame: EngineProbeFrame): void {
    this.frame = frame
    if (frame.ready && !this.pageReady) {
      this.pageReady = true
      this.list.push('page-ready')
    }
    if (frame.hubPresented && !this.hubReady) {
      this.hubReady = true
      this.list.push('hub-ready')
    }
    if (frame.flow === 'queued' && frame.lobbyId !== null && !this.lobbies.has(frame.lobbyId)) {
      this.lobbies.add(frame.lobbyId)
      this.list.push('lobby-ready')
    }
    if (frame.show !== this.show) this.enterShow(frame.show)
    if (frame.show) this.observeShow(frame.show)
    if (SHOW_FLOWS.has(frame.flow)) this.seenShow = true
    if (this.seenShow && !this.hubReturned && HUB_FLOWS.has(frame.flow)) {
      this.hubReturned = true
      this.list.push('hub-returned')
    }
  }

  /** A copy of the current shell state. */
  state(): EngineShellState {
    const f = this.frame
    return {
      backend: 'engine',
      screen: f.screen,
      flow: f.flow,
      ready: f.ready,
      error: f.error,
      moduleKey: f.moduleKey,
      seats: f.seats,
      humans: f.humans,
      bots: f.seats - f.humans,
      round: this.values.round,
      tick: this.values.tick,
      completedRounds: this.values.completedRounds,
      faults: this.values.showFaults + f.hubFaults,
      desyncs: this.values.desyncs,
      lobbyId: f.lobbyId,
      lobbyMembers: f.lobbyMembers,
      visibility: f.visibility,
      online: f.online,
    }
  }

  /** A copy of the ordered signal list. */
  signals(): readonly string[] {
    return this.list.slice()
  }

  private enterShow(show: EngineShowRuntime | null): void {
    this.show = show
    this.roundReady = false
    this.podiumReady = false
    this.results = 0
  }

  private observeShow(show: EngineShowRuntime): void {
    const snap: EngineShowSnapshot = show.snapshot()
    this.values = {
      round: snap.round,
      tick: snap.tick,
      showFaults: snap.faults,
      completedRounds: snap.results.length,
      desyncs: engineOnlineStats(show)?.desyncs ?? 0,
    }
    if (!this.roundReady && snap.screen === 'playing') {
      this.roundReady = true
      this.list.push('round-ready')
    }
    while (this.results < snap.results.length) {
      this.results += 1
      this.list.push('round-ended')
    }
    if (!this.podiumReady && (snap.screen === 'podium' || snap.screen === 'done')) {
      this.podiumReady = true
      this.list.push('podium-ready')
    }
  }
}

/** Sets target.rfEngine to handle; the returned uninstall deletes it only while it is still this handle. */
export function installEngineProbe(target: { rfEngine?: EngineShellHandle }, handle: EngineShellHandle): () => void {
  target.rfEngine = handle
  return () => {
    if (target.rfEngine === handle) delete target.rfEngine
  }
}
