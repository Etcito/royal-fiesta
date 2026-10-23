// Content sources are provider files: a later milestone adds one by adding a file (1.4).
import type { ContentProvider, GameContent } from '@royal-fiesta/game/content'
import { refuse } from '@royal-fiesta/sim/refusal'

const MODULES = import.meta.glob<{ provider: ContentProvider }>('./providers/*.ts', { eager: true })

export function contentProviders(): ContentProvider[] {
  const providers: ContentProvider[] = []
  for (const path of Object.keys(MODULES).sort()) {
    const provider = MODULES[path].provider
    if (provider === undefined) refuse('content', path, 'the provider file exports no `provider`; export one')
    providers.push(provider)
  }
  // Highest priority first; ties keep file order.
  return providers.sort((a, b) => b.priority - a.priority)
}

export function pickContent(query: URLSearchParams): GameContent {
  const providers = contentProviders()
  if (providers.length === 0) refuse('content', 'apps/web/src/content/providers', 'no content provider; add a provider file')
  const id = query.get('content')
  if (id === null) return providers[0].create()
  const provider = providers.find(p => p.id === id)
  if (provider === undefined) {
    refuse('content', `?content=${id}`, `unknown content; available: ${providers.map(p => p.id).join(', ')}`)
  }
  return provider.create()
}
