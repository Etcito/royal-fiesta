// Consumes existing compressed bake output. Never bakes, encodes, or reads credentials.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

interface Item { name: string; size: number; contentKey: string; status: 'pending' | 'uploaded' | 'failed' }
interface Journal { version: 1; files: Item[] }
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

export async function uploadAudio(opts: {
  dir: string; journal: string; command?: string; dryRun?: boolean; log?: (line: string) => void
}): Promise<{ total: number; uploaded: number; skipped: number; failed: number }> {
  const log = opts.log ?? console.log
  const dir = resolve(opts.dir)
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as {
    format: string; version: number; sounds: { files: string[] }[]
  }
  if (manifest.format !== 'royal-fiesta.audio' || manifest.version !== 1 || !Array.isArray(manifest.sounds)) throw new Error('expected baked audio manifest')
  const names = [...new Set(manifest.sounds.flatMap(sound => sound.files))].sort()
  for (const name of names) {
    if (!/\.(mp3|ogg)$/i.test(name) || !resolve(dir, name).startsWith(dir + sep)) throw new Error(`not compressed audio: ${name}`)
  }
  // Publish the manifest last, so its referenced media has been attempted first.
  names.push('manifest.json')
  let previous: Item[] = []
  try {
    const doc = JSON.parse(readFileSync(opts.journal, 'utf8')) as Journal
    if (doc.version !== 1 || !Array.isArray(doc.files)) throw new Error('invalid audio journal')
    previous = doc.files
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const files: Item[] = names.map(name => {
    const file = resolve(dir, name)
    const size = statSync(file).size
    if (!size) throw new Error(`empty audio file: ${name}`)
    const contentKey = createHash('sha256').update(readFileSync(file)).digest('hex')
    const done = previous.some(item => item.name === name && item.size === size && item.contentKey === contentKey && item.status === 'uploaded')
    return { name, size, contentKey, status: done ? 'uploaded' : 'pending' }
  })
  const save = (): void => {
    mkdirSync(dirname(resolve(opts.journal)), { recursive: true })
    const temp = `${opts.journal}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, files }, null, 2) + '\n')
    renameSync(temp, opts.journal)
  }
  const counts = { total: files.length, uploaded: 0, skipped: 0, failed: 0 }
  if (!opts.dryRun && (!opts.command?.includes('{file}') || !opts.command.includes('{name}'))) throw new Error('AUDIO_UPLOAD_CMD must contain {file} and {name} (unquoted; shell quoting is automatic)')
  if (!opts.dryRun) save()
  for (const item of files) {
    if (item.status === 'uploaded') { counts.skipped++; continue }
    log(`${opts.dryRun ? 'would upload' : 'upload'} ${item.name} ${item.size} bytes ${item.contentKey}`)
    if (opts.dryRun) continue
    // Do not publish a manifest while any media failed.
    if (item.name === 'manifest.json' && counts.failed) { item.status = 'failed'; counts.failed++; save(); continue }
    const command = opts.command!.replace(/\{(file|name)\}/g, (_, key: string) => quote(key === 'file' ? resolve(dir, item.name) : item.name))
    const ok = await new Promise<boolean>(resolveDone => {
      const child = spawn(command, { shell: true, stdio: 'inherit' })
      child.once('error', () => resolveDone(false))
      child.once('close', code => resolveDone(code === 0))
    })
    item.status = ok ? 'uploaded' : 'failed'
    if (ok) counts.uploaded++
    else counts.failed++
    save()
  }
  log(`audio:upload total=${counts.total} uploaded=${counts.uploaded} skipped=${counts.skipped} failed=${counts.failed} pending=${counts.total - counts.uploaded - counts.skipped - counts.failed}${opts.dryRun ? ' dry-run' : ''}`)
  return counts
}

export async function main(args: string[]): Promise<number> {
  let dir = 'apps/web/public/audio'
  let journal = 'out/audio-upload.json'
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true
    else if (args[i] === '--dir' && args[i + 1]) dir = args[++i]
    else if (args[i] === '--journal' && args[i + 1]) journal = args[++i]
    else throw new Error('usage: npm run audio:upload -- [--dry-run] [--dir <compressed-audio-dir>] [--journal <file>]')
  }
  const result = await uploadAudio({ dir, journal, dryRun, command: process.env.AUDIO_UPLOAD_CMD })
  return result.failed ? 1 : 0
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch (error) { console.error(`audio:upload: ${(error as Error).message}`); process.exitCode = 1 }
}
