import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import type { JointKind, JointSpec, MotorSpec } from '../mechanismSpec.ts'
import { refuse } from '../refusal.ts'
import { normalize3, quatConj, quatIdentity, quatMul, quatNormalize, v3 } from '../vec.ts'
import type { Quat, Vec3 } from '../vec.ts'
import type { WorldCtx } from '../world.ts'

type UnitJoint = InstanceType<RapierModule['UnitImpulseJoint']>

// Scratch values for createJoint; never part of sim state.
const scratchAxis: Vec3 = v3(0, 0, 0)
const qa: Quat = quatIdentity()
const qb: Quat = quatIdentity()
const qRel: Quat = quatIdentity()
const qAxis: Quat = quatIdentity()
const qFrame2: Quat = quatIdentity()

// The world side of a joint (BodyRef item -1): a hidden fixed body without
// colliders at the identity pose, so world anchors and axes are course space.
// It is found by a scan in body order rather than cached, so every peer gets
// the same body from the same world state, also after a rollback past its
// creation; it is created once per world, the first time a joint needs it.
function worldAnchor(ctx: WorldCtx<unknown>): BodyId {
  const physics = ctx.physics
  const ids = physics.ids()
  for (let i = 0; i < ids.length; i++) {
    const rb = physics.body(ids[i])
    if (!rb.isFixed() || rb.numColliders() !== 0) continue
    const t = rb.translation()
    const r = rb.rotation()
    if (t.x === 0 && t.y === 0 && t.z === 0 && r.x === 0 && r.y === 0 && r.z === 0 && r.w === 1) return ids[i]
  }
  return physics.createBody(ctx.R.RigidBodyDesc.fixed())
}

// Shortest-arc rotation taking the joint's local +X (Rapier's free axis for
// revolute and prismatic joints) onto the unit `axis`.
function axisFrame(axis: Vec3, out: Quat): Quat {
  if (axis.x < -1 + 1e-12) {
    out.x = 0; out.y = 1; out.z = 0; out.w = 0
    return out
  }
  out.x = 0
  out.y = -axis.z
  out.z = axis.y
  out.w = 1 + axis.x
  return quatNormalize(out, out)
}

function readRotation(ctx: WorldCtx<unknown>, id: BodyId, out: Quat): Quat {
  const r = ctx.physics.body(id).rotation()
  out.x = r.x; out.y = r.y; out.z = r.z; out.w = r.w
  return out
}

// One Rapier impulse joint for a JointSpec; returns its handle. Anchors are in
// each body's frame, the axis in body a's frame; a null body is the world.
export function createJoint(ctx: WorldCtx<unknown>, j: JointSpec, a: BodyId | null, b: BodyId | null): number {
  const where = `mechanisms/joints/${j.id}`
  if (a === null && b === null) refuse('mechanisms', where, 'both bodies are the world; attach at least one body')
  const idA = a === null ? worldAnchor(ctx) : a
  const idB = b === null ? worldAnchor(ctx) : b
  if (idA === idB) refuse('mechanisms', where, 'joint bodies are the same body; pass two different bodies')
  const R = ctx.R
  const world = ctx.physics.world
  const anchorA = { x: j.anchorA.x, y: j.anchorA.y, z: j.anchorA.z }
  const anchorB = { x: j.anchorB.x, y: j.anchorB.y, z: j.anchorB.z }
  readRotation(ctx, idA, qa)
  readRotation(ctx, idB, qb)
  // Rotation of a's frame expressed in b's frame at load: welds and axes keep the rest pose.
  quatNormalize(quatMul(quatConj(qb, qRel), qa, qRel), qRel)
  let data: ReturnType<RapierModule['JointData']['fixed']>
  switch (j.kind) {
    case 'fixed':
      data = R.JointData.fixed(anchorA, { x: 0, y: 0, z: 0, w: 1 }, anchorB, { x: qRel.x, y: qRel.y, z: qRel.z, w: qRel.w })
      break
    case 'hinge':
    case 'slider': {
      const axis = normalize3(j.axis, scratchAxis)
      if (axis.x === 0 && axis.y === 0 && axis.z === 0) refuse('mechanisms', where, `${j.kind} axis is zero; pass a unit axis`)
      const raw = { x: axis.x, y: axis.y, z: axis.z }
      data = j.kind === 'hinge' ? R.JointData.revolute(anchorA, anchorB, raw) : R.JointData.prismatic(anchorA, anchorB, raw)
      break
    }
    case 'ball':
      data = R.JointData.spherical(anchorA, anchorB)
      break
    case 'spring':
      data = R.JointData.spring(j.length, j.stiffness, j.damping, anchorA, anchorB)
      break
    case 'rope':
      data = R.JointData.rope(j.length, anchorA, anchorB)
      break
    default: {
      const bad: never = j.kind
      return refuse('mechanisms', where, `unknown joint kind '${bad as string}'; use fixed, hinge, slider, ball, spring or rope`)
    }
  }
  const joint = world.createImpulseJoint(data, ctx.physics.body(idA), ctx.physics.body(idB), true)
  if (j.kind === 'hinge' || j.kind === 'slider') {
    // Identity-body technique. Rapier 0.21 revolute/prismatic joint data puts
    // the same axis (and the same basis around it) in both bodies' local
    // frames, which is only right when both bodies share one orientation: any
    // other rest pose is snapped into alignment on the first step and offsets
    // the limits. So the frame is carried by an identity frame instead: +X is
    // mapped onto the axis in body a's frame (the hidden fixed identity body's,
    // i.e. course space, for a world joint), and body b gets that same frame
    // re-expressed in its own frame, so the rest pose is angle/travel 0.
    axisFrame(scratchAxis, qAxis)
    quatNormalize(quatMul(qRel, qAxis, qFrame2), qFrame2)
    joint.setLocalFrame1(anchorA, { x: qAxis.x, y: qAxis.y, z: qAxis.z, w: qAxis.w })
    joint.setLocalFrame2(anchorB, { x: qFrame2.x, y: qFrame2.y, z: qFrame2.z, w: qFrame2.w })
    // JointData limits are dropped for revolute joints by 0.21's intoRaw: set them on the joint.
    if (j.limits !== null) (joint as UnitJoint).setLimits(j.limits[0], j.limits[1])
  }
  // Welded bodies never touch each other, in the game and the preview alike.
  if (j.kind === 'fixed') joint.setContactsEnabled(false)
  return joint.handle
}

// Drives a hinge (rad, rad/s) or slider (m, m/s) motor; null turns it off.
export function applyMotor(ctx: WorldCtx<unknown>, joint: number, kind: JointKind, m: MotorSpec | null): void {
  if (kind !== 'hinge' && kind !== 'slider') {
    if (m === null) return
    refuse('mechanisms', `joint ${joint}`, `a ${kind} joint has no motor; motors drive hinge and slider joints`)
  }
  const j = ctx.physics.world.getImpulseJoint(joint) as UnitJoint | null | undefined
  if (!j) refuse('mechanisms', `joint ${joint}`, 'no such joint in the world; pass a handle returned by createJoint')
  if (m === null) {
    j.configureMotor(0, 0, 0, 0)
    j.setMotorMaxForce(0)
    return
  }
  if (!m.enabled) j.configureMotor(m.mode === 'target' ? m.target : 0, 0, 0, 0)
  else if (m.mode === 'speed') j.configureMotorVelocity(m.speed, m.damping)
  else j.configureMotorPosition(m.target, m.stiffness, m.damping)
  j.setMotorMaxForce(m.maxForce)
}
