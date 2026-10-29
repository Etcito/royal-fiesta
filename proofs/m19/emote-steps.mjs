// Builds the SDF Modeler operation steps (anim_clip_create / anim_clip_settings_set / anim_key_set ...) that author the
// penguin `emote.wave` and `emote.dance` clips. It only computes the argument values of the registered operations; the clips
// themselves are created by the operations (sdfm-mcp-client.mjs dispatches them). FK keys only on the existing 12-bone rig
// (root = hips): no IK, no root motion, world displacement stays with the simulation.
// usage: node emote-steps.mjs <out-steps.json> [game-folder]
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

// Left flipper extends along +X at rest, +Z is the front, +Y up. theta raises a flipper, phi swings it forward,
// lam bends the elbow (raises the forearm), tau flaps the tip.
const upper = (side, theta, phi) => side === 'l' ? compose(Ry(-phi), Rz(theta)) : compose(Ry(phi), Rz(-theta))
const lower = (side, lam, fwd) => side === 'l' ? compose(Ry(-fwd), Rz(lam)) : compose(Ry(fwd), Rz(-lam))
const tip = (side, tau) => side === 'l' ? Rz(tau) : Rz(-tau)
// leg swing > 0 kicks the leg back, < 0 drives the knee forward; foot > 0 points the toes down
const leg = (side, swing, splay) => side === 'l' ? compose(Rz(splay), Rx(swing)) : compose(Rz(-splay), Rx(swing))

