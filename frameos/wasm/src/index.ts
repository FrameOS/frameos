// frameos-wasm: run FrameOS scenes in the browser via WebAssembly.
//
// The runtime assets (frameos.js, frameos.wasm, preview-worker.js) ship in
// this package under ./assets — serve that directory same-origin and pass
// `workerUrl: '<mount>/preview-worker.js'`. Version tracks the FrameOS
// release the runtime was built from (versions.json in the FrameOS repo).
export { FrameOSPreview, createFrameOSPreview, type FrameOSPreviewOptions } from './preview'
export { mountFrameOSManager, type FrameOSManagerHandle, type FrameOSManagerOptions } from './manager'
export {
  coerceStateFieldValue,
  evaluateShowIf,
  stateFieldShowIfValues,
  visiblePublicStateFields,
} from './showIf'
export {
  LIFECYCLE_EVENTS,
  sceneEventButtons,
  type ConfigFieldCondition,
  type ConfigFieldConditionAnd,
  type FrameOSScene,
  type PreviewFrame,
  type SceneEventButton,
  type SceneInfo,
  type SceneNode,
  type ShowIfCondition,
  type StateField,
} from './types'
