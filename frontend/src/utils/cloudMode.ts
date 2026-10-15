// Cloud mode: the shared SPA is running as the FrameOS Cloud fleet UI
// (cloud-frontend/ wrapper served from cloud.frameos.net/frames). The
// cloud manages interpreted-only frames over an outbound WebSocket — no
// SSH, no compiled deploys, no shell. See cloud/docs/cloud-frames.md
// ("Frontend: the fourth adapter") and docs/cloud-frames.md.
export function isCloudMode(): boolean {
  return typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.cloudMode === true
}

// The cloud serves the SPA's shell to signed-out visitors too — the public
// scene store at /store (and the scenes host's root). The shell says whether
// the visitor has a session (cloud_signed_in, injected by
// app/frames/[[...path]]/route.ts), so the store front can stay clear of
// every account-scoped call, which apiFetch would turn into a trip to /login.
export function cloudSignedIn(): boolean {
  return typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.cloud_signed_in === true
}

/** The signed-out cloud: only the public store is on offer. */
export function isCloudPublicStore(): boolean {
  return isCloudMode() && !cloudSignedIn()
}
