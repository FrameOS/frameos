// Origin discipline for the embedded editor's postMessage protocol
// (EmbeddedEditor.tsx). Pure, so the rules are unit-tested without mounting
// the editor.

/**
 * Which origins may drive the editor over postMessage when it runs in an
 * iframe. Until 2026-09-07 any window that could get a reference to the frame
 * could `init` it with its own scenes or point `previewProxyUrl` anywhere,
 * and every reply went to `'*'`. Now the host names itself: the iframe URL
 * carries `?parentOrigin=https://host.example` (comma-separated for several),
 * and without that the document that framed us (`document.referrer`) is the
 * one host allowed. The direct mount (mount.tsx) talks to its own window and
 * is not affected.
 */
export function allowedParentOrigins(search: string, referrer: string): string[] {
  const fromQuery = new URLSearchParams(search)
    .getAll('parentOrigin')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      try {
        return new URL(value).origin
      } catch {
        return ''
      }
    })
    .filter((value) => value.length > 0)
  if (fromQuery.length > 0) {
    return fromQuery
  }
  try {
    return referrer ? [new URL(referrer).origin] : []
  } catch {
    return []
  }
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
