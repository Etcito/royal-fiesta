// Builds the SDF Modeler operation steps (anim_clip_create / anim_clip_settings_set / anim_key_set ...) that author the
// penguin `climbUp` clip. It only computes the argument values of the registered operations; the clip itself is created by
// the operations (sdfm-mcp-client.mjs dispatches them). No IK and no root motion: every pose is plain FK keys on the existing
// 12-bone rig (root = hips), the world displacement of the climb stays with the simulation.
// usage: node climb-up-steps.mjs <out-steps.json> [game-folder]
import { writeFileSync } from 'node:fs'

const D = Math.PI / 180
const r5 = (x) => Math.round(x * 1e5) / 1e5 + 0
const axisq = (axis, deg) => {
  const h = (deg * D) / 2, s = Math.sin(h)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]
}
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
const Rx = (d) => axisq([1, 0, 0], d), Ry = (d) => axisq([0, 1, 0], d), Rz = (d) => axisq([0, 0, 1], d)
const compose = (...qs) => qs.reduce((acc, q) => mul(acc, q))
const norm = (q) => { const n = Math.hypot(...q); const o = q.map((c) => c / n); return o[3] < 0 ? o.map((c) => -c) : o }

// Left flipper extends along +X at rest, +Z is the front, +Y up. theta raises a flipper, phi swings it forward.
const upper = (side, theta, phi) => side === 'l' ? compose(Ry(-phi), Rz(theta)) : compose(Ry(phi), Rz(-theta))
const lower = (side, lam, fwd) => side === 'l' ? compose(Ry(-fwd), Rz(lam)) : compose(Ry(fwd), Rz(-lam))
const tip = (side, tau) => side === 'l' ? Rz(tau) : Rz(-tau)
// leg swing > 0 kicks the leg back, < 0 drives the knee forward; foot > 0 points the toes down
const leg = (side, swing, splay) => side === 'l' ? compose(Rz(splay), Rx(swing)) : compose(Rz(-splay), Rx(swing))

function pose(p) {
  const out = {}
  const put = (bone, channel, v) => { (out[bone] ??= {})[channel] = v }
  put('root', 'rotation', norm(compose(Rz(p.rootRoll), Rx(p.rootPitch))))
  put('root', 'scale', [r5(p.sx), r5(p.sy), r5(p.sx)])
  put('root', 'translation', [0, r5(p.rootY), 0])
  put('head', 'rotation', norm(compose(Rz(p.headRoll), Rx(p.headPitch))))
  for (const s of ['l', 'r']) {
    const a = p.arm[s]
    put(`upper.${s}`, 'rotation', norm(upper(s, a.theta, a.phi)))
    put(`lower.${s}`, 'rotation', norm(lower(s, a.lam, a.fwd)))
    put(`tip.${s}`, 'rotation', norm(tip(s, a.tau)))
    const l = p.leg[s]
    put(`upperLeg.${s}`, 'rotation', norm(leg(s, l.swing, l.splay)))
    put(`foot.${s}`, 'rotation', norm(Rx(l.foot)))
  }
  return out
}
const arm = (theta, phi, lam, fwd, tau) => ({ theta, phi, lam, fwd, tau })
const lg = (swing, splay, foot) => ({ swing, splay, foot })
const base = { rootRoll: 0, rootPitch: 0, sx: 1, sy: 1, rootY: 0, headRoll: 0, headPitch: 0,
  arm: { l: arm(0, 0, 0, 0, 0), r: arm(0, 0, 0, 0, 0) }, leg: { l: lg(0, 0, 0), r: lg(0, 0, 0) } }
const P = (over) => pose({ ...base, ...over })

// Same pose as grab tick 24 / hang tick 0: both flippers overhead on the ledge, legs and feet dangling, body stretched.
const HANG = { rootRoll: 0, rootPitch: -4, sx: 0.98, sy: 1.06, rootY: 0, headRoll: 0, headPitch: -10,
  arm: { l: arm(72, 38, 10, 12, 6), r: arm(72, 38, 10, 12, 6) }, leg: { l: lg(8, 6, 26), r: lg(8, 6, 26) } }

