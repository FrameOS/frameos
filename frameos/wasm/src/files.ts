// Files between the preview and the computer: the page's half of Upload and
// Download in the Files scene (frameos/src/frameos/file_transfer_preview.nim,
// the worker's `fileRequest`).
//
// A file picker opens, and a download starts, only from a person's gesture.
// The tap on Upload happened on the canvas a moment ago, so the page still
// has it when the request arrives: `navigator.userActivation.isActive` says
// so, and the picker opens at once. A request that comes after the gesture
// ran out (a slow render in between), or in a browser that cannot say,
// waits for the page to ask the person with a button of its own
// (`onFileRequest`), whose click is the gesture.

/** What the Files scene asks of the page. */
export interface PreviewFileRequest {
  id: number
  /** 'upload': pick files from the computer; 'download': save one there. */
  op: 'upload' | 'download'
  /** The folder the files go into ('' its top), or the file to save. */
  name: string
}

/** One file picked, as the worker takes it. */
export interface PickedFile {
  name: string
  data: ArrayBuffer
}

/**
 * Whether the page may open a file picker now: a gesture is still in force.
 * False where the browser cannot say (no `navigator.userActivation`), so the
 * page asks with a button instead of a picker that would not open.
 */
export function pageHasGesture(): boolean {
  try {
    const activation = (globalThis.navigator as Navigator & { userActivation?: { isActive?: boolean } } | undefined)
      ?.userActivation
    return activation?.isActive === true
  } catch {
    return false
  }
}

/**
 * Open the browser's file picker (several files at once) and resolve with
 * the files read, or null when it was closed with none. Call it from a
 * gesture. A browser that never says the picker was closed (no `cancel`
 * event) leaves the promise waiting; the next request replaces it.
 */
export function pickFiles(doc: Document = document): Promise<PickedFile[] | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    let settled = false
    const settle = (files: PickedFile[] | null) => {
      if (!settled) {
        settled = true
        input.remove()
        resolve(files)
      }
    }
    input.addEventListener('change', () => {
      const chosen = Array.from(input.files ?? [])
      if (chosen.length === 0) {
        settle(null)
        return
      }
      void Promise.all(chosen.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })))
        .then((files) => settle(files))
        .catch(() => settle(null))
    })
    input.addEventListener('cancel', () => settle(null))
    doc.body.appendChild(input)
    input.click()
  })
}

/** Save `data` to the computer as `name` (a Blob and a link's download). */
export function saveFile(name: string, data: ArrayBuffer, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([data]))
  const link = doc.createElement('a')
  link.href = url
  link.download = name || 'file'
  link.style.display = 'none'
  doc.body.appendChild(link)
  link.click()
  link.remove()
  // After the browser took it: revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
