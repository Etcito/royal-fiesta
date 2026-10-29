import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../../sim/src/course.ts'
import { neutralInput } from '../../sim/src/input.ts'
import { createMatchSim } from '../../sim/src/match/matchSim.ts'
import type { RoundSystem } from '../../sim/src/match/roundSystem.ts'
import { PROFILES } from '../../sim/src/match/setup.ts'
import type { MechEvent, MechanismSpec } from '../../sim/src/mechanismSpec.ts'
import type { MechanismSystem } from '../../sim/src/mechanisms/system.ts'
import { pose } from '../../sim/src/vec.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { GameAssetResolver } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = await readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
async function load(id: string): Promise<ResolvedCourse> {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(await readJson(path), path, assets)
  assert.ok(course.sim, `${id} has a simulation course`)
  return course.sim
}
function body(m: MechanismSpec, itemId: string, bodyId: string) {
  const item = m.items.findIndex(i => i.id === itemId)
  assert.ok(item >= 0, `missing item ${itemId}`)
  const index = m.items[item].bodies.findIndex(b => b.id === bodyId)
  assert.ok(index >= 0, `missing body ${itemId}/${bodyId}`)
  return { ref: { item, body: index }, rest: m.items[item].bodies[index].rest }
}
const R = await initRapier()
const mechLab = await load('mech-lab')
const survival = await load('survival-sprint')
assert.ok(mechLab.mechanisms)
const mechanisms = mechLab.mechanisms

test('mech-lab: eight bots reach the race target and the plate opens the door', { timeout: 170_000 }, () => {
  const sim = createMatchSim(R, {
    seed: 1, playerCount: 8, humans: Array(8).fill(false), profile: 'sprint', courses: [mechLab, survival],
  })
  try {
    const rounds = sim.world.ctx.system<RoundSystem>('round')
    const mech = sim.world.ctx.system<MechanismSystem>('mechanisms')
    const doorLink = mechanisms.links.find(l => l.id === 'door')!
    assert.equal(doorLink.to.kind, 'door')
    assert.ok(doorLink.to.kind === 'door')
    const events: MechEvent[] = []
    const inputs = Array.from({ length: 8 }, () => neutralInput())
    // Normal match elimination stops at five qualifiers. Exercise the same S5 MatchSim
    // systems with an eight-finisher race, keeping the original sprint deadline.
    for (let t = 0; t <= PROFILES.sprint.introTicks; t++) sim.step(inputs)
    const players = Array.from({ length: 8 }, (_, p) => p)
    rounds.begin(sim.world.ctx, { index: 0, kind: 'race', final: false, target: 8 },
      0, players, players, PROFILES.sprint.timeCapS! * 60 - sim.tick)
    let plateTick: number | undefined
    let movingTick: number | undefined
    let doorTick: number | undefined
    let switchOn = false
    // Enough for the intro and the complete sprint round, including a failing time cap.
    const maxTicks = PROFILES.sprint.introTicks + PROFILES.sprint.timeCapS! * 60 + 2
    while (!rounds.over && sim.tick < maxTicks) {
      const fromTick = sim.tick
      sim.step(inputs)
      sim.mechanismEvents(fromTick, events)
      const plateEvent = events.find(e => e.kind === 'switchOn' && e.source === mechanisms.signals.indexOf('plate'))
      switchOn ||= plateEvent !== undefined
      if (plateTick === undefined && plateEvent) plateTick = plateEvent.tick
      // Observe from the start, so opening before switchOn cannot pass unnoticed.
      const angle = mech.jointAngle(sim.world.ctx, doorLink.to.joint)
      if (angle >= Math.PI / 3 && movingTick === undefined) movingTick = fromTick
      if (angle >= doorLink.to.openAngle && doorTick === undefined) {
        assert.ok(plateTick !== undefined && plateTick < fromTick, 'switchOn precedes the open hinge')
        doorTick = fromTick
      }
    }
    assert.ok(rounds.over, 'round 0 ends within the sprint cap')
    const round = rounds.result()
    assert.ok(round, 'round 0 ends within the sprint cap')
    assert.equal(round.courseIndex, 0)
    assert.equal(round.plan.index, 0)
    assert.equal(round.reason, 'target', `race result: ${JSON.stringify({ qualified: round.qualified, target: round.plan.target, plateTick, doorTick, switchOn })}`)
    assert.equal(round.participants.length, 8)
    assert.equal(round.plan.target, 8)
    assert.equal(round.qualified.length, 8)
    assert.deepEqual([...round.qualified].sort((a, b) => a - b), players)
    assert.deepEqual(round.eliminated, [])
    assert.ok(plateTick !== undefined, 'bots activate the plate')
    assert.ok(doorTick !== undefined, 'door hinge reaches its configured openDeg (90 degrees)')
    assert.ok(movingTick !== undefined && movingTick > plateTick && movingTick - plateTick <= 120,
      'door passes 60 degrees within 120 ticks after switchOn')
    assert.ok(switchOn, 'mechanismEvents reports switchOn during the race')
  } finally {
    sim.free()
  }
})

