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

startDevServer(__dirname)
copyPublicFolder(path.resolve(__dirname, 'public'), path.resolve(__dirname, 'dist'))
writeIndexHtml()

const common = {
  absWorkingDir: __dirname,
  bundle: true,
}

function isMonacoWorkerOutput(outputPath) {
  return outputPath.startsWith('dist/static/monaco/') && outputPath.endsWith('.js')
}

function isSharedWorkerChunk(outputPath) {
  return outputPath.startsWith('dist/static/chunk-') && outputPath.endsWith('.js')
}

function copyMonacoWorkerChunks(buildOutputs) {
  const outputs = buildOutputs.outputs ?? {}
  const workerOutputKeys = Object.keys(outputs).filter(isMonacoWorkerOutput)
  const chunkKeys = new Set()
  const visit = (key) => {
    const output = outputs[key]
    if (!output) {
      return
    }
    for (const imported of output.imports ?? []) {
      if (isSharedWorkerChunk(imported.path) && !chunkKeys.has(imported.path)) {
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
    const targetPath = path.resolve(__dirname, 'dist/static/monaco', path.basename(key))
    fse.copyFileSync(sourcePath, targetPath)

    const sourceMapPath = `${sourcePath}.map`
    if (fse.existsSync(sourceMapPath)) {
      fse.copyFileSync(sourceMapPath, `${targetPath}.map`)
    }
  }
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
