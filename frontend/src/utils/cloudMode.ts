// Cloud mode: the shared SPA is running as the FrameOS Cloud fleet UI
// (cloud-frontend/ wrapper served from cloud.frameos.net/frames). The
// cloud manages interpreted-only frames over an outbound WebSocket — no
// SSH, no compiled deploys, no shell. See cloud/docs/cloud-frames.md
// ("Frontend: the fourth adapter") and docs/cloud-frames.md.
export function isCloudMode(): boolean {
  return typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.cloudMode === true
}
