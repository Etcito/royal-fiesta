// Build-time sidecars. SDF Modeler's saved sidecar always wins; never overwrite authored art.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { LOCAL_COSMETICS } from '../packages/game/src/flow/startScreen.ts'
import { repoRoot } from './bricks.ts'
export async function ensureCosmeticThumbnails(root = repoRoot(), captured?: string): Promise<number> {
  const missing = LOCAL_COSMETICS.filter(item => !existsSync(join(root, `assets/common/${item.id}.thumb.avif`)))
  if (!missing.length) { console.log('cosmetic thumbnails: 36 saved sidecars'); return 0 }
  const out = captured ?? join(root, 'out/cosmetic-thumbnails')
  if (!captured) {
    if (!process.env.NMC_GPU_CLIENT) throw new Error('Missing cosmetic sidecars: build requires NMC_GPU_CLIENT to render saved .mesh thumbnails on hardware')
    const run = spawnSync(process.execPath, ['--experimental-strip-types', 'tools/chromeCheck.ts', 'cosmeticThumbs', '--out', out], { cwd: root, stdio: 'inherit' })
    if (run.status !== 0) throw new Error('Cosmetic thumbnail GPU render failed')
  }
  for (const item of missing) {
    // chromeCheck/GPU client writes operation files below its output directory.
    const candidates = [join(out, `${item.id}.png`), join(out, 'files', `${item.id}.png`)]
    const source = candidates.find(existsSync)
    if (!source) throw new Error(`GPU output missing ${item.id}.png under ${out}`)
    const target = join(root, `assets/common/${item.id}.thumb.avif`)
    mkdirSync(join(root, 'assets/common'), { recursive: true })
    await sharp(readFileSync(source)).trim().resize(224, 224, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).extend({ top: 16, bottom: 16, left: 16, right: 16, background: { r: 0, g: 0, b: 0, alpha: 0 } }).avif({ quality: 85, effort: 6 }).toFile(target)
    const meta = await sharp(target).metadata()
    if (!meta.hasAlpha) throw new Error(`Thumbnail lost alpha: ${target}`)
  }
  console.log(`cosmetic thumbnails: generated ${missing.length} transparent 256×256 sidecars`)
  return missing.length
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const n = await ensureCosmeticThumbnails(repoRoot(), process.argv[2])
  // The initial bundle supplies the GPU op; rebuild only when new sidecars were generated.
  if (n && !process.argv[2]) {
    const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'runner', '--config', 'apps/web/anim-brick.vite.config.ts'], { cwd: repoRoot(), stdio: 'inherit' })
    if (build.status !== 0) throw new Error('Thumbnail bundle rebuild failed')
  }
}
