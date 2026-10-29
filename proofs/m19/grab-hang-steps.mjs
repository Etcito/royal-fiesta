// Builds the SDF Modeler operation steps (anim_clip_create / anim_clip_settings_set / anim_key_set ...) that author the
// penguin `grab` and `hang` clips. It only computes the argument values of the registered operations; the clips themselves
// are created by the operations (sdfm-mcp-client.mjs dispatches them). No IK: every pose is plain FK keys.
// usage: node grab-hang-steps.mjs <out-steps.json> [game-folder]
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
const leg = (side, swing, splay) => side === 'l' ? compose(Rz(splay), Rx(swing)) : compose(Rz(-splay), Rx(swing))

// A pose is {bone: {rotation|translation|scale: value}}; the hang base pose is the grab end pose and the hang start/end pose.
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

// hang base: both flippers overhead and slightly forward gripping a ledge, legs and feet dangling, body stretched by its weight
const HANG = { rootRoll: 0, rootPitch: -4, sx: 0.98, sy: 1.06, rootY: 0, headRoll: 0, headPitch: -10,
  arm: { l: arm(72, 38, 10, 12, 6), r: arm(72, 38, 10, 12, 6) }, leg: { l: lg(8, 6, 26), r: lg(8, 6, 26) } }

const GRAB = [
  [0, P({})],
  [6, P({ rootPitch: 6, sx: 1.04, sy: 0.93, rootY: -0.06, headPitch: 6,
    arm: { l: arm(-18, -10, -6, 0, 0), r: arm(-18, -10, -6, 0, 0) }, leg: { l: lg(-16, 3, 10), r: lg(-16, 3, 10) } })],
  [14, P({ rootPitch: 10, sx: 0.96, sy: 1.08, rootY: 0.1, headPitch: -16,
    arm: { l: arm(78, 46, 14, 10, 8), r: arm(78, 46, 14, 10, 8) }, leg: { l: lg(12, 8, 30), r: lg(12, 8, 30) } })],
  [18, P({ rootPitch: 2, sx: 0.97, sy: 1.07, rootY: 0.03, headPitch: -12,
    arm: { l: arm(80, 44, 12, 14, 8), r: arm(80, 44, 12, 14, 8) }, leg: { l: lg(10, 7, 28), r: lg(10, 7, 28) } })],
  [24, pose(HANG)],
]
const sway = (t) => [0, 1, 0, -1, 0][t / 12]
const HANGKEYS = [0, 12, 24, 36, 48].map((t) => {
  const i = t / 12, s = sway(t), b = i % 2 ? 1 : 0
  return [t, pose({ ...HANG,
    rootRoll: 2.2 * s, rootPitch: HANG.rootPitch - 1.3 * b, sy: 1.06 + 0.01 * b, sx: 0.98 - 0.003 * b,
    headRoll: -2 * s, headPitch: HANG.headPitch + 1.5 * b,
    arm: { l: arm(72 + s, 38, 10 + 0.8 * s, 12, 6), r: arm(72 - s, 38, 10 - 0.8 * s, 12, 6) },
    leg: { l: lg(8 + 3 * s, 6, 26 - 4 * s), r: lg(8 - 3 * s, 6, 26 + 4 * s) } })]
})

// Catmull-Rom tangents converted to S17 BEZIER handles (dv only matters for sampling; dt is stored).
function items(keys, loop) {
  const bones = Object.keys(keys[0][1])
  const rows = []
  for (const bone of bones) for (const channel of Object.keys(keys[0][1][bone])) {
    const vals = keys.map(([t, p]) => p[bone][channel]), ticks = keys.map(([t]) => t), n = keys.length
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : (loop ? n - 2 : i), next = i < n - 1 ? i + 1 : (loop ? 1 : i)
      const span = (ticks[next] - ticks[prev]) + (i === 0 && loop ? ticks[n - 1] : 0) + (i === n - 1 && loop ? ticks[n - 1] : 0)
      const slope = vals[i].map((_, k) => span === 0 ? 0 : (vals[next][k] - vals[prev][k]) / span)
      const dtR = i < n - 1 ? (ticks[i + 1] - ticks[i]) / 3 : 0, dtL = i > 0 ? (ticks[i] - ticks[i - 1]) / 3 : 0
      const row = { bone, channel, tick: ticks[i], v: vals[i].map(r5), interp: 'BEZIER',
        hl: [r5(-dtL), ...slope.map((s) => r5(-s * dtL))], hr: [r5(dtR), ...slope.map((s) => r5(s * dtR))] }
      rows.push(row)
    }
  }
  return rows
}

const G = 'penguin', folder = process.argv[3] ?? '/tmp/env/game'
const steps = [
  { tool: '@list' },
  { tool: 'game_register', input: { folder } },
  { tool: 'asset_open_game', input: { game: 'royal-fiesta', id: 'penguin.body' } },
  { tool: 'anim_clip_create', input: { group: G, name: 'grab' } },
  { tool: 'anim_clip_settings_set', input: { group: G, clip: 'grab', lengthTicks: 24, loop: false, rootMotion: 'none', events: [] } },
  { tool: 'anim_key_set', input: { action: 'insert', group: G, clip: 'grab', items: items(GRAB, false) } },
  { tool: 'anim_clip_create', input: { group: G, name: 'hang' } },
  { tool: 'anim_clip_settings_set', input: { group: G, clip: 'hang', lengthTicks: 48, loop: true, rootMotion: 'none', events: [] } },
  { tool: 'anim_key_set', input: { action: 'insert', group: G, clip: 'hang', items: items(HANGKEYS, true) } },
  { tool: 'anim_preview_loop_set', input: { enabled: true } },
  { tool: 'anim_auto_key_set', input: { enabled: false } },
  ...[['grab', [0, 6, 14, 18, 24]], ['hang', [0, 12, 24, 36, 48]]].flatMap(([clip, ticks]) => [
    { tool: 'anim_clip_select', input: { action: 'select', group: G, clip } },
    ...ticks.map((tick) => ({ tool: 'anim_preview_seek', input: { group: G, clip, tick, action: 'seek' }, keep: true })),
  ]),
  { tool: 'anim_clip_select', input: { group: G, action: 'clear' } },
  // asset_save_game refuses the owner's Face patch ellipsoid collider flag; it is switched off for the save only
  { tool: 'node_update', input: { id: 'face_patch', gameCollision: false } },
  { tool: 'asset_save_game', input: { group: G, overwrite: true } },
]
writeFileSync(process.argv[2], JSON.stringify(steps))
console.log(`steps: ${steps.length}, grab items ${steps[5].input.items.length}, hang items ${steps[8].input.items.length}`)
