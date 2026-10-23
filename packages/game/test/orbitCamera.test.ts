import assert from 'node:assert/strict'
import test from 'node:test'
import { stickToWorld } from '../src/client/cameraBasis.ts'
import { followCamera } from '../src/render/camera.ts'
import { DEFAULT_PITCH, ORBIT_DISTANCE, OrbitCamera, PITCH_MAX, PITCH_MIN } from '../src/render/orbitCamera.ts'
import type { CameraPose, Vec3T } from '../src/render/port.ts'

const EPS = 1e-9

function near(a: number, b: number, what: string): void {
  assert.ok(Math.abs(a - b) <= EPS, `${what}: ${a} != ${b}`)
}

function dist(p: CameraPose): number {
  const dx = p.eye[0] - p.target[0]
  const dy = p.eye[1] - p.target[1]
  const dz = p.eye[2] - p.target[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

type V3 = [number, number, number]
const sub = (a: Vec3T, b: Vec3T): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3T, b: Vec3T) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3T, b: Vec3T): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3T): V3 => { const l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l] }

// NDC x through the same maths as raa-math look_at_rh plus an RH perspective (16/9).
function ndcX(p: CameraPose, w: Vec3T): number {
  const f = norm(sub(p.target, p.eye))
  const s = norm(cross(f, [0, 1, 0]))
  const vx = dot(s, w) - dot(s, p.eye)
  const vz = -dot(f, w) + dot(f, p.eye)
  const fy = 1 / Math.tan((p.fovYDeg * Math.PI / 180) / 2)
  assert.ok(-vz > p.near && -vz < p.far, 'marker inside the depth range')
  return (fy / (16 / 9)) * vx / -vz
}

test('camera-relative maths: WASD rotated by the orbit yaw into world space', () => {
  // The V0 test pinned right = (1, 0) at yaw 0, a mirror. RAA is right-handed (1.6):
  // looking along +Z, screen-right is -X, so every expected right flips sign.
  const cases: [number, [number, number], [number, number]][] = [
    [0, [0, 1], [-1, 0]],
    [90, [1, 0], [0, 1]],
    [180, [0, -1], [1, 0]],
    [270, [-1, 0], [0, -1]],
  ]
  const cam = new OrbitCamera()
  const out = { x: 0, z: 0 }
  for (const [deg, fwd, right] of cases) {
    cam.reset(deg * Math.PI / 180)
    const dirs: [string, [number, number], [number, number]][] = [
      ['forward', [0, 1], fwd],
      ['back', [0, -1], [-fwd[0], -fwd[1]]],
      ['right', [1, 0], right],
      ['left', [-1, 0], [-right[0], -right[1]]],
    ]
    for (const [key, xy, want] of dirs) {
      stickToWorld(xy[0], xy[1], cam.basis(), out)
      near(out.x, want[0], `yaw ${deg} ${key} moveX`)
      near(out.z, want[1], `yaw ${deg} ${key} moveZ`)
    }
  }
})

test('pitch clamps at both ends under large mouse and stick input; yaw wraps', () => {
  const cam = new OrbitCamera()
  cam.mouse(0, 1e6, 10, false)
  assert.equal(cam.pitch, PITCH_MAX)
  cam.mouse(0, -1e6, 10, false)
  assert.equal(cam.pitch, PITCH_MIN)
  cam.reset()
  for (let i = 0; i < 600; i++) cam.stick(0, 1, 1 / 60, 10, false)
  assert.equal(cam.pitch, PITCH_MAX)
  for (let i = 0; i < 600; i++) cam.stick(0, -1, 1 / 60, 10, false)
  assert.equal(cam.pitch, PITCH_MIN)
  for (let i = 0; i < 600; i++) cam.stick(1, 0, 1 / 60, 10, false)
  assert.ok(cam.yaw > -Math.PI && cam.yaw <= Math.PI, `yaw ${cam.yaw}`)
  cam.reset(3 * Math.PI)
  near(cam.yaw, Math.PI, 'reset 3PI wraps to PI')
  cam.reset(-Math.PI)
  near(cam.yaw, Math.PI, '-PI wraps to PI')
  // Turning right lowers the yaw (1.6), so start just above -PI to cross the wrap.
  cam.reset(-Math.PI + 0.01)
  cam.mouse(0.02 / 0.0025, 0, 5, false)
  near(cam.yaw, Math.PI - 0.01, 'turning past -PI wraps to the positive side')
  // Dead zone: small stick values do nothing.
  cam.reset()
  cam.stick(0.15, -0.15, 1, 10, false)
  assert.equal(cam.yaw, 0)
  assert.equal(cam.pitch, DEFAULT_PITCH)
})

