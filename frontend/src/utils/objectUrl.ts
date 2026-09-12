/**
 * Every object URL the frontend mints is created and revoked here. A blob URL
 * pins its blob in memory until it is revoked (or the document goes away), and
 * the code base had grown three conventions for that: revoke right after the
 * download click, revoke on a 60 s timer, or never revoke at all. Pick the
 * helper that matches how long the URL is needed:
 *
 * - `downloadBlob` / `downloadJson`: a save-as click; the URL is revoked as
 *   soon as the click has been dispatched (the browser holds its own
 *   reference to the blob for the download by then).
 * - `withObjectUrl`: the URL is needed for one async step (decoding into an
 *   `Image`, say) and is revoked when that step settles.
 * - `useObjectUrl`: a React component renders the blob (an `<img src>`); the
 *   URL lives as long as the blob is mounted and is revoked on cleanup.
 * - `openBlobInNewTab`: a window the caller opened synchronously (popup
 *   blockers) is pointed at the blob; the URL is revoked once that window has
 *   loaded it, with a timer as the fallback for windows that never report.
 */
import { useEffect, useState } from 'react'

/** Trigger a save-as of `blob` under `fileName`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(url)
  }
}

/** Trigger a save-as of `value` pretty-printed as JSON. */
export function downloadJson(value: unknown, fileName: string): void {
  downloadBlob(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }), fileName)
}

/** Run `use` with a URL for `blob`; the URL is revoked once `use` settles. */
export async function withObjectUrl<T>(blob: Blob, use: (url: string) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob)
  try {
    return await use(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A URL for `blob` for as long as it is the blob being rendered; null while there is none. */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => {
      URL.revokeObjectURL(objectUrl)
    }
  }, [blob])
  return blob ? url : null
}

/** Fallback for windows that never fire `load` for the blob (a closed popup). */
export const OPEN_IN_NEW_TAB_REVOKE_FALLBACK_MS = 60_000

/**
 * Point `win` (opened synchronously by the caller, so popup blockers see a
 * user gesture) at `blob`. A null `win` means the popup was blocked: nothing
 * is minted.
 */
export function openBlobInNewTab(blob: Blob, win: Window | null): void {
  if (!win) {
    return
  }
  const url = URL.createObjectURL(blob)
  let revoked = false
  const revoke = (): void => {
    if (!revoked) {
      revoked = true
      URL.revokeObjectURL(url)
    }
  }
  try {
    win.addEventListener('load', revoke)
  } catch {
    // A cross-origin or already-navigated window: the fallback timer covers it.
  }
  window.setTimeout(revoke, OPEN_IN_NEW_TAB_REVOKE_FALLBACK_MS)
  win.location.href = url
}
