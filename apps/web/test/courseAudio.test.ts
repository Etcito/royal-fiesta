// Headless checks for the course audio wiring: the falloff reaches the emitter gain, the pan
// follows the listener's facing and a missing patch is skipped with one warning. Web Audio is a
// fake graph; the haa player is injected through createCourseAudio's test-only last parameter.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmitterCommand } from '@royal-fiesta/game/audio/emitters'
import { CourseEmitters } from '@royal-fiesta/game/audio/emitters'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MechEvent } from '@royal-fiesta/sim/mechanismSpec'
import { createCourseAudio } from '../src/play/courseAudio.ts'

class FakeNode {
  readonly outs = new Set<FakeNode>()
  connect(dest: FakeNode): FakeNode {
    this.outs.add(dest)
    return dest
  }
  disconnect(dest?: FakeNode): void {
    if (dest) this.outs.delete(dest)
    else this.outs.clear()
  }
}

class FakeGain extends FakeNode {
  readonly gain = { value: 1 }
}

class FakePanner extends FakeNode {
  readonly pan = { value: 0 }
}

function fakeContext() {
  const ctx = {
    destination: new FakeNode(),
    gains: [] as FakeGain[],
    panners: [] as FakePanner[],
    createGain() {
      const gain = new FakeGain()
      ctx.gains.push(gain)
      return gain
    },
    createStereoPanner() {
      const panner = new FakePanner()
      ctx.panners.push(panner)
      return panner
    },
  }
  return ctx
}

function fakePlayer(gainInput = false) {
  const node = new FakeNode()
  const calls: unknown[][] = []
  let restarts = 0
  let disposals = 0
  const player = {
    node,
    info: { nodes: [], inputs: gainInput ? [{ name: 'gain', kind: 'continuous', min: 0, max: 1, default: 1 }] : [], mode: 'live', duration: 1, loop: false },
    issues: [],
    playable: true,
    set(name: string, value: number | string) { calls.push(['set', name, value]) },
    trigger() {},
    async setPatch() { return { playable: true, issues: [] } },
    onTrace() { return () => {} },
    onEnded() { return () => {} },
    restart() { calls.push(['restart']); restarts++ },
    dispose() { disposals++ },
  }
  return { player, node, calls, restarts: () => restarts, disposals: () => disposals }
}

type MakePlayer = Parameters<typeof createCourseAudio>[5]

function rig(gainInput = false, ready = Promise.resolve()) {
  const ctx = fakeContext()
  const made: ReturnType<typeof fakePlayer>[] = []
  const initialInputs: (Record<string, number | string> | undefined)[] = []
  // The test-only seam: no AudioWorklet, no wasm, just a player whose node joins the fake graph.
  const makePlayer = (async (_ctx: unknown, options: { inputs?: Record<string, number | string>; output: FakeNode }) => {
    const p = fakePlayer(gainInput)
    p.node.connect(options.output)
    made.push(p)
    initialInputs.push(options.inputs)
    await ready
    return p.player
  }) as unknown as MakePlayer
  return { ctx, made, initialInputs, makePlayer }
}

const WASM = {} as WebAssembly.Module
const PATCHES = new Map([['tap', 'data:text/plain,{"haa":1}']])

function start(id: string, x: number, y: number, z: number, patch = 'tap'): EmitterCommand {
  return { kind: 'start', id, patch, gain: 1, ref: 2, max: 60, loop: true, x, y, z }
}

function audioOf(r: ReturnType<typeof rig>, patches: ReadonlyMap<string, string> = PATCHES) {
  return createCourseAudio(
    r.ctx as unknown as BaseAudioContext,
    patches,
    WASM,
    'worklet.js',
    r.ctx.destination as unknown as AudioNode,
    r.makePlayer,
  )
}

