// Headless checks for the course audio wiring: the falloff reaches the emitter gain, the pan
// follows the listener's facing and a missing patch is skipped with one warning. Web Audio is a
// fake graph; the haa player is injected through createCourseAudio's test-only last parameter.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmitterCommand } from '@royal-fiesta/game/audio/emitters'
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

function fakePlayer() {
  const node = new FakeNode()
  let restarts = 0
  let disposals = 0
  const player = {
    node,
    info: { nodes: [], inputs: [], mode: 'live', duration: 1, loop: false },
    issues: [],
    playable: true,
    set() {},
    trigger() {},
    async setPatch() { return { playable: true, issues: [] } },
    onTrace() { return () => {} },
    onEnded() { return () => {} },
    restart() { restarts++ },
    dispose() { disposals++ },
  }
  return { player, node, restarts: () => restarts, disposals: () => disposals }
}

type MakePlayer = Parameters<typeof createCourseAudio>[5]

function rig() {
  const ctx = fakeContext()
  const made: ReturnType<typeof fakePlayer>[] = []
  // The test-only seam: no AudioWorklet, no wasm, just a player whose node joins the fake graph.
  const makePlayer = (async () => {
    const p = fakePlayer()
    made.push(p)
    return p.player
  }) as unknown as MakePlayer
  return { ctx, made, makePlayer }
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

  audio.setListener({ x: 0, y: 0, z: 0, fx: 0, fz: 1 })
  const near = r.ctx.gains[1].gain.value
  const far = r.ctx.gains[2].gain.value
  assert.ok(near > far, `near ${near} should be louder than far ${far}`)
  assert.ok(Math.abs(near - 1) < 1e-9, 'inside ref the gain is 1')
  assert.ok(Math.abs(far - 1 / 16) < 1e-9, 'at 32 m with ref 2 and rolloff 1 the gain is 1/16')
})

test('an emitter on the listener right pans right', async () => {
  const r = rig()
  const audio = audioOf(r)
  audio.apply([start('right', 3, 0, 0)], 1)
  await waitFor(() => r.made.length === 1, 'the right player')
  audio.setListener({ x: 0, y: 0, z: 0, fx: 0, fz: 1 })
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
