// The document node ids a costume shares with the body it mounts on. tools/renderViews.ts refuses them when it
// merges the costume into the penguin; the commit guard reports them with this same rule.

function nodeKeys(document: unknown): string[] {
  if (typeof document !== 'object' || document === null) return []
  const nodes = (document as Record<string, unknown>).nodes
  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) return []
  return Object.keys(nodes)
}

export function sharedNodeIds(costumeDocument: unknown, bodyDocument: unknown): string[] {
  const bodyIds = new Set(nodeKeys(bodyDocument))
  return nodeKeys(costumeDocument).filter((id) => bodyIds.has(id))
}
