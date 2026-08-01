// The editor's modals and tooltips portal into #modal / #popper (the iframe
// bundle's index.html ships them as static divs). Host pages rendering
// EmbeddedSceneEditor directly don't have them — create them on demand.
// Idempotent; the (empty, absolutely-positioned) divs are left in place on
// unmount. The z-indexes sit above a typical full-screen host modal.
export function ensurePortalRoots(): void {
  if (typeof document === 'undefined') {
    return
  }
  for (const [id, zIndex] of [
    ['modal', '60'],
    ['popper', '90'],
  ] as const) {
    if (!document.getElementById(id)) {
      const element = document.createElement('div')
      element.id = id
      element.style.position = 'absolute'
      element.style.zIndex = zIndex
      document.body.appendChild(element)
    }
  }
}
