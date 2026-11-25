#!/usr/bin/env node
// The FrameOS Cloud wrapper bundle: deep-imports the shared frontend
// (../frontend/src) and esbuilds a static SPA that Next.js (cloud/apps/
// auth-web) serves at account.frameos.net/frames. Modeled on
// frameos/frontend/build.mjs — see cloud/docs/cloud-frames.md
// ("Frontend: the fourth adapter") and README.md here for the base-path
// contract.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import autoprefixer from 'autoprefixer'
import cssnano from 'cssnano'
import { build, context } from 'esbuild'
import { createRequire } from 'node:module'
import postcss from 'postcss'
import postcssPresetEnv from 'postcss-preset-env'
import sharp from 'sharp'
import tailwindcss from 'tailwindcss'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')
const isWatch = process.argv.includes('--watch')

const outputDir = path.resolve(__dirname, 'dist')
const staticDir = path.join(outputDir, 'static')
const publicDir = path.resolve(__dirname, '../frontend/public')

await import('../frontend/scripts/generateRepoApps.mjs')

await fs.rm(outputDir, { recursive: true, force: true })
await fs.mkdir(staticDir, { recursive: true })
await fs.copyFile(path.resolve(__dirname, 'src/index.html'), path.join(outputDir, 'index.html'))
// flash.frameos.net (cloud/docs/flasher.md): a page of its own, served by
// auth-web's app/flash route, built here beside the workspace because it is
// the workspace's flashing engine with a page around it.
await fs.copyFile(path.resolve(__dirname, 'src/flasher/index.html'), path.join(outputDir, 'flasher.html'))

// The samples a standalone frame can start with on flash.frameos.net, read
// from repo/scenes at build time (so a sample's fix reaches the flasher with
// the next deploy): src/flasher/sampleCatalog.ts decides which can run on such
// a frame, from the scenes themselves. The page loads the light index
// (flasher-scenes/index.json) and fetches a sample's scenes only when it is
// picked (flasher-scenes/<file>). Each sample's own picture (template.json
// `image`) goes beside them as a small JPEG for the list (flasher-scenes/<thumb>):
// the originals are 17 MB, some of them 2 MB, for a 64 x 48 slot.
{
  const bundled = await build({
    absWorkingDir: __dirname,
    entryPoints: [path.resolve(__dirname, 'src/flasher/sampleCatalog.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
    tsconfig: path.resolve(__dirname, 'tsconfig.json'),
  })
  const catalog = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
  const scenesRoot = path.resolve(__dirname, '../repo/scenes')
  const sources = []
  for (const shelf of ['samples', 'gallery']) {
    const entries = await fs.readdir(path.join(scenesRoot, shelf), { withFileTypes: true })
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      const dir = path.join(scenesRoot, shelf, entry.name)
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'template.json'), 'utf8'))
      const scenes = JSON.parse(await fs.readFile(path.join(dir, String(meta.scenes ?? './scenes.json')), 'utf8'))
      const image = typeof meta.image === 'string' && meta.image ? path.join(dir, meta.image) : null
      const hasImage =
        image !== null &&
        (await fs
          .stat(image)
          .then((stat) => stat.isFile())
          .catch(() => false))
      sources.push({
        name: entry.name,
        title: typeof meta.name === 'string' ? meta.name : entry.name,
        description: String(meta.description ?? ''),
        hasImage,
        image: hasImage ? image : null,
        scenes: Array.isArray(scenes) ? scenes : [],
      })
    }
  }
  const index = catalog.flasherSampleIndex(sources)
  const sampleDir = path.join(outputDir, 'flasher-scenes')
  await fs.mkdir(sampleDir, { recursive: true })
  const byName = new Map(sources.map((source) => [source.name, source]))
  let thumbBytes = 0
  await Promise.all(
    index.samples.map(async (sample) => {
      const source = byName.get(sample.name)
      await fs.writeFile(path.join(sampleDir, sample.file), catalog.flasherScenesJson(source.scenes))
      if (sample.thumb) {
        const thumb = await sharp(source.image)
          .rotate()
          .resize(catalog.FLASHER_THUMB_WIDTH, catalog.FLASHER_THUMB_HEIGHT, { fit: 'cover' })
          .jpeg({ quality: 75, mozjpeg: true })
          .toBuffer()
        await fs.writeFile(path.join(sampleDir, sample.thumb), thumb)
        thumbBytes += thumb.byteLength
      }
    })
  )
  const indexJson = JSON.stringify({ samples: index.samples })
  await fs.writeFile(path.join(sampleDir, 'index.json'), indexJson)
  const total = index.samples.reduce((sum, sample) => sum + sample.bytes, 0)
  console.log(
    `🧩 flasher: ${index.samples.length} samples (${Math.round(total / 1024)} KB of scenes, index ${Math.round(
      indexJson.length / 1024
    )} KB, ${index.samples.filter((sample) => sample.thumb).length} pictures in ${Math.round(
      thumbBytes / 1024
    )} KB), ${index.leftOut.length} left out`
  )
}