test('default pose matches the follow camera; eye stays at ORBIT_DISTANCE', () => {
  const player = { x: 3, y: 1.5, z: -4 }
  for (const deg of [0, 37, 90, 180, 270]) {
    const cam = new OrbitCamera()
    cam.reset(deg * Math.PI / 180)
    const p = cam.pose(player)
    const f = followCamera(null, player, cam.ground(), 1 / 60)
    for (let i = 0; i < 3; i++) {
      near(p.eye[i]!, f.eye[i]!, `yaw ${deg} eye[${i}]`)
      near(p.target[i]!, f.target[i]!, `yaw ${deg} target[${i}]`)
    }
    assert.equal(p.fovYDeg, 60)
    assert.equal(p.near, 0.1)
    assert.equal(p.far, 500)
  }
  const cam = new OrbitCamera()
  for (const pitch of [PITCH_MIN, -0.1, 0, DEFAULT_PITCH, 0.8, PITCH_MAX]) {
    cam.pitch = pitch
    near(dist(cam.pose(player)), ORBIT_DISTANCE, `distance at pitch ${pitch}`)
  }
})

test('mouse right by a quarter turn at sensitivity 5; invertY flips the pitch', () => {
  const cam = new OrbitCamera()
  near(cam.ground().x, 0, 'start x')
  near(cam.ground().z, 1, 'start z')
  cam.mouse((Math.PI / 2) / 0.0025, 0, 5, false)
  // V0 expected (1, 0), a left turn. RH (1.6): screen-right at +Z is -X, so a right turn ends at (-1, 0).
  near(cam.ground().x, -1, 'turned x')
  near(cam.ground().z, 0, 'turned z')
  cam.reset()
  cam.mouse(0, -20, 5, false)
  const up = cam.pitch - DEFAULT_PITCH
  assert.ok(up < 0, 'mouse up looks up (lower pitch)')
  cam.reset()
  cam.mouse(0, -20, 5, true)
  near(cam.pitch - DEFAULT_PITCH, -up, 'invertY flips the pitch sign')
  cam.reset()
  cam.stick(0, -1, 0.1, 5, false)
  const stickUp = cam.pitch - DEFAULT_PITCH
  assert.ok(stickUp < 0, 'stick up looks up')
  cam.reset()
  cam.stick(0, -1, 0.1, 5, true)
  near(cam.pitch - DEFAULT_PITCH, -stickUp, 'stick invertY flips')
})

test('a positive look step turns right for 8 start yaws: mouse dx > 0 and right stick x > 0', () => {
  const focus = { x: 2, y: 0.5, z: -3 }
  const steps: [string, (c: OrbitCamera) => void][] = [
    ['mouse', c => c.mouse(40, 0, 5, false)],
    ['stick', c => c.stick(1, 0, 1 / 60, 5, false)],
  ]
  let wrong = 0
  for (const [name, step] of steps) {
    for (let k = 0; k < 8; k++) {
      const cam = new OrbitCamera()
      cam.reset(k * Math.PI / 4)
      const before = cam.pose(focus)
      const oldRight = cam.basis().right
      // A fixed world marker on the view ray beyond the target starts at screen centre.
      const ray = norm(sub(before.target, before.eye))
      const marker: Vec3T = [before.target[0] + ray[0] * 20, before.target[1] + ray[1] * 20, before.target[2] + ray[2] * 20]
      near(ndcX(before, marker), 0, `${name} yaw ${k} marker centred`)
      step(cam)
      const f = cam.basis().forward
      const turned = f.x * oldRight.x + f.z * oldRight.z
      const x = ndcX(cam.pose(focus), marker)
      if (!(turned > 0) || !(x < 0)) wrong++
    }
  }
  assert.equal(wrong, 0)
})
