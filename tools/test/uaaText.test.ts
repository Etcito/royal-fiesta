import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fixUaaTextShader } from '../uaaText.ts'

const source = readFileSync(new URL(import.meta.resolve('@etcito/uaa/webgpu')), 'utf8')

test('the installed uaa shader is patched once, before compilation', () => {
  const fixed = fixUaaTextShader(source)
  assert.notEqual(fixed, source)
  assert.equal(fixUaaTextShader(fixed), fixed)
  assert.throws(() => fixUaaTextShader('changed upstream shader'), /review the MSDF/)
})

test('saturated empty atlas texels have no outline veil on light or dark backgrounds', () => {
  const fixed = fixUaaTextShader(source)
  const expression = /let w = ([^;]+);/.exec(fixed.slice(fixed.indexOf('fn fs_text')))![1]
  const width = new Function('t', 'pr', 'range', 'min', 'max', `return ${expression}`) as
    (t: { xfT: { z: number } }, pr: number, range: number, min: typeof Math.min, max: typeof Math.max) => number
  for (const pr of [1, 2]) for (const range of [2, 5.5, 10.6667, 20]) for (const outline of [2, 4, 6, 12]) {
    const w = width({ xfT: { z: outline } }, pr, range, Math.min, Math.max)
    const alpha = Math.max(0, Math.min(1, 0.5 - (range / 2 - w)))
    assert.equal(alpha, 0, `range ${range}, outline ${outline}, dpr ${pr}`)
    for (const background of [[1, 1, 1], [0.08, 0.03, 0.15]]) for (const color of [[1, 0, 0.5], [0.48, 0.12, 0.55]]) {
      assert.deepEqual(color.map((c, i): number => c * alpha + background[i] * (1 - alpha)), background)
    }
  }
  assert.equal(Math.max(0, Math.min(1, 0.5 - (5 - 5))), 0.5, 'the old clamp leaves half-opacity outside the glyph')
})
