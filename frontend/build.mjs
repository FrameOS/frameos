#!/usr/bin/env node
import * as path from 'path'
import { fileURLToPath } from 'url'

import {
  buildInParallel,
  copyIndexHtml,
  copyPublicFolder,
  createHashlessEntrypoints,
  isDev,
  startDevServer,
} from './utils.mjs'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))

startDevServer(__dirname)
copyPublicFolder(path.resolve(__dirname, 'public'), path.resolve(__dirname, 'dist'))
writeIndexHtml()

const common = {
  absWorkingDir: __dirname,
  bundle: true,
}

await buildInParallel(
  [
    {
      name: 'FrameOS Frontend',
      globalName: 'frameOSApp',
      entryPoints: ['src/main.tsx'],
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

      const files = Object.keys(buildResponse.outputs).filter((key) => key.startsWith('dist/static/main-'))
      createHashlessEntrypoints(__dirname, files)
    },
  }
)

export function writeIndexHtml(chunks = {}, entrypoints = []) {
  copyIndexHtml(__dirname, './src/index.html', 'dist/index.html', 'main', chunks, entrypoints)
}
