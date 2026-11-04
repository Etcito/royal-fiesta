// Isolated GPU proof using committed meshes, the game animation driver and the production RAA port.
import { LOCAL_COSMETICS } from '@royal-fiesta/game/flow/startScreen'
import { nextTask, publishPhase } from '../game/checks/boot.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { createSdfPort } from './sdfPort.ts'
import { decodeMeshBytes } from './meshWire.ts'
import { assetSkin } from '../content/cosmeticSkin.ts'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import { WornMounts } from '@royal-fiesta/game/render/wornLook'
import type { MeshedAsset } from './mamaApi.ts'
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
    meshed.set(id, await decodeMeshBytes(new Uint8Array(await (await fetch(`./saved/${id}.mesh`)).arrayBuffer())))
  }
  if(input.vertexNormals)for(const value of meshed.values())for(const group of (value.data as any).groups)for(const part of group.parts)delete part.normalVolume
  const canvas = document.createElement('canvas'); canvas.width=480;canvas.height=480;document.body.append(canvas)
  const port = await createSdfPort({canvas,width:480,height:480,viewports:[{x:0,y:0,width:480,height:480}]},meshed)
  const body = assetSkin(meshed.get('penguin.body')!.data,docs.get('penguin.body'))!
  const bodyInstance=port.createInstance(port.registerSkinned('penguin.body',body),null)
  const owner=Object.values(docs.get('penguin.body').nodes).find((n:any)=>n.rig) as any
  const {bindings,smooth,...rig}=owner.rig
  const graph=await (await fetch('./penguin.animgraph.json')).text()
  const mounts=new WornMounts(port), files:{name:string;blob:Blob}[]=[],records:unknown[]=[]
  try {
    for (const id of manifest) {
      const skin=assetSkin(meshed.get(id)!.data,docs.get(id),body.rig)!
      if(!skin || !skin.parts.length)throw Error(id+': no skin')
      port.registerSkinned(id,skin)
      mounts.sync({colour:0,items:[{asset:{id} as PrimsAsset,mount:[0,0,0],tint:null}]})
      for (const [clip,mode] of [['walk',0],['dive-slide',2]] as const) {
        const driver=await AnimDriver.load(graph,JSON.stringify(rig),owner.clips.map((c:unknown)=>JSON.stringify(c)),{ik:false})
        const sheet=document.createElement('canvas');sheet.width=960;sheet.height=480
        const ctx=sheet.getContext('2d')!
        try {
          for(let tick=0;tick<=42;tick++) {
            driver.observeTick(tick,[{id:0,mode,grounded:mode===0,surface:'normal',vel:{x:4,y:0,z:0},emote:0}])
            if(tick!==18&&tick!==42)continue
            const pose=driver.pose(0)!.skin
            port.setPose(bodyInstance,pose);mounts.setPose(pose)
            port.setTransform(bodyInstance,[0,0,0],[0,0,0,1],[1,1,1]);mounts.draw([0,0,0],[0,0,0,1],[1,1,1])
            port.setCamera(0,{eye:[-3,1.5,5],target:[0,0.25,0],fovYDeg:42,near:0.1,far:100})
            // Drain async pipeline creation, then capture the production port's output.
            publishPhase(`${id} ${clip} tick ${tick}`)
            const readyAt=performance.now()+1000
            const deadline=performance.now()+30000
            for(let n=0;n<4 || pendingPipelines()>0 || performance.now()<readyAt;n++) {
              if(performance.now()>deadline)throw Error('Pipeline warmup timeout')
              port.setPose(bodyInstance,pose);mounts.setPose(pose)
              port.render();await nextTask()
            }
            // A WebGPU surface is presented at task end. Capture the fresh render in this task.
            port.setPose(bodyInstance,pose);mounts.setPose(pose);port.render()
            const png=await port.capture();if(!png)throw Error('No GPU capture')
            const bitmap=await createImageBitmap(new Blob([png as BlobPart],{type:'image/png'}))
            ctx.drawImage(bitmap,tick===18?0:480,0);bitmap.close()
          }
          const blob=await new Promise<Blob>(r=>sheet.toBlob(b=>r(b!),'image/png'))
          files.push({name:`${id}-${clip}.png`,blob})
          records.push({id,clip,frames:[18,42],skinned:skin.parts.length})
        } finally {driver.dispose()}
      }
    }
    return {json:{records,adapter:{vendor:info.vendor,architecture:info.architecture,description:info.description},inventory:port.inventory?.()},files}
  }finally{mounts.dispose();port.dispose();canvas.remove()}
}

