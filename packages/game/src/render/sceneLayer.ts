// Retain a prepared scene on a shared renderer while another scene is visible.
import type { RenderPort } from './port.ts'

export class SceneLayer {
  readonly port: RenderPort
  private visible = true
  private readonly instances = new Map<number, boolean>()
  private environment: Readonly<Record<string, unknown>> | null = null

  private readonly target: RenderPort

  constructor(target: RenderPort) {
    this.target = target
    this.port = new Proxy(target, {
      get: (port, key) => {
        if (key === 'createInstance') return (...args: Parameters<RenderPort['createInstance']>) => {
          const id = port.createInstance(...args)
          this.instances.set(id, true)
          if (!this.visible) port.setVisible(id, false)
          return id
        }
        if (key === 'destroyInstance') return (id: number) => {
          this.instances.delete(id)
          port.destroyInstance(id)
        }
        if (key === 'setVisible') return (id: number, visible: boolean) => {
          this.instances.set(id, visible)
          port.setVisible(id, this.visible && visible)
        }
        if (key === 'setEnvironment') return (env: Readonly<Record<string, unknown>> | null) => {
          this.environment = env
          if (this.visible) port.setEnvironment(env)
        }
        const value = Reflect.get(port, key, port)
        return typeof value === 'function' ? value.bind(port) : value
      },
    })
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    for (const [id, shown] of this.instances) this.target.setVisible(id, visible && shown)
    if (visible) this.target.setEnvironment(this.environment)
  }
}
