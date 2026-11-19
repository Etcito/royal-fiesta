import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Diagnostic } from '@etcito/game-engine-compile'
import { collectRfScripts, compileRfScripts, formatRfDiagnostic } from '../egeScripts.ts'

test('collects AssemblyScript files in byte order', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-scripts-'))
  try {
    for (const name of ['b/x.as.ts', 'a_b/q.as.ts', 'a/y.as.ts', 'a/z.ts']) {
      const file = join(root, 'scripts/ege', name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, name)
    }
    assert.deepEqual(collectRfScripts(root).map(file => file.name), ['a/y.as.ts', 'a_b/q.as.ts', 'b/x.as.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formats user, generated and SDK diagnostic paths', () => {
  const diagnostic: Diagnostic = { file: 'lib/vec.as.ts', line: 3, column: 5, endLine: 3, endColumn: 6, severity: 'error', code: 'EGE1001', message: 'm' }
  assert.equal(formatRfDiagnostic(diagnostic), 'scripts/ege/lib/vec.as.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'components.gen.ts' }), 'generated/components.gen.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'ege/query.ts' }), 'sdk/query.ts:3:5 EGE1001 m')
})

test('compiles an added override and retains its diagnostics', async () => {
  const result = await compileRfScripts({ overrides: [{ name: 'probe/bad.as.ts', text: 'let x: f32 = 0;' }] })
  assert.ok(result.files.includes('probe/bad.as.ts'))
  assert.ok(result.diagnostics.some(d => d.code === 'EGE1001' && d.file === 'probe/bad.as.ts' && d.line === 1))
})
