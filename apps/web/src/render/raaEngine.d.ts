// RAA has no documented v0 web entry yet, so every member is loose and optional.
declare module '@raa/engine' {
  export const RAA_ABSENT: boolean | undefined
  export const RAA_API_VERSION: string | null | undefined
  export const createEngine: ((...args: unknown[]) => unknown) | undefined
  export const loadMeshFromPrims: ((...args: unknown[]) => unknown) | undefined
  export const setInstanceColor: ((...args: unknown[]) => unknown) | undefined
  export const setCamera: ((...args: unknown[]) => unknown) | undefined
  export const setViewport: ((...args: unknown[]) => unknown) | undefined
  export const renderFrame: ((...args: unknown[]) => unknown) | undefined
  export const readback: ((...args: unknown[]) => unknown) | undefined
}
