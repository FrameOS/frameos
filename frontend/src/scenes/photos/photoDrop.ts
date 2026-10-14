import type { DroppedPhotoFile } from './photosLogic'

/** Photos dragged within the page carry their paths under this type. */
export const PHOTO_PATHS_DRAG_TYPE = 'application/x-frameos-photo-paths'

export function setPhotoPathsDragData(dataTransfer: DataTransfer, paths: string[]): void {
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(PHOTO_PATHS_DRAG_TYPE, JSON.stringify(paths))
}

export function getPhotoPathsDragData(dataTransfer: DataTransfer): string[] | null {
  const raw = dataTransfer.getData(PHOTO_PATHS_DRAG_TYPE)
  if (!raw) {
    return null
  }
  try {
    const paths = JSON.parse(raw)
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : null
  } catch {
    return null
  }
}

export function dragHasPhotoPaths(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PHOTO_PATHS_DRAG_TYPE)
}

export function dragHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export type DroppedItem = { entry: FileSystemEntry } | { file: File }

/** Must run inside the drop handler: the browser empties the list after it. */
export function takeDroppedItems(dataTransfer: DataTransfer): DroppedItem[] {
  const items = Array.from(dataTransfer.items ?? [])
  if (items.length) {
    const taken: DroppedItem[] = []
    for (const item of items) {
      if (item.kind !== 'file') {
        continue
      }
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      const file = entry ? null : item.getAsFile()
      if (entry) {
        taken.push({ entry })
      } else if (file) {
        taken.push({ file })
      }
    }
    return taken
  }
  return Array.from(dataTransfer.files ?? []).map((file) => ({ file }))
}

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** Every file in the drop, folders walked, each with the folder it sat in. */
export async function readDroppedItems(items: DroppedItem[]): Promise<DroppedPhotoFile[]> {
  const files: DroppedPhotoFile[] = []
  const walk = async (entry: FileSystemEntry, folder: string): Promise<void> => {
    if (entry.name.startsWith('.')) {
      return
    }
    if (entry.isFile) {
      files.push({ file: await entryFile(entry as FileSystemFileEntry), folder })
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      const child = folder ? `${folder}/${entry.name}` : entry.name
      // readEntries answers in batches until it returns an empty one.
      for (;;) {
        const batch = await readDirectory(reader)
        if (!batch.length) {
          break
        }
        for (const next of batch) {
          await walk(next, child)
        }
      }
    }
  }
  for (const item of items) {
    if ('file' in item) {
      if (!item.file.name.startsWith('.')) {
        files.push({ file: item.file, folder: '' })
      }
    } else {
      await walk(item.entry, '')
    }
  }
  return files
}
