// Scrolling the settings page to one of its anchored sections.

export function settingsHeaderOffset(): number {
  if (typeof window === 'undefined') {
    return 0
  }

  return window.matchMedia?.('(max-width: 639px)').matches ? 96 : 104
}

// The element that scrolls the settings page. Self-hosted that is the
// window; on the cloud the page is boxed under the account header and the
// shell (.frameos-app-shell) scrolls instead, where window.scrollTo() is a
// silent no-op. Walk up from the section and take the first ancestor that
// actually overflows.
function settingsScrollContainer(section: HTMLElement): HTMLElement | null {
  let element: HTMLElement | null = section.parentElement
  while (element && element !== document.body) {
    const overflowY = window.getComputedStyle(element).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
      return element
    }
    element = element.parentElement
  }
  return null
}

export function scrollToSettingsSection(sectionId: string, attempt = 0): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  window.requestAnimationFrame(() => {
    const section = document.getElementById(sectionId)
    if (section) {
      const container = settingsScrollContainer(section)
      // Right after mount nothing overflows yet (the sections are still
      // filling in); scrolling then would land on top. Wait a little.
      const scrollable = container !== null || document.documentElement.scrollHeight > window.innerHeight
      if (!scrollable && attempt < 20) {
        window.setTimeout(() => scrollToSettingsSection(sectionId, attempt + 1), 100)
        return
      }
      if (container) {
        const top =
          section.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          settingsHeaderOffset()
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        return
      }
      const top = section.getBoundingClientRect().top + window.scrollY - settingsHeaderOffset()
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      return
    }

    if (attempt < 20) {
      window.setTimeout(() => scrollToSettingsSection(sectionId, attempt + 1), 100)
    }
  })
}