// 72 ticks (1.2 s at 60 Hz). Left side leads the knee drive so the climb reads asymmetric and organic.
const CLIMB = [
  [0, pose(HANG)],
  // brace: arms lock straight and the body arches back while the legs kick behind it
  [8, P({ rootPitch: -9, sx: 0.97, sy: 1.08, rootY: -0.04, headPitch: -16,
    arm: { l: arm(76, 40, 4, 10, 8), r: arm(76, 40, 4, 10, 8) }, leg: { l: lg(20, 4, 34), r: lg(20, 4, 34) } })],
  // pull: elbows fold, the flippers come down and the hips curl up under the chest
  [22, P({ rootPitch: 7, sx: 1.0, sy: 1.02, rootY: 0.04, headPitch: -20,
    arm: { l: arm(36, 42, 64, 16, 14), r: arm(36, 42, 64, 16, 14) }, leg: { l: lg(-12, 8, 18), r: lg(0, 8, 24) } })],
  // chest over the ledge: elbows low, flipper tips pressed on the edge, left knee drives forward
  [34, P({ rootPitch: 24, sx: 1.0, sy: 0.98, rootY: 0.1, headPitch: -6,
    arm: { l: arm(-8, 30, 84, 10, 20), r: arm(-8, 30, 84, 10, 20) }, leg: { l: lg(-56, 8, 6), r: lg(-26, 8, 14) } })],
  // push up: flippers straighten down and back against the ledge, feet find the ground ahead
  [46, P({ rootPitch: 20, sx: 1.0, sy: 1.0, rootY: 0.12, headPitch: 4,
    arm: { l: arm(-34, 8, 24, 4, -6), r: arm(-34, 8, 24, 4, -6) }, leg: { l: lg(-52, 6, 0), r: lg(-40, 6, -4) } })],
  // rise: torso straightens, flippers swing out for balance, a small crouch absorbs the weight
  [58, P({ rootPitch: 6, sx: 1.04, sy: 0.93, rootY: -0.04, headPitch: 6,
    arm: { l: arm(20, -4, 8, -4, 4), r: arm(20, -4, 8, -4, 4) }, leg: { l: lg(-24, 8, 4), r: lg(-24, 8, 4) } })],
  // recovery: upright neutral stance, the rest pose that idle starts from
  [72, P({})],
]

// Catmull-Rom tangents converted to S17 BEZIER handles (dv only matters for sampling; dt is stored); the last key settles flat.
function items(keys) {
  const bones = Object.keys(keys[0][1])
  const rows = []
  for (const bone of bones) for (const channel of Object.keys(keys[0][1][bone])) {
    const vals = keys.map(([, p]) => p[bone][channel]), ticks = keys.map(([t]) => t), n = keys.length
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : i, next = i < n - 1 ? i + 1 : i
      const span = ticks[next] - ticks[prev]
      const slope = vals[i].map((_, k) => i === n - 1 || span === 0 ? 0 : (vals[next][k] - vals[prev][k]) / span)
      const dtR = i < n - 1 ? (ticks[i + 1] - ticks[i]) / 3 : 0, dtL = i > 0 ? (ticks[i] - ticks[i - 1]) / 3 : 0
      rows.push({ bone, channel, tick: ticks[i], v: vals[i].map(r5), interp: 'BEZIER',
        hl: [r5(-dtL), ...slope.map((s) => r5(-s * dtL))], hr: [r5(dtR), ...slope.map((s) => r5(s * dtR))] })
    }
  }
  return rows
}

const G = 'penguin', folder = process.argv[3] ?? '/tmp/env/game', ticks = CLIMB.map(([t]) => t)
const steps = [
  { tool: '@list' },
  { tool: 'game_register', input: { folder } },
  { tool: 'asset_open_game', input: { game: 'royal-fiesta', id: 'penguin.body' } },
  { tool: 'anim_clip_create', input: { group: G, name: 'climbUp' } },
  { tool: 'anim_clip_settings_set', input: { group: G, clip: 'climbUp', lengthTicks: 72, loop: false, rootMotion: 'none', events: [] } },
  { tool: 'anim_key_set', input: { action: 'insert', group: G, clip: 'climbUp', items: items(CLIMB) } },
  { tool: 'anim_preview_loop_set', input: { enabled: false } },
  { tool: 'anim_auto_key_set', input: { enabled: false } },
  { tool: 'anim_clip_select', input: { action: 'select', group: G, clip: 'climbUp' } },
  ...ticks.map((tick) => ({ tool: 'anim_preview_seek', input: { group: G, clip: 'climbUp', tick, action: 'seek' }, keep: true })),
  { tool: 'anim_clip_select', input: { group: G, action: 'clear' } },
  // asset_save_game refuses the owner's Face patch ellipsoid collider flag; it is switched off for the save only
  { tool: 'node_update', input: { id: 'face_patch', gameCollision: false } },
  { tool: 'asset_save_game', input: { group: G, overwrite: true } },
]
writeFileSync(process.argv[2], JSON.stringify(steps))
console.log(`steps: ${steps.length}, climbUp items ${steps[5].input.items.length}`)
