import { urls } from '../urls'

// The AI chat's links (docs/ai-chat.md "Links"). The assistant names a frame
// as [Kitchen](frameos://frame/<frame id>) and a scene on a frame as
// [Clock](frameos://frame/<frame id>/scene/<scene id>), with the ids its tools
// returned. It cannot know where the pages are (the cloud mounts the SPA at
// /frames, a backend may sit under an ingress path, the store's AI panel is
// on another host), so whoever shows the reply turns them into the page they
// stand for there. Ids are opaque: never parsed, only encoded into the path.
const CHAT_LINK = /^frameos:\/\/frame\/([^/?#\s]+)(?:\/scene\/([^/?#\s]+))?\/?$/i

export interface ChatLink {
  frameId: string
  sceneId: string | null
}

function decodeSegment(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment)
    return value.trim() ? value : null
  } catch {
    return null
  }
}

/** The frame (and scene) a chat link names, or null when `href` is not one. */
export function parseChatLink(href: string): ChatLink | null {
  const [, frameSegment, sceneSegment] = CHAT_LINK.exec(href.trim()) ?? []
  const frameId = frameSegment ? decodeSegment(frameSegment) : null
  const sceneId = sceneSegment ? decodeSegment(sceneSegment) : null
  if (!frameId || (sceneSegment !== undefined && !sceneId)) {
    return null
  }
  return { frameId, sceneId }
}

/** Where a chat link goes, given the path of a frame's page: the frame, or
 * the frame with the scene's drawer open (what the scene does there, with
 * Activate, Preview and the way into the editor). */
export function chatLinkPath(link: ChatLink, framePath: (frameId: string) => string): string {
  const path = framePath(encodeURIComponent(link.frameId))
  return link.sceneId ? `${path}?${new URLSearchParams({ drawer: 'scene', sceneId: link.sceneId }).toString()}` : path
}

/** The route in this SPA a chat link stands for, or null when `href` is not one. */
export function chatLinkRoute(href: string): string | null {
  const link = parseChatLink(href)
  return link ? chatLinkPath(link, (frameId) => urls.frame(frameId)) : null
}
