#!/usr/bin/env node
import * as path from 'path'
import { fileURLToPath } from 'url'
import fse from 'fs-extra'

import {
  buildInParallel,
  copyIndexHtml,
  copyPublicFolder,
  createHashlessEntrypoints,
  isDev,
  startDevServer,
} from './utils.mjs'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))

await import('./scripts/generateRepoApps.mjs')
await import('./scripts/generateBuiltinApps.mjs')

startDevServer(__dirname)
copyPublicFolder(path.resolve(__dirname, 'public'), path.resolve(__dirname, 'dist'))
writeIndexHtml()

const common = {
  absWorkingDir: __dirname,
  bundle: true,
}

function isMonacoWorkerOutput(outputPath, staticPrefix) {
  return outputPath.startsWith(`${staticPrefix}monaco/`) && outputPath.endsWith('.js')
}

function isSharedWorkerChunk(outputPath, staticPrefix) {
  return outputPath.startsWith(`${staticPrefix}chunk-`) && outputPath.endsWith('.js')
}

function copyMonacoWorkerChunks(buildOutputs, staticPrefix = 'dist/static/') {
  const outputs = buildOutputs.outputs ?? {}
  const workerOutputKeys = Object.keys(outputs).filter((key) => isMonacoWorkerOutput(key, staticPrefix))
  const chunkKeys = new Set()
  const visit = (key) => {
    const output = outputs[key]
    if (!output) {
      return
    }
    for (const imported of output.imports ?? []) {
      if (isSharedWorkerChunk(imported.path, staticPrefix) && !chunkKeys.has(imported.path)) {
        chunkKeys.add(imported.path)
        visit(imported.path)
      }
    }
  }

  for (const key of workerOutputKeys) {
    visit(key)
  }

  for (const key of chunkKeys) {
    const sourcePath = path.resolve(__dirname, key)
    const targetPath = path.resolve(__dirname, `${staticPrefix}monaco`, path.basename(key))
    fse.copyFileSync(sourcePath, targetPath)

    const sourceMapPath = `${sourcePath}.map`
    if (fse.existsSync(sourceMapPath)) {
      fse.copyFileSync(sourceMapPath, `${targetPath}.map`)
    }
  }
}

// The embedded scene editor (dist-editor/): the same Diagram/EditApp code,
// but with frameLogic and logsLogic swapped for in-memory shims so it runs
// without a backend — scenes go in and out over postMessage. Published to
// npm as `frameos-editor`; see src/embed/.
const embedAliasPlugin = {
  name: 'frameos-embed-aliases',
  setup(build) {
    const shimSkip = /frameLogicShim|logsLogicShim/
    const realFrameLogic = path.resolve(__dirname, 'src/scenes/frame/frameLogic')
    const realLogsLogic = path.resolve(__dirname, 'src/scenes/frame/panels/Logs/logsLogic')
    build.onResolve({ filter: /(frameLogic|logsLogic)$/ }, (args) => {
      if (!args.path.startsWith('.') || !args.importer || shimSkip.test(args.importer)) {
        return null
      }
      const resolved = path.resolve(path.dirname(args.importer), args.path)
      if (resolved === realFrameLogic) {
        return { path: path.resolve(__dirname, 'src/embed/frameLogicShim.ts') }
      }
      if (resolved === realLogsLogic) {
        return { path: path.resolve(__dirname, 'src/embed/logsLogicShim.ts') }
      }
      return null
    })
  },
}

function writeEditorHtml(outputs = {}) {
  const distEditor = path.resolve(__dirname, 'dist-editor')
  fse.mkdirpSync(distEditor)
  // Hashless copies of the entry + monaco workers, so the html (and
  // configureMonaco's worker URLs) can use stable names.
  for (const key of Object.keys(outputs)) {
    if (/^dist-editor\/static\/(editor-[A-Z0-9]+\.(js|css)|monaco\/(editor|json|css|html|ts)\.worker-[A-Z0-9]+\.js)$/.test(key)) {
      createHashlessEntrypoints(__dirname, [key])
    }
  }
  fse.writeFileSync(
    path.resolve(distEditor, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FrameOS Scene Editor</title>
    <script>
      // Serve this directory anywhere; asset URLs resolve relative to it.
      window.FRAMEOS_APP_CONFIG = { ingress_path: new URL('.', location.href).pathname.replace(/\\/$/, '') }
      window.ESBUILD_LOAD_CHUNKS = function () {}
      // Default theme before the bundle loads; the embedding page can
      // override it via the init message's \`theme\`.
      const theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      document.documentElement.dataset.frameosTheme = theme
      document.documentElement.style.colorScheme = theme
    </script>
    <link rel="stylesheet" href="./static/editor.css" />
  </head>
  <body>
    <div id="root"></div>
    <div id="modal" style="position: absolute; z-index: 10"></div>
    <div id="popper" style="position: absolute; z-index: 80"></div>
    <script type="module" src="./static/editor.js"></script>
  </body>
</html>
`
  )
}

await buildInParallel(
  [
    {
      name: 'FrameOS Frontend',
      globalName: 'frameOSApp',
      entryPoints: [
        'src/main.tsx',
        'src/monaco/editor.worker.ts',
        'src/monaco/json.worker.ts',
        'src/monaco/css.worker.ts',
        'src/monaco/html.worker.ts',
        'src/monaco/ts.worker.ts',
      ],
      splitting: true,
      format: 'esm',
      outdir: path.resolve(__dirname, 'dist', 'static'),
      ...common,
    },
    {
      name: 'FrameOS Embedded Editor',
      globalName: 'frameOSEditor',
      // publicPath './' makes chunk imports same-directory-relative, so the
      // entry must land at the outdir root, next to the chunks (the workers
      // get their shared chunks copied in by copyMonacoWorkerChunks).
      entryPoints: [
        { in: 'src/embed/editor.tsx', out: 'editor' },
        { in: 'src/monaco/editor.worker.ts', out: 'monaco/editor.worker' },
        { in: 'src/monaco/json.worker.ts', out: 'monaco/json.worker' },
        { in: 'src/monaco/css.worker.ts', out: 'monaco/css.worker' },
        { in: 'src/monaco/html.worker.ts', out: 'monaco/html.worker' },
        { in: 'src/monaco/ts.worker.ts', out: 'monaco/ts.worker' },
      ],
      splitting: true,
      format: 'esm',
      outdir: path.resolve(__dirname, 'dist-editor', 'static'),
      extraPlugins: [embedAliasPlugin],
      ...common,
    },
  ],
  {
    async onBuildComplete(config, buildResponse) {
      if (!buildResponse) {
        return
      }
      const { chunks, entrypoints } = buildResponse

      if (config.name === 'FrameOS Frontend') {
        writeIndexHtml(chunks, entrypoints)
      }
      if (config.name === 'FrameOS Embedded Editor') {
        try {
          writeEditorHtml(buildResponse.outputs)
          copyMonacoWorkerChunks(buildResponse, 'dist-editor/static/')
        } catch (error) {
          console.error('Embedded editor packaging failed:', error)
          throw error
        }
        return
      }

      const files = Object.keys(buildResponse.outputs).filter(
        (key) => key.startsWith('dist/static/main-') || key.startsWith('dist/static/monaco/')
      )
      createHashlessEntrypoints(__dirname, files)
      copyMonacoWorkerChunks(buildResponse)
    },
  }
)

export function writeIndexHtml(chunks = {}, entrypoints = []) {
  copyIndexHtml(__dirname, './src/index.html', 'dist/index.html', 'main', chunks, entrypoints)
}
