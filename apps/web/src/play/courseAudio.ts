// The course's spatial sounds, on haa 0.2.0. Only apps/web resolves that version (packages/game
// stays on 0.1.1), so the implementation lives here and packages/game only names CourseAudio.
//
// One spatial scene per page. A `start` fetches the patch text once per patch id, creates a
// HaaPlayer into the scene and adds an emitter with the sound's falloff. `move` follows the item,
// `trigger` moves the sound and restarts its player (creating it on the first event), `stop` frees
// the emitter and its player. A missing patch is warned once and skipped; at most 32 are active.
import { createPlayer, createSpatialScene } from '@etcito/haa'
import type { HaaPlayer, SpatialEmitter, SpatialScene } from '@etcito/haa'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { EmitterCommand, ListenerPose } from '@royal-fiesta/game/audio/emitters'

/** Course sounds per course are capped at 32 (MECH_CAPS.maxSounds); the active set matches it. */
const MAX_ACTIVE = 32
/** The contract's falloff: inverse distance from `ref`, silent beyond `max`. */
const ROLLOFF = 1
/** The player factory; `makePlayer` is a test-only seam, the default is haa's createPlayer. */
type PlayerFactory = typeof createPlayer

interface ActiveSound {
  readonly player: HaaPlayer
  readonly emitter: SpatialEmitter
}

/** A start still fetching its patch; `again` means a trigger arrived while it was pending. */
interface PendingSound {
  readonly version: number
  again: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The course audio over one context: a single spatial scene whose output is `output`.
 * `patches` maps patch ids to the URL of the patch text; `module` is the compiled haa wasm and
 * `processorUrl` the haa 0.2.0 worklet bundle. `makePlayer` is test-only.
 *
 * `ctx` is haa's own context type (`Parameters<typeof createPlayer>[0]`); naming the DOM type
 * here would trip tools/test/audio-boundary.test.ts, which only lets
 * packages/game/src/audio/context.ts create a context.
 */
export function createCourseAudio(
  ctx: Parameters<typeof createPlayer>[0],
  patches: ReadonlyMap<string, string>,
  module: WebAssembly.Module,
  processorUrl: string | URL,
  output: AudioNode,
  makePlayer: PlayerFactory = createPlayer,
): CourseAudio {
  const scene: SpatialScene = createSpatialScene(ctx, output)
  const active = new Map<string, ActiveSound>()
  const pending = new Map<string, PendingSound>()
  const texts = new Map<string, Promise<string>>()
  const warned = new Set<string>()
  const refused = new Set<string>()
  // Per-id version: a start or stop makes any earlier start for that id stale when it resolves.
  const versions = new Map<string, number>()
  let disposed = false

  function warn(message: string): void {
    console.warn(`[course-audio] ${message}`)
  }

  // The patch text, fetched at most once per patch id; null when no patch has that id.
  function patchText(id: string): Promise<string> | null {
    const url = patches.get(id)
    if (url === undefined) {
      if (!warned.has(id)) {
        warned.add(id)
        warn(`no patch for ${id}; skipped`)
      }
      return null
    }
    let text = texts.get(id)
    if (text === undefined) {
      text = fetch(url).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
        return response.text()
      })
      texts.set(id, text)
    }
    return text
  }

  function bump(id: string): number {
    const version = (versions.get(id) ?? 0) + 1
    versions.set(id, version)
    return version
  }

  function stop(id: string): void {
    bump(id)
    pending.delete(id)
    const sound = active.get(id)
    if (sound === undefined) return
    active.delete(id)
    sound.emitter.dispose()
    sound.player.dispose()
  }

  // The active + pending set stays within MAX_ACTIVE; a sound already known may always restart.
  function admit(id: string): boolean {
    if (active.has(id) || pending.has(id)) return true
    if (active.size + pending.size < MAX_ACTIVE) return true
    if (!refused.has(id)) {
      refused.add(id)
      warn(`more than ${MAX_ACTIVE} active course sounds; ${id} skipped`)
    }
    return false
  }

  // The player appears once its patch text (and the player itself) has resolved.
  async function spawn(cmd: EmitterCommand, entry: PendingSound): Promise<void> {
    const text = patchText(cmd.patch)
    if (text === null) return
    try {
      const patch = await text
      if (disposed || versions.get(cmd.id) !== entry.version) return
      const player = await makePlayer(ctx, { module, processorUrl, patch, output: scene.output })
      // A stop, or a newer start, may have landed while this one was awaiting.
      if (disposed || versions.get(cmd.id) !== entry.version) {
        player.dispose()
        return
      }
      const emitter = scene.addEmitter(cmd.id, player, { ref: cmd.ref, max: cmd.max, rolloff: ROLLOFF })
      emitter.setGain(cmd.gain)
      emitter.setPosition(cmd.x, cmd.y, cmd.z)
      active.set(cmd.id, { player, emitter })
      if (entry.again) player.restart()
    } catch (error) {
      warn(`${cmd.id} is off: ${messageOf(error)}`)
    }
  }

  function schedule(cmd: EmitterCommand, restartWhenReady: boolean): void {
    const entry: PendingSound = { version: versions.get(cmd.id) ?? 0, again: restartWhenReady }
    pending.set(cmd.id, entry)
    void spawn(cmd, entry).finally(() => {
      if (pending.get(cmd.id) === entry) pending.delete(cmd.id)
    })
  }

  return {
    apply(cmds: readonly EmitterCommand[], n: number): void {
      if (disposed) return
      for (let i = 0; i < n; i++) {
        const cmd = cmds[i]
        switch (cmd.kind) {
          case 'start':
            if (!admit(cmd.id)) break
            stop(cmd.id)
            schedule(cmd, false)
            break
          case 'stop':
            stop(cmd.id)
            break
          case 'move':
            active.get(cmd.id)?.emitter.setPosition(cmd.x, cmd.y, cmd.z)
            break
          case 'trigger': {
            const sound = active.get(cmd.id)
            if (sound !== undefined) {
              sound.emitter.setPosition(cmd.x, cmd.y, cmd.z)
              sound.player.restart()
              break
            }
            // An event sound has no player until its first trigger: create it, then restart.
            const entry = pending.get(cmd.id)
            if (entry !== undefined) {
              entry.again = true
              break
            }
            if (admit(cmd.id)) schedule(cmd, true)
            break
          }
        }
      }
    },
    setListener(l: ListenerPose): void {
      if (disposed) return
      scene.setListener(l)
      scene.update()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const id of [...active.keys()]) stop(id)
      scene.dispose()
    },
  }
}
