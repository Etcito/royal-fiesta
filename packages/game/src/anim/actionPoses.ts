// Snapshot-driven rotations relative to the rig rest pose. No render clock is involved.
import { CHAR, CharMode, CarryKind, SLIDE_STROKE, strokeAnimPhase } from '@royal-fiesta/sim/character/constants'
import type { PoseLayer } from './layers.ts'
import { walkBones, type WalkBones } from './walkCycle.ts'

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const ease = (v: number) => { const t = clamp(v); return t*t*(3-2*t) }

/** Where the swim stroke's power sweep starts (its push is the press itself). */
const SWIM_SWEEP_START = 0.4

/**
 * Stroke phase 0..1 (1 = glide). Belly: the sim's own strokePhase when observed (it follows the
 * sim's stroke parameters, tuned or not), else derived from strokeTimer with SLIDE_STROKE.
 * Swim: the timer counts the cooldown down from the press.
 */
export function strokePhase(mode: number, timer: number, simPhase?: number): number {
  if (mode === CharMode.swim) return timer > 0 ? clamp(1 - timer / CHAR.swim.strokeCooldownTicks) : 1
  return simPhase ?? strokeAnimPhase(SLIDE_STROKE, timer)
}

/**
 * A breaststroke: the flippers reach wide and forward (catch), hold, then sweep back from
 * `sweepStart` (the sim's push start, startFrac) and settle into the streamlined glide before the
 * animation ends. reach 1 = flippers forward, power = the sweep back.
 */
export function strokeShapeAt(phase: number, sweepStart: number) {
  const s = Math.max(0.1, Math.min(0.9, sweepStart))
  const sweep = 0.8 * (1 - s)
  const reach = ease(phase / (0.8 * s)) * (1 - ease((phase - s) / sweep))
  const power = Math.sin(Math.PI * clamp((phase - s) / sweep))
  return { reach, power }
}

export function strokeShape(mode: number, timer: number, simPhase?: number, sweepStart?: number) {
  const swim = mode === CharMode.swim
  return strokeShapeAt(strokePhase(mode, timer, simPhase), swim ? SWIM_SWEEP_START : sweepStart ?? SLIDE_STROKE.startFrac)
}

export function actionPose(mode: number, carry: number, strokeTimer: number, out: Float32Array, bones: WalkBones,
  simPhase?: number, sweepStart?: number): void {
  out.fill(0)
  for (let i = 3; i < out.length; i += 4) out[i] = 1
  const rotate = (bone: number, x: number, y: number, z: number): void => {
    const sx = Math.sin(x / 2), cx = Math.cos(x / 2)
    const sy = Math.sin(y / 2), cy = Math.cos(y / 2)
    const sz = Math.sin(z / 2), cz = Math.cos(z / 2)
    out.set([sx*cy*cz + cx*sy*sz, cx*sy*cz - sx*cy*sz,
      cx*cy*sz + sx*sy*cz, cx*cy*cz - sx*sy*sz], bone * 4)
  }
  const sliding = mode === CharMode.slide, swimming = mode === CharMode.swim
  if (sliding || swimming || mode === CharMode.dive || mode === CharMode.diveRecover) {
    const { reach, power } = sliding || swimming ? strokeShape(mode, strokeTimer, simPhase, sweepStart) : strokeShapeAt(1, SLIDE_STROKE.startFrac)
    // +Y of the upright rig becomes forward; local -Z becomes up on the belly.
    // No pitch from the stroke: the body stays flat on the belly, only the flippers sweep.
    rotate(bones.root, sliding || mode === CharMode.diveRecover ? 1.48 : swimming ? 1.3 : 1.4, 0, 0)
    rotate(bones.head, -1.25 + power * 0.06, 0, 0)
    rotate(bones.footL, 1.15, 0, 0); rotate(bones.footR, 1.15, 0, 0)
    rotate(bones.legL, 0.18, 0, -0.08); rotate(bones.legR, 0.18, 0, 0.08)
    const sweep = -1.43 + reach * 2.68
    rotate(bones.flipperL, 0, 0.24 + reach * 0.08, sweep)
    rotate(bones.flipperR, 0, -0.24 - reach * 0.08, -sweep)
  }
  if (carry !== CarryKind.none || mode === CharMode.grabbing) {
    const holding = carry !== CarryKind.none
    // Mirrored yaw brings the flippers in front (+Z); carry cups them inward.
    rotate(bones.flipperL, holding ? -0.35 : 0, holding ? -1.25 : -1.5, -0.25)
    rotate(bones.flipperR, holding ? -0.35 : 0, holding ? 1.25 : 1.5, 0.25)
  }
}

