// The course's spatial sounds, on haa 0.2.0. Only apps/web resolves that version (packages/game
// stays on 0.1.1), so the implementation lives here and packages/game only names CourseAudio.
//
// Each player feeds its own gain and stereo panner into the sfx bus. Spatial values follow
// the nearest local listener. Patches are fetched once per id; at most 32 sounds are active.
import { createPlayer } from '@etcito/haa-spatial'
import type { HaaPatch, HaaPlayer } from '@etcito/haa-spatial'
import { spatialFor, type ListenerPose as MixListenerPose } from '@royal-fiesta/game/audio/mix/listeners'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { EmitterCommand, ListenerPose } from '@royal-fiesta/game/audio/emitters'

/** Course sounds per course are capped at 32 (MECH_CAPS.maxSounds); the active set matches it. */
const MAX_ACTIVE = 32
/** The player factory; `makePlayer` is a test-only seam, the default is haa's createPlayer. */
type PlayerFactory = typeof createPlayer

interface ActiveSound {
  readonly player: HaaPlayer
  readonly gain: GainNode
  readonly panner: StereoPannerNode
  cmd: EmitterCommand
}

/** A start still fetching its patch; `again` means a trigger arrived while it was pending. */
interface PendingSound {
  readonly version: number
  cmd: EmitterCommand
  again: boolean
  strength?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The course audio over one context: `output` is the sfx bus input.
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
  let listeners: readonly MixListenerPose[] = []
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
    sound.gain.disconnect()
    sound.panner.disconnect()
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
    let gain: GainNode | undefined
    let panner: StereoPannerNode | undefined
    try {
      const patch = await text
      if (disposed || versions.get(cmd.id) !== entry.version) return
      const declared = (JSON.parse(patch) as HaaPatch).inputs ?? []
      const inputs: Record<string, number> = {}
      if (declared.some(input => input.name === 'gain')) inputs.gain = entry.strength ?? 1
      if (declared.some(input => input.name === 'rate')) inputs.rate = entry.cmd.rate ?? 1
      gain = ctx.createGain()
      panner = ctx.createStereoPanner()
      updateSpatial({ gain, panner, cmd: entry.cmd })
      gain.connect(panner)
      panner.connect(output)
      const player = await makePlayer(ctx, { module, processorUrl, patch, inputs, output: gain })
      // A stop, or a newer start, may have landed while this one was awaiting.
      if (disposed || versions.get(cmd.id) !== entry.version) {
        player.dispose()
        gain.disconnect()
        panner.disconnect()
        return
      }
      const sound = { player, gain, panner, cmd: entry.cmd }
      updateSpatial(sound)
      setRate(player, entry.cmd.rate)
      active.set(cmd.id, sound)
      if (entry.again) {
        setStrength(player, entry.strength)
        player.restart()
      }
    } catch (error) {
      gain?.disconnect()
      panner?.disconnect()
      warn(`${cmd.id} is off: ${messageOf(error)}`)
    }
  }

  function updateSpatial(sound: Pick<ActiveSound, 'gain' | 'panner' | 'cmd'>): void {
    const spatial = spatialFor(sound.cmd, listeners, sound.cmd)
    sound.gain.gain.value = spatial.gain * sound.cmd.gain
    sound.panner.pan.value = spatial.pan
  }

  function move(cmd: EmitterCommand): void {
    const sound = active.get(cmd.id)
    if (sound) {
      sound.cmd = { ...cmd }
      setRate(sound.player, cmd.rate)
      updateSpatial(sound)
    }
    const entry = pending.get(cmd.id)
    if (entry) entry.cmd = { ...cmd }
  }

  function setRate(player: HaaPlayer, rate: number | undefined): void {
    if (rate !== undefined && player.info.inputs.some(input => input.name === 'rate')) player.set('rate', rate)
  }

  function setStrength(player: HaaPlayer, strength: number | undefined): void {
    if (player.info.inputs.some((input) => input.name === 'gain')) player.set('gain', strength ?? 1)
  }

  function schedule(cmd: EmitterCommand, restartWhenReady: boolean): void {
    const entry: PendingSound = { cmd: { ...cmd }, version: versions.get(cmd.id) ?? bump(cmd.id), again: restartWhenReady, strength: cmd.strength }
    pending.set(cmd.id, entry)
    void spawn({ ...cmd }, entry).finally(() => {
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
            move(cmd)
            break
          case 'trigger': {
            move(cmd)
            const sound = active.get(cmd.id)
            if (sound !== undefined) {
              setStrength(sound.player, cmd.strength)
              sound.player.restart()
              break
            }
            // An event sound has no player until its first trigger: create it, then restart.
            const entry = pending.get(cmd.id)
            if (entry !== undefined) {
              entry.again = true
              entry.strength = cmd.strength
              break
            }
            if (admit(cmd.id)) schedule(cmd, true)
            break
          }
        }
      }
    },
    setListeners(ls: readonly ListenerPose[]): void {
      if (disposed) return
      listeners = ls.map(l => ({ pos: { x: l.x, y: l.y, z: l.z }, forward: { x: l.fx, y: 0, z: l.fz } }))
      for (const sound of active.values()) updateSpatial(sound)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const id of [...active.keys()]) stop(id)
    },
  }
}
