// frameos-wasm: run FrameOS scenes in the browser via WebAssembly.
//
// The runtime assets (frameos.js, frameos.wasm, preview-worker.js) ship in
// this package under ./assets — serve that directory same-origin and pass
// `workerUrl: '<mount>/preview-worker.js'`. Version tracks the FrameOS
// release the runtime was built from (versions.json in the FrameOS repo).
export {
  FrameOSPreview,
  createFrameOSPreview,
  type DeviceMemoryUsage,
  type FrameOSPreviewOptions,
} from './preview'
export {
  describeDeviceLimits,
  deviceLimitsFor,
  devicePresetFor,
  devicePresets,
  esp32CanvasBytesPerPixel,
  esp32DeviceHeapBytes,
  esp32PreviewMemoryBytes,
  type DeviceLimits,
  type DevicePreset,
  type DevicePresetKey,
} from './devices'
export { ditherFrame, panelPalettes, panelPaletteFor, type PanelPaletteKey } from './dither'
export { mountFrameOSManager, type FrameOSManagerHandle, type FrameOSManagerOptions } from './manager'
export { selectFieldOptions } from './options'
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
  type PreviewAssetEntry,
  type PreviewAssetsInfo,
  type PreviewFrame,
  type SceneEventButton,
  type SceneInfo,
  type SceneNode,
  type SelectFieldOption,
  type ShowIfCondition,
  type StateField,
} from './types'
