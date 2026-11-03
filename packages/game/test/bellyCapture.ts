// Isolated GPU proof using committed meshes, the game animation driver and the production RAA port.
import { CHAR, CharMode } from '@royal-fiesta/sim/character/constants'
import { nextTask, publishPhase } from '../../../apps/web/src/game/checks/boot.ts'
import { pendingPipelines } from '../../../apps/web/src/render/asyncPipelines.ts'
import { createSdfPort } from '../../../apps/web/src/sdf/sdfPort.ts'
import { decodeMesh } from '../../../apps/web/src/sdf/meshWire.ts'
import { assetSkin } from '../../../apps/web/src/content/cosmeticSkin.ts'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import { WornMounts } from '@royal-fiesta/game/render/wornLook'
import type { MeshedAsset } from '../../../apps/web/src/sdf/mamaApi.ts'
import type { PrimsAsset } from '@royal-fiesta/game/prims'

async function skinProof(input: {vertexNormals?: boolean; items?: string[]} = {}) {
  const adapter = await (navigator as Navigator & {gpu:{requestAdapter():Promise<{info:{vendor:string;architecture:string;description:string}}|null>}}).gpu.requestAdapter()
  if(!adapter)throw Error('No GPU adapter')
  const info = adapter.info
  if(/swiftshader|llvmpipe|lavapipe|software/i.test([info.vendor,info.architecture,info.description].join(' ')))throw Error('Hardware GPU required')
  let manifest = await (await fetch('./cosmetics.json')).json() as string[]
  if(input.items)manifest=manifest.filter(id=>input.items!.includes(id))
  const meshed = new Map<string, MeshedAsset>(), docs = new Map<string, any>()
  for (const id of ['penguin.body', ...manifest]) {
    const file = await (await fetch(`./saved/${id}.asset.json`)).json()
    docs.set(id, file.document)
    meshed.set(id, decodeMesh(new Uint8Array(await (await fetch(`./saved/${id}.mesh`)).arrayBuffer())))
  }
  if(input.vertexNormals)for(const value of meshed.values())for(const group of (value.data as any).groups)for(const part of group.parts)delete part.normalVolume
  const canvas = document.createElement('canvas'); canvas.width=320;canvas.height=280;document.body.append(canvas)
  const port = await createSdfPort({canvas,width:320,height:280,viewports:[{x:0,y:0,width:320,height:280}]},meshed)
  const body = assetSkin(meshed.get('penguin.body')!.data,docs.get('penguin.body'))!
  const bodyInstance=port.createInstance(port.registerSkinned('penguin.body',body),null)
  const owner=Object.values(docs.get('penguin.body').nodes).find((n:any)=>n.rig) as any
  const {bindings,smooth,...rig}=owner.rig
  const graph=await (await fetch('./penguin.animgraph.json')).text()
  const mounts=new WornMounts(port), files:{name:string;blob:Blob}[]=[],records:unknown[]=[]
  try {
    for (const id of ['plain', ...manifest]) {
      if (id !== 'plain') {
        const skin=assetSkin(meshed.get(id)!.data,docs.get(id),body.rig)!
        port.registerSkinned(id,skin)
      }
      mounts.sync({colour:0,items:id === 'plain' ? [] : [{asset:{id} as PrimsAsset,mount:[0,0,0],tint:null}]})
      for (const sequence of id === 'plain' ? ['stroke','transition','bank'] : ['stroke']) {
        const driver=await AnimDriver.load(graph,JSON.stringify(rig),owner.clips.map((c:unknown)=>JSON.stringify(c)),{ik:false})
        const sheet=document.createElement('canvas');sheet.width=2560;sheet.height=840
        const ctx=sheet.getContext('2d')!
        const frames = sequence === 'stroke' ? [0,2,4,6,8,10,13,18] : sequence === 'transition' ? [0,4,8,12,18,24,30,36] : [0,4,8,12,16,20,24,31]
        const views = [{eye:[4,0.8,0],target:[0,-0.1,0]}, {eye:[0,1.6,-4],target:[0,-0.1,0]}, {eye:[2.3,2.8,-3.5],target:[0,-0.1,0]}] as const
        try {
          for(let tick=0;tick<=60;tick++) {
            const t=tick-24
            const mode=sequence === 'transition' ? (t<4?CharMode.dive:t<20?CharMode.slide:CharMode.ground) : CharMode.slide
            const angle=sequence === 'bank' ? Math.max(0,t)*0.065 : 0
            const timer=sequence === 'stroke' && t>=0 ? Math.max(0, CHAR.slide.strokeCooldownTicks-t) : 0
            driver.observeTick(tick,[{id:0,mode,strokeTimer:timer,grounded:mode!==CharMode.dive,surface:'ice',vel:{x:Math.sin(angle)*5,y:0,z:Math.cos(angle)*5},emote:0}])
            const frame=frames.indexOf(t);if(frame<0)continue
            const pose=driver.pose(0)!.skin
            port.setPose(bodyInstance,pose);mounts.setPose(pose)
            port.setTransform(bodyInstance,[0,0,0],[0,0,0,1],[1,1,1]);mounts.draw([0,0,0],[0,0,0,1],[1,1,1])
            for(let view=0;view<views.length;view++) {
              port.setCamera(0,{eye:[...views[view].eye],target:[...views[view].target],fovYDeg:42,near:0.1,far:100})
              publishPhase(`${id} ${sequence} ${frame} ${view}`)
              const readyAt=performance.now()+(frame===0?250:0),deadline=performance.now()+30000
              for(let n=0;n<3 || pendingPipelines()>0 || performance.now()<readyAt;n++) {
                if(performance.now()>deadline)throw Error('Pipeline warmup timeout')
                port.setPose(bodyInstance,pose);mounts.setPose(pose);port.render();await nextTask()
              }
              port.setPose(bodyInstance,pose);mounts.setPose(pose);port.render()
              const png=await port.capture();if(!png)throw Error('No GPU capture')
              const bitmap=await createImageBitmap(new Blob([png as BlobPart],{type:'image/png'}))
              ctx.drawImage(bitmap,frame*320,view*280);bitmap.close()
              ctx.fillStyle='#fff';ctx.font='14px sans-serif';ctx.fillText(`${['side','rear','game'][view]} ${sequence} t=${t}`,frame*320+8,view*280+22)
            }
          }
          const blob=await new Promise<Blob>(r=>sheet.toBlob(b=>r(b!),'image/png'))
          files.push({name:`${id}-${sequence}.png`,blob});records.push({id,sequence,frames})
        } finally {driver.dispose()}
      }
    }
    return {json:{records,adapter:{vendor:info.vendor,architecture:info.architecture,description:info.description},inventory:port.inventory?.()},files}
  }finally{mounts.dispose();port.dispose();canvas.remove()}
}

window.nmcGpu={ops:{skinProof}} as any
