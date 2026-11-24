// Files between the preview and the computer: the page's half of Upload and
// Download in the Files scene (frameos/src/frameos/file_transfer_preview.nim,
// the worker's `fileRequest`).
//
// A file picker opens, and a download starts, only from a person's gesture
// on the preview itself. The tap on Upload happened on the canvas a moment
// ago (`previewHasGesture` in ./pointer), and the page still has it when the
// request arrives (`navigator.userActivation.isActive`), so the picker opens
// at once. A request with no such tap behind it (scene code is anyone's, and
// may ask whenever it likes: a click elsewhere on the page is not its
// permission), one that comes after the gesture ran out (a slow render in
// between), or one in a browser that cannot say, waits for the page to ask
// the person with a button of its own (`onFileRequest`), whose click is the
// gesture; a page with no such button turns it down.
//
// The name a file is saved under is cleaned here (`safeFileName`), whatever
// the worker sent: a name in one folder, nothing a file manager hides.

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

/** The longest name a file is saved under. */
const SAFE_FILE_NAME_MAX = 120

// What no file name holds: the C0 and C1 controls, and the marks that turn
// the reading order around (a name that reads `...gpj.exe` backwards).
function isUnprintable(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/**
 * The name the computer saves a file under: the last part of what was asked
 * (no folders), without control or direction-changing characters or the
 * characters a Windows name cannot have, not starting with a dot or a space
 * (a hidden file) nor ending in one, at most 120 characters with its
 * extension kept. "file" when nothing is left.
 */
export function safeFileName(name: unknown): string {
  let clean = typeof name === 'string' ? name : ''
  clean = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
  clean = Array.from(clean)
    .filter((character) => !isUnprintable(character.codePointAt(0) ?? 0))
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (clean.length > SAFE_FILE_NAME_MAX) {
    const dot = clean.lastIndexOf('.')
    const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
    clean = clean.slice(0, SAFE_FILE_NAME_MAX - extension.length).replace(/[.\s]+$/, '') + extension
  }
  return clean || 'file'
}

/** Save `data` to the computer as `name`, cleaned (a Blob and a link's download). */
export function saveFile(name: string, data: ArrayBuffer, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([data]))
  const link = doc.createElement('a')
  link.href = url
  link.download = safeFileName(name)
  link.style.display = 'none'
  doc.body.appendChild(link)
  link.click()
  link.remove()
  // After the browser took it: revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
