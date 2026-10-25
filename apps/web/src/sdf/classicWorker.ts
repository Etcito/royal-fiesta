// An opaque-origin page can start classic blob workers, but not blob module workers.
export function workerBootstrap(moduleHref: string): string {
  return `
const pending = []
const enqueue = event => pending.push(event)
self.onmessage = enqueue
import(${JSON.stringify(moduleHref)}).then(() => {
  const receive = self.onmessage
  if (typeof receive !== 'function' || receive === enqueue) {
    throw new Error('MAMA worker module did not install its message handler')
  }
  for (const event of pending) receive.call(self, event)
  pending.length = 0
}).catch(error => {
  setTimeout(() => { throw error }, 0)
})
`
}

export function classicWorker(moduleHref: string): Worker {
  const url = URL.createObjectURL(new Blob([workerBootstrap(moduleHref)], { type: 'text/javascript' }))
  const release = (): void => URL.revokeObjectURL(url)
  try {
    const worker = new Worker(url)
    // Keep the blob alive until it loads, including when a pool closes during startup.
    worker.addEventListener('message', release, { once: true })
    worker.addEventListener('error', release, { once: true })
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => { release(); terminate() }
    return worker
  } catch (error) {
    release()
    throw error
  }
}
