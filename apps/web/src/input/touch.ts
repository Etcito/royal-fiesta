import type { RawControls } from '@royal-fiesta/game/client/inputMap'

const STICK_RADIUS = 60
const DEAD_ZONE = 0.15
const BUTTON_RADIUS = 34
type Action = 'jump' | 'dive' | 'grab'

export function mountTouchControls(root: HTMLElement): { readonly active: boolean; read(out: RawControls): void; dispose(): void } {
  const canvas = root.ownerDocument.createElement('canvas')
  canvas.className = 'rf-touch'
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    touchAction: 'none', pointerEvents: 'auto'
  })
  root.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  const view = root.ownerDocument.defaultView
  const pointers = new Map<number, 'stick' | Action>()
  const buttons: { action: Action; label: string; x: number; y: number; held: number }[] = [
    { action: 'jump', label: 'JUMP', x: 0, y: 0, held: 0 },
    { action: 'dive', label: 'DIVE', x: 0, y: 0, held: 0 },
    { action: 'grab', label: 'GRAB', x: 0, y: 0, held: 0 }
  ]
  let active = true
  let width = 0
  let height = 0
  let dpr = 1
  let stickPointer: number | null = null
  let offsetX = 0
  let offsetY = 0

  function draw(): void {
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    function circle(x: number, y: number, radius: number, fill: string): void {
      ctx!.beginPath()
      ctx!.arc(x, y, radius, 0, Math.PI * 2)
      ctx!.fillStyle = fill
      ctx!.fill()
      ctx!.strokeStyle = 'rgba(255, 255, 255, 0.65)'
      ctx!.lineWidth = 3
      ctx!.stroke()
    }
    circle(90, height - 90, STICK_RADIUS, 'rgba(20, 28, 45, 0.45)')
    circle(90 + offsetX, height - 90 + offsetY, 26, 'rgba(255, 255, 255, 0.65)')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const button of buttons) {
      circle(button.x, button.y, BUTTON_RADIUS, button.held > 0
        ? 'rgba(120, 165, 255, 0.9)' : 'rgba(35, 55, 90, 0.6)')
      ctx.fillStyle = 'white'
      ctx.font = button.action === 'jump' ? 'bold 16px sans-serif' : 'bold 14px sans-serif'
      ctx.fillText(button.label, button.x, button.y)
    }
  }

  function resize(): void {
    if (!active) return
    const rect = canvas.getBoundingClientRect()
    width = rect.width
    height = rect.height
    dpr = Math.min(view?.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    buttons[0].x = width - 70
    buttons[0].y = height - 70
    buttons[1].x = width - 152
    buttons[1].y = height - 70
    buttons[2].x = width - 70
    buttons[2].y = height - 152
    draw()
  }

  function moveStick(x: number, y: number): void {
    const dx = x - 90
    const dy = y - (height - 90)
    const scale = Math.max(1, Math.hypot(dx, dy) / STICK_RADIUS)
    offsetX = dx / scale
    offsetY = dy / scale
  }

  function down(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (stickPointer === null && Math.hypot(x - 90, y - (height - 90)) <= STICK_RADIUS * 1.5) {
      pointers.set(event.pointerId, 'stick')
      stickPointer = event.pointerId
      moveStick(x, y)
    } else {
      const button = buttons.find(b => Math.hypot(x - b.x, y - b.y) <= BUTTON_RADIUS)
      if (button === undefined) return
      pointers.set(event.pointerId, button.action)
      button.held++
    }
    event.preventDefault()
    canvas.setPointerCapture?.(event.pointerId)
    draw()
  }

  function move(event: PointerEvent): void {
    const owner = pointers.get(event.pointerId)
    if (owner === undefined) return
    event.preventDefault()
    if (owner === 'stick') {
      const rect = canvas.getBoundingClientRect()
      moveStick(event.clientX - rect.left, event.clientY - rect.top)
      draw()
    }
  }

  function releaseCapture(id: number): void {
    // A cancelled pointer may have already lost its browser capture.
    if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture?.(id)
  }

  function up(event: PointerEvent): void {
    const owner = pointers.get(event.pointerId)
    if (owner === undefined) return
    event.preventDefault()
    pointers.delete(event.pointerId)
    if (owner === 'stick') {
      stickPointer = null
      offsetX = offsetY = 0
    } else {
      buttons.find(b => b.action === owner)!.held--
    }
    releaseCapture(event.pointerId)
    draw()
  }

  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
  observer?.observe(root)
  if (observer === null) view?.addEventListener('resize', resize)
  resize()

  return {
    get active() { return active },
    read(out): void {
      out.left = out.right = out.forward = out.back = false
      const magnitude = Math.hypot(offsetX, offsetY) / STICK_RADIUS
      const scaled = Math.max(0, (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE))
      out.stickX = magnitude === 0 || scaled === 0 ? 0 : offsetX / (magnitude * STICK_RADIUS) * scaled
      out.stickY = magnitude === 0 || scaled === 0 ? 0 : -offsetY / (magnitude * STICK_RADIUS) * scaled
      out.jump = buttons[0].held > 0
      out.dive = buttons[1].held > 0
      out.grab = buttons[2].held > 0
    },
    dispose(): void {
      if (!active) return
      active = false
      observer?.disconnect()
      if (observer === null) view?.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      for (const id of pointers.keys()) releaseCapture(id)
      pointers.clear()
      stickPointer = null
      offsetX = offsetY = 0
      for (const button of buttons) button.held = 0
      canvas.remove()
    }
  }
}
