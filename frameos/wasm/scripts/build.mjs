// Copy the wasm runtime assets into dist/assets. The assets are built by
// frameos/tools/build_wasm.sh into frontend/public/frameos-wasm (a gitignored
// build output — run that script first; the release workflow does).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const assetsSource = join(packageDir, '..', '..', 'frontend', 'public', 'frameos-wasm')
const assetsTarget = join(packageDir, 'dist', 'assets')

const files = ['frameos.js', 'frameos.wasm', 'preview-worker.js']
for (const file of files) {
  if (!existsSync(join(assetsSource, file))) {
    console.error(
      `Missing ${join(assetsSource, file)} — build the wasm runtime first: frameos/tools/build_wasm.sh`
    )
    process.exit(1)
  }
}

mkdirSync(assetsTarget, { recursive: true })
for (const file of files) {
  copyFileSync(join(assetsSource, file), join(assetsTarget, file))
}
console.log(`Copied ${files.join(', ')} to dist/assets`)
