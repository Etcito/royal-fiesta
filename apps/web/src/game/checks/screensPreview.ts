// Isolated screen capture: real screen renderers and saved RAA meshes, no unrelated courses.
import { createUaaHost } from '../../ui/uaaHost.ts'
import { createSdfPort } from '../../sdf/sdfPort.ts'
import { decodeMesh } from '../../sdf/meshWire.ts'
import { mountStartScreen } from '../../screens/startScreen.ts'
import { mountShop } from '../../screens/shop.ts'
import { LOCAL_COSMETICS, startScreen } from '@royal-fiesta/game/flow/startScreen'
import { shopModel, shopTab, shopStep } from '@royal-fiesta/game/flow/shop'
import type { CatalogItem } from '@royal-fiesta/game/economy/contract'
import type { Vec3T } from '@royal-fiesta/game/render/port'
import type { TourDeps } from '../uiTour.ts'
import { nextTask } from './boot.ts'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import economyText from '../../../../../economy/royal-fiesta.economy.json?raw'
export const name = 'screensPreview'
export async function run(_input: unknown, deps: TourDeps) {
  const files: { name: string; blob: Blob }[] = []
  const meshes = new Map()
  const anchors = new Map<string, Record<string, { t: number[] }>>()
  const ids = ['penguin.body', ...LOCAL_COSMETICS.filter(c=>c.id===c.asset).map(c=>c.asset)]
  for (const id of ids) {
    const base = new URL(`content/assets/common/${id}`, document.baseURI).href
    meshes.set(id, decodeMesh(new Uint8Array(await (await fetch(base+'.mesh')).arrayBuffer())))
    anchors.set(id, (await (await fetch(base+'.asset.json')).json()).anchors)
  }
  const owned = LOCAL_COSMETICS.filter(c=>c.id===c.asset).map(c=>c.id)
  const catalog = (JSON.parse(economyText) as { catalog: { shop: { items: CatalogItem[] } } }).catalog.shop.items
  const originalW = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalH = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const root = document.createElement('div'); root.style.cssText='position:fixed;left:0;top:0'; document.body.append(root)
  try {
    for (const phone of [false,true]) {
      const width = phone ? 390 : 1280, height = phone ? 844 : 720
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
      root.style.width=width+'px'; root.style.height=height+'px'
      const stage = document.createElement('canvas'), ui = document.createElement('canvas')
      for (const c of [stage,ui]) { c.width=width;c.height=height;c.style.cssText=`position:absolute;inset:0;width:${width}px;height:${height}px`;root.append(c) }
      const host = await createUaaHost({ canvas:ui,width,height,dpr:1 })
      const port = await createSdfPort({ canvas:stage,width,height,viewports:[{x:0,y:0,width,height}] },meshes)
      const mounts = new Map<string, Vec3T>()
      for (const item of LOCAL_COSMETICS) {
        const costume = anchors.get(item.asset)!, key=Object.keys(costume)[0]
        const a=anchors.get('penguin.body')![key]?.t, b=costume[key].t
        if (a) mounts.set(item.id,a.map((v,i)=>v-b[i]) as unknown as Vec3T)
      }
      let start: ReturnType<typeof mountStartScreen> | undefined
      let shop: ReturnType<typeof mountShop> | undefined
      try {
        const model = startScreen(owned,LOCAL_COSMETICS,0,{colour:1,worn:{head:owned[0],body:owned[3],bottom:owned[6],special:owned[9]}})
        start = mountStartScreen(host,model,{cue(){}},{ port, character:{id:'penguin.body'} as never, costume:id=>({id:LOCAL_COSMETICS.find(c=>c.id===id)?.asset??id} as never), mounts, environment:{sky:'snow',post:'candy',sun:{dir:[-.4,-1,-.3],color:[1,1,1],intensity:3}} })
        let uiNow = performance.now()
        const settle = async () => {
          const end=Date.now()+120000
          for (let frame=0;frame<12 || pendingPipelines()>0;frame++) {
            if(Date.now()>end)throw new Error('Screen shaders timed out')
            port.render();host.frame(uiNow += 100)
            await nextTask()
          }
        }
        const capture = async (name:string) => {
          await settle();port.render();host.frame(uiNow += 100)
          const a=createImageBitmap(stage),b=createImageBitmap(ui)
          const out=document.createElement('canvas');out.width=width;out.height=height
          const ctx=out.getContext('2d')!;for(const shot of [a,b]){const bitmap=await shot;ctx.drawImage(bitmap,0,0);bitmap.close()}
          const blob=await new Promise<Blob|null>(resolve=>out.toBlob(resolve,'image/png'));if(!blob)throw new Error('Capture failed')
          files.push({name:(phone?'phone-':'')+name+'.png',blob})
        }
        await capture('start-carousels')
        start.setVisible(false)
        const initial=shopModel(catalog,{playerId:'preview',coins:500,tickets:20,owned,inboxUnread:0})
        shop=mountShop(host,initial,{cue(){}})
        for(let tab=0;tab<4;tab++){shop.update(shopTab(initial,tab),null);await capture('shop-'+['hat','outfit','extra','special'][tab])}
        const selected={...initial,zone:'grid' as const,focus:[0,1] as [number,number]}
        shop.update(shopStep(selected,'confirm').model,null);await capture('shop-confirm')
      } finally {shop?.unmount();start?.unmount();host.destroy();port.dispose();stage.remove();ui.remove()}
    }
  } finally {
    root.remove()
    if(originalW)Object.defineProperty(window,'innerWidth',originalW)
    if(originalH)Object.defineProperty(window,'innerHeight',originalH)
  }
  return {json:{ok:true,isolated:true,screenshots:files.map(f=>f.name),adapter:await deps.adapter()},files}
}
