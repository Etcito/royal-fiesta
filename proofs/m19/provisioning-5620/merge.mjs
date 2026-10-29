// Appends the emote.cheer and emote.laugh clips, as saved by SDF Modeler's registered operations (asset_save_game), to the committed asset text.
// The SDF Modeler save re-lays the whole asset out (face_patch collider flag, bounds, layout), so only the new clip objects are
// taken from it, after asserting the rig and the thirteen earlier clips are identical to the committed ones; every other byte of the
// committed file is kept. `hash` is then recomputed as the SDF Modeler document-text hash that parseGameAsset accepts.
// usage (repo root): node --experimental-strip-types proofs/m19/provisioning-5620/merge.mjs <saved-asset.json> <committed-asset.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { parseGameAsset } from '../../../packages/game/src/gameAsset.ts'

const [savedPath, orig] = process.argv.slice(2)
const text = readFileSync(orig, 'utf8')
const o = JSON.parse(text), s = JSON.parse(readFileSync(savedPath, 'utf8'))
const find = (d) => Object.values(d.document.nodes).find((n) => n.id === 'penguin')
const oc = find(o).clips, sc = find(s).clips
for (let i = 0; i < oc.length; i++) if (JSON.stringify(oc[i]) !== JSON.stringify(sc[i])) throw new Error(`earlier clip ${oc[i].name} differs`)
if (JSON.stringify(find(o).rig) !== JSON.stringify(find(s).rig)) throw new Error('rig differs')
const add = sc.slice(oc.length)
if (add.map((c) => c.name).join() !== 'emote.cheer,emote.laugh') throw new Error(`expected exactly emote.cheer,emote.laugh, got ${add.map((c) => c.name)}`)
const fmt = (c) => '          {"format":"raa.clip","version":2,"name":' + JSON.stringify(c.name) + ',"rig":' + JSON.stringify(c.rig) + ',"lengthTicks":' + c.lengthTicks + ',"loop":' + c.loop + ',"rootMotion":' + JSON.stringify(c.rootMotion) + ',"tracks":[\n' +
  c.tracks.map((t) => '            {"bone":' + JSON.stringify(t.bone) + ',"channel":' + JSON.stringify(t.channel) + ',"keys":[\n' +
    t.keys.map((k) => '              ' + JSON.stringify(k)).join(',\n') + '\n            ]}').join(',\n') + '\n          ],"events":' + JSON.stringify(c.events) + '}'
const marker = '],"events":[]}\n        ],\n        "gameCollision": true'
const idx = text.lastIndexOf(marker)
if (idx < 0 || text.indexOf(marker) !== idx) throw new Error('insertion marker not unique')
const cut = idx + '],"events":[]}'.length
let out = text.slice(0, cut) + add.map((c) => ',\n' + fmt(c)).join('') + text.slice(cut)
const m = JSON.parse(out)
add.forEach((c, i) => { if (JSON.stringify(find(m).clips[oc.length + i]) !== JSON.stringify(c)) throw new Error('merged clip differs from the saved one') })
const setHash = (h) => out.replace(/"hash": "[0-9a-f]{64}"\s*\n\}\s*$/, `"hash": "${h}"\n}\n`)
const probe = JSON.parse(setHash('0'.repeat(64)))
let hash
try { await parseGameAsset(probe, orig); throw new Error('zero hash accepted') } catch (e) {
  hash = String(e.message ?? e).match(/nor of the SDF Modeler document text ([0-9a-f]{64})/)?.[1]
  if (!hash) throw e
}
out = setHash(hash)
await parseGameAsset(JSON.parse(out), orig)
writeFileSync(orig, out)
console.log(JSON.stringify({ added: add.map((c) => c.name), keys: add.map((c) => c.tracks.reduce((n, t) => n + t.keys.length, 0)), hash }))
