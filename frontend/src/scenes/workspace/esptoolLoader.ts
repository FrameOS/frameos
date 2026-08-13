import type * as EsptoolJs from 'esptool-js'

/**
 * Loaded on demand: esptool-js adds ~380KB we only need when actually
 * flashing. Split into its own module (mirroring the cloud flasher's
 * cloud-frontend/src/lib/esptool.ts) so the shared-SPA tests in
 * cloud/apps/auth-web/src/test/shared-spa can mock the loader by source path —
 * the bare "esptool-js" specifier only resolves from frontend/'s own
 * node_modules, which vitest across the package boundary cannot reach.
 */
export function loadEsptool(): Promise<typeof EsptoolJs> {
  return import('esptool-js')
}
