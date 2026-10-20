import { NEUTRAL_CODE, inputCode } from '@royal-fiesta/sim/input'
import type { CharState } from '@royal-fiesta/sim/character/system'

// Replay inputs: character k starts at spawn k of obstacle-gallery and is driven
// by REPLAY_SCRIPTS[k] over ticks 0..1800. Directions are world-space S1 codes.
export interface ScriptStep {
  from: number
  to: number
  code: number
}

export type InputScript = readonly ScriptStep[]

export function codeAt(script: InputScript, tick: number): number {
  for (let i = 0; i < script.length; i++) {
    const step = script[i]
    if (tick >= step.from && tick < step.to) return step.code
  }
  return NEUTRAL_CODE
}

const FWD = inputCode({ moveZ: 1 })
const LEFT = inputCode({ moveX: -1 })
const RIGHT = inputCode({ moveX: 1 })
const FWD_LEFT = inputCode({ moveX: -1, moveZ: 1 })
const FWD_RIGHT = inputCode({ moveX: 1, moveZ: 1 })
const JUMP_FWD = inputCode({ moveZ: 1, jump: true })
const DIVE_FWD = inputCode({ moveZ: 1, dive: true })
const GRAB = inputCode({ grab: true })
const GRAB_MOVE = inputCode({ moveX: 1, grab: true })

// 0 run+turn: run out, curve left then right on the start floor, then walk +Z into spinner-1 at (-24, 14).
const S0: InputScript = [
  { from: 0, to: 30, code: FWD },
  { from: 30, to: 60, code: FWD_LEFT },
  { from: 60, to: 90, code: FWD_RIGHT },
  { from: 90, to: 225, code: LEFT },
  { from: 225, to: 1800, code: FWD },
]

// 1 jump chain: forward hops every 48 ticks (air time is ~45 ticks), then idle.
const S1: InputScript = [
  { from: 0, to: 3, code: JUMP_FWD },
  { from: 3, to: 48, code: FWD },
  { from: 48, to: 51, code: JUMP_FWD },
  { from: 51, to: 96, code: FWD },
  { from: 96, to: 99, code: JUMP_FWD },
  { from: 99, to: 144, code: FWD },
  { from: 144, to: 147, code: JUMP_FWD },
  { from: 147, to: 192, code: FWD },
  { from: 192, to: 195, code: JUMP_FWD },
  { from: 195, to: 330, code: FWD },
  { from: 330, to: 1800, code: NEUTRAL_CODE },
]

// 2 dive: run, dive, recover, dive again, then run down lane 4 and idle.
const S2: InputScript = [
  { from: 0, to: 36, code: FWD },
  { from: 36, to: 42, code: DIVE_FWD },
  { from: 42, to: 90, code: FWD },
  { from: 90, to: 96, code: DIVE_FWD },
  { from: 96, to: 400, code: FWD },
  { from: 400, to: 1800, code: NEUTRAL_CODE },
]

// 3 grab of character 4: close the 2 m gap with +X, then hold grab.
const S3: InputScript = [
  { from: 0, to: 20, code: RIGHT },
  { from: 20, to: 1800, code: GRAB },
]

// 4 grab target: neutral bait, then run +X/-X so it stays inside the start floor (x -28..28, z -2..10).
const S4: InputScript = [
  { from: 0, to: 30, code: NEUTRAL_CODE },
  { from: 30, to: 150, code: RIGHT },
  { from: 150, to: 270, code: LEFT },
  { from: 270, to: 390, code: RIGHT },
  { from: 390, to: 510, code: LEFT },
  { from: 510, to: 630, code: RIGHT },
  { from: 630, to: 750, code: LEFT },
  { from: 750, to: 870, code: RIGHT },
  { from: 870, to: 990, code: LEFT },
  { from: 990, to: 1800, code: NEUTRAL_CODE },
]

// 5 conveyor ride: +X to x=8, +Z across conveyor-1 (opposes) onto conveyor-2 near z=21, then ride +Z while neutral.
const S5: InputScript = [
  { from: 0, to: 52, code: RIGHT },
  { from: 52, to: 300, code: FWD },
  { from: 300, to: 1800, code: NEUTRAL_CODE },
]

