// Frame list ordering, null-safe by construction.
//
// The old comparator did `a.frame_host.localeCompare(...)` — fine on the
// backend, where every frame has a host, but cloud frames have no frame_host
// at all and a freshly enrolled one may not even have a name (nothing typed
// at flash time). One such frame white-screened the whole workspace the
// moment the fleet selectors sorted it. Every field here is optional and the
// opaque id (numeric on the backend, uuid on the cloud) breaks ties so the
// order stays stable.
//
// Import-free so the cloud app's node test suite can exercise it directly.

export interface FrameSortInput {
  frame_host?: string | null
  id: number | string
  name?: string | null
  ssh_user?: string | null
}

function frameSortLabel(frame: FrameSortInput): string {
  return (frame.frame_host || frame.name || '').trim()
}

export function compareFrames(a: FrameSortInput, b: FrameSortInput): number {
  return (
    frameSortLabel(a).localeCompare(frameSortLabel(b)) ||
    (a.ssh_user || '').localeCompare(b.ssh_user || '') ||
    String(a.id).localeCompare(String(b.id))
  )
}
