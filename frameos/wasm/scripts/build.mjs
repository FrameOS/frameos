// Copy the wasm runtime assets into dist/assets. The assets are built by
// frameos/tools/build_wasm.sh into frontend/public/frameos-wasm (a gitignored
// build output — `turbo run build:runtime --filter=frameos-wasm`; needs nim +
// emscripten). When that build output is absent but dist/assets already holds
// a previously built runtime, it is reused: the runtime only changes with the
// nim sources, so everyday TS-only builds need no emscripten toolchain.
//
// With neither, the TypeScript half still builds and the runtime is simply
// absent from dist/assets — the cloud does not read it from here (it installs
// the release's signed bundle; see cloud/apps/auth-web/scripts/lib/
// wasm-runtime.mjs). Publishing to npm must ship the runtime, so
// prepublishOnly sets FRAMEOS_WASM_REQUIRE_RUNTIME=1 and that case fails.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const assetsSource = join(packageDir, '..', '..', 'frontend', 'public', 'frameos-wasm')
const assetsTarget = join(packageDir, 'dist', 'assets')

const files = ['frameos.js', 'frameos.wasm', 'preview-worker.js']
// Written by build_wasm.sh next to the bundle; optional for older outputs.
const optionalFiles = ['version.json']
const sourceComplete = files.every((file) => existsSync(join(assetsSource, file)))
const targetComplete = files.every((file) => existsSync(join(assetsTarget, file)))
const requireRuntime = process.env.FRAMEOS_WASM_REQUIRE_RUNTIME === '1'

if (!sourceComplete) {
  if (targetComplete) {
    console.log(`No runtime build at ${assetsSource}; keeping existing dist/assets`)
    process.exit(0)
  }
  const message =
    `No wasm runtime in ${assetsSource} and no previous copy in dist/assets — ` +
    'build it with: turbo run build:runtime --filter=frameos-wasm (needs nim + emscripten)'
  if (requireRuntime) {
    console.error(message)
    process.exit(1)
  }
  console.warn(`${message}; dist/assets stays empty`)
  process.exit(0)
}

mkdirSync(assetsTarget, { recursive: true })
const copied = []
for (const file of [...files, ...optionalFiles]) {
  if (existsSync(join(assetsSource, file))) {
    copyFileSync(join(assetsSource, file), join(assetsTarget, file))
    copied.push(file)
  }
}
console.log(`Copied ${copied.join(', ')} to dist/assets`)