// 6 bounce pad: +X to x=16, +Z onto bounce-1 at (16, 14), then bounce in place while neutral.
const S6: InputScript = [
  { from: 0, to: 95, code: RIGHT },
  { from: 95, to: 210, code: FWD },
  { from: 210, to: 1800, code: NEUTRAL_CODE },
]

// 7 platform ride: +X to x=21, +Z past platform-1, wait beside platform-2, step +X on while it is low (tick 135+180k), then ride.
const S7: InputScript = [
  { from: 0, to: 110, code: RIGHT },
  { from: 110, to: 305, code: FWD },
  { from: 305, to: 475, code: NEUTRAL_CODE },
  { from: 475, to: 510, code: RIGHT },
  { from: 510, to: 1800, code: NEUTRAL_CODE },
]

export const REPLAY_SCRIPTS: readonly InputScript[] = [S0, S1, S2, S3, S4, S5, S6, S7]

export const REPLAY_TICKS: readonly number[] = [0, 60, 120, 240, 480, 720, 1200, 1800]

export interface ScenarioActor { spawn: number; script: InputScript }
export interface BehaviourScenario {
  label: string
  course: string
  spawn: number
  script: InputScript
  others: readonly ScenarioActor[]
  ticks: number
  measure: (samples: CharState[]) => { value: number; threshold: string; pass: boolean }
}

const GALLERY = 'obstacle-gallery'
const SPINNER_1 = 13
const CONVEYOR_2 = 30
const BOUNCE_1 = 33
const PLATFORM_2 = 37
const JUMP_ONCE: InputScript = [
  { from: 0, to: 24, code: NEUTRAL_CODE },
  { from: 24, to: 25, code: inputCode({ jump: true }) },
  { from: 25, to: 100, code: NEUTRAL_CODE },
]
const RUN_60: InputScript = [{ from: 0, to: 60, code: FWD }]
const DIVE_RUN: InputScript = [
  { from: 0, to: 30, code: FWD },
  { from: 30, to: 31, code: DIVE_FWD },
  { from: 31, to: 100, code: FWD },
]
const SPINNER_WALK: InputScript = [
  { from: 0, to: 30, code: FWD },
  { from: 30, to: 60, code: FWD_LEFT },
  { from: 60, to: 90, code: FWD_RIGHT },
  { from: 90, to: 225, code: LEFT },
  { from: 225, to: 500, code: FWD },
]
const BOUNCE_WALK: InputScript = [
  { from: 0, to: 90, code: RIGHT },
  { from: 90, to: 225, code: FWD },
  { from: 225, to: 500, code: NEUTRAL_CODE },
]
const CONVEYOR_WALK: InputScript = [
  { from: 0, to: 43, code: RIGHT },
  { from: 43, to: 78, code: FWD },
  { from: 78, to: 83, code: JUMP_FWD },
  { from: 83, to: 260, code: FWD },
  { from: 260, to: 380, code: NEUTRAL_CODE },
]
const PLATFORM_WALK: InputScript = [
  { from: 0, to: 110, code: RIGHT },
  { from: 110, to: 312, code: FWD },
  { from: 312, to: 475, code: NEUTRAL_CODE },
  { from: 475, to: 510, code: RIGHT },
  { from: 510, to: 800, code: NEUTRAL_CODE },
]
const GRABBER: InputScript = [
  { from: 0, to: 20, code: RIGHT },
  { from: 20, to: 40, code: GRAB },
  { from: 40, to: 300, code: GRAB_MOVE },
]
const TARGET: InputScript = [
  { from: 0, to: 40, code: NEUTRAL_CODE },
  { from: 40, to: 300, code: RIGHT },
]

function horizontalSpeed(s: CharState): number {
  return Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z)
}

function distanceXZ(a: CharState, b: CharState): number {
  const x = a.pos.x - b.pos.x
  const z = a.pos.z - b.pos.z
  return Math.sqrt(x * x + z * z)
}

function reached(samples: CharState[], obstacle: number): boolean {
  return samples.some((s) => s.grounded && s.groundObstacle === obstacle)
}

