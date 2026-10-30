import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MatchSim, CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { pose } from '@royal-fiesta/sim/vec'

// Read the real mechanism and character state; the capture never moves a body or changes a bot input.
export function iceAction(sim: MatchSim, course: ResolvedCourse) {
  const items = course.mechanisms?.items ?? []
  const item = items.findIndex(item => item.id === 'gate-a')
  const body = items[item]?.bodies.findIndex(body => body.id === 'gate') ?? -1
  if (item < 0 || body < 0) throw new Error('ice-slide-gates is missing gate-a/gate')
  const at = pose()
  if (!sim.mechanismBodyPose({ item, body }, at)) return null
  const travel = at.t.x - items[item].bodies[body].rest.t.x
  const c: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  const players = Array.from({ length: sim.setup.playerCount }, (_, p) => {
    sim.character(p, c)
    return { player: p, position: { ...c.pos }, speed: Math.hypot(c.vel.x, c.vel.z) }
  })
  return { tick: sim.tick, travel, signal: sim.signal('timer-a'), players }
}

export function iceActionReady(action: ReturnType<typeof iceAction>): boolean {
  return action !== null && action.signal && action.travel > 0.35 && action.travel < 1.85 &&
    action.players.filter(p => p.speed > 0.5).length >= 4
}
