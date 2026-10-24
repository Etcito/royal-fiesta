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