export function behaviourScenarios(): BehaviourScenario[] {
  return [
    {
      label: 'jump-apex', course: GALLERY, spawn: 0, script: JUMP_ONCE, others: [], ticks: 80,
      measure: (s) => {
        let high = s[24].pos.y
        for (let i = 25; i < s.length; i++) high = Math.max(high, s[i].pos.y)
        const value = high - s[24].pos.y
        return { value, threshold: '1.30..1.50 m', pass: value >= 1.3 && value <= 1.5 }
      },
    },
    {
      label: 'run-speed', course: GALLERY, spawn: 0, script: RUN_60, others: [], ticks: 60,
      measure: (s) => {
        const value = horizontalSpeed(s[60])
        return { value, threshold: '7.9..8.0 m/s', pass: value >= 7.9 && value <= 8.0 }
      },
    },
    {
      label: 'dive-speed', course: GALLERY, spawn: 0, script: DIVE_RUN, others: [], ticks: 31,
      measure: (s) => {
        const value = horizontalSpeed(s[31])
        return { value, threshold: '>=10 m/s', pass: value >= 10 }
      },
    },
    {
      label: 'spinner-bump', course: GALLERY, spawn: 0, script: SPINNER_WALK, others: [], ticks: 500,
      measure: (s) => {
        let first = -1
        for (let i = 0; i < s.length; i++) if (s[i].mode === 4) { first = i; break }
        let value = 0
        if (first >= 0) for (let i = first + 1; i <= Math.min(first + 30, s.length - 1); i++) value = Math.max(value, distanceXZ(s[first], s[i]))
        const hit = s.some((v) => v.knockbacks >= 1)
        return { value, threshold: 'stunned, knockbacks>=1, >=1.0 m', pass: first >= 0 && hit && value >= 1 }
      },
    },
    {
      label: 'bounce-apex', course: GALLERY, spawn: 6, script: BOUNCE_WALK, others: [], ticks: 300,
      measure: (s) => {
        let lastGround = -1
        let high = -Infinity
        for (let i = 0; i < s.length; i++) {
          if (s[i].grounded && s[i].groundObstacle === BOUNCE_1) lastGround = i
          else if (lastGround >= 0) high = Math.max(high, s[i].pos.y)
        }
        const value = lastGround >= 0 && high > -Infinity ? high - s[lastGround].pos.y : 0
        return { value, threshold: '>=4.5 m', pass: lastGround >= 0 && value >= 4.5 }
      },
    },
    {
      label: 'conveyor', course: GALLERY, spawn: 5, script: CONVEYOR_WALK, others: [], ticks: 390,
      measure: (s) => {
        let start = -1
        for (let i = 0; i < s.length; i++) if (i >= 261 && s[i].grounded && s[i].groundObstacle === CONVEYOR_2) { start = i; break }
        const end = Math.min(s.length - 1, start + 120)
        const value = start >= 0 && end - start === 120 ? distanceXZ(s[start], s[end]) : 0
        return { value, threshold: '>=5.4 m', pass: start >= 0 && end - start === 120 && value >= 5.4 }
      },
    },
    {
      label: 'platform', course: GALLERY, spawn: 7, script: PLATFORM_WALK, others: [], ticks: 800,
      measure: (s) => {
        let run = 0
        let longest = 0
        for (const v of s) {
          run = v.grounded && v.groundObstacle === PLATFORM_2 ? run + 1 : 0
          longest = Math.max(longest, run)
        }
        return { value: longest, threshold: '>=180 samples', pass: longest >= 180 }
      },
    },
    {
      label: 'grab', course: GALLERY, spawn: 4, script: TARGET, others: [{ spawn: 3, script: GRABBER }], ticks: 300,
      measure: (s) => {
        let value = 0
        let count = 0
        for (let i = 40; i < s.length; i++) {
          const speed = horizontalSpeed(s[i])
          if (speed > 0.01 && speed <= 4.8 + 1e-6) { value = Math.max(value, speed); count++ }
        }
        return { value, threshold: '<=4.8 m/s; >=30 grabbed samples', pass: count >= 30 && value <= 4.8 + 1e-6 }
      },
    },
  ]
}
