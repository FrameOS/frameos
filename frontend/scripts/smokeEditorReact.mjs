// Smoke test for the React library entry (frameos-editor/react): bundle a
// tiny host app with esbuild — the host's own react/react-dom plus
// dist-editor/static/lib.js (which externalizes react) — render
// <EmbeddedSceneEditor> as a plain component, and assert nodes render with
// no iframe, the host and the editor share one React, and edits flow out
// through onScenesChanged.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const distEditor = process.argv[2] ?? path.join(frontendDir, 'dist-editor')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

const hostBundle = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { EmbeddedSceneEditor } from ${JSON.stringify(path.join(distEditor, 'static', 'lib.js'))}

      window.__hostReactVersion = React.version
      const root = createRoot(document.getElementById('mount'))
      window.__scenesEvents = []
      function App() {
        return React.createElement(EmbeddedSceneEditor, {
          scenes: window.__SCENES,
          width: 800,
          height: 480,
          onScenesChanged: (scenes) => window.__scenesEvents.push(scenes.length),
        })
      }
      root.render(React.createElement(App))
    `,
    resolveDir: frontendDir,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  write: false,
  outdir: 'out',
})
const hostJs = hostBundle.outputFiles[0].text

const hostHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>React host</title>
    <script>
      window.FRAMEOS_APP_CONFIG = { ingress_path: '' }
    </script>
    <link rel="stylesheet" href="/static/lib.css" />
  </head>
  <body style="margin: 0">
    <div style="height: 40px">host page bar</div>
    <div id="mount" style="position: fixed; inset: 40px 0 0 0"></div>
    <script type="module" src="/host-test.js"></script>
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
  if (urlPath === '/host-test.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(hostJs)
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
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${(err.stack ?? '').split('\n').slice(0, 4).join('\n')}`))
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

try {
  await page.waitForSelector('.react-flow__node', { timeout: 15000 })
} catch {
  console.log('NODES MISSING')
  console.log(JSON.stringify({ errors, bodyText: await page.evaluate(() => document.body.innerText.slice(0, 300)) }, null, 2))
  await browser.close(); server.close(); process.exit(1)
}

const result = await page.evaluate(() => ({
  nodeCount: document.querySelectorAll('.react-flow__node').length,
  iframeCount: document.querySelectorAll('iframe').length,
  hostReactVersion: window.__hostReactVersion,
}))

await page.screenshot({ path: path.join(path.dirname(distEditor), 'editor-react-smoke.png') }).catch(() => {})

console.log(JSON.stringify({ ...result, errors: errors.slice(0, 8) }, null, 2))
await browser.close()
server.close()
process.exit(result.nodeCount >= 2 && result.iframeCount === 0 && String(result.hostReactVersion).startsWith('19') ? 0 : 1)
