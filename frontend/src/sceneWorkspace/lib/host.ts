// What the scene workspace (the store's editor · AI · preview page, also a
// self-hosted backend's scene page) needs from the control plane it runs on:
// where its routes are and how to call them. FrameOS Cloud's are the
// defaults; a backend's pages set theirs before they render
// (setSceneWorkspaceHost), with `fetch` adding the project prefix and the
// session the way the SPA's apiFetch does.

export interface SceneWorkspaceHost {
  /** fetch for this plane's API routes. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** POST: one turn of the AI chat (NDJSON events, docs/ai-chat.md). */
  aiChatUrl: string
  /** Resuming a turn whose stream dropped; null where the plane has none. */
  aiChatTurnsUrl: string | null
  /** GET `${aiChatsUrl}/${chatId}`: a saved conversation. */
  aiChatsUrl: string
  /** GET: the service keys ({group: {field: value}}); `?reveal=1` unmasks. */
  settingsUrl: string
  /** Where the browser preview sends the requests a scene makes that the
   * browser itself may not (CORS); null: none, they go direct. */
  previewProxyUrl: string | null
  /** Whether the preview sends every request through that proxy without
   * trying the browser first: a backend's frame proxy reaches what the frame
   * reaches, so nothing is gained by a direct try but a CORS error in the
   * console. The cloud's shared proxy is the fallback only. */
  previewProxyFirst: boolean
  /** The previewed frame's local network access (docs/lan-access.md), read
   * when the preview starts: `false` refuses private hosts in the frame's
   * words; undefined where there is no such switch to copy. */
  previewLanAccess: () => boolean | undefined
  /** What else every AI turn sends (a backend's frame scene: its frameId). */
  aiChatContext: () => Record<string, unknown>
  /** Where the owner chooses how often the preview asks before it reads the
   * saved keys (the cloud's Security page); null where it never asks. */
  savedKeysSettingsUrl: string | null
  /** Product analytics; a no-op where there are none. */
  track: (event: string, properties?: Record<string, unknown>) => void
}

const cloudHost: SceneWorkspaceHost = {
  fetch: (path, init) => fetch(path, init),
  aiChatUrl: '/api/ai/chat',
  aiChatTurnsUrl: '/api/ai/chat/turns',
  aiChatsUrl: '/api/ai/chats',
  settingsUrl: '/api/settings',
  previewProxyUrl: '/api/store/preview-proxy',
  previewProxyFirst: false,
  previewLanAccess: () => undefined,
  aiChatContext: () => ({}),
  savedKeysSettingsUrl: '/account/security#saved-keys',
  track: () => {},
}

let currentHost: SceneWorkspaceHost = cloudHost

export function sceneWorkspaceHost(): SceneWorkspaceHost {
  return currentHost
}

/** Overrides the cloud's defaults (every key not given keeps them). */
export function setSceneWorkspaceHost(host: Partial<SceneWorkspaceHost>): void {
  currentHost = { ...cloudHost, ...host }
}
