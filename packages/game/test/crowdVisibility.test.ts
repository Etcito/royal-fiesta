import assert from 'node:assert/strict'
import test from 'node:test'
import { inCrowdView } from '../src/render/crowdVisibility.ts'
import type { CameraPose } from '../src/render/port.ts'
const camera: CameraPose = { eye: [0,0,0], target: [0,0,1], fovYDeg:60, near:0.1, far:500 }
test('crowd culling keeps the view and its costume/shadow margin, including a turn and a resize', () => {
  for (const pos of [{x:0,y:0,z:10},{x:10,y:0,z:10},{x:0,y:8,z:10}]) assert.equal(inCrowdView(camera,pos,16/9),true)
  assert.equal(inCrowdView(camera,{x:30,y:0,z:10},16/9),false)
  assert.equal(inCrowdView(camera,{x:0,y:0,z:-10},16/9),false)
  const turned = {...camera,target:[1,0,0] as [number,number,number]}
  assert.equal(inCrowdView(turned,{x:30,y:0,z:10},16/9),true)
  assert.equal(inCrowdView(camera,{x:15,y:0,z:10},16/9),true)
  assert.equal(inCrowdView(camera,{x:15,y:0,z:10},0.5),false)
  assert.equal(inCrowdView(null,{x:30,y:0,z:10},16/9),true)
})
