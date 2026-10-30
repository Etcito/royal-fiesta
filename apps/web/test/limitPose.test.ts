import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { meshRequestOf } from '../src/sdf/mamaApi.ts'
import { limitPoseOf } from '../src/nmc/limitPose.ts'

const load = (id: string): GameAsset => JSON.parse(readFileSync(new URL(`../../../assets/candy/${id}.asset.json`, import.meta.url), 'utf8')) as GameAsset
const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} != ${b}`))

test('seesaw limit pose turns the plank body about the hinge by the limit angle and leaves the pivot body at rest', () => {
  const seesaw = load('candy.mech-seesaw')
  const pose = limitPoseOf(seesaw)
  const hinge = seesaw.physics!.joints.find(j => j.id === 'pivot')!
  assert.equal(pose.body, 'plank')
  const half = hinge.limitsDeg![1] * Math.PI / 360
  near(pose.r, [Math.sin(half), 0, 0, Math.cos(half)])
  // The hinge anchor does not move: R * anchor + t = anchor.
  const [, y, z] = hinge.anchorB
  const a = 2 * half
  near([0, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)].map((v, i) => v + pose.t[i]), hinge.anchorB)
  // The pivot (base) is a fixed body: it has no limit pose, so it stays at its rest pose.
  assert.equal(seesaw.physics!.bodies.find(b => b.id === 'base')!.type, 'fixed')
})

test('every body of the seesaw and plate asks for its visible parts, never a hidden collider node', () => {
  for (const id of ['candy.mech-seesaw', 'candy.mech-plate']) {
    const asset = load(id)
    const parts = meshRequestOf(asset).parts!
    assert.deepEqual([...parts].sort(), asset.physics!.bodies.map(b => b.parts[0]).sort())
    const nodes = asset.document.nodes as Record<string, { visible?: boolean; children?: string[] }>
    for (const part of parts) assert.notEqual(nodes[part].visible, false, `${id}/${part} is hidden`)
    const children = parts.flatMap(part => nodes[part].children ?? [])
    assert.ok(children.some(c => nodes[c].visible !== false), `${id}: no visible geometry`)
  }
})

test('plate limit pose slides the plate body down its travel axis', () => {
  const pose = limitPoseOf(load('candy.mech-plate'))
  assert.equal(pose.body, 'plate')
  near(pose.t, [0, -0.1, 0])
  near(pose.r, [0, 0, 0, 1])
})