export const ACTION_LAYER: PoseLayer = {
  name: 'action',
  create(names) {
    const bones = walkBones(names), target = new Float32Array(names.length * 4)
    const affected = Object.values(bones)
    let ramp = 0, bellyWeight = 0, impact = 0, previousMode = -1
    let prevX = 0, prevZ = 0, bank = 0, power = 0, load = 0
    let belly = false, contact = 0
    return {
      observe(obs) {
        belly = obs.mode === CharMode.slide || obs.mode === CharMode.swim ||
          obs.mode === CharMode.dive || obs.mode === CharMode.diveRecover
        const active = belly ||
          obs.mode === CharMode.grabbing || (obs.carry ?? 0) !== CarryKind.none
        ramp = Math.max(0, Math.min(6, ramp + (active ? 1 : bellyWeight > 0 ? -0.5 : -1)))
        bellyWeight = Math.max(0, Math.min(1, bellyWeight + (belly ? 1/6 : -1/12)))
        const onBelly = obs.mode === CharMode.slide || obs.mode === CharMode.diveRecover
        contact = Math.max(0, Math.min(1, contact + (onBelly ? 1/6 : -1/12)))
        impact = obs.mode === CharMode.slide && previousMode === CharMode.dive ? 1 : Math.max(0, impact - 1/10)
        previousMode = obs.mode
        const speed = Math.hypot(obs.vel.x, obs.vel.z)
        const x = speed > 0.5 ? obs.vel.x / speed : prevX
        const z = speed > 0.5 ? obs.vel.z / speed : prevZ
        const turn = Math.atan2(prevZ*x - prevX*z, prevX*x + prevZ*z)
        bank += (Math.max(-0.22, Math.min(0.22, -turn*4)) - bank) * 0.25
        prevX = x; prevZ = z
        const stroking = obs.mode === CharMode.slide || obs.mode === CharMode.swim
        const phase = stroking ? strokePhase(obs.mode, obs.strokeTimer ?? 0, obs.strokePhase) : 1
        load = belly ? Math.sin(Math.PI * clamp(phase / 0.3)) : load
        power = belly ? (stroking ? strokeShape(obs.mode, obs.strokeTimer ?? 0, obs.strokePhase, obs.strokeStart).power : 0) : power
        // Retain the last target while fading back to the graph.
        if (active) actionPose(obs.mode, obs.carry ?? 0, obs.strokeTimer ?? 0, target, bones, obs.strokePhase, obs.strokeStart)
      },
      apply(local) {
        if (!ramp) return
        for (const bone of affected) {
          const q = bone * 4, o = bone * 10 + 3, weight = ease(ramp / 6)
          let dot = 0
          for (let i = 0; i < 4; i++) dot += local[o+i] * target[q+i]
          const sign = dot < 0 ? -1 : 1
          let norm = 0
          for (let i = 0; i < 4; i++) {
            local[o+i] += (sign * target[q+i] - local[o+i]) * weight
            norm += local[o+i] ** 2
          }
          norm = Math.sqrt(norm)
          for (let i = 0; i < 4; i++) local[o+i] /= norm
        }
        // Lower the visible body within the unchanged upright collision capsule to touch the ice.
        // Root translation is model space: t.y is height (only lowered here), t.z is forward travel
        // (the stroke surge, never a lift). Scale y/z are travel/thickness after the prone rotation.
        const r = bones.root * 10, w = ease(bellyWeight)
        local[r+1] += (-0.42 - impact*0.045 - local[r+1]) * ease(contact)
        local[r+2] += (power * 0.16 - load * 0.035) * w
        local[r+7] *= 1 + (impact*0.08 - power*0.065 + load*0.035)*w
        local[r+8] *= 1 + (power*0.24 - load*0.08 + impact*0.05)*w
        local[r+9] *= 1 - (power*0.12 + impact*0.14 - load*0.035)*w
        // Bank about the prone body's long axis (local Y).
        const h = bank*w/2, sy = Math.sin(h), cy = Math.cos(h)
        const x = local[r+3], y = local[r+4], z = local[r+5], q = local[r+6]
        local[r+3] = x*cy-z*sy; local[r+4] = y*cy+q*sy
        local[r+5] = z*cy+x*sy; local[r+6] = q*cy-y*sy
      },
      reset() {
        ramp = 0; bellyWeight = 0; impact = 0; previousMode = -1
        prevX = 0; prevZ = 0; bank = 0; power = 0; load = 0; belly = false; contact = 0; target.fill(0)
      },
    }
  },
}
