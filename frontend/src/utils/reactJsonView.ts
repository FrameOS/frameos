import * as ReactJsonImport from '@microlink/react-json-view'

// The CJS build of @microlink/react-json-view resolves differently under vite
// (dev) and esbuild (production): the component may sit on the module itself,
// on .default, or on .default.default. Unwrap defensively or return null.
const reactJsonModule = ReactJsonImport as any

export const ReactJsonComponent: any =
  (typeof reactJsonModule === 'function' && reactJsonModule) ||
  (typeof reactJsonModule?.default === 'function' && reactJsonModule.default) ||
  (typeof reactJsonModule?.default?.default === 'function' && reactJsonModule.default.default) ||
  null
