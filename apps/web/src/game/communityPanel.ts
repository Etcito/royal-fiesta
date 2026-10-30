// The title's "Community levels" list (docs/community-levels.md): a DOM button and panel next to the uaa menu, shown only
// when the page has a levels base URL. Choosing a level reloads the page with ?community=<id>.
import type { LevelListing } from '@royal-fiesta/game/levelPack'

export interface CommunityPanel { setVisible(on: boolean): void; dispose(): void }

export function mountCommunityPanel(button: HTMLButtonElement, panel: HTMLElement, api: { list(): Promise<LevelListing[]>; play(id: string): void }): CommunityPanel {
  const doc = panel.ownerDocument
  const render = async (): Promise<void> => {
    panel.replaceChildren()
    const title = doc.createElement('strong')
    title.textContent = 'Community levels'
    const close = doc.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.addEventListener('click', () => { panel.hidden = true })
    const list = doc.createElement('ul')
    const note = doc.createElement('p')
    note.textContent = 'Loading...'
    panel.append(title, note, list, close)
    try {
      const levels = await api.list()
      note.textContent = levels.length === 0 ? 'No community level yet.' : ''
      for (const level of levels) {
        const row = doc.createElement('li')
        const play = doc.createElement('button')
        play.type = 'button'
        play.textContent = 'Play'
        play.dataset.level = level.id
        play.addEventListener('click', () => api.play(level.id))
        const label = doc.createElement('span')
        label.textContent = `${level.title} by ${level.author} (${level.contentHash.slice(0, 8)})`
        row.append(play, label)
        list.append(row)
      }
    } catch (e) {
      note.textContent = `The list is not available: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const open = (): void => { panel.hidden = false; void render() }
  button.addEventListener('click', open)
  button.hidden = true
  panel.hidden = true
  return {
    setVisible(on) {
      button.hidden = !on
      if (!on) panel.hidden = true
    },
    dispose() {
      button.removeEventListener('click', open)
      button.hidden = true
      panel.hidden = true
    },
  }
}
