import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameOSEditor } from './embed.js'

test('setScenes keeps its selected scene until the iframe is ready', () => {
  const messages = []
  const listeners = new Map()
  const contentWindow = {
    postMessage: (message, origin) => messages.push({ message, origin }),
  }
  const iframe = {
    contentWindow,
    remove: () => {},
    style: {},
  }
  globalThis.document = { createElement: () => iframe }
  globalThis.location = new URL('https://host.example/page')
  globalThis.window = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }

  const editor = createFrameOSEditor({
    container: { appendChild: () => {} },
    url: 'https://host.example/editor/',
    scenes: [{ id: 'old' }],
    sceneId: 'old',
  })
  editor.setScenes([{ id: 'replacement' }], 'replacement')

  listeners.get('message')({
    source: contentWindow,
    origin: 'https://host.example',
    data: { type: 'frameos-editor:ready' },
  })

  assert.deepEqual(messages.at(-1).message, {
    type: 'frameos-editor:init',
    scenes: [{ id: 'replacement' }],
    sceneId: 'replacement',
    mode: 'rpios',
    width: 800,
    height: 480,
    interval: 300,
    theme: undefined,
    previewProxyUrl: undefined,
    description: undefined,
  })
  editor.destroy()
})