test('mech-lab: two lever rising edges raise then lower the piston', { timeout: 10_000 }, () => {
  const preview = createMatchSim(R, {
    seed: 1, playerCount: 8, humans: Array(8).fill(false), profile: 'sprint', courses: [mechLab, survival],
  })
  const inputs = Array.from({ length: 8 }, () => neutralInput())
  preview.step(inputs)
  try {
    const ctx = preview.world.ctx
    const mech = ctx.system<MechanismSystem>('mechanisms')
    const lever = mechanisms.levers.find(l => l.id === 'lever')
    assert.ok(lever)
    const piston = body(mechanisms, 'piston', 'block')
    const current = pose()
    const events: MechEvent[] = []
    let leverOn = false
    const step = () => {
      const fromTick = preview.tick
      preview.step(inputs)
      preview.mechanismEvents(fromTick, events)
      leverOn ||= events.some(e => e.kind === 'leverOn')
    }
    const height = () => {
      assert.ok(preview.mechanismBodyPose(piston.ref, current))
      return current.t.y - piston.rest.t.y
    }
    const drive = (target: number, on: boolean) => {
      mech.setMotor(ctx, lever.joint, {
        mode: 'target', target, speed: 0, stiffness: 100000, damping: 1000, maxForce: 100000, enabled: true,
      })
      for (let i = 0; i < 90 && preview.signal('lever') !== on; i++) step()
      assert.equal(preview.signal('lever'), on, `lever reaches ${on ? 'on' : 'off'} threshold (angle ${mech.jointAngle(ctx, lever.joint)})`)
    }
    assert.equal(preview.signal('lever'), false)
    assert.equal(preview.signal('piston-toggle'), false)
    assert.ok(height() < 0.2, 'piston starts lowered')
    drive(lever.onAngle + Math.PI / 36, true)
    assert.equal(preview.signal('piston-toggle'), true, 'first lever rising edge toggles piston on')
    for (let i = 0; i < 90 && height() < 1.2; i++) step()
    assert.ok(height() >= 1.2, 'piston rises at least 1.2 m within 90 ticks')
    assert.ok(leverOn, 'mechanismEvents reports leverOn')

    drive(lever.offAngle - Math.PI / 12, false)
    assert.equal(preview.signal('piston-toggle'), true, 'lever falling edge leaves toggle on')
    drive(lever.onAngle + Math.PI / 36, true)
    assert.equal(preview.signal('piston-toggle'), false, 'second lever rising edge toggles piston off')
    for (let i = 0; i < 90 && height() >= 0.2; i++) step()
    assert.ok(height() < 0.2, `second toggle lowers piston below 0.2 m within 90 ticks (height ${height()}, lever ${preview.signal('lever')}, toggle ${preview.signal('piston-toggle')})`)
  } finally {
    preview.free()
  }
})
