import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import {
  emptyMechanisms,
} from '@royal-fiesta/sim/mechanismSpec'
import type {
  MechanismView,
  MechEvent,
  SoundSpec,
} from '@royal-fiesta/sim/mechanismSpec'
import type { Pose, Vec3 } from '@royal-fiesta/sim/vec'
import { CourseEmitters } from '../src/audio/emitters.ts'
import type { EmitterCommand } from '../src/audio/emitters.ts'

function sound(over: Partial<SoundSpec> = {}): SoundSpec {
  return {
    id: 's', patch: 'p', item: -1, t: { x: 1, y: 2, z: 3 },
    event: null, signal: -1, gain: 0.8, ref: 2, max: 60, loop: true,
    ...over,
  }
}

function course(sounds: SoundSpec[], signals: string[] = []): ResolvedCourse {
  return {
    id: 'c', name: 'C', kind: 'gallery', profiles: ['standard'], timeLimitS: 60, killPlaneY: -10,
    spawns: [], checkpoints: [], finish: null, path: [], regions: [], queuePad: null, obstacles: [],
    contentHash: 0,
    mechanisms: signals.length > 0 ? { ...emptyMechanisms(), signals } : null,
    sounds,
  }
}

/** A scripted MechanismView: events are reported again on every read, poses per item. */
class FakeView implements MechanismView {
  events: MechEvent[] = []
  poses = new Map<number, Vec3>()
  on = new Set<string>()

  mechanismEvents(_fromTick: number, out: MechEvent[]): number {
    for (let i = 0; i < this.events.length; i++) out[i] = { ...this.events[i] }
    return this.events.length
  }

  mechanismBodyPose(ref: { item: number; body: number }, out: Pose): boolean {
    const p = this.poses.get(ref.item)
    if (p === undefined) return false
    out.t.x = p.x
    out.t.y = p.y
    out.t.z = p.z
    return true
  }

  signal(id: string): boolean {
    return this.on.has(id)
  }
}

function impact(tick: number, source = 0): MechEvent {
  return { tick, kind: 'impact', source, x: 4, y: 5, z: 6, strength: 0.7 }
}

test('an impact event triggers once, even when it is reported again', () => {
  const view = new FakeView()
  view.events = [impact(5)]
  const emitters = new CourseEmitters(course([sound({ event: 'impact' })]))
  const out: EmitterCommand[] = []

  assert.equal(emitters.frame(view, 5, out), 1)
  assert.equal(out[0].kind, 'trigger')
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [4, 5, 6])
  assert.equal(out[0].gain, 0.8)
  assert.equal(out[0].ref, 2)
  assert.equal(out[0].max, 60)
  assert.equal(out[0].loop, true)

  // Rollback reports the same tick + kind + source again: no second trigger.
  assert.equal(emitters.frame(view, 6, out), 0)

  // After reset the history is forgotten, so the event can trigger again.
  emitters.reset()
  assert.equal(emitters.frame(view, 7, out), 1)
})

test('an impact only fires its item sound when the event source is that item', () => {
  const view = new FakeView()
  view.events = [impact(5, 2)]
  const emitters = new CourseEmitters(course([sound({ event: 'impact', item: 1 })]))
  const out: EmitterCommand[] = []
  assert.equal(emitters.frame(view, 5, out), 0)
  view.events = [impact(6, 1)]
  assert.equal(emitters.frame(view, 6, out), 1)
})

test('a signal on then off gives start then stop', () => {
  const view = new FakeView()
  const emitters = new CourseEmitters(course([sound({ signal: 0 })], ['gate']))
  const out: EmitterCommand[] = []

  view.on.add('gate')
  assert.equal(emitters.frame(view, 1, out), 1)
  assert.equal(out[0].kind, 'start')
  assert.equal(out[0].id, 's')

  assert.equal(emitters.frame(view, 2, out), 0)
  view.on.delete('gate')
  assert.equal(emitters.frame(view, 3, out), 1)
  assert.equal(out[0].kind, 'stop')
  assert.equal(emitters.frame(view, 4, out), 0)
})

test('a switch event only fires its signal sound for its own source', () => {
  const view = new FakeView()
  const emitters = new CourseEmitters(course([sound({ event: 'switchOn', signal: 1 })], ['a', 'b']))
  const out: EmitterCommand[] = []
  view.events = [{ tick: 2, kind: 'switchOn', source: 0, x: 0, y: 0, z: 0, strength: 1 }]
  assert.equal(emitters.frame(view, 2, out), 0)
  view.events = [{ tick: 3, kind: 'switchOn', source: 1, x: 7, y: 8, z: 9, strength: 1 }]
  assert.equal(emitters.frame(view, 3, out), 1)
  assert.equal(out[0].kind, 'trigger')
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [7, 8, 9])
})

test('an item loop starts once, then moves with body 0 of its item', () => {
  const view = new FakeView()
  view.poses.set(0, { x: 10, y: 1, z: 10 })
  const emitters = new CourseEmitters(course([sound({ item: 0, t: { x: 99, y: 99, z: 99 } })]))
  const out: EmitterCommand[] = []

  assert.equal(emitters.frame(view, 1, out), 1)
  assert.equal(out[0].kind, 'start')
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [10, 1, 10])

  view.poses.set(0, { x: 11, y: 1, z: 12 })
  assert.equal(emitters.frame(view, 2, out), 1)
  assert.equal(out[0].kind, 'move')
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [11, 1, 12])

  assert.equal(emitters.frame(view, 3, out), 1)
  assert.equal(out[0].kind, 'move')
})

test('an item loop falls back to its point when the item has no pose', () => {
  const view = new FakeView()
  const emitters = new CourseEmitters(course([sound({ item: 0 })]))
  const out: EmitterCommand[] = []
  assert.equal(emitters.frame(view, 1, out), 1)
  assert.equal(out[0].kind, 'start')
  assert.deepEqual([out[0].x, out[0].y, out[0].z], [1, 2, 3])
})

test('a course without mechanisms starts only the fixed loops', () => {
  const emitters = new CourseEmitters(course([
    sound({ id: 'fixed' }),
    sound({ id: 'signalled', signal: 0 }),
    sound({ id: 'evented', event: 'impact' }),
  ], ['gate']))
  const out: EmitterCommand[] = []

  assert.equal(emitters.frame({}, 1, out), 1)
  assert.equal(out[0].kind, 'start')
  assert.equal(out[0].id, 'fixed')
  assert.equal(emitters.frame({}, 2, out), 0)
})
