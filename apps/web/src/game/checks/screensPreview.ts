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
import { publishPhase } from './boot.ts'
import { assetSkin } from '../../content/cosmeticSkin.ts'
import penguinGraph from '../../../../../assets/common/penguin.animgraph.json?raw'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import season from '../../../../../courses/start-season1.course.json' with { type: 'json' }
import economyText from '../../../../../economy/royal-fiesta.economy.json?raw'
export const name = 'screensPreview'
export async function run(raw: unknown, deps: TourDeps) {
  const input = raw as { screen?: 'start' | 'shop'; sizes?: string[] } | null
  const files: { name: string; blob: Blob }[] = []
  const meshes = new Map()
  const skins = new Map()
  const anchors = new Map<string, Record<string, { t: number[] }>>()
  const ids = ['penguin.body', ...LOCAL_COSMETICS.filter(c=>c.id===c.asset).map(c=>c.asset), ...new Set(season.decor.map(d => d.asset))]
  for (const id of ids) {
    const base = new URL(`content/assets/${id.startsWith('candy.') ? 'candy' : 'common'}/${id}`, document.baseURI).href
    meshes.set(id, decodeMesh(new Uint8Array(await (await fetch(base+'.mesh')).arrayBuffer())))
    const asset = await (await fetch(base+'.asset.json')).json()
    anchors.set(id, asset.anchors)
    const skin = assetSkin(meshes.get(id).data, asset.document)
    if (skin) skins.set(id, skin)
  }
  const owned = LOCAL_COSMETICS.filter(c=>c.id===c.asset).map(c=>c.id)
  const catalog = (JSON.parse(economyText) as { catalog: { shop: { items: CatalogItem[] } } }).catalog.shop.items
  const originalW = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalH = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const root = document.createElement('div'); root.style.cssText='position:fixed;left:0;top:0'; document.body.append(root)
  try {
    for (const size of ['desktop','phone','landscape'].filter(size => !input?.sizes || input.sizes.includes(size))) {
      const phone = size === 'phone'
      const width = phone ? 390 : size === 'landscape' ? 844 : 1280, height = phone ? 844 : size === 'landscape' ? 390 : 720
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
      root.style.width=width+'px'; root.style.height=height+'px'
      const stage = document.createElement('canvas'), ui = document.createElement('canvas')
      for (const c of [stage,ui]) { c.width=width;c.height=height;c.style.cssText=`position:absolute;inset:0;width:${width}px;height:${height}px`;root.append(c) }
      const host = await createUaaHost({ canvas:ui,width,height,dpr:1 })
      const port = await createSdfPort({ canvas:stage,width,height,viewports:[{x:0,y:0,width,height}] },meshes)
      for (const [id, skin] of skins) port.registerSkinned?.(id, skin)
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
        start = mountStartScreen(host,model,{cue(){}},{ skinned: skins.has('penguin.body') ? {assetId:'penguin.body',skin:skins.get('penguin.body'),graph:penguinGraph} : undefined, wallet:{coins:500,tickets:20}, port, character:{id:'penguin.body'} as never, costume:id=>({id:LOCAL_COSMETICS.find(c=>c.id===id)?.asset??id} as never), mounts, environment:{sky:'day',post:'candy',sun:{dir:[-.4,-1,-.3],color:[1,1,1],intensity:3}} })
        const decor = season.decor.map(d => {
          const handle = port.registerAsset(d.asset, {id:d.asset} as never)
          const instance = port.createInstance(handle, null)
          port.setTransform(instance, d.t as unknown as Vec3T, d.r as unknown as [number,number,number,number], d.s as unknown as Vec3T)
          return instance
        })
        let uiNow = performance.now()
        const settle = async () => {
          const end=Date.now()+120000
          for (let frame=0;frame<12 || pendingPipelines()>0;frame++) {
            if(Date.now()>end)throw new Error('Screen shaders timed out')
            port.render();host.frame(uiNow += 100)
            await new Promise<void>(resolve => setTimeout(resolve, 30))
          }
        }
        const capture = async (name:string) => {
          await settle();port.render();host.frame(uiNow += 100)
          publishPhase('snapshot '+name+' stage')
          const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG failed')), 'image/png'))
          const stagePng = await png(stage)
          publishPhase('snapshot '+name+' ui')
          const uiPng = await png(ui)
          const a=createImageBitmap(stagePng),b=createImageBitmap(uiPng)
          const out=document.createElement('canvas');out.width=width;out.height=height
          const ctx=out.getContext('2d')!;for(const shot of [a,b]){const bitmap=await shot;ctx.drawImage(bitmap,0,0);bitmap.close()}
          const blob=await new Promise<Blob|null>(resolve=>out.toBlob(resolve,'image/png'));if(!blob)throw new Error('Capture failed')
          files.push({name:(size === 'desktop' ? '' : size+'-')+name+'.png',blob})
        }
        if (input?.screen !== 'shop') await capture('start-carousels')
        if (input?.screen === 'start') continue
        start.setVisible(false)
        for (const instance of decor) port.destroyInstance(instance)
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
