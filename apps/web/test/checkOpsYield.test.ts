import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { nextTask, publishPhase } from '../src/game/checks/boot.ts'

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
