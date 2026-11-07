// The embedded editor (frameos-editor, the store's Editor panel) is a file
// tree: template.json, then each scene of the template as a diagram with its
// app nodes as folders of files. What the tree lists and the template.json
// it edits are pinned here; how the selection follows the diagram is in
// embedded-editor-file-tree-logic.test.ts.

import { describe, expect, it } from 'vitest'
import type { FrameScene } from '../../../../../../frontend/src/types'
import {
  sceneAppEntries,
  sceneFileName,
  shownSelection,
  templateChangesFromJson,
  templateJsonText,
  type SceneTemplateMetadata,
} from '../../../../../../frontend/src/embed/sceneFiles'

function appNode(id: string, data: Record<string, unknown>) {
  return { id, type: 'app', position: { x: 0, y: 0 }, data: { config: {}, ...data } }
}

const clock = {
  id: 'clock',
  name: 'Clock',
  nodes: [
    { id: 'render', type: 'event', position: { x: 0, y: 0 }, data: { keyword: 'render' } },
    appNode('face', { keyword: 'face', name: 'Clock face' }),
    appNode('text1', { keyword: 'render/text' }),
    appNode('text2', { keyword: 'render/text' }),
    appNode('inline', { keyword: 'inline', sources: { 'app.ts': '', 'config.json': '{}' } }),
    appNode('shared', { keyword: 'weatherApp' }),
  ],
  edges: [],
  apps: { face: { name: 'Face', sources: { 'app.tsx': '' } }, weatherApp: { name: 'Weather', sources: {} } },
  settings: { execution: 'interpreted' },
} as unknown as FrameScene

const photos = {
  id: 'photos',
  name: '  ',
  nodes: [appNode('album', { keyword: 'repo/apps/image/photoAlbum', sources: { 'app.ts': '' } })],
  edges: [],
  settings: { execution: 'interpreted' },
} as unknown as FrameScene

const template: SceneTemplateMetadata = {
  name: 'Desk companion',
  description: 'Two scenes',
  category: 'fun',
  tags: ['clock', 'photos'],
  frameosVersion: null,
}

describe('what the tree lists', () => {
  it("names a scene's diagram after the scene, its id when it has no name", () => {
    expect(sceneFileName(clock)).toBe('Clock.scene')
    expect(sceneFileName(photos)).toBe('photos.scene')
  })

  it('lists every app node as a folder: scene-carried apps editable, catalog apps built-in', () => {
    expect(sceneAppEntries(clock)).toEqual([
      // The node's own name wins over the scene app's.
      { nodeId: 'face', label: 'Clock face', keyword: 'face', source: 'scene' },
      // Two nodes of one name: each gets its node id, neither hides the other.
      { nodeId: 'text1', label: 'text (text1)', keyword: 'render/text', source: 'builtin' },
      { nodeId: 'text2', label: 'text (text2)', keyword: 'render/text', source: 'builtin' },
      { nodeId: 'inline', label: 'inline', keyword: 'inline', source: 'scene' },
      { nodeId: 'shared', label: 'Weather', keyword: 'weatherApp', source: 'scene' },
    ])
    expect(sceneAppEntries(photos)).toEqual([
      { nodeId: 'album', label: 'photoAlbum', keyword: 'repo/apps/image/photoAlbum', source: 'scene' },
    ])
    expect(sceneAppEntries(null)).toEqual([])
  })

  it("falls back to the scene's diagram when the open app's node is gone", () => {
    const open = { kind: 'app', sceneId: 'clock', nodeId: 'face' } as const
    expect(shownSelection(open, [clock])).toEqual(open)
    expect(shownSelection({ ...open, nodeId: 'deleted' }, [clock])).toEqual({ kind: 'diagram' })
    expect(shownSelection(open, [photos])).toEqual({ kind: 'diagram' })
    expect(shownSelection({ kind: 'template' }, [])).toEqual({ kind: 'template' })
  })
})

describe('template.json', () => {
  it("is the zip's manifest: the listing, then the scenes' path", () => {
    expect(JSON.parse(templateJsonText(template))).toEqual({
      name: 'Desk companion',
      description: 'Two scenes',
      category: 'fun',
      tags: ['clock', 'photos'],
      scenes: './scenes.json',
    })
    expect(JSON.parse(templateJsonText({ ...template, description: null, category: null, tags: [] }))).toEqual({
      name: 'Desk companion',
      scenes: './scenes.json',
    })
  })

  it('turns an edited source into the listing changes it asks for', () => {
    const edited = JSON.parse(templateJsonText(template))
    edited.description = 'Three scenes'
    edited.tags = ['clock']
    edited.frameosVersion = '2026.11.3'
    delete edited.category
    expect(templateChangesFromJson(JSON.stringify(edited), template)).toEqual({
      changes: { description: 'Three scenes', category: null, frameosVersion: '2026.11.3', tags: ['clock'] },
    })
    expect(templateChangesFromJson(templateJsonText(template), template)).toEqual({ changes: {} })
  })

  it('refuses what it cannot apply, with a reason to show', () => {
    expect(templateChangesFromJson('{', template)).toHaveProperty('error')
    expect(templateChangesFromJson('[]', template)).toEqual({ error: 'template.json is an object' })
    expect(templateChangesFromJson(JSON.stringify({ name: 'Renamed' }), template)).toEqual({
      error: "The name follows the scene's: rename it from the bar",
    })
    expect(templateChangesFromJson(JSON.stringify({ name: template.name, tags: 'clock' }), template)).toEqual({
      error: '"tags" is a list of strings',
    })
    expect(templateChangesFromJson(JSON.stringify({ name: template.name, category: 3 }), template)).toEqual({
      error: '"category" is a string',
    })
  })
})
