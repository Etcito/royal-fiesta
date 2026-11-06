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
        // Scene preparation (SdfRenderPort, read by render/pipelineGate) is scoped to this layer's instances, so a
        // selected scene prepares and reports its own parts while hidden behind the visible one.
        if (key === 'warmableAssets' || key === 'fallbackParts' || key === 'warmPipelines') {
          const scoped = Reflect.get(port, key, port) as unknown
          if (typeof scoped !== 'function') return scoped
          if (key === 'warmPipelines') return (assetIds?: readonly string[]) => scoped.call(port, assetIds, this.scene())
          return () => scoped.call(port, this.scene())
        }
        const value = Reflect.get(port, key, port)
        return typeof value === 'function' ? value.bind(port) : value
      },
    })
  }

  /** The instances this layer shows when visible: the scene its preparation covers, hidden or not. */
  private scene(): number[] {
    return [...this.instances].flatMap(([id, shown]) => shown ? [id] : [])
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    for (const [id, shown] of this.instances) this.target.setVisible(id, visible && shown)
    if (visible) this.target.setEnvironment(this.environment)
  }
}
