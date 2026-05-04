const args = scriptArgs.length >= 4 ? scriptArgs.slice(1) : scriptArgs
const filename = args[0]
const sourcePath = args[1]
const vendorPath = args[2]

function writePayload(payload, exitCode) {
  std.out.puts(JSON.stringify(payload))
  std.exit(exitCode)
}

try {
  const source = std.loadFile(sourcePath)
  const vendor = std.loadFile(vendorPath)

  if (source === null) {
    throw new Error(`Unable to read JavaScript source: ${sourcePath}`)
  }
  if (vendor === null) {
    throw new Error(`Unable to read Sucrase vendor bundle: ${vendorPath}`)
  }

  globalThis.eval(vendor)
  globalThis.__frameosTranspile(source, { filePath: filename })
  writePayload({ ok: true }, 0)
} catch (error) {
  writePayload(
    {
      ok: false,
      errors: [
        {
          text: String((error && error.message) || error || 'Unknown JavaScript error'),
          location: {
            line: Number((error && error.loc && error.loc.line) || 1),
            column: Number((error && error.loc && error.loc.column) || 1),
          },
        },
      ],
    },
    1
  )
}
