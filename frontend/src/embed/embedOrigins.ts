// Origin discipline for the embedded editor's postMessage protocol
// (EmbeddedEditor.tsx). Pure, so the rules are unit-tested without mounting
// the editor.

/** The `<meta name>` in the editor's own page that lists the hosts allowed to frame and drive it. */
export const PARENT_ORIGINS_META = 'frameos-editor-parent-origins'

// A URL's origin, or '' for what is no http(s) URL (an opaque origin reads
// "null", which every sandboxed or file: document shares: never a host to
// trust).
function originOf(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : ''
  } catch {
    return ''
  }
}

// "https://a.example/page, https://b.example:8443" -> their origins, in
// order, once each.
function originsOf(values: string[]): string[] {
  const origins: string[] = []
  for (const value of values.flatMap((entry) => entry.split(/[\s,]+/))) {
    const origin = value ? originOf(value) : ''
    if (origin && !origins.includes(origin)) {
      origins.push(origin)
    }
  }
  return origins
}

/**
 * The hosts the editor trusts to frame it: its own origin, and the origins
 * its own page lists in `<meta name="frameos-editor-parent-origins"
 * content="https://a.example, https://b.example">` (written by whoever
 * serves the bundle: `FRAMEOS_EDITOR_PARENT_ORIGINS` at build time, or by
 * hand in the served index.html). Nothing the framing page says is in here.
 */
export function trustedParentOrigins(editorOrigin: string, listedByPage: string | null | undefined): string[] {
  return originsOf([editorOrigin, listedByPage ?? ''])
}

/**
 * Which origins may drive the editor over postMessage when it runs in an
 * iframe. Until 2026-09-07 any window that could get a reference to the frame
 * could `init` it with its own scenes or point `previewProxyUrl` anywhere,
 * and every reply went to `'*'`. Then the host named itself: the iframe URL
 * carries `?parentOrigin=https://host.example` (comma-separated for several),
 * and without that the document that framed us (`document.referrer`) was the
 * one host allowed. But both are the framing page's own word, so any page
 * that framed the editor could name itself. Now that word only picks among
 * the hosts the editor's own page trusts (`trustedParentOrigins`): an origin
 * that is not one of them is never allowed, and with nothing named (no
 * `parentOrigin`, no referrer) every trusted one is. The direct mount (mount.tsx) talks to its own window and
 * is not affected.
 */
export function allowedParentOrigins(search: string, referrer: string, trusted: string[]): string[] {
  const params = new URLSearchParams(search)
  if (params.has('parentOrigin')) {
    return originsOf(params.getAll('parentOrigin')).filter((origin) => trusted.includes(origin))
  }
  if (referrer) {
    const origin = originOf(referrer)
    return origin && trusted.includes(origin) ? [origin] : []
  }
  // No word at all (a host whose page sends no referrer): any trusted host.
  return [...trusted]
}

/** A postMessage `origin` value: the editor's own for the direct mount, the locked parent origin in an iframe. */
export function replyTargetOrigin(lockedParentOrigin: string | null): string {
  return lockedParentOrigin ?? window.location.origin
}

// The parent origin the iframe editor locked onto with its first accepted
// message, for components that post to the host on their own (the Preview
// panel's screenshot request). Null until locked, and in the direct mount.
let lockedParentOriginForReplies: string | null = null

export function setLockedParentOrigin(origin: string | null): void {
  lockedParentOriginForReplies = origin
}

/**
 * Where a message for the host goes, and what its answer must look like:
 * the locked parent origin in an iframe, the editor's own window otherwise.
 * Never `'*'` — a screenshot data URL would otherwise go to whoever framed
 * us, and an ack from any window would be believed.
 */
export function hostMessageTarget(): { target: Window; origin: string } {
  if (window.parent !== window) {
    return { target: window.parent, origin: replyTargetOrigin(lockedParentOriginForReplies) }
  }
  return { target: window, origin: window.location.origin }
}

/** Whether a message event is the host's reply to something posted via hostMessageTarget(). */
export function isHostReply(event: MessageEvent, expected: { target: Window; origin: string }): boolean {
  return event.source === expected.target && event.origin === expected.origin
}

/** `previewProxyUrl` must point back at the editor's own origin: it receives every URL scene code fetches. */
export function sameOriginPreviewProxyUrl(candidate: unknown, editorOrigin: string): string | undefined {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return undefined
  }
  try {
    const resolved = new URL(candidate, editorOrigin)
    return resolved.origin === editorOrigin ? candidate : undefined
  } catch {
    return undefined
  }
}
