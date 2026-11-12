import type { FrameScene } from '../types'
import { diffHunks, diffLines, splitLines, type DiffHunk } from './lineDiff'

// What a scene update changes, as files (the deploy drawer's "Scene updates"):
// a scene's code is not diffed as JSON. Each app's sources, each inline app's
// sources and each code node's code become files of their own, diffed line
// by line, and scene.json keeps the rest (nodes, edges, fields, settings)
// with a pointer where the code was. Keys are sorted, so an object written in
// another order is not a change.

export interface SceneCodeFile {
  path: string
  text: string
}

export interface SceneFileDiff {
  path: string
  status: 'added' | 'removed' | 'changed'
  added: number
  removed: number
  hunks: DiffHunk[]
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/** JSON with sorted keys and two-space indent, ending in a newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortedKeys(value), null, 2)}\n`
}

function pathPart(name: string): string {
  return name.replace(/\//g, '∕').trim() || '_'
}

/** The scene as files: scene.json, then its code, each under `folder`. */
export function sceneCodeFiles(scene: FrameScene, folder = ''): SceneCodeFile[] {
  const prefix = folder ? `${pathPart(folder)}/` : ''
  const files: SceneCodeFile[] = []
  const take = (path: string, text: unknown): string => {
    files.push({ path: `${prefix}${path}`, text: typeof text === 'string' ? text : String(text ?? '') })
    return `<${path}>`
  }
  const apps = Object.fromEntries(
    Object.entries(scene.apps ?? {}).map(([keyword, app]) => [
      keyword,
      app && typeof app === 'object' && app.sources && typeof app.sources === 'object'
        ? {
            ...app,
            sources: Object.fromEntries(
              Object.entries(app.sources).map(([file, source]) => [
                file,
                take(`apps/${pathPart(keyword)}/${file}`, source),
              ])
            ),
          }
        : app,
    ])
  )
  const nodes = (scene.nodes ?? []).map((node) => {
    const data = (node.data ?? {}) as Record<string, unknown>
    let next: Record<string, unknown> | null = null
    if (node.type === 'app' && data.sources && typeof data.sources === 'object') {
      next = {
        ...data,
        sources: Object.fromEntries(
          Object.entries(data.sources as Record<string, unknown>).map(([file, source]) => [
            file,
            take(`nodes/${pathPart(node.id)}/${file}`, source),
          ])
        ),
      }
    }
    if (node.type === 'code') {
      next = { ...data }
      if (typeof data.code === 'string' && data.code) {
        next.code = take(`code/${pathPart(node.id)}.nim`, data.code)
      }
      if (typeof data.codeJS === 'string' && data.codeJS) {
        next.codeJS = take(`code/${pathPart(node.id)}.js`, data.codeJS)
      }
    }
    return next ? { ...node, data: next } : node
  })
  const sceneJson = { ...scene, nodes, ...(scene.apps ? { apps } : {}) }
  return [{ path: `${prefix}scene.json`, text: stableJson(sceneJson) }, ...files]
}

/**
 * The files that differ between two versions of a group of scenes (a store
 * scene's pack, a template's installed scenes), scenes paired by id. Each
 * scene is a folder of its own when the group holds more than one.
 */
export function diffSceneFiles(before: readonly FrameScene[], after: readonly FrameScene[]): SceneFileDiff[] {
  const ids = [...new Set([...before, ...after].map((scene) => scene.id))]
  const nameOf = (id: string): string =>
    (after.find((scene) => scene.id === id) ?? before.find((scene) => scene.id === id))?.name?.trim() || id
  const folder = (id: string): string => (ids.length > 1 ? nameOf(id) : '')
  const filesOf = (scenes: readonly FrameScene[]): Map<string, string> =>
    new Map(scenes.flatMap((scene) => sceneCodeFiles(scene, folder(scene.id))).map((file) => [file.path, file.text]))
  const oldFiles = filesOf(before)
  const newFiles = filesOf(after)
  const diffs: SceneFileDiff[] = []
  for (const path of [...new Set([...newFiles.keys(), ...oldFiles.keys()])]) {
    const oldText = oldFiles.get(path)
    const newText = newFiles.get(path)
    if (oldText === newText) {
      continue
    }
    const lines = diffLines(splitLines(oldText ?? ''), splitLines(newText ?? ''))
    diffs.push({
      path,
      status: oldText === undefined ? 'added' : newText === undefined ? 'removed' : 'changed',
      added: lines.filter((line) => line.kind === 'add').length,
      removed: lines.filter((line) => line.kind === 'remove').length,
      hunks: diffHunks(lines),
    })
  }
  return diffs
}
