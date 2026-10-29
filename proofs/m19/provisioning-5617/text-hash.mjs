import { readFileSync, writeFileSync } from 'node:fs'
const { parseGameAsset } = await import('/root/nmc/worktrees/78/5617/packages/game/src/gameAsset.ts')
const wrong = '0'.repeat(64)
async function textHash(p) {
  const j = JSON.parse(readFileSync(p, 'utf8'))
  try { await parseGameAsset(j, p); return { stored: j.hash, ok: true } } catch {}
  j.hash = wrong
  try { await parseGameAsset(j, p) } catch (e) { const m = String(e.message ?? e).match(/nor of the SDF Modeler document text ([0-9a-f]{64})/); return { stored: JSON.parse(readFileSync(p, 'utf8')).hash, text: m?.[1], raw: m ? undefined : String(e.message).slice(0, 300) } }
}
for (const p of process.argv.slice(2)) console.log(p, await textHash(p))
