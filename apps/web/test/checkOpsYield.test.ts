import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BOOT_FRAMES, checkBoot, nextTask, publishPhase } from '../src/game/checks/boot.ts'
import { waitFor } from '../src/game/checks/lobbyUnload.ts'
import type { TourDeps, TourGame } from '../src/game/uiTour.ts'

const CHECKS = new URL('../src/game/checks/', import.meta.url)

// The GPU client runs the page in an off-screen sandboxed iframe where requestAnimationFrame never fires:
// a check that awaited it per frame hung until the job timeout ('the page published no phase').
test('check ops never wait on requestAnimationFrame', () => {
  for (const file of readdirSync(CHECKS).filter(name => name.endsWith('.ts'))) {
    const code = readFileSync(new URL(file, CHECKS), 'utf8').replace(/\/\/.*$/gm, '')
    assert.ok(!/requestAnimationFrame\s*\(/.test(code), `${file} waits on requestAnimationFrame; use nextTask() from boot.ts`)
  }
})

test('nextTask resolves without a presentation frame', async () => {
  for (let i = 0; i < 600; i++) await nextTask()
})

test('publishPhase is a no-op without a window', () => {
  publishPhase('boot: frame 0')
})

// A round load waits on fetches, workers and pipeline compilation in real time; with one instant task per
// frame, 1800 counted loading frames ended before a SwiftShader load did ("screen 'vote' did not arrive
// within 1800 frames (on 'loading')"). Loading frames must not use up a screen's game-time budget.
function fakeGame(script: (steps: number) => string): { game: TourGame; current: () => string } {
  let steps = 0
  let screen = script(0)
  const game = { step: () => { screen = script(++steps) } } as unknown as TourGame
  return { game, current: () => screen }
}

test('lobbyUnload waitFor does not count loading frames against its budget', async () => {
  const { game, current } = fakeGame(steps => steps < 5000 ? 'loading' : 'vote')
  await waitFor(game, current, 'vote', () => {}, 1800)
  assert.equal(current(), 'vote')
})

test('lobbyUnload waitFor still fails a screen that never changes', async () => {
  const { game, current } = fakeGame(() => 'hub')
  await assert.rejects(waitFor(game, current, 'vote', () => {}, 1800), /did not arrive within 1800 frames \(on 'hub'\)/)
})

test('checkBoot does not count loading frames against BOOT_FRAMES', async () => {
  const { game, current } = fakeGame(steps => steps < BOOT_FRAMES * 4 ? 'loading' : 'start')
  const deps = { boot: async (onScreen: (change: { to: string }) => void) => {
    const step = game.step.bind(game)
    let last = ''
    const report = (): void => { if (current() !== last) onScreen({ to: last = current() }) }
    report()
    return { ...game, step: (dt: number) => { step(dt); report() }, dispose: () => {} }
  } } as unknown as TourDeps
  const { json } = await checkBoot(deps)
  assert.deepEqual(json, { ok: true, screen: 'start', transitions: ['loading', 'start'] })
})
