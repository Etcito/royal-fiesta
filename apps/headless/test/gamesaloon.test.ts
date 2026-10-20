import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brickDir } from '../../../tools/bricks.ts'
import { helloHandshake, startGameSaloon } from '../src/gamesaloon.ts'

let dir: string | null = null
try { dir = brickDir('gamesaloon-public') } catch {}

test('local GameSaloon answers the hello-client handshake', { skip: dir === null ? 'gamesaloon-public not found: clone it next to this repo or set GAMESALOON_DIR' : false }, async () => {
  const server = await startGameSaloon()
  try {
    assert.match(await helloHandshake(server), /^OK: created room [A-Z0-9]+/)
  } finally {
    await server.stop()
  }
})
