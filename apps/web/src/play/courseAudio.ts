// Course spatial playback of server-baked media; gain and pan follow the nearest listener.
import type { MediaFactory, MediaPlayer } from '@royal-fiesta/game/audio/context'
import { spatialFor, type ListenerPose as MixListenerPose } from '@royal-fiesta/game/audio/mix/listeners'
import type { CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { EmitterCommand, ListenerPose } from '@royal-fiesta/game/audio/emitters'

/** Course sounds per course are capped at 32 (MECH_CAPS.maxSounds); the active set matches it. */
const MAX_ACTIVE = 32
/** Shared decoded-media factory, injectable in headless tests. */
type PlayerFactory = MediaFactory

interface ActiveSound {
  readonly player: MediaPlayer
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
  readonly inputs: Record<string, number>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Baked media shares decoded buffers; every emitter owns its gain and stereo panner. */
export function createCourseAudio(
  ctx: BaseAudioContext,
  makePlayer: PlayerFactory,
  output: AudioNode,
): CourseAudio {
  let listeners: readonly MixListenerPose[] = []
  const active = new Map<string, ActiveSound>()
  const pending = new Map<string, PendingSound>()
  const refused = new Set<string>()
  // Per-id version: a start or stop makes any earlier start for that id stale when it resolves.
  const versions = new Map<string, number>()
  let disposed = false

  function warn(message: string): void {
    console.warn(`[course-audio] ${message}`)
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

  // The player appears once the shared media has decoded.
  async function spawn(cmd: EmitterCommand, entry: PendingSound): Promise<void> {
    let gain: GainNode | undefined
    let panner: StereoPannerNode | undefined
    try {
      gain = ctx.createGain()
      panner = ctx.createStereoPanner()
      updateSpatial({ gain, panner, cmd: entry.cmd })
      gain.connect(panner)
      panner.connect(output)
      const player = await makePlayer(cmd.patch, gain, entry.inputs, cmd.loop)
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
      if (entry.again) setStrength(player, entry.strength)
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
    if (entry) { entry.cmd = { ...cmd }; entry.inputs.rate = cmd.rate ?? 1 }
  }

  function setRate(player: MediaPlayer, rate: number | undefined): void {
    if (rate !== undefined) player.set('rate', rate)
  }

  function setStrength(player: MediaPlayer, strength: number | undefined): void {
    player.set('gain', strength ?? 1)
  }

  function schedule(cmd: EmitterCommand, restartWhenReady: boolean): void {
    const entry: PendingSound = { cmd: { ...cmd }, version: versions.get(cmd.id) ?? bump(cmd.id), again: restartWhenReady, strength: cmd.strength, inputs: { gain: cmd.strength ?? 1, rate: cmd.rate ?? 1 } }
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
              entry.inputs.gain = cmd.strength ?? 1
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
