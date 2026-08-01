// Smoke test for the direct (iframe-free) mount entry: serve dist-editor
// statically plus a synthetic host page that imports static/mount.js, mounts
// the editor with a small scene, and checks nodes render, the stylesheet is
// injected, edits round-trip through the handle, and destroy() cleans up.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const distEditor = process.argv[2] ?? new URL('../dist-editor', import.meta.url).pathname
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

const hostHtml = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Mount host</title></head>
  <body style="margin: 0">
    <div style="height: 40px">host page bar</div>
    <div id="mount" style="position: fixed; inset: 40px 0 0 0"></div>
    <script type="module">
      import { mountFrameOSEditor } from '/static/mount.js'
      window.__scenesEvents = []
      window.__handle = mountFrameOSEditor(document.getElementById('mount'), {
        scenes: window.__SCENES,
        width: 800,
        height: 480,
        onReady: () => { window.__ready = true },
        onScenesChanged: (scenes) => { window.__scenesEvents.push(scenes.length) },
      })
    </script>
  </body>
</html>
`

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (urlPath === '/host.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(hostHtml)
    return
  }
  const filePath = path.join(distEditor, urlPath === '/' ? 'index.html' : urlPath)
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, resolve))
const port = server.address().port

const scenes = [
  {
    id: 'scene-1',
    name: 'Smoke scene',
    default: true,
    nodes: [
      { id: 'n-render', type: 'event', position: { x: 0, y: 0 }, data: { keyword: 'render' } },
      {
        id: 'n-color',
        type: 'app',
        position: { x: 300, y: 0 },
        data: { keyword: 'render/color', config: { color: '#ff0000' } },
      },
    ],
    edges: [{ id: 'e1', source: 'n-render', target: 'n-color', sourceHandle: 'next', targetHandle: 'prev' }],
    fields: [],
  },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(`console: ${msg.text()}`)
  }
})
page.on('requestfailed', (req) => errors.push(`reqfail: ${req.url()}`))
page.on('response', (res) => {
  if (res.status() === 404) {
    errors.push(`404: ${res.url()}`)
  }
})

await page.addInitScript((initialScenes) => {
  window.__SCENES = initialScenes
}, scenes)
await page.goto(`http://127.0.0.1:${port}/host.html`)

// The diagram should render both nodes, directly in the host DOM (no iframe).
try {
  await page.waitForSelector('.react-flow__node', { timeout: 15000 })
} catch {
  console.log('NODES MISSING')
  console.log(JSON.stringify({ errors, bodyText: await page.evaluate(() => document.body.innerText.slice(0, 300)) }, null, 2))
  await browser.close(); server.close(); process.exit(1)
}
const nodeCount = await page.locator('.react-flow__node').count()
const iframeCount = await page.locator('iframe').count()
const stylesheetInjected = await page.evaluate(
  () => !!document.querySelector('link[rel="stylesheet"][href*="mount"]')
)

// Round-trip: replace the scenes through the handle and read them back.
const roundTrip = await page.evaluate(async () => {
  const next = structuredClone(window.__SCENES)
  next[0].name = 'Renamed by host'
  window.__handle.setScenes(next)
  const scenes = await window.__handle.getScenes()
  return { name: scenes[0]?.name, ready: window.__ready === true }
})

await page.screenshot({ path: path.join(path.dirname(distEditor), 'editor-mount-smoke.png') }).catch(() => {})

// Destroy: root removed, stylesheet gone, remount allowed.
const afterDestroy = await page.evaluate(() => {
  window.__handle.destroy()
  return {
    stylesheetGone: !document.querySelector('link[rel="stylesheet"][href*="mount"]'),
    mountEmpty: document.getElementById('mount').childElementCount === 0,
  }
})

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200))

const pass =
  nodeCount >= 2 &&
  iframeCount === 0 &&
  stylesheetInjected &&
  roundTrip.ready &&
  roundTrip.name === 'Renamed by host' &&
  afterDestroy.stylesheetGone &&
  afterDestroy.mountEmpty

console.log(JSON.stringify({ nodeCount, iframeCount, stylesheetInjected, roundTrip, afterDestroy, errors: errors.slice(0, 8), bodyText }, null, 2))
await browser.close()
server.close()
process.exit(pass ? 0 : 1)