// cloud/apps/auth-web/app/frames/[[...path]]/route.ts injects server-side
// configuration by replacing these exact lines in the shell. Dropping one
// would make the replacement a silent no-op — a dev websocket pointed at the
// wrong server, or an account header linking to the wrong origin — with no
// error anywhere, so fail the build loudly instead.
const configInjectionAnchors = {
  '//__FRAMEOS_CLOUD_WS_ORIGIN__': 'cloud_ws_origin in dev',
  '//__FRAMEOS_CLOUD_APP_CONFIG__': 'the account header URLs, enrollment origin and claim-code TTL',
}
const shellHtml = await fs.readFile(path.join(outputDir, 'index.html'), 'utf8')
// A whole line, not just "appears somewhere": the comment above the config
// object names both anchors too, so an `includes` check stays happy even if
// the real line is gone — and the route would then serve a shell whose
// websocket points at itself.
for (const [anchor, injects] of Object.entries(configInjectionAnchors)) {
  const anchorLines = shellHtml.split('\n').filter((line) => line.trim() === anchor)
  if (anchorLines.length !== 1) {
    throw new Error(
      `cloud-frontend/src/index.html must contain exactly one line that is only ${JSON.stringify(anchor)} ` +
        `(found ${anchorLines.length}): cloud/apps/auth-web/app/frames/[[...path]]/route.ts replaces that line ` +
        `to inject ${injects}.`
    )
  }
}
await fs.cp(publicDir, outputDir, {
  recursive: true,
  filter: (source) => path.basename(source) !== '.DS_Store',
})

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
  'kea-forms',
  'kea-localstorage',
  'kea-loaders',
  'kea-router',
  'kea-subscriptions',
]
const sortedSharedPackages = [...sharedPackages].sort((a, b) => b.length - a.length)

const sharedPackageResolutions = new Map()

const resolveInstalledSharedPackage = (specifier) => {
  if (sharedPackageResolutions.has(specifier)) {
    return sharedPackageResolutions.get(specifier)
  }

  try {
    const resolution = require.resolve(specifier)
    sharedPackageResolutions.set(specifier, resolution)
    return resolution
  } catch {
    sharedPackageResolutions.set(specifier, null)
    return null
  }
}

const resolveSharedPackage = (specifier) => {
  const packageName = sortedSharedPackages.find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`)
  )

  if (!packageName) {
    return null
  }

  return resolveInstalledSharedPackage(specifier)
}

const sharedDepsPlugin = {
  name: 'frameos-shared-deps',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      const resolvedPath = resolveSharedPackage(args.path)
      if (!resolvedPath) {
        return undefined
      }
      return { path: resolvedPath }
    })
  },
}

// Monaco's workers load by fixed URL (configureMonaco.ts:
// {assets_base_path}/static/monaco/<name>.js), so they are built separately
// with stable, unhashed names — the shell never references them, the main
// bundle constructs their URLs at runtime. Self-contained (no splitting):
// a worker cannot share chunks with the DOM bundle anyway.
const monacoWorkerNames = ['editor.worker', 'json.worker', 'css.worker', 'html.worker', 'ts.worker']
await build({
  absWorkingDir: __dirname,
  entryPoints: monacoWorkerNames.map((name) => ({
    in: `../frontend/src/monaco/${name}.ts`,
    out: `monaco/${name}`,
  })),
  bundle: true,
  format: 'esm',
  splitting: false,
  outdir: staticDir,
  minify: true,
  sourcemap: isDev,
  tsconfig: path.resolve(__dirname, 'tsconfig.json'),
})

const buildOptions = {
  absWorkingDir: __dirname,
  entryPoints: [
    { in: 'src/main.tsx', out: 'main' },
    { in: 'src/flasher/main.tsx', out: 'flasher' },
  ],
  bundle: true,
  format: 'esm',
  // The cloud frontend imports shared TSX files from ../frontend/src. Force the
  // automatic runtime so those files never fall back to classic JSX on a build host.
  jsx: 'automatic',
  jsxImportSource: 'react',
  tsconfig: path.resolve(__dirname, 'tsconfig.json'),
  splitting: false,
  outdir: staticDir,
  sourcemap: isDev,
  minify: true,
  // Content-hashed entry names in production builds: the no-store shell
  // references the new names each deploy, so every cache layer between the
  // server and the browser (Cloudflare rewrites weaker origin cache-control
  // headers) becomes harmless and the assets can be cached forever. Watch
  // and dev builds keep stable names — the dev server copies the bundle
  // once at startup and a changing name would strand its index.html.
  entryNames: isDev || isWatch ? '[name]' : '[name]-[hash]',
  metafile: !isWatch,
  assetNames: 'asset-[hash]',
  // Assets are served by Next.js from public/frames-app/ — see README.md.
  publicPath: '/frames-app/static/',
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
  const result = await build(buildOptions)
  // The templates keep the stable names; point each shell at its hashed
  // outputs. Failing loudly beats serving a shell whose script 404s.
  const toRelative = (outputPath) =>
    path.relative(outputDir, path.resolve(__dirname, outputPath)).split(path.sep).join('/')
  for (const { entryPoint, name, shell } of [
    { entryPoint: 'src/main.tsx', name: 'main', shell: 'index.html' },
    { entryPoint: 'src/flasher/main.tsx', name: 'flasher', shell: 'flasher.html' },
  ]) {
    const entry = Object.entries(result.metafile.outputs).find(([, meta]) => meta.entryPoint === entryPoint)
    if (!entry) {
      throw new Error(`${entryPoint} entry missing from the esbuild metafile`)
    }
    const jsFile = toRelative(entry[0])
    if (!entry[1].cssBundle) {
      throw new Error(`css bundle of ${entryPoint} missing from the esbuild metafile`)
    }
    const cssFile = toRelative(entry[1].cssBundle)
    const shellPath = path.join(outputDir, shell)
    let html = await fs.readFile(shellPath, 'utf8')
    for (const [from, to] of [
      [`/frames-app/static/${name}.css`, `/frames-app/${cssFile}`],
      [`/frames-app/static/${name}.js`, `/frames-app/${jsFile}`],
    ]) {
      if (!html.includes(from)) {
        throw new Error(`${shell} no longer references ${from}; the hashed-name rewrite would be a no-op`)
      }
      html = html.replaceAll(from, to)
    }
    await fs.writeFile(shellPath, html)
    console.log(`🔗 ${shell} references ${jsFile} and ${cssFile}`)
  }
}
