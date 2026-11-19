// The offline round of the engineRound op: it steps the round tick by tick on a virtual clock and returns ONE capture.
// Measured on the GPU client (m4-race-sprint-gates, 1200 ticks, 1920x1080): a tick costs ~5 ms of CPU (step, scene
// update, encoding) but, once the field-shading pipelines are compiled (tick ~420), every drawn frame costs 550-770 ms
// of GPU, scaling with the pixel count (190 ms at render scale 0.5, AO and post off changed nothing). Drawing all 1200
// ticks is ~780 s of GPU work for frames nobody reads, past the 295 s page limit (run 16017, and op 7349 reached tick
// 780). So the loop advances the scene every tick but draws only every DRAW_TICKS ticks (RAA requests the pipelines of
// visible draws when it draws, and the page names its tick) and the capture tick, then SETTLE_FRAMES still frames.
export const DRAW_TICKS = 60
export const SETTLE_FRAMES = 8

export interface GpuQueueOwner { queue: { onSubmittedWorkDone(): Promise<unknown> } }

export interface OfflineRun { step(): boolean; readonly done: boolean }

export interface OfflinePage {
  /** The scene follows the round (sim refresh, view update, render bridge sync); nothing is drawn. */
  advance(dtS: number): void
  /** Draws the current scene. */
  render(): void
}

export interface OfflineHooks {
  /** Called before each tick's scene update with the ticks already done (the page's virtual clock reads it). */
  tick(ticks: number): void
  /** Awaited once, after the first tick is drawn. */
  firstFrame(): Promise<void>
  /** The device of the drawn canvas, once RAA configured it. */
  device(): GpuQueueOwner | undefined
  phase(text: string): void
}

/** Whether the loop draws tick `ticks`: the first one, every DRAW_TICKS-th and the capture tick. */
export function drawsTick(ticks: number, done: boolean): boolean {
  return ticks === 1 || ticks % DRAW_TICKS === 0 || done
}

/** Steps `run` to its capture point; returns the number of ticks. */
export async function runOffline(run: OfflineRun, page: OfflinePage, hooks: OfflineHooks, frames: number): Promise<number> {
  let ticks = 0
  while (run.step()) {
    hooks.tick(ticks)
    page.advance(1 / 60)
    ticks++
    if (!drawsTick(ticks, run.done)) continue
    page.render()
    if (ticks === 1) await hooks.firstFrame()
    hooks.phase(`engine-round: tick ${ticks}/${frames}`)
    // Never queue more GPU work than the GPU has finished, and give the page its turn (heartbeat).
    const device = hooks.device()
    if (device !== undefined) await device.queue.onSubmittedWorkDone()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  return ticks
}

/** SETTLE_FRAMES still frames of the final scene (the temporal passes settle on it), then the GPU is waited for. */
export async function settle(page: OfflinePage, device: GpuQueueOwner | undefined): Promise<void> {
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    page.advance(0)
    page.render()
  }
  if (device !== undefined) await device.queue.onSubmittedWorkDone()
}
