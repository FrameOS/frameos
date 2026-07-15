// Keep this package's version identical to the independent editor component
// version (without its content hash).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const versionsPath = join(packageDir, '..', '..', 'versions.json')
const packageJsonPath = join(packageDir, 'package.json')

const versions = JSON.parse(readFileSync(versionsPath, 'utf8'))
const editorVersion = String(versions.editor ?? '').split('+')[0]
if (!/^\d{4}\.\d{1,2}\.\d+$/.test(editorVersion)) {
  console.error(`Unexpected editor version in versions.json: ${versions.editor}`)
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
if (packageJson.version === editorVersion) {
  console.log(`frameos-editor version already ${editorVersion}`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  console.error(
    `frameos-editor version ${packageJson.version} != editor version ${editorVersion}. Run: npm run sync-version`
  )
  process.exit(1)
}

packageJson.version = editorVersion
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
console.log(`frameos-editor version set to ${editorVersion}`)
