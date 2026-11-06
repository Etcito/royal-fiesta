// The one gate every path that shows a course goes through (owner 2026-11-04: course assets appeared one after the other
// once the race had started). Each part of a course has its own SDF field material, so its lit pipelines compile for
// seconds to tens of seconds; meanwhile the SDF port draws that part in vertex colour and swaps the field material in
// the frame it is compiled (sdfPort fallbacks, asyncPipelines fieldReady). The gate:
// - prepareCourse: the warm-up draw while the loading or vote screen is up, so RAA requests every pipeline of the
//   scene's assets at once instead of when each comes into view (the background first-course preload uses it too, one
//   asset at a time). It resolves once the scene's visible parts no longer draw in vertex colour, and only then marks
//   the course warm: a cancelled, timed out or failed preparation never counts as ready;
// - RoundGate: the app's per-frame gate for every mode, roundStarts when a countdown starts and prepareCourse once per
//   scene shown (a show round already warmed in its prepare is not drawn again);
// - roundStarts: the guard, a console.error naming the course and how many parts are still in vertex colour.
import { pendingPipelines } from './asyncPipelines.ts'

/** What the gate uses of a render port (SdfRenderPort has all of it; other ports are skipped). */
export interface GatedPort {
  warmPipelines?(assetIds?: readonly string[]): void
  warmableAssets?(): string[]
  fallbackParts?(): number
}

export interface PrepareOptions {
  /** Warm one asset at a time, each once the page has no pipeline compiling (the background preload). */
  oneAtATime?: boolean
  cancelled?: () => boolean
  /** Wait for the complete visible scene before marking the course warm (default true). */
  waitReady?: boolean
  /** Give up waiting for the complete visible scene after this long (default 120 s). */
  timeoutMs?: number
}

const warmedOn = new WeakMap<object, Set<string>>()
/** True once prepareCourse ran for `course` on `port`. */
export function courseWarmed(port: unknown, course: string): boolean {
  return typeof port === 'object' && port !== null && warmedOn.get(port)?.has(course) === true
}

/** The warm-up draw of the scene on `port` (every visible asset it has instances of), for course `course`. */
export async function prepareCourse(port: unknown, course: string, options: PrepareOptions = {}): Promise<void> {
  if (typeof port !== 'object' || port === null) return
  const gated = port as GatedPort
  if (typeof gated.warmPipelines !== 'function') return
  let courses = warmedOn.get(gated)
  if (courses === undefined) warmedOn.set(gated, courses = new Set())
  const assets = gated.warmableAssets?.()
  if (!options.oneAtATime || assets === undefined) {
    gated.warmPipelines(assets)
  } else {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    const idle = async (): Promise<boolean> => {
      while (pendingPipelines() > 0) {
        if (options.cancelled?.() || Date.now() >= deadline) return false
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      }
      return !options.cancelled?.()
    }
    for (const asset of assets) {
      if (!await idle()) return
      gated.warmPipelines([asset])
    }
  }
  if (options.waitReady === false) {
    courses.add(course)
    return
  }
  // Ready means the complete visible scene: no part still waiting for warm-up, its field pipeline or its bake.
  const waiting = (): number => gated.fallbackParts?.() ?? 0
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (options.cancelled?.()) return
    if (waiting() + pendingPipelines() === 0) break
    if (Date.now() >= deadline) throw new Error(`[render] ${course}: complete scene preparation timed out after ${Math.round(timeoutMs / 1000)} s`)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  courses.add(course)
}

/** The countdown of a round on `course` starts: logs how many of its parts still draw in vertex colour. */
export function roundStarts(course: string, port: unknown): number {
  const parts = typeof port === 'object' && port !== null ? (port as GatedPort).fallbackParts?.() ?? 0 : 0
  if (parts > 0) {
    console.error(`[render] round ${course}: the countdown starts with ${parts} parts still in vertex colour (their SDF field pipelines are compiling)`)
  }
  return parts
}

/** Where a mode draws what is on screen: the port and the course (or 'hub', 'podium') it shows. */
export interface RoundStage { port: unknown; course: string }

// The screens on which a course, the hub or the podium becomes visible.
const SHOWN = new Set(['countdown', 'hub', 'podium'])

/**
 * The app's gate for every mode (show rounds, local rounds, online and in-page matches, the hub, the podium): call
 * frame() every frame with the game screen and the mode's stage. Entering a countdown runs the guard; entering a
 * countdown, the hub or the podium with a scene not warmed yet on that port runs the warm-up draw.
 */
export class RoundGate {
  private screen: string | null = null
  // Entered a shown screen whose stage the mode has not given yet (it is gated on the first frame that has one).
  private pending = false

  frame(screen: string, stage: RoundStage | null): void {
    if (screen !== this.screen) this.pending = SHOWN.has(screen)
    this.screen = screen
    if (!this.pending || stage === null) return
    this.pending = false
    if (screen === 'countdown') roundStarts(stage.course, stage.port)
    if (courseWarmed(stage.port, stage.course)) return
    // A failed preparation stays a visible failure: it never marks the course warm.
    void prepareCourse(stage.port, stage.course, { waitReady: false }).catch((e: unknown) => {
      console.error(`[render] round ${stage.course}: preparation failed: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}
