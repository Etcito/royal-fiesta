export class RefusalError extends Error {
  readonly area: string
  readonly path: string
  readonly reason: string

  constructor(area: string, path: string, reason: string) {
    super(`[${area}] ${path}: ${reason}`)
    this.name = 'RefusalError'
    this.area = area
    this.path = path
    this.reason = reason
  }
}

export function refuse(area: string, path: string, reason: string): never {
  throw new RefusalError(area, path, reason)
}

export function isRefusal(e: unknown): e is RefusalError {
  return e instanceof RefusalError
}