function pose(p) {
  const out = {}
  const put = (bone, channel, v) => { (out[bone] ??= {})[channel] = v }
  put('root', 'rotation', norm(compose(Ry(p.rootYaw), Rz(p.rootRoll), Rx(p.rootPitch))))
  put('root', 'scale', [r5(p.sx), r5(p.sy), r5(p.sx)])
  put('root', 'translation', [0, r5(p.rootY), 0])
  put('head', 'rotation', norm(compose(Ry(p.headYaw), Rz(p.headRoll), Rx(p.headPitch))))
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
const base = { rootYaw: 0, rootRoll: 0, rootPitch: 0, sx: 1, sy: 1, rootY: 0, headYaw: 0, headRoll: 0, headPitch: 0,
  arm: { l: arm(0, 0, 0, 0, 0), r: arm(0, 0, 0, 0, 0) }, leg: { l: lg(0, 0, 0), r: lg(0, 0, 0) } }
const P = (over) => pose({ ...base, ...over })

// ---- emote.wave: 96 ticks (1.6 s), one shot, rest -> flipper greeting -> rest. The right flipper rises, the forearm and tip
// swing side to side (five half swings) while the head turns to the viewer; the left flipper stays low, the body leans away.
const wv = (lam, tau) => arm(58, 14, lam, 6, tau)
const WAVE = [
  [0, P({})],
  // anticipation: small dip, flipper starts to lift
  [8, P({ rootPitch: 3, sy: 0.98, sx: 1.01, rootY: -0.02, headPitch: 4, headRoll: 3,
    arm: { l: arm(-3, 0, 0, 0, 0), r: arm(24, 8, 6, 2, 2) } })],
  // raised, forearm swung out
  [20, P({ rootRoll: -4, rootYaw: -8, sy: 1.02, sx: 0.99, rootY: 0.02, headYaw: -16, headRoll: -6, headPitch: -4,
    arm: { l: arm(-6, 0, 2, 0, 0), r: wv(-14, -14) }, leg: { l: lg(0, 2, 0), r: lg(0, 0, 0) } })],
  [32, P({ rootRoll: -4, rootYaw: -8, sy: 1.02, sx: 0.99, rootY: 0.02, headYaw: -18, headRoll: -4, headPitch: -4,
    arm: { l: arm(-6, 0, 2, 0, 0), r: wv(40, 18) }, leg: { l: lg(0, 2, 0), r: lg(0, 0, 0) } })],
  [44, P({ rootRoll: -5, rootYaw: -9, sy: 1.03, sx: 0.99, rootY: 0.03, headYaw: -18, headRoll: -7, headPitch: -5,
    arm: { l: arm(-6, 0, 2, 0, 0), r: wv(-16, -16) }, leg: { l: lg(0, 2, 0), r: lg(0, 0, 0) } })],
  [56, P({ rootRoll: -4, rootYaw: -8, sy: 1.02, sx: 0.99, rootY: 0.02, headYaw: -18, headRoll: -4, headPitch: -4,
    arm: { l: arm(-6, 0, 2, 0, 0), r: wv(42, 20) }, leg: { l: lg(0, 2, 0), r: lg(0, 0, 0) } })],
  [68, P({ rootRoll: -4, rootYaw: -8, sy: 1.02, sx: 0.99, rootY: 0.02, headYaw: -16, headRoll: -6, headPitch: -4,
    arm: { l: arm(-5, 0, 2, 0, 0), r: wv(-12, -12) }, leg: { l: lg(0, 2, 0), r: lg(0, 0, 0) } })],
  // last, smaller swing as the flipper starts to come down
  [80, P({ rootRoll: -2, rootYaw: -4, rootY: 0.01, headYaw: -8, headRoll: -2, headPitch: 0,
    arm: { l: arm(-2, 0, 1, 0, 0), r: arm(34, 10, 18, 4, 6) } })],
  [96, P({})],
]

// ---- emote.dance: 96 ticks (4 beats at 150 bpm on the 60 Hz tick), looping. A key every half beat. Body: hip twist about the
// vertical axis, sway, a squash-and-stretch bounce on each beat; flippers pump in alternation then both rise; legs lift the
// knees in turn. No forward travel and no waddle leg cycle: the pose is built around yaw and bounce, not stride.
// per half beat i = 0..7 (down, up, down, up ...)
const yaw = [26, 0, -26, 0, 26, 0, -26, 0]
const roll = [0, -8, 0, 8, 0, -8, 0, 8]
const bounce = [-1, 1, -1, 1, -1, 1, -1, 1] // -1 crouch on the beat, +1 stretched between beats
const headBob = [10, -6, 10, -6, 12, -8, 12, -8]
const headYawD = [-18, 0, 18, 0, -18, 0, 18, 0]
const headRollD = [8, 0, -8, 0, 8, 0, -8, 0]
const armL = [arm(18, 8, 4, 4, 0), arm(84, 22, 36, 12, 16), arm(24, 8, 6, 4, 0), arm(-8, 0, 2, 0, 0),
  arm(18, 8, 4, 4, 0), arm(104, 14, 22, 8, 18), arm(26, 6, 4, 2, 0), arm(100, 14, 24, 8, -14)]
const armR = [arm(18, 8, 4, 4, 0), arm(-8, 0, 2, 0, 0), arm(24, 8, 6, 4, 0), arm(84, 22, 36, 12, 16),
  arm(18, 8, 4, 4, 0), arm(104, 14, 22, 8, -18), arm(26, 6, 4, 2, 0), arm(100, 14, 24, 8, 14)]
const legL = [lg(0, 6, 4), lg(-38, 4, 22), lg(0, 6, 4), lg(10, 12, 0), lg(0, 6, 4), lg(-38, 4, 22), lg(0, 6, 4), lg(10, 12, 0)]
const legR = [lg(0, 6, 4), lg(10, 12, 0), lg(0, 6, 4), lg(-38, 4, 22), lg(0, 6, 4), lg(10, 12, 0), lg(0, 6, 4), lg(-38, 4, 22)]
const danceBeat = (i) => P({
  rootYaw: yaw[i], rootRoll: roll[i], rootPitch: bounce[i] < 0 ? 5 : -3,
  sx: bounce[i] < 0 ? 1.06 : 0.98, sy: bounce[i] < 0 ? 0.92 : 1.05, rootY: bounce[i] * 0.05,
  headYaw: headYawD[i], headRoll: headRollD[i], headPitch: headBob[i], arm: { l: armL[i], r: armR[i] }, leg: { l: legL[i], r: legR[i] } })
const DANCE = Array.from({ length: 9 }, (_, i) => [i * 12, danceBeat(i % 8)])

// Catmull-Rom tangents converted to S17 BEZIER handles (only dv matters for sampling; dt is stored). One-shot clips settle flat
// at both ends; a looping clip uses the periodic neighbours so the seam has a continuous tangent.
function items(keys, periodic) {
  const bones = Object.keys(keys[0][1])
  const rows = []
  for (const bone of bones) for (const channel of Object.keys(keys[0][1][bone])) {
    const vals = keys.map(([, p]) => p[bone][channel]), ticks = keys.map(([t]) => t), n = keys.length
    const len = ticks[n - 1]
    for (let i = 0; i < n; i++) {
      let prevV, nextV, span
      if (periodic && (i === 0 || i === n - 1)) { prevV = vals[n - 2]; nextV = vals[1]; span = (ticks[1] - ticks[0]) + (ticks[n - 1] - ticks[n - 2]) }
      else { const prev = i > 0 ? i - 1 : i, next = i < n - 1 ? i + 1 : i; prevV = vals[prev]; nextV = vals[next]; span = ticks[next] - ticks[prev] }
      const flat = !periodic && (i === 0 || i === n - 1)
      const slope = vals[i].map((_, k) => flat || span === 0 ? 0 : (nextV[k] - prevV[k]) / span)
      const dtR = i < n - 1 ? (ticks[i + 1] - ticks[i]) / 3 : (periodic ? (ticks[1] - ticks[0]) / 3 : 0)
      const dtL = i > 0 ? (ticks[i] - ticks[i - 1]) / 3 : (periodic ? (ticks[n - 1] - ticks[n - 2]) / 3 : 0)
      rows.push({ bone, channel, tick: ticks[i], v: vals[i].map(r5), interp: 'BEZIER',
        hl: [r5(-dtL), ...slope.map((s) => r5(-s * dtL))], hr: [r5(dtR), ...slope.map((s) => r5(s * dtR))] })
    }
  }
  return rows
}

const G = 'penguin', folder = process.argv[3] ?? '/tmp/env/game'
const author = (name, keys, loop, periodic) => [
  { tool: 'anim_clip_create', input: { group: G, name } },
  { tool: 'anim_clip_settings_set', input: { group: G, clip: name, lengthTicks: 96, loop, rootMotion: 'none', events: [] } },
  { tool: 'anim_key_set', input: { action: 'insert', group: G, clip: name, items: items(keys, periodic) } },
]
const seek = (name, keys) => [
  { tool: 'anim_clip_select', input: { action: 'select', group: G, clip: name } },
  ...keys.map(([tick]) => ({ tool: 'anim_preview_seek', input: { group: G, clip: name, tick, action: 'seek' }, keep: true })),
]
const steps = [
  { tool: '@list' },
  { tool: 'game_register', input: { folder } },
  { tool: 'asset_open_game', input: { game: 'royal-fiesta', id: 'penguin.body' } },
  ...author('emote.wave', WAVE, false, false),
  ...author('emote.dance', DANCE, true, true),
  { tool: 'anim_preview_loop_set', input: { enabled: false } },
  { tool: 'anim_auto_key_set', input: { enabled: false } },
  ...seek('emote.wave', WAVE),
  ...seek('emote.dance', DANCE),
  { tool: 'anim_clip_select', input: { group: G, action: 'clear' } },
  // asset_save_game refuses the owner's Face patch ellipsoid collider flag; it is switched off for the save only
  { tool: 'node_update', input: { id: 'face_patch', gameCollision: false } },
  { tool: 'asset_save_game', input: { group: G, overwrite: true } },
]
writeFileSync(process.argv[2], JSON.stringify(steps))
console.log(`steps: ${steps.length}`)
