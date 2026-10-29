// Computes arguments for registered SDF Modeler MCP operations; does not construct clip JSON.
// Q7: preserve the owner rig; beak follows head rigidly. Usage: node cheer-laugh-steps.mjs steps.json
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

// Cheer: dip, throw both flippers into a broad raised V, pump twice, hold, settle.
const raised = (theta, lam, tau) => ({ l: arm(theta, 8, lam, 2, tau), r: arm(theta, 8, lam, 2, tau) })
const CHEER = [
  [0, P({})],
  [8, P({ rootPitch: 7, rootY: -0.055, sx: 1.025, sy: 0.95, headPitch: 8,
    arm: raised(-12, 10, 0), leg: { l: lg(-8, 4, 5), r: lg(-8, 4, 5) } })],
  [20, P({ rootPitch: -5, rootY: 0.09, sx: 0.99, sy: 1.035, headPitch: -12,
    arm: raised(66, 8, 8), leg: { l: lg(3, 5, -3), r: lg(3, 5, -3) } })],
  [32, P({ rootPitch: 1, rootY: -0.015, sx: 1.01, sy: 0.98, headPitch: -4,
    arm: raised(52, 18, -5), leg: { l: lg(-5, 5, 2), r: lg(-5, 5, 2) } })],
  [44, P({ rootPitch: -5, rootY: 0.085, sx: 0.99, sy: 1.035, headPitch: -14, headRoll: 3,
    arm: raised(68, 6, 10), leg: { l: lg(3, 5, -3), r: lg(3, 5, -3) } })],
  [56, P({ rootPitch: 1, rootY: -0.015, sx: 1.01, sy: 0.98, headPitch: -4,
    arm: raised(52, 18, -5), leg: { l: lg(-5, 5, 2), r: lg(-5, 5, 2) } })],
  [68, P({ rootPitch: -5, rootY: 0.085, sx: 0.99, sy: 1.035, headPitch: -14, headRoll: -3,
    arm: raised(68, 6, 10), leg: { l: lg(3, 5, -3), r: lg(3, 5, -3) } })],
  [82, P({ rootPitch: -3, rootY: 0.03, headPitch: -8, arm: raised(64, 10, 3) })],
  [96, P({ rootY: -0.015, headPitch: 3, arm: raised(22, 8, 0) })],
  [108, P({})],
]
// Laugh: head toss back, then four synchronized chuckles. Body compresses as head nods,
// expands as head tips back; forearms and tips shake in opposition. No new jaw or rig edits.
const laughPose = (up, side = 1) => P({
  rootPitch: up ? -7 : 5, rootRoll: side * 1.5, rootY: up ? 0.04 : -0.025,
  sx: up ? 0.99 : 1.02, sy: up ? 1.025 : 0.965,
  headPitch: up ? -30 : -8, headYaw: side * 4, headRoll: side * 3,
  arm: { l: arm(up ? 12 : -2, 12, up ? 20 : 7, 10, side * 12),
    r: arm(up ? 10 : -4, 12, up ? 7 : 20, 10, -side * 12) },
  leg: { l: lg(up ? 2 : -5, 3, up ? -2 : 3), r: lg(up ? 2 : -5, 3, up ? -2 : 3) },
})
const LAUGH = [
  [0, P({})],
  [12, P({ rootPitch: 4, rootY: -0.02, headPitch: 9, arm: raised(-5, 8, 0) })],
  [24, laughPose(true, 1)], [32, laughPose(false, -1)],
  [40, laughPose(true, -1)], [48, laughPose(false, 1)],
  [56, laughPose(true, 1)], [64, laughPose(false, -1)],
  [72, laughPose(true, -1)],
  [84, P({ rootPitch: 2, headPitch: -5, headRoll: 2, arm: raised(0, 4, 0) })],
  [96, P({})],
]
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

const G = 'penguin'
const author = (name, keys) => [
  { tool: 'anim_clip_create', input: { group: G, name } },
  { tool: 'anim_clip_settings_set', input: { group: G, clip: name, lengthTicks: keys.at(-1)[0], loop: false, rootMotion: 'none', events: [] } },
  { tool: 'anim_key_set', input: { action: 'insert', group: G, clip: name, items: items(keys, false) } },
]
const seek = (name, keys) => [
  { tool: 'anim_clip_select', input: { action: 'select', group: G, clip: name } },
  ...keys.map(([tick]) => ({ tool: 'anim_preview_seek', input: { group: G, clip: name, tick, action: 'seek' }, keep: true })),
]
const steps = [
  { tool: '@list' },
  { tool: 'game_register', input: { folder: '/tmp/env/game' } },
  { tool: 'asset_open_game', input: { game: 'royal-fiesta', id: 'penguin.body' } },
  ...author('emote.cheer', CHEER), ...author('emote.laugh', LAUGH),
  { tool: 'anim_preview_loop_set', input: { enabled: false } },
  { tool: 'anim_auto_key_set', input: { enabled: false } },
  ...seek('emote.cheer', CHEER), ...seek('emote.laugh', LAUGH),
  { tool: 'anim_clip_select', input: { group: G, action: 'clear' } },
  // Save workaround inherited from earlier tasks; merge restores all original non-clip fields.
  { tool: 'node_update', input: { id: 'face_patch', gameCollision: false } },
  { tool: 'asset_save_game', input: { group: G, overwrite: true } },
]
writeFileSync(process.argv[2], JSON.stringify(steps))
console.log(`steps: ${steps.length}`)
