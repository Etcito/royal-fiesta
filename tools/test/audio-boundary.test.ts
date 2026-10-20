import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { repoRoot } from '../bricks.ts'

// Only the game's audio context module may create Web Audio objects. Everything else reaches
// sound through GameAudio, so the sim and the apps never depend on a browser audio stack.
const ALLOWED = 'packages/game/src/audio/context.ts'
const FORBIDDEN = [/AudioContext/, /new Audio\(/]

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') walk(path, out)
    } else if (/\.(ts|tsx|js|html)$/.test(name)) {
      out.push(path)
    }
  }
}

function sources(root: string): string[] {
  const files: string[] = []
  for (const area of ['packages', 'apps']) {
    for (const pkg of readdirSync(join(root, area))) {
      for (const sub of ['src', 'proofs', '']) {
        const dir = join(root, area, pkg, sub)
        if (sub === '') {
          // The HTML pages at the app root (inline scripts count as sources).
          for (const name of readdirSync(dir)) if (name.endsWith('.html')) files.push(join(dir, name))
        } else if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
          walk(dir, files)
        }
      }
    }
  }
  return files
}

test('only packages/game/src/audio/context.ts touches the Web Audio API', () => {
  const root = repoRoot()
  const offenders: string[] = []
  let scanned = 0
  for (const file of sources(root)) {
    const rel = relative(root, file).split(sep).join('/')
    if (rel === ALLOWED) continue
    scanned++
    const text = readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) offenders.push(`${rel}: ${pattern.source}`)
    }
  }
  assert.ok(scanned > 20, `only ${scanned} sources scanned`)
  assert.deepEqual(offenders, [], `Web Audio outside ${ALLOWED}; route the sound through GameAudio`)
  assert.match(readFileSync(join(root, ALLOWED), 'utf8'), /new AudioContext\(\)/)
})