async function cosmeticThumbs() {
  const items=LOCAL_COSMETICS.filter(item=>item.id!==item.asset)
  const meshed=new Map<string,MeshedAsset>(), bounds=new Map<string,{min:number[];max:number[]}>()
  for(const id of new Set(items.map(item=>item.asset))) {
    const file=await(await fetch(`./saved/${id}.asset.json`)).json();bounds.set(id,file.bounds)
    meshed.set(id,await decodeMeshBytes(new Uint8Array(await(await fetch(`./saved/${id}.mesh`)).arrayBuffer())))
  }
  // Sidecars use geometric normals, like the existing cosmetic thumbnail renderer.
  for(const value of meshed.values())for(const group of (value.data as any).groups)for(const part of group.parts)delete part.normalVolume
  const canvas=document.body.appendChild(document.createElement('canvas'));canvas.width=canvas.height=256
  const port=await createSdfPort({canvas,width:256,height:256,viewports:[{x:0,y:0,width:256,height:256}]},meshed)
  const engine=(port as any).engine
  const output=document.createElement('canvas');output.width=output.height=256
  const ctx=output.getContext('2d',{willReadFrequently:true})!,files:{name:string;blob:Blob}[]=[]
  try {
    port.setEnvironment(null)
    for(const pass of ['sky.background','fog','bloom','grading'])engine.setPassEnabled(pass,false)
    engine.setLight({direction:[-.4,-1,-.8],color:[1,1,1],intensity:3})
    engine.setAmbient({color:[.8,.85,1],intensity:.8})
    for(const item of items) {
      publishPhase(`variant ${item.id}`)
      const inst=port.createInstance(port.registerAsset(item.asset,{id:item.asset} as PrimsAsset),item.tint??null)
      const box=bounds.get(item.asset)!,center=box.min.map((v,i)=>(v+box.max[i])/2) as [number,number,number]
      const distance=Math.hypot(...box.max.map((v,i)=>v-box.min[i]))/2/Math.sin(32*Math.PI/360)*1.12
      port.setTransform(inst,[0,0,0],[0,0,0,1],[1,1,1])
      port.setCamera(0,{eye:[center[0]+distance*.18,center[1]+distance*.12,center[2]+distance],target:center,fovYDeg:32,near:.01,far:100})
      const pixels=async(white:boolean)=>{
        engine.setBackground(white?[1,1,1]:[0,0,0])
        const readyAt=performance.now()+200,deadline=performance.now()+30000
        for(let n=0;n<4||pendingPipelines()>0||performance.now()<readyAt;n++) {
          if(performance.now()>deadline)throw Error('Variant pipeline timeout')
          port.render();await nextTask()
        }
        port.render();const png=await port.capture();if(!png)throw Error('Missing variant capture')
        const bitmap=await createImageBitmap(new Blob([png as BlobPart],{type:'image/png'}))
        ctx.clearRect(0,0,256,256);ctx.drawImage(bitmap,0,0);bitmap.close()
        return ctx.getImageData(0,0,256,256)
      }
      const black=await pixels(false),white=await pixels(true)
      for(let i=0;i<black.data.length;i+=4) {
        const alpha=255-Math.max(white.data[i]-black.data[i],white.data[i+1]-black.data[i+1],white.data[i+2]-black.data[i+2])
        for(let c=0;c<3;c++)black.data[i+c]=alpha>0?Math.min(255,black.data[i+c]*255/alpha):0
        black.data[i+3]=alpha
      }
      let brightest=0
      for(let i=0;i<black.data.length;i+=4)if(black.data[i+3]>64)brightest=Math.max(brightest,black.data[i],black.data[i+1],black.data[i+2])
      if(brightest<32)throw Error(`Unlit variant: ${item.id}`)
      ctx.putImageData(black,0,0)
      files.push({name:`${item.id}.png`,blob:await new Promise<Blob>(resolve=>output.toBlob(b=>resolve(b!),'image/png'))})
      port.destroyInstance(inst)
    }
    return {json:{ok:files.length===24,items:files.map(f=>f.name)},files}
  }finally{port.dispose();canvas.remove()}
}
window.nmcGpu={ops:{skinProof,cosmeticThumbs}} as any