// The patch fetch and the player factory settle after apply(); poll instead of guessing a delay.
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a near emitter gets a higher gain than a far one', async () => {
  const r = rig()
  const audio = audioOf(r)
  audio.apply([start('near', 0, 0, 1)], 1)
  await waitFor(() => r.made.length === 1, 'the near player')
  audio.apply([start('far', 0, 0, 32)], 1)
  await waitFor(() => r.made.length === 2, 'the far player')

  audio.setListeners([{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
  const near = r.ctx.gains[0].gain.value
  const far = r.ctx.gains[1].gain.value
  assert.ok(near > far, `near ${near} should be louder than far ${far}`)
  assert.ok(Math.abs(near - 1) < 1e-9, 'inside ref the gain is 1')
  assert.ok(Math.abs(far - 1 / 16) < 1e-9, 'at 32 m with ref 2 and rolloff 1 the gain is 1/16')
})

test('an emitter on the listener right pans right', async () => {
  const r = rig()
  const audio = audioOf(r)
  audio.apply([start('right', 3, 0, 0)], 1)
  await waitFor(() => r.made.length === 1, 'the right player')
  audio.setListeners([{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
  assert.ok(r.ctx.panners[0].pan.value > 0, 'facing +Z puts +X on the right')
})

test('a missing patch is skipped once', async () => {
  const r = rig()
  const audio = audioOf(r, new Map())
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    audio.apply([start('a', 0, 0, 0, 'missing')], 1)
    audio.apply([start('a', 0, 0, 0, 'missing')], 1)
    // The warning is synchronous; the wait proves no late player appears either.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    console.warn = original
  }
  assert.equal(r.made.length, 0, 'no player is created')
  assert.equal(r.ctx.panners.length, 0, 'no emitter is added')
  assert.equal(warnings.length, 1, 'the missing patch is named once')
  assert.match(warnings[0], /missing/)
})

const GAIN_PATCHES = new Map([['tap', 'data:text/plain,' + encodeURIComponent(JSON.stringify({
  haa: 1, inputs: [{ name: 'gain', kind: 'continuous', min: 0, max: 1, default: 1 }],
}))]])

test('impact strength reaches the declared gain before playback and every restart', async () => {
  const r = rig(true)
  const audio = audioOf(r, GAIN_PATCHES)
  const c = {
    sounds: [{
      id: 'impact', patch: 'tap', event: 'impact', item: -1, signal: -1,
      gain: 0.6, ref: 2, max: 60, loop: false, t: { x: 0, y: 0, z: 0 },
    }],
    mechanisms: null,
  } as ResolvedCourse
  const emitters = new CourseEmitters(c)
  let event: MechEvent = { tick: 1, kind: 'impact', source: 0, x: 0, y: 0, z: 1, strength: 0.2 }
  const view = {
    mechanismEvents(_from: number, out: MechEvent[]) { out[0] = event; return 1 },
    mechanismBodyPose() { return false },
    signal() { return false },
  }
  const out: EmitterCommand[] = []
  audio.apply(out, emitters.frame(view, 1, out))
  await waitFor(() => r.made[0]?.restarts() === 1, 'the first impact')
  assert.equal(out[0].strength, 0.2)
  assert.equal(out[0].gain, 0.6, 'course gain remains the spatial emitter gain')
  assert.deepEqual(r.initialInputs, [{ gain: 0.2 }])
  audio.setListeners([{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
  assert.equal(r.ctx.gains[0].gain.value, 0.6)

  for (const strength of [1, 0]) {
    event = { ...event, tick: event.tick + 1, strength }
    audio.apply(out, emitters.frame(view, event.tick, out))
    assert.equal(out[0].strength, strength)
  }
  assert.deepEqual(r.made[0].calls, [
    ['set', 'gain', 0.2], ['restart'],
    ['set', 'gain', 1], ['restart'],
    ['set', 'gain', 0], ['restart'],
  ])

  const fixed = new CourseEmitters({ ...c, sounds: [{ ...c.sounds![0], event: null }] })
  fixed.frame({}, 4, out)
  assert.equal(out[0].strength, undefined, 'reused commands clear event strength')
  audio.apply([{ ...out[0], kind: 'trigger' }], 1)
  assert.deepEqual(r.made[0].calls.slice(-2), [['set', 'gain', 1], ['restart']])
  audio.dispose()
})

test('patches without a gain input receive no strength input', async () => {
  const r = rig()
  const audio = audioOf(r)
  const cmd: EmitterCommand = { ...start('click', 0, 0, 0), kind: 'trigger', strength: 0.2 }
  audio.apply([cmd], 1)
  await waitFor(() => r.made[0]?.restarts() === 1, 'the click')
  audio.apply([{ ...cmd, strength: 1 }], 1)
  assert.deepEqual(r.initialInputs, [{}])
  assert.deepEqual(r.made[0].calls, [['restart'], ['restart']])
  audio.dispose()
})

test('pending triggers use the latest strength across fetch and player creation', async () => {
  let release!: () => void
  const r = rig(true, new Promise<void>((resolve) => { release = resolve }))
  const audio = audioOf(r, GAIN_PATCHES)
  const cmd: EmitterCommand = { ...start('thud', 0, 0, 0), kind: 'trigger', strength: 0.2 }
  audio.apply([cmd], 1)
  audio.apply([{ ...cmd, strength: 0.4 }], 1)
  await waitFor(() => r.made.length === 1, 'player creation')
  assert.deepEqual(r.initialInputs, [{ gain: 0.4 }])
  audio.apply([{ ...cmd, strength: 0.8 }], 1)
  release()
  await waitFor(() => r.made[0].restarts() === 1, 'the pending impact')
  assert.deepEqual(r.made[0].calls, [['set', 'gain', 0.8], ['restart']])
  audio.dispose()
})

test('each player feeds a gain and panner into the sfx bus and disconnects on stop', async () => {
  const r = rig()
  const audio = audioOf(r)
  const cmd = start('loop', 0, 0, 1)
  audio.apply([cmd], 1)
  await waitFor(() => r.ctx.panners.length === 1 && r.made.length === 1, 'the chain')
  assert.deepEqual([...r.made[0].node.outs], [r.ctx.gains[0]])
  assert.deepEqual([...r.ctx.gains[0].outs], [r.ctx.panners[0]])
  assert.deepEqual([...r.ctx.panners[0].outs], [r.ctx.destination])
  audio.apply([{ ...cmd, kind: 'stop' }], 1)
  assert.equal(r.made[0].disposals(), 1)
  assert.equal(r.ctx.gains[0].outs.size, 0)
  assert.equal(r.ctx.panners[0].outs.size, 0)
})

test('two listeners use the nearer listener gain and pan, recomputed on moves and triggers', async () => {
  const r = rig()
  const audio = audioOf(r)
  audio.setListeners([
    { x: 0, y: 0, z: 0, fx: 0, fz: 1 },
    { x: 12, y: 0, z: 0, fx: 0, fz: 1 },
  ])
  const cmd = { ...start('loop', 8, 0, 0), gain: 0.6 }
  audio.apply([cmd], 1)
  await waitFor(() => r.made.length === 1, 'the spatial player')
  assert.equal(r.ctx.gains[0].gain.value, 0.3)
  assert.equal(r.ctx.panners[0].pan.value, -1)
  audio.apply([{ ...cmd, kind: 'move', x: 2 }], 1)
  assert.equal(r.ctx.gains[0].gain.value, 0.6)
  assert.equal(r.ctx.panners[0].pan.value, 1)
  audio.apply([{ ...cmd, kind: 'trigger', x: 16 }], 1)
  assert.equal(r.ctx.gains[0].gain.value, 0.3)
  assert.equal(r.ctx.panners[0].pan.value, 1)
  audio.setListeners([{ x: 18, y: 0, z: 0, fx: 0, fz: 1 }])
  assert.equal(r.ctx.gains[0].gain.value, 0.6)
  assert.equal(r.ctx.panners[0].pan.value, -1)
  audio.setListeners([])
  assert.equal(r.ctx.gains[0].gain.value, 0.6)
  assert.equal(r.ctx.panners[0].pan.value, 0)
  audio.dispose()
})

test('a declared course-loop rate starts at one', async () => {
  const r = rig()
  const patches = new Map([['tap', 'data:text/plain,' + encodeURIComponent(JSON.stringify({
    haa: 1, inputs: [{ name: 'rate', kind: 'continuous', min: 0, max: 1, default: 0 }],
  }))]])
  const audio = audioOf(r, patches)
  audio.apply([start('motor', 0, 0, 0)], 1)
  await waitFor(() => r.made.length === 1, 'the motor')
  assert.deepEqual(r.initialInputs, [{ rate: 1 }])
  audio.dispose()
})

test('a pending player uses the latest emitter and listener positions when ready', async () => {
  let release!: () => void
  const r = rig(false, new Promise<void>(resolve => { release = resolve }))
  const audio = audioOf(r)
  const cmd = start('moving', 0, 0, 1)
  audio.apply([cmd], 1)
  await waitFor(() => r.made.length === 1, 'pending player')
  audio.apply([{ ...cmd, kind: 'move', x: 8, z: 0 }], 1)
  audio.setListeners([{ x: 12, y: 0, z: 0, fx: 0, fz: 1 }])
  release()
  await waitFor(() => r.ctx.gains[0].gain.value === 0.5, 'updated spatial gain')
  assert.equal(r.ctx.panners[0].pan.value, -1)
  audio.dispose()
})

test('stopping during player creation disposes the stale player and its chain', async () => {
  let release!: () => void
  const r = rig(false, new Promise<void>(resolve => { release = resolve }))
  const audio = audioOf(r)
  const cmd = start('stale', 0, 0, 1)
  audio.apply([cmd], 1)
  await waitFor(() => r.made.length === 1, 'pending player')
  audio.apply([{ ...cmd, kind: 'stop' }], 1)
  release()
  await waitFor(() => r.made[0].disposals() === 1, 'stale disposal')
  assert.equal(r.ctx.gains[0].outs.size, 0)
  assert.equal(r.ctx.panners[0].outs.size, 0)
  audio.dispose()
})

test('laser rate reaches spawn, pending player and live moves', async () => {
  let release!: () => void
  const r = rig(false, new Promise<void>(resolve => { release = resolve }))
  const patches = new Map([['tap', 'data:text/plain,' + encodeURIComponent(JSON.stringify({
    haa: 1, inputs: [{ name: 'rate', kind: 'continuous', min: 0, max: 2, default: 1 }],
  }))]])
  const audio = audioOf(r, patches)
  const cmd = { ...start('laser', 0, 0, 0), rate: 1.2 }
  audio.apply([cmd], 1)
  await waitFor(() => r.made.length === 1, 'pending laser')
  assert.deepEqual(r.initialInputs, [{ rate: 1.2 }])
  r.made[0].player.info.inputs.push({ name: 'rate', kind: 'continuous', min: 0, max: 2, default: 1 })
  audio.apply([{ ...cmd, kind: 'move', rate: 1.5 }], 1)
  release()
  await waitFor(() => r.made[0].calls.length > 0, 'pending rate update')
  audio.apply([{ ...cmd, kind: 'move', rate: 1.7 }], 1)
  assert.deepEqual(r.made[0].calls, [['set', 'rate', 1.5], ['set', 'rate', 1.7]])
  audio.dispose()
})
