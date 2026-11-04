import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { uploadAudio } from '../audioUpload.ts'
import { checkUpload } from '../wavedash.ts'

test('uploads sequentially, journals failures, resumes and detects changed bytes; dry run writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-upload-'))
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'royal-fiesta.audio', version: 1, sounds: [{ files: ['a.mp3', 'b.ogg'] }] }))
    for (const name of ['a.mp3', 'b.ogg']) writeFileSync(join(dir, name), name)
    const journal = join(dir, 'journal.json')
    const log = (): void => {}
    await uploadAudio({ dir, journal, dryRun: true, log })
    assert.equal(existsSync(journal), false)
    const fake = join(dir, 'fake.cjs')
    writeFileSync(fake, `const fs = require('node:fs'); const [file, name] = process.argv.slice(2); const lock = ${JSON.stringify(join(dir, 'lock'))}; const log = ${JSON.stringify(join(dir, 'calls'))}; fs.writeFileSync(lock, '', {flag:'wx'}); fs.readFileSync(file); fs.appendFileSync(log, name+'\\n'); setTimeout(() => { fs.unlinkSync(lock); process.exit(name === 'b.ogg' && !fs.existsSync(${JSON.stringify(join(dir, 'retry'))}) ? 1 : 0) }, 30)`)
    const command = `"${process.execPath}" "${fake}" {file} {name}`
    assert.deepEqual(await uploadAudio({ dir, journal, command, log }), { total: 3, uploaded: 1, skipped: 0, failed: 2 })
    writeFileSync(join(dir, 'retry'), '')
    assert.deepEqual(await uploadAudio({ dir, journal, command, log }), { total: 3, uploaded: 2, skipped: 1, failed: 0 })
    assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'a.mp3\nb.ogg\nb.ogg\nmanifest.json\n')
    assert.deepEqual(await uploadAudio({ dir, journal, command, log }), { total: 3, uploaded: 0, skipped: 3, failed: 0 })
    writeFileSync(join(dir, 'a.mp3'), 'changed')
    assert.equal((await uploadAudio({ dir, journal, command, log })).uploaded, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('checkUpload with a CDN refuses packed audio and stale builds; without one it wants the packed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-check-'))
  try {
    const base = 'https://cdn.example.invalid/sounds'
    writeFileSync(join(dir, 'game.js'), `const base = ${JSON.stringify(base)}`)
    checkUpload(dir, base)
    assert.throws(() => checkUpload(dir, ''), /audio manifest is missing/)
    assert.throws(() => checkUpload(dir, 'ftp://x'), /VITE_RF_AUDIO_URL/)
    assert.throws(() => checkUpload(dir, base + '/other'), /absent/)
    writeFileSync(join(dir, 'hidden.ogg'), 'sound')
    assert.throws(() => checkUpload(dir, base), /separately/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
