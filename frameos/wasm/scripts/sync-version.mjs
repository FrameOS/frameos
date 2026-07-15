// Keep this package's version identical to the FrameOS release version (the
// `frameos` entry of versions.json at the repo root, without the content
// hash). Run with --check to fail instead of write (used by prepublishOnly).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const versionsPath = join(packageDir, '..', '..', 'versions.json')
const packageJsonPath = join(packageDir, 'package.json')

const versions = JSON.parse(readFileSync(versionsPath, 'utf8'))
const frameosVersion = String(versions.frameos ?? '').split('+')[0]
if (!/^\d{4}\.\d{1,2}\.\d+$/.test(frameosVersion)) {
  console.error(`Unexpected frameos version in versions.json: ${versions.frameos}`)
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
if (packageJson.version === frameosVersion) {
  console.log(`frameos-wasm version already ${frameosVersion}`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  console.error(
    `frameos-wasm version ${packageJson.version} != FrameOS version ${frameosVersion}. Run: npm run sync-version`
  )
  process.exit(1)
}

packageJson.version = frameosVersion
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
console.log(`frameos-wasm version set to ${frameosVersion}`)
