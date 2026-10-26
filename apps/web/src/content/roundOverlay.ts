// This backing stays readable while a synchronous GPU call blocks the canvas frame loop.
export function roundOverlay(): { show(label: string, done?: number, total?: number): void; hide(immediate?: boolean): void } {
  const root = document.querySelector<HTMLElement>('#round-loading')
  const label = root?.querySelector<HTMLElement>('[data-label]')
  const bar = root?.querySelector<HTMLProgressElement>('progress')
  let revision = 0
  return {
    show(text, done, total) {
      revision++
      if (root) root.hidden = false
      if (label) label.textContent = text
      if (bar) {
        if (total !== undefined && total > 0) { bar.max = total; bar.value = done ?? 0 }
        else bar.removeAttribute('value')
      }
    },
    hide(immediate = false) {
      if (immediate && root) root.hidden = true
      const ticket = ++revision
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (ticket === revision && root) root.hidden = true
      }))
    },
  }
}
