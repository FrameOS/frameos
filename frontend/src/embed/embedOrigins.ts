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
