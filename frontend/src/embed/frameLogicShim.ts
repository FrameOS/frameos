// Swapped in for scenes/frame/frameLogic by the embedded-editor build (an
// esbuild alias in build.mjs). Everything the real module exports stays
// available (helpers, types); only the `frameLogic` logic itself is replaced
// with the in-memory embed version, so the whole Diagram/EditApp dependency
// graph runs without a backend.
export * from '../scenes/frame/frameLogic'
export { embedFrameLogic as frameLogic } from './embedFrameLogic'
