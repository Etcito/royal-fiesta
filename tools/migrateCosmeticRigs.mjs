// One-time migration. Run after building the sibling MAMA worktree: node tools/migrateCosmeticRigs.mjs
// Remaps saved mesh joints by bone name; geometry, weights, binding source IDs and document node IDs stay intact.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { installCorePlugins } from '../../MAMA/dist/plugins/index.js'
import { parseAssetFile, serializeAssetFile, documentHash } from '../../MAMA/dist/core/game/asset-file.js'
import { cosmeticRigReference } from '../../MAMA/dist/core/game/cosmetic.js'
import { resolveRigReferences } from '../../MAMA/dist/core/doc/rig-reference.js'
import { meshFileKey } from '../../MAMA/dist/core/game/mesh-file.js'
import { decodeMesh, encodeMesh } from '../apps/web/src/sdf/meshWire.ts'

export async function migrateCosmeticRigs(root = fileURLToPath(new URL('../assets/common/', import.meta.url))) {
  installCorePlugins()
  const body = parseAssetFile(readFileSync(resolve(root, 'penguin.body.asset.json'), 'utf8'))
  const changed = []
  for (const name of readdirSync(root).filter(n => /^costume\..*\.asset\.json$/.test(n)).sort()) {
    const path = resolve(root, name), file = parseAssetFile(readFileSync(path, 'utf8'))
    const group = Object.values(file.document.nodes).find(n => n.rig)
    if (!group || group.rigRef) continue
    const before = group.rig.bones.map(b => b.name)
    group.rigRef = cosmeticRigReference(body, group.rig)
    delete group.rig
    delete group.clips
    const resolved = resolveRigReferences(file.document, r => r.game === body.game && r.id === body.id ? body.document : null)
    const after = resolved.nodes[group.id].rig.bones.map(b => b.name)
    const mapping = before.map(name => {
      const at = after.indexOf(name)
      if (at < 0) throw new Error(`${file.id}: lost bone ${name}`)
      return at
    })
    file.hash = documentHash(file.document)
    // Transform no geometry: only joint palette indices change (the jester hat's own bones follow the base rig).
    const meshPath = path.replace(/\.asset\.json$/, '.mesh')
    const mesh = decodeMesh(new Uint8Array(readFileSync(meshPath)))
    for (const g of mesh.data.groups) for (const part of g.parts) if (part.skin) {
      for (let i = 0; i < part.skin.joints.length; i++) {
        const at = mapping[part.skin.joints[i]]
        if (at === undefined) throw new Error(`${file.id}: dangling mesh joint ${part.skin.joints[i]}`)
        part.skin.joints[i] = at
      }
    }
    mesh.hash = file.hash
    mesh.key = await meshFileKey({ ...file, document: resolved }, '', '', async b => createHash('sha256').update(b).digest('hex'))
    writeFileSync(path, serializeAssetFile(file))
    writeFileSync(meshPath, encodeMesh(mesh))
    changed.push(name)
  }
  return changed
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log((await migrateCosmeticRigs()).join('\n'))
}
