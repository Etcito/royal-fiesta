// The uaa host loads each ui/fonts.json font from the build's copy next to the page, never from the
// network: the GPU page has none.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fontEntries } from '../src/ui/uaaHost.ts'

const PAGE = 'https://gpu.example.test/pages/rev/game.html'

test('fontEntries maps every ui/fonts.json font to fonts/<sha256>.ttf beside the page', () => {
  const text = readFileSync(new URL('../../../ui/fonts.json', import.meta.url), 'utf8')
  const fonts = (JSON.parse(text) as { fonts: { family: string; weight: number; sha256: string }[] }).fonts
  assert.deepEqual(fontEntries(text, PAGE), fonts.map(f => ({
    family: f.family,
    weight: f.weight,
    url: `https://gpu.example.test/pages/rev/fonts/${f.sha256}.ttf`,
  })))
})

test('fontEntries refuses a font without a sha256', () => {
  const text = JSON.stringify({ fonts: [{ family: 'Fredoka', weight: 700, url: 'https://assets.etcito.com/x' }] })
  assert.throws(() => fontEntries(text, PAGE), /FONT_LOAD|sha256/)
})

// uaa refuses a glyph the font lacks, and the shipped Fredoka 700 is the reduced latin set: no arrows,
// triangles or ticks. Every source line outside comments, \u escapes above U+00FF decoded, keeps to Latin-1 and the
// common punctuation, in apps/web/src and in packages/game/src (menu labels).
const DRAWABLE = /^[\u0009 -~ -ÿ–—‘’“”…]*$/

test('UI source strings use only characters the shipped Fredoka 700 can draw', async () => {
  const { readdirSync } = await import('node:fs')
  const bad: string[] = []
  for (const dir of ['../src/', '../../../packages/game/src/']) {
    const root = new URL(dir, import.meta.url)
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue
      readFileSync(new URL(rel, root), 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '')
          .replace(/\\u(0[1-9a-fA-F]|[1-9a-fA-F][0-9a-fA-F])([0-9a-fA-F]{2})/g, (_, h: string, l: string) => String.fromCharCode(parseInt(h + l, 16)))
        if (!DRAWABLE.test(code)) bad.push(`${dir}${rel}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(bad, [])
})

test('every ui/screens.ui-doc.json text uses only characters the shipped Fredoka 700 can draw', () => {
  const doc = readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8')
  const bad: string[] = []
  JSON.parse(doc, (key, value: unknown) => {
    if (key === 'text' && typeof value === 'string' && !DRAWABLE.test(value)) bad.push(value)
    return value
  })
  assert.deepEqual(bad, [])
})
