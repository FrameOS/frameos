import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameOSEditor } from './embed.js'

// A minimal DOM: one iframe whose contentWindow records what the helper
// posts, and a window whose single 'message' listener the test drives.
function setup({ url = 'https://host.example/editor/', page = 'https://host.example/page' } = {}) {
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
  globalThis.location = new URL(page)
  globalThis.window = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  const dispatch = (event) => listeners.get('message')?.(event)
  return { messages, listeners, contentWindow, iframe, dispatch, url }
}

test('setScenes keeps its selected scene until the iframe is ready', () => {
  const { messages, contentWindow, dispatch, url } = setup()

  const editor = createFrameOSEditor({
    container: { appendChild: () => {} },
    url,
    scenes: [{ id: 'old' }],
    sceneId: 'old',
  })
  editor.setScenes([{ id: 'replacement' }], 'replacement')

  dispatch({
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

test('names the parent origin on the editor URL', () => {
  const { iframe } = setup({ url: 'https://editor.example/app/?theme=dark', page: 'https://host.example/page' })

  const editor = createFrameOSEditor({ container: { appendChild: () => {} }, url: 'https://editor.example/app/?theme=dark', scenes: [] })

  const src = new URL(iframe.src)
  assert.equal(src.origin, 'https://editor.example')
  assert.equal(src.searchParams.get('theme'), 'dark')
  assert.equal(src.searchParams.get('parentOrigin'), 'https://host.example')
  editor.destroy()
})

test('ignores messages from a foreign origin, even from the editor iframe', () => {
  const { messages, contentWindow, dispatch, url } = setup()
  const changes = []
  let readyCalls = 0

  const editor = createFrameOSEditor({
    container: { appendChild: () => {} },
    url,
    scenes: [{ id: 'mine' }],
    onScenesChanged: (scenes) => changes.push(scenes),
    onReady: () => readyCalls++,
  })

  // Same source window, wrong origin: e.g. the iframe was navigated away to
  // an attacker's page, which can still postMessage from that window.
  dispatch({ source: contentWindow, origin: 'https://evil.example', data: { type: 'frameos-editor:ready' } })
  dispatch({
    source: contentWindow,
    origin: 'https://evil.example',
    data: { type: 'frameos-editor:scenes', scenes: [{ id: 'injected' }] },
  })
  // Scheme and port are part of the origin too.
  dispatch({ source: contentWindow, origin: 'http://host.example', data: { type: 'frameos-editor:ready' } })
  dispatch({ source: contentWindow, origin: 'https://host.example:8443', data: { type: 'frameos-editor:ready' } })

  assert.equal(readyCalls, 0)
  assert.deepEqual(changes, [])
  assert.deepEqual(messages, [], 'nothing (scenes included) is sent in reply to a foreign origin')
  assert.deepEqual(editor.getScenesSync(), [{ id: 'mine' }])
  editor.destroy()
})

test('ignores messages from other windows on the editor origin', () => {
  const { messages, dispatch, url } = setup()
  const changes = []
  let readyCalls = 0

  const editor = createFrameOSEditor({
    container: { appendChild: () => {} },
    url,
    scenes: [{ id: 'mine' }],
    onScenesChanged: (scenes) => changes.push(scenes),
    onReady: () => readyCalls++,
  })

  // Right origin, wrong window: another tab or frame on the same host.
  const otherWindow = { postMessage: () => {} }
  dispatch({ source: otherWindow, origin: 'https://host.example', data: { type: 'frameos-editor:ready' } })
  dispatch({
    source: otherWindow,
    origin: 'https://host.example',
    data: { type: 'frameos-editor:scenes', scenes: [{ id: 'injected' }] },
  })
  dispatch({ source: null, origin: 'https://host.example', data: { type: 'frameos-editor:ready' } })

  assert.equal(readyCalls, 0)
  assert.deepEqual(changes, [])
  assert.deepEqual(messages, [])
  assert.deepEqual(editor.getScenesSync(), [{ id: 'mine' }])
  editor.destroy()
})

test('accepts the editor and only ever posts to the editor origin', async () => {
  const { messages, contentWindow, dispatch } = setup({ page: 'https://host.example/page' })
  const url = 'https://editor.example/app/'
  const changes = []

  const editor = createFrameOSEditor({
    container: { appendChild: () => {} },
    url,
    scenes: [{ id: 'mine' }],
    onScenesChanged: (scenes) => changes.push(scenes),
  })

  dispatch({ source: contentWindow, origin: 'https://editor.example', data: { type: 'frameos-editor:ready' } })
  const pending = editor.getScenes()
  dispatch({
    source: contentWindow,
    origin: 'https://editor.example',
    data: { type: 'frameos-editor:scenes', scenes: [{ id: 'edited' }] },
  })
  editor.selectScene('edited')

  assert.deepEqual(await pending, [{ id: 'edited' }])
  assert.deepEqual(changes, [[{ id: 'edited' }]])
  assert.deepEqual(
    messages.map((m) => m.message.type),
    ['frameos-editor:init', 'frameos-editor:get-scenes', 'frameos-editor:select-scene'],
  )
  for (const { origin } of messages) {
    assert.equal(origin, 'https://editor.example', 'never "*" and never the host page origin')
  }
  editor.destroy()
})

test('stops listening once destroyed', () => {
  const { listeners, dispatch, contentWindow, url } = setup()
  let readyCalls = 0
  const editor = createFrameOSEditor({ container: { appendChild: () => {} }, url, scenes: [], onReady: () => readyCalls++ })

  editor.destroy()
  assert.equal(listeners.has('message'), false)
  dispatch({ source: contentWindow, origin: 'https://host.example', data: { type: 'frameos-editor:ready' } })
  assert.equal(readyCalls, 0)
})

test('ignores non-object payloads from the editor', () => {
  const { messages, contentWindow, dispatch, url } = setup()
  const editor = createFrameOSEditor({ container: { appendChild: () => {} }, url, scenes: [] })

  for (const data of [null, 'frameos-editor:ready', 42, undefined]) {
    dispatch({ source: contentWindow, origin: 'https://host.example', data })
  }
  assert.deepEqual(messages, [])
  editor.destroy()
})
