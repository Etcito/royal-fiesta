import assert from 'node:assert/strict'
import test from 'node:test'
import { controlsToInput, emptyControls, mergeControls } from '../src/client/inputMap.ts'
import type { PlayerInput } from '@royal-fiesta/sim/input'

test('mergeControls: a touch stick moves the hub when the keyboard and pad are idle', () => {
  const merged = mergeControls(emptyControls(), { ...emptyControls(), stickY: 0.8, jump: true })
  assert.equal(merged.stickY, 0.8)
  assert.equal(merged.jump, true)
  const out = controlsToInput(merged, { x: 0, z: 1 }, {} as PlayerInput)
  assert.ok(Math.hypot(out.moveX, out.moveZ) > 0.5)
  assert.equal(out.jump, true)
})

test('mergeControls: keys and actions are ORed, the larger stick wins', () => {
  const base = { ...emptyControls(), left: true, stickX: 0.3 }
  mergeControls(base, { ...emptyControls(), dive: true, stickX: -0.9 })
  assert.equal(base.left, true)
  assert.equal(base.dive, true)
  assert.equal(base.stickX, -0.9)
  mergeControls(base, { ...emptyControls(), stickX: 0.2 })
  assert.equal(base.stickX, -0.9)
})
