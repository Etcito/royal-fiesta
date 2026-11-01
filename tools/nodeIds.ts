// The document node and material ids a costume shares with the body it mounts on. tools/renderViews.ts refuses them when it
// merges the costume into the penguin; the commit guard reports them with this same rule.

function keysOf(document: unknown, field: 'nodes' | 'materials'): string[] {
  if (typeof document !== 'object' || document === null) return []
  const map = (document as Record<string, unknown>)[field]
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return []
  return Object.keys(map)
}

function shared(costumeDocument: unknown, bodyDocument: unknown, field: 'nodes' | 'materials'): string[] {
  const bodyIds = new Set(keysOf(bodyDocument, field))
  return keysOf(costumeDocument, field).filter((id) => bodyIds.has(id))
}

export function sharedNodeIds(costumeDocument: unknown, bodyDocument: unknown): string[] {
  return shared(costumeDocument, bodyDocument, 'nodes')
}

export function sharedMaterialIds(costumeDocument: unknown, bodyDocument: unknown): string[] {
  return shared(costumeDocument, bodyDocument, 'materials')
}
