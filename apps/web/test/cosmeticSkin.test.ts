import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import { restPoseSkin } from '@royal-fiesta/game/render/sceneView'
import { assetSkin } from '../src/content/cosmeticSkin.ts'
const rig = { name: 'penguin', bones: [{name:'root', parent:null, rest:{t:[0,0,0],r:[0,0,0,1],s:[1,1,1]}}] }
const skin = { joints: new Uint16Array(4), weights: new Float32Array([1,0,0,0]) }
const payload = { groups: [{group:'a',parts:[{name:'mesh',partId:'x',skin}]}, {group:'b',parts:[{name:'mesh',partId:'y',skin}]}] }
const document = {nodes:{root:{rig,asset:{cosmetic:{binding:'penguin'}}}}}
test('cosmetic loading retains skin streams and the port part names, rejects a different rest skeleton', () => {
  const result = assetSkin(payload, document, rig)!
  assert.deepEqual(result.parts.map(p=>p.name), ['mesh','b/y'])
  assert.equal(result.parts[0].skin, skin)
  assert.equal(result.rig, rig)
  assert.throws(()=>assetSkin(payload,document,{...rig,bones:[{...rig.bones[0],name:'other'}]}), /must match penguin/)
  assert.equal(assetSkin({groups:[]},document,rig),null)
})
test('the web provider registers cosmetic skins before presenting the port; wardrobe poses them with the body', () => {
  // Integration guards complement the running SceneView/port tests without importing Vite raw modules in Node.
  const provider = readFileSync(new URL('../src/content/providers/sdf.ts', import.meta.url),'utf8')
  assert.ok(provider.includes('assetSkin(meshed.data, document, loaded.skinned.skin.rig)'))
  assert.ok(provider.indexOf('if (skin) port.registerSkinned(id, skin)') < provider.indexOf('return port'))
})


test('every committed cosmetic loads normalized skin streams on the exact penguin skeleton', () => {
  const root = new URL('../../../',import.meta.url)
  const body=JSON.parse(readFileSync(new URL('assets/common/penguin.body.asset.json',root),'utf8'))
  const penguin=Object.values(body.document.nodes).find((n:any)=>n.rig) as any
  for(const id of readdirSync(new URL('assets/common/',root)).filter(n=>/^costume\..*\.asset\.json$/.test(n)).map(n=>n.replace(/\.asset\.json$/,''))) {
    const file=JSON.parse(readFileSync(new URL(`assets/common/${id}.asset.json`,root),'utf8'))
    const mesh=decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`,root))))
    assert.equal(mesh.hash,file.hash)
    const skin=assetSkin(mesh.data,file.document,penguin.rig)!
    assert.ok(skin && skin.parts.length>0)
    const matrices=restPoseSkin(penguin.rig,12)
    assert.equal(matrices.length,skin.rig.bones.length*16)
    for(const part of skin.parts) {
      assert.ok(part.skin!.joints.length>0)
      assert.equal(part.skin!.joints.length,part.skin!.weights.length)
      const {joints,weights}=part.skin!
      const bone = id.endsWith('-hat') || id.endsWith('-crown') ? 'head' : id.endsWith('sparkler-wand') ? 'tip.r' : null
      for(let v=0;v<weights.length;v+=4) {
        assert.ok(Math.abs(weights[v]+weights[v+1]+weights[v+2]+weights[v+3]-1)<1e-5,id)
        for(let k=0;k<4;k++)assert.ok(joints[v+k]<skin.rig.bones.length && Number.isFinite(weights[v+k]) && weights[v+k]>=0,id)
        if(bone) {assert.equal(weights[v],1,id);assert.equal(skin.rig.bones[joints[v]].name,bone,id)}
      }
    }
  }
})
