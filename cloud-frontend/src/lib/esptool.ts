// The ESP32 flasher's one third-party dependency, behind a seam.
//
// It is loaded lazily because esptool-js is large and only matters once
// somebody actually flashes a board — and it is loaded through this function
// rather than a bare `import('esptool-js')` at the call site so tests can
// replace it by relative path. Mocking the bare specifier only works when the
// test file resolves "esptool-js" to the same copy the component does, and the
// tests live in another package (cloud/apps/auth-web) that does not depend on
// it at all.
export async function loadEsptool(): Promise<typeof import('esptool-js')> {
  return import('esptool-js')
}
