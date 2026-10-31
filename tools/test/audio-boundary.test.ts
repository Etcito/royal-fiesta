import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { repoRoot } from '../bricks.ts'

// Only the game's audio context module may create Web Audio objects. Everything else reaches
// sound through GameAudio, so the sim and the apps never depend on a browser audio stack.
const ALLOWED = 'packages/game/src/audio/context.ts'
// The legacy HAA v0.1 pack (docs/audio.md §4: M2 deletes pack/) still value-imports @etcito/haa.
// Until that lands it is the one exception to the value-import rule; naming a type such as
// BaseAudioContext is fine, creating a context is not.
const LEGACY_PACK = 'packages/game/src/audio/pack/'
// Creating a Web Audio context is the forbidden act. `new AudioContext(` and
// `new OfflineAudioContext(` both count; merely naming the type `BaseAudioContext` does not.
const CONTEXT_CREATION = [/new\s+(Offline)?AudioContext\s*\(/, /new Audio\(/]
// A value import of the HAA engine. `import type` stays allowed: the sound family modules need
// BankEntry and Arrangement types from @etcito/haa-spatial/*. This also catches the
// @etcito/haa-spatial subpaths because the pattern has no closing quote.
const HAA_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*from\s+['"]@etcito\/haa/m

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
    for (const pattern of CONTEXT_CREATION) {
      if (pattern.test(text)) offenders.push(`${rel}: creates a Web Audio context (${pattern.source})`)
    }
    if (rel.startsWith('packages/game/src') && !rel.startsWith(LEGACY_PACK) && HAA_VALUE_IMPORT.test(text)) {
      offenders.push(`${rel}: value-imports @etcito/haa (only \`import type\` is allowed outside ${ALLOWED})`)
    }
  }
  assert.ok(scanned > 20, `only ${scanned} sources scanned`)
  assert.deepEqual(
    offenders,
    [],
    `audio boundary rules broken outside ${ALLOWED} (no context creation; no haa value imports):\n${offenders.join('\n')}`,
  )
  assert.match(readFileSync(join(root, ALLOWED), 'utf8'), /new AudioContext\(\)/)
})
