#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import autoprefixer from 'autoprefixer'
import cssnano from 'cssnano'
import { build, context } from 'esbuild'
import { createRequire } from 'node:module'
import postcss from 'postcss'
import postcssPresetEnv from 'postcss-preset-env'
import tailwindcss from 'tailwindcss'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')
const isWatch = process.argv.includes('--watch')

const outputDir = path.resolve(__dirname, '../assets/compiled/frame_web')
const staticDir = path.join(outputDir, 'static')

await fs.mkdir(staticDir, { recursive: true })
await fs.copyFile(path.resolve(__dirname, 'src/index.html'), path.join(outputDir, 'index.html'))

const postcssPlugins = [
  tailwindcss({ config: path.resolve(__dirname, 'tailwind.config.js') }),
  autoprefixer,
  postcssPresetEnv({ stage: 0 }),
]

if (!isDev) {
  postcssPlugins.push(cssnano({ preset: 'default' }))
}

const postcssPlugin = {
  name: 'frameos-postcss',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = await fs.readFile(args.path, 'utf8')
      const { css } = await postcss(postcssPlugins).process(source, { from: args.path })
      return { contents: css, loader: 'css' }
    })
  },
}

const require = createRequire(import.meta.url)
const sharedPackages = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'kea',
  'kea-router',
  'kea-loaders',
]

const sharedPackagePaths = new Map(sharedPackages.map((packageName) => [packageName, require.resolve(packageName)]))
const sharedDepsFilter =
  /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|kea|kea-router|kea-loaders)$/

const sharedDepsPlugin = {
  name: 'frameos-shared-deps',
  setup(build) {
    build.onResolve({ filter: sharedDepsFilter }, (args) => ({
      path: sharedPackagePaths.get(args.path) ?? args.path,
    }))
  },
}

const buildOptions = {
  absWorkingDir: __dirname,
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'esm',
  splitting: false,
  outdir: staticDir,
  sourcemap: true,
  minify: true,
  entryNames: 'main',
  assetNames: 'asset-[hash]',
  loader: {
    '.png': 'file',
    '.ttf': 'file',
    '.svg': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  plugins: [sharedDepsPlugin, postcssPlugin],
}

if (isWatch) {
  const buildContext = await context(buildOptions)
  await buildContext.watch()
  console.log(`👀 Watching ${staticDir}`)
} else {
  await build(buildOptions)
}
