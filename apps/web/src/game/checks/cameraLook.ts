// Drive the production show route and input/frame/render wiring. Synthetic events cannot grant
// browser user activation: model only the pointer-lock API, retaining target selection and hit testing.
import type { TourDeps, TourGame } from '../uiTour.ts'
import { checkBoot, nextTask } from './boot.ts'
import { startMounted, waitFor } from './lobbyUnload.ts'
export const name = 'cameraLook'
function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
}
interface Sample { yaw: number; pitch: number; rendered: { eye: number[]; target: number[] } | null }
function sample(game: TourGame): Sample { return (game.inventory() as { camera: Sample }).camera }
function renderedYaw(s: Sample): number {
  if (!s.rendered) throw new Error('No rendered round camera')
  const { eye, target } = s.rendered
  return Math.atan2(target[0] - eye[0], target[2] - eye[2])
}
export async function run(_input: unknown, deps: TourDeps) {
  let screen = ''
  let game: TourGame | null = null
  const raf = window.requestAnimationFrame
  const cancelRaf = window.cancelAnimationFrame
  let rafId = 0
  const paints = new Map<number, FrameRequestCallback>()
  window.requestAnimationFrame = callback => { paints.set(++rafId, callback); return rafId }
  window.cancelAnimationFrame = id => { paints.delete(id) }
  const paint = () => { const batch = [...paints.values()]; paints.clear(); for (const callback of batch) callback(performance.now()) }
  const lockDescriptor = Object.getOwnPropertyDescriptor(document, 'pointerLockElement')
  const padDescriptor = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  let canvas: HTMLCanvasElement | null = null
  let requestDescriptor: PropertyDescriptor | undefined
  try {
    const result = await checkBoot({ ...deps, boot: async on => {
      const booted = await deps.boot(e => { screen = e.to; on(e) })
      const step = booted.step.bind(booted)
      booted.step = dt => { step(dt); paint() }
      return booted
    } })
    game = result.game
    if (!result.json.ok) throw new Error(JSON.stringify(result.json))
    const live = game
    const current = () => screen
    // The boot lands on the start screen, the root; five ArrowDowns reach its Play once its view mounted.
    await startMounted(live, current)
    await waitFor(live, current, 'hub', () => { for (let i=0;i<5;i++) press('ArrowDown'); press('Enter') })
    await waitFor(live, current, 'vote', () => press('Enter'), 1800)
    for (let i=0;i<8;i++) { live.step(1/60); await nextTask() }
    press('ArrowRight'); press('Enter')
    await waitFor(live, current, 'round', () => {}, 3600)
    for (let i=0;i<4;i++) { live.step(1/60); await nextTask() }
    canvas = live.views.querySelector<HTMLCanvasElement>('canvas[data-show]')
    if (!canvas) throw new Error('Missing show canvas')
    const box = canvas.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width/2, box.top + box.height/2)
    if (hit !== canvas) throw new Error(`Round click intercepted by ${hit?.tagName}#${hit?.id}`)
    let locked: Element | null = null
    let requested = false
    requestDescriptor = Object.getOwnPropertyDescriptor(canvas, 'requestPointerLock')
    Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value() { requested = true; locked = canvas; document.dispatchEvent(new Event('pointerlockchange')) } })
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked })
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    if (!requested) throw new Error('Production input did not request lock on the show canvas')
    const before = sample(live)
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 120, movementY: -30 }))
    live.step(1/60)
    const mouse = sample(live)
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [{ axes: [0,0,0.8,-0.5], buttons: Array.from({length: 17}, () => ({pressed: false})), index: 0, id: 'camera-check', connected: true }] })
    live.step(1/60)
    const stick = sample(live)
    const failures: string[] = []
    if (mouse.yaw === before.yaw || mouse.pitch === before.pitch) failures.push('Mouse did not turn orbit')
    if (stick.yaw === mouse.yaw || stick.pitch === mouse.pitch) failures.push('Right stick did not turn orbit')
    for (const s of [before, mouse, stick]) if (Math.abs(renderedYaw(s) - s.yaw) > 1e-6) failures.push('Rendered camera differs from input orbit')
    return { json: { ok: !failures.length, screen, pointerLock: 'simulated API; real target selection and mouse events', before, mouse, stick, failures }, files: [] }
  } catch (e) {
    return { json: { ok: false, screen, failures: [String(e)] }, files: [] }
  } finally {
    if (canvas) { if (requestDescriptor) Object.defineProperty(canvas, 'requestPointerLock', requestDescriptor); else Reflect.deleteProperty(canvas, 'requestPointerLock') }
    if (lockDescriptor) Object.defineProperty(document, 'pointerLockElement', lockDescriptor); else Reflect.deleteProperty(document, 'pointerLockElement')
    if (padDescriptor) Object.defineProperty(navigator, 'getGamepads', padDescriptor); else Reflect.deleteProperty(navigator, 'getGamepads')
    game?.dispose()
    window.requestAnimationFrame = raf
    window.cancelAnimationFrame = cancelRaf
  }
}
