// Copy the wasm runtime assets into dist/assets. The assets are built by
// frameos/tools/build_wasm.sh into frontend/public/frameos-wasm (a gitignored
// build output — `turbo run build:runtime --filter=frameos-wasm`; needs nim +
// emscripten). When that build output is absent but dist/assets already holds
// a previously built runtime, it is reused: the runtime only changes with the
// nim sources, so everyday TS-only builds need no emscripten toolchain.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const assetsSource = join(packageDir, '..', '..', 'frontend', 'public', 'frameos-wasm')
const assetsTarget = join(packageDir, 'dist', 'assets')

const files = ['frameos.js', 'frameos.wasm', 'preview-worker.js']
const sourceComplete = files.every((file) => existsSync(join(assetsSource, file)))
const targetComplete = files.every((file) => existsSync(join(assetsTarget, file)))

if (!sourceComplete) {
  if (targetComplete) {
    console.log(`No runtime build at ${assetsSource}; keeping existing dist/assets`)
    process.exit(0)
  }
  console.error(
    `Missing wasm runtime in ${assetsSource} and no previous copy in dist/assets — ` +
      'build it first: turbo run build:runtime --filter=frameos-wasm (needs nim + emscripten)'
  )
  process.exit(1)
}

mkdirSync(assetsTarget, { recursive: true })
for (const file of files) {
  copyFileSync(join(assetsSource, file), join(assetsTarget, file))
}
console.log(`Copied ${files.join(', ')} to dist/assets`)
