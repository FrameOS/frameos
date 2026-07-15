// Smoke test for the embedded editor bundle: serve dist-editor statically,
// post an init message with a small scene, and check nodes render + edits
// round-trip over postMessage.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const distEditor = process.argv[2] ?? new URL("../dist-editor", import.meta.url).pathname
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
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

const received = []
await page.exposeFunction('smokeReport', (msg) => received.push(msg))

await page.addInitScript(() => {
  window.addEventListener('message', (event) => {
    if (event.data?.type?.startsWith('frameos-editor:')) {
      // The page IS the "parent" here (window.parent === window when not framed).
      window.smokeReport({ type: event.data.type, sceneCount: event.data.scenes?.length })
    }
  })
})

await page.goto(`http://127.0.0.1:${port}/index.html`)
try {
  await page.waitForFunction(() => document.body.innerText.includes('Waiting for scenes'), null, { timeout: 15000 })
} catch {
  console.log('INIT SCREEN MISSING')
  console.log(JSON.stringify({ errors, bodyText: await page.evaluate(() => document.body.innerText.slice(0, 300)), html: await page.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 300)) }, null, 2))
  await browser.close(); server.close(); process.exit(1)
}

await page.evaluate((scenes) => {
  window.postMessage({ type: 'frameos-editor:init', scenes, width: 800, height: 480, mode: 'rpios' }, '*')
}, scenes)

// The diagram should render both nodes.
try {
  await page.waitForSelector('.react-flow__node', { timeout: 15000 })
} catch {
  console.log('NODES MISSING')
  console.log(JSON.stringify({ errors, received, bodyText: await page.evaluate(() => document.body.innerText.slice(0, 300)) }, null, 2))
  await browser.close(); server.close(); process.exit(1)
}
const nodeCount = await page.locator('.react-flow__node').count()

// Ask for the scenes back.
await page.evaluate(() => window.postMessage({ type: 'frameos-editor:get-scenes' }, '*'))
await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {})
await page.waitForTimeout(800)

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400))
await page.screenshot({ path: path.join(path.dirname(distEditor), 'editor-smoke.png') }).catch(() => {})

console.log(JSON.stringify({ nodeCount, received, errors: errors.slice(0, 8), bodyText: bodyText.slice(0, 200) }, null, 2))
await browser.close()
server.close()
process.exit(nodeCount >= 2 && received.some((m) => m.type === 'frameos-editor:scenes' && m.sceneCount === 1) ? 0 : 1)
