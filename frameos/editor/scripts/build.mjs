// Package the embedded editor bundle: frontend/dist-editor (built by the
// frontend's build.mjs "FrameOS Embedded Editor" config) is copied into
// dist/. Run the frontend build first; the release workflow does.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const bundleSource = join(packageDir, '..', '..', 'frontend', 'dist-editor')
const bundleTarget = join(packageDir, 'dist')

if (!existsSync(join(bundleSource, 'index.html'))) {
  console.error(`Missing ${bundleSource}/index.html — build the frontend first: pnpm --dir frontend run build`)
  process.exit(1)
}

rmSync(bundleTarget, { force: true, recursive: true })
cpSync(bundleSource, bundleTarget, { recursive: true })
console.log(`Copied ${bundleSource} to dist/`)
