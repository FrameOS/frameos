import { Edge, Node } from 'reactflow'
import type { FrameCompilationModeOptionValue } from './utils/frameBuildOptions'
import type { FrameId } from './utils/frameId'
import type { ScheduledEventName } from './utils/scheduleEvents'

// Defined in utils/frameId.ts (which has no imports) and re-exported here so
// the SPA's usual `from '../types'` import keeps working.
export type { FrameId }
export type { ScheduledEventName }

export type FrameErrorBehaviorMode = 'safe_mode' | 'show_error_retry' | 'silent_retry'
export type FrameVirtualColorMode = 'rgb' | 'bw' | 'gray4' | 'bwyr' | 'sevencolor' | 'spectra6'
export type FrameEmbeddedFlashSize = '2MB' | '4MB' | '8MB' | '16MB' | '32MB'
export type FrameEmbeddedHardwarePreset =
  | 'custom'
  | 'waveshare_esp32_s3_photopainter'
  | 'waveshare_esp32_s3_epaper_13_3e6'
  | 'trmnl_og'
  | 'trmnl_bwry'
  | 'trmnl_og_diy_kit'
  | 'trmnl_4in26_diy_kit'
  | 'xteink_x4'
  | 'seeed_reterminal_sticky'
  | 'seeed_reterminal_e1001'
  | 'seeed_reterminal_e1002'
  | 'seeed_reterminal_e1004'
  | 'elecrow_crowpanel_5in79'
  | 'pimoroni_inky_frame_4'
  | 'pimoroni_inky_frame_5_7'
  | 'pimoroni_inky_frame_7_3'
  | 'pimoroni_inky_frame_7_3_pico2'
  | 'pimoroni_inky_frame_7_3_spectra'

export interface FrameErrorBehavior {
  mode?: FrameErrorBehaviorMode
  retry_seconds?: number
  silent_retry_seconds?: number
  silent_retry_forever?: boolean
  silent_window_minutes?: number
  show_error_retry_seconds?: number
}

/** One store scene's slice of a cloud assignment push: the version that
 * produced the bytes and the checksum of just that scene's runtime scenes
 * (cloud/apps/auth-web/src/lib/frames.ts buildScenesPayloadForFrame). */
export interface CloudSceneDeployState {
  version?: number | null
  checksum?: string
}

/** Which store-scene assignment a hydrated runtime scene came from. */
export interface CloudSceneSource {
  scene_id: string
  scene_version?: number | null
}

export interface FrameType {
  id: FrameId
  project_id: number
  name: string
  mode?: 'rpios' | 'buildroot' | 'embedded'
  /** Which control plane manages this frame. Cloud-managed frames are
   * interpreted-only: no SSH, no compiled scenes, no shell-flagged apps. */
  managed_by?: 'backend' | 'cloud'
  /** Cloud-managed frames: which service-settings groups ("unsplash",
   * "openAI", …) this frame's assigned scenes declare. Group NAMES only —
   * the keys themselves only ever travel over the device's own authenticated
   * pull (cloud/docs/cloud-frames.md, "Service settings"). */
  service_setting_groups?: string[]
  /** Cloud-managed frames: whether the frame's link still holds
   * `settings:services`, i.e. whether those keys are actually delivered. The
   * owner toggles it per frame; absent means "not reported" (hub broadcasts
   * that do not carry the link), never "off". */
  service_settings_enabled?: boolean
  /** The hardware object the device reported at cloud enrollment and on every
   * hub hello (frames.hardware jsonb on the cloud; absent on backend-managed
   * frames). `platform` drives the device-profile capability gating in
   * workspaceSurfaces.ts: an "esp32" frame implements only a subset of the
   * management verbs (docs/cloud-frames.md). Everything past `color` arrived
   * with 2026.8 firmware (fos_cloud.c add_hardware_json) — older devices
   * report only the first six fields, so all of it stays optional. */
  hardware?: {
    platform?: string | null
    /** Linux/Pi frames only: the Buildroot platform key of the board the
     * device detected itself to be (`raspberry-pi-5` / `raspberry-pi-64` /
     * `raspberry-pi-32`), i.e. which SD image it runs. Absent on boards
     * FrameOS publishes no image for and on firmware older than 2026.8 —
     * `platform` above is the deployment MODE ("buildroot"), never a board. */
    board?: string | null
    device?: string | null
    panel?: string | null
    width?: number | null
    height?: number | null
    color?: string | null
    mac?: string | null
    /** major*100 + minor, as esp_chip_info reports it */
    chipRevision?: number | null
    chipCores?: number | null
    memory?: {
      internalHeapBytes?: number | null
      psramBytes?: number | null
    } | null
    /** Partition-map byte counts, mirroring the USB console's status JSON. */
    storage?: {
      flashBytes?: number | null
      nvsBytes?: number | null
      otadataBytes?: number | null
      phyBytes?: number | null
      factorySlotBytes?: number | null
      otaSlots?: number | null
      otaSlotBytes?: number | null
      otaBytes?: number | null
      stateBytes?: number | null
    } | null
    ota?: {
      supported?: boolean | null
      slotBytes?: number | null
    } | null
    sd?: {
      enabled?: boolean | null
      mounted?: boolean | null
      capacityBytes?: number | null
    } | null
  } | null
  /** Cloud only: the firmware version the device itself reports, refreshed on
   * every hub hello/state. Compare against the latest published release
   * (GET /api/frames/firmware, whose `release` keeps its "v" prefix). */
  frameos_version?: string | null
  /** Cloud only: bumped whenever the hub hears from the device. */
  last_seen_at?: string | null
  frame_host: string
  frame_port: number
  frame_access_key: string
  frame_access: string
  frame_admin_auth?: {
    enabled?: boolean
    user?: string
    pass?: string
  }
  https_proxy?: {
    enable?: boolean
    port?: number
    expose_only_port?: boolean
    certs?: {
      server?: string
      server_key?: string
      client_ca?: string
    }
    server_cert_not_valid_after?: string
    client_ca_cert_not_valid_after?: string
  }
  ssh_user?: string
  ssh_pass?: string
  ssh_port: number
  ssh_keys?: string[]
  server_host?: string
  server_port: number
  server_api_key?: string
  server_send_logs?: boolean
  status: string
  archived?: boolean
  version?: string
  width?: number
  height?: number
  device?: string
  timezone?: string
  timezone_updater?: {
    enabled?: boolean
    hour?: number
    url?: string
  } | null
  device_config?: {
    vcom?: number | string
    partial?: boolean
    partialMaxAreaPercent?: number
    partialMaxRefreshesBeforeFull?: number
    uploadUrl?: string
    uploadHeaders?: { name: string; value: string }[]
    psramMB?: number
    /** ESP32 power management, backend-managed frames.
     *
     * The cloud pushes these as top-level `set_settings` keys (see
     * deep_sleep/battery_pin/… below); a backend-managed board reads them
     * from here — baked into the firmware build as compile-time defaults and
     * re-sent on every settings poll (embedded_frame_settings in
     * backend/app/api/embedded_device.py). Both spellings appear in the wild:
     * the workspace writes camelCase, USB-console provisioning writes
     * snake_case, and the backend reads either. */
    deepSleep?: boolean
    deep_sleep?: boolean
    deepSleepOnBattery?: boolean
    deep_sleep_on_battery?: boolean
    wakeCheckSeconds?: number
    wake_check_seconds?: number
    batteryPin?: number
    battery_pin?: number
    batteryDivider?: number
    battery_divider?: number
    renderMode?: 'local' | 'remote' | 'on_device' | 'thin_client' | 'backend'
    hardwarePreset?: FrameEmbeddedHardwarePreset
    /** Virtual frames only: how the backend quantizes the rendered image.
     * Mirrors VIRTUAL_COLOR_MODES in backend/app/api/virtual_frame.py. */
    colorMode?: FrameVirtualColorMode
    // View-only credential for the virtual image/page URLs
    viewToken?: string
    pins?: {
      rst?: number
      dc?: number
      cs?: number
      cs2?: number
      busy?: number
      sck?: number
      sclk?: number
      mosi?: number
      pwr?: number
      // Pimoroni Inky Frame extras: BUSY and the front buttons live behind a
      // shift register; consumed by the pico firmware only.
      sr_clock?: number
      sr_latch?: number
      sr_data?: number
      busy_bit?: number
      hold_vsys?: number
    }
    sdCardAssets?: {
      enabled?: boolean
      preset?: 'custom' | 'waveshare_esp32_s3_photopainter' | 'waveshare_esp32_s3_epaper_13_3e6'
      pins?: {
        cs?: number
        sck?: number
        miso?: number
        mosi?: number
      }
      maxFrequencyKHz?: number
      mountPath?: string
    }
  }
  color?: string
  interval: number
  metrics_interval: number
  max_http_response_bytes?: number
  scaling_mode: string
  rotate?: number
  /** ESP32 power management (cloud set_settings mirror, frames.settings). */
  deep_sleep?: boolean
  deep_sleep_on_battery?: boolean
  wake_check_seconds?: number
  battery_pin?: number
  battery_divider?: number
  flip?: 'horizontal' | 'vertical' | 'both' | ''
  background_color: string // deprecated, serves as fallback for scenes
  scenes?: FrameScene[]
  debug?: boolean
  last_log_at?: string
  log_to_file?: string
  assets_path?: string
  save_assets?: boolean | Record<string, boolean>
  upload_fonts?: string
  last_successful_deploy?: Record<string, any>
  last_successful_deploy_at?: string
  active_scene_id?: string
  /** Cloud only: the device-reported state the hub mirrors onto the frame row (e.g. active_scene). */
  last_state?: Record<string, any>
  /** Cloud only: the checksum of the scene payload the CONTROL PLANE has
   * assigned, and the one the DEVICE last acknowledged applying. Equal means
   * in sync; a device that never acked one has never had a scene delivered,
   * which is the cloud's notion of "not deployed yet" (there is no
   * last_successful_deploy_at on this control plane). */
  assigned_checksum?: string | null
  scenes_checksum?: string | null
  /** Cloud only: per-STORE-scene deploy ledger ({storeSceneId: {version,
   * checksum}}). assigned_scene_state describes the last assignment push;
   * deployed_scene_state is the hub's copy of it from the moment the device
   * acked the matching set checksum. Null/absent on frames that predate the
   * ledger — per-scene sync state then falls back to all-or-nothing. */
  assigned_scene_state?: Record<string, CloudSceneDeployState> | null
  deployed_scene_state?: Record<string, CloudSceneDeployState> | null
  /** Cloud only, client-side: which store scene each hydrated RUNTIME scene
   * came from, recorded while fetching scenes.json per assignment
   * (framesModel.hydrateCloudFrameScenes). Keyed by runtime scene id. */
  cloud_scene_sources?: Record<string, CloudSceneSource>
  /** Cloud only: the newest metrics sample the device sent. Read for the
   * memory advisory (utils/frameMemory.ts) — an embedded frame can render
   * fine while having too little internal RAM left to open its TLS link. */
  last_metrics?: Record<string, any>
  reboot?: {
    enabled?: 'true' | 'false'
    crontab?: string
    type?: 'frameos' | 'raspberry'
  }
  control_code?: {
    enabled?: 'true' | 'false'
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
    size?: string
    padding?: string
    offsetX?: string
    offsetY?: string
    qrCodeColor?: string
    backgroundColor?: string
  }
  schedule?: FrameSchedule
  gpio_buttons?: GPIOButton[]
  network?: {
    wifiSSID?: string
    wifiPassword?: string
    networkCheck?: boolean
    networkCheckTimeoutSeconds?: number
    networkCheckUrl?: string
    wifiHotspot?: string
    wifiHotspotSsid?: string
    wifiHotspotPassword?: string
    wifiHotspotTimeoutSeconds?: number
  }
  agent?: {
    agentEnabled?: boolean
    agentRunCommands?: boolean
    agentSharedSecret?: string
    deployWithAgent?: boolean
    agentVersion?: string | null
  }
  mountpoints?: FrameMountpointsConfig
  error_behavior?: FrameErrorBehavior
  palette?: Palette
  buildroot?: FrameBuildrootConfig
  embedded?: FrameEmbeddedConfig
  rpios?: FrameRpiOSConfig
  terminal_history?: string[]
  active_connections?: number
  // Cloud frames only: whether the device's management WebSocket is live on
  // the hub right now. Commands sent while false queue until it redials.
  connected?: boolean
  frame_sync_hint?: FrameSyncHint
}

export type FrameSyncSectionId = 'frame_json' | 'scenes_json'
export type FrameSyncChoice = 'backend' | 'frame' | 'ignore'
export type FrameSyncSceneChoice = FrameSyncChoice | 'both'

export interface FrameSyncHint {
  has_changes: boolean
  checked_at?: string | null
  current_revision?: string | null
  deployed_revision?: string | null
  frame_config_modified_at?: string | null
  scenes_modified_at?: string | null
  last_successful_deploy_at?: string | null
}

export interface FrameSyncChangeDetail {
  path: string
  backend: string
  frame: string
}

export interface FrameSyncChange {
  path: string
  choice_key?: string
  label: string
  kind: 'added' | 'removed' | 'changed'
  backend: string
  frame: string
  backend_json?: Record<string, any>
  frame_json?: Record<string, any>
  details?: FrameSyncChangeDetail[]
}

export interface FrameSyncSection {
  id: FrameSyncSectionId
  label: string
  filename: string
  has_changes: boolean
  backend_updated_at?: string | null
  frame_updated_at?: string | null
  changes: FrameSyncChange[]
}

export interface FrameSyncStatus {
  status: 'ok'
  has_changes: boolean
  checked_at: string
  last_in_sync_at?: string | null
  backend?: {
    last_successful_deploy_at?: string | null
    updated_at?: string | null
  }
  frame?: {
    id?: number | string | null
    name?: string | null
    current_revision?: string | null
    deployed_revision?: string | null
    frame_config_modified_at?: string | null
    scenes_modified_at?: string | null
    last_successful_deploy_at?: string | null
  }
  sections: FrameSyncSection[]
}

export interface FrameMountpointConfig {
  enabled?: boolean
  source?: string
  target?: string
  username?: string
  password?: string
  domain?: string
  options?: string
}

export interface FrameMountpointsConfig {
  enabled?: boolean
  items?: FrameMountpointConfig[]
}

export type FrameMode = 'rpios' | 'buildroot' | 'embedded' | 'import' | 'adopt'
export type FrameInstallMethod = 'sd_card' | 'ssh' | 'script' | 'embedded'
export interface NewFrameFormType {
  mode: FrameMode
  install_method?: FrameInstallMethod
  name?: string | null
  frame_host?: string | null
  device?: string | null
  device_config?: FrameType['device_config']
  embedded?: FrameEmbeddedConfig
  /** Virtual frames only. FrameCreateRequest has no width/height fields, so
   * these are applied with a follow-up update right after creation. */
  width?: number
  height?: number
  timezone?: string | null
  server_host?: string | null
  ssh_pass?: string | null
  ssh_keys?: string[]
  gpio_buttons?: GPIOButton[]
  platform?: string | null
  agent?: {
    agentEnabled?: boolean
    agentRunCommands?: boolean
    deployWithAgent?: boolean
  }
  network?: {
    wifiSSID?: string
    wifiPassword?: string
  }
  rememberWifi?: boolean
}

export interface GPIOButton {
  pin: number
  label: string
}

export interface FrameSchedule {
  events: ScheduledEvent[]
  disabled?: boolean
}

export interface ScheduledEvent {
  id: string
  minute: number
  hour: number
  weekday: number // undefined/null/''/0 for every day, 1-7 mon-sun, 8 for every weekday, 9 for every weekend
  /** setCurrentScene shows a scene; restart / reboot (utils/scheduleEvents.ts) carry an empty payload. */
  event: ScheduledEventName
  payload: { sceneId?: string; state?: Record<string, any> }
  disabled?: boolean
}

export interface TemplateType {
  id?: string
  name: string
  description?: string
  scenes?: FrameScene[]
  /** Repository templates ship metadata only; fetch the scenes from here on install or when needed. */
  scenesUrl?: string
  /** Template version (explicit or a content hash of the scenes); used to detect scene updates. */
  version?: string
  /** Set to false in template.json when the template cannot run on embedded (ESP32) frames. */
  embedded?: boolean
  image?: any
  imageWidth?: number
  imageHeight?: number
  /** Publisher display name (FrameOS Cloud store scenes). */
  author?: string
  /** FrameOS version the scene was exported with (FrameOS Cloud store scenes). */
  frameosVersion?: string
  /** Risk flags computed by the cloud store, e.g. 'shell' for scenes that run shell commands. */
  flags?: string[]
  /** Store scene uuid ("Private cloud scenes" entries). */
  sceneId?: string
  /** Scene page on the cloud store. */
  url?: string
  /** 'private' | 'public' ("Private cloud scenes" entries). */
  visibility?: string
}

export interface TemplateForm extends TemplateType {
  exportScenes?: string[]
}

export interface RepositoryType {
  id?: string
  name: string
  description?: string
  url: string
  last_updated_at?: string
  templates?: TemplateType[]
}

export interface LogType {
  id: number
  timestamp: string
  ip: string
  type: string
  line: string
  frame_id: FrameId
}

export interface AiSceneLogType {
  message: string
  requestId?: string
  status?: string
  stage?: string
  timestamp: string
}

export interface AssetType {
  path: string
  size: number
  mtime: number
  is_dir?: boolean
}

export interface MetricsType {
  id: string
  timestamp: string
  frame_id: FrameId
  metrics: Record<string, any>
}

export type FieldType =
  | 'string'
  | 'text'
  | 'float'
  | 'integer'
  | 'boolean'
  | 'color'
  | 'date'
  | 'json'
  | 'node'
  | 'scene'
  | 'image'
  | 'font'
  | 'path'

export const fieldTypes = [
  'string',
  'text',
  'float',
  'integer',
  'boolean',
  'color',
  'date',
  'json',
  'node',
  'scene',
  'image',
  'font',
  'path',
] as const

/** What a 'path' field may point at. Defaults to 'file' when absent. */
export type PathFieldPick = 'file' | 'folder' | 'any'

export type AppConfigFieldType = FieldType | 'select' | 'font'

export const appConfigFieldTypes = [...fieldTypes, 'select'] as const

export const toFieldType: (value: string | AppConfigFieldType) => FieldType = (value) =>
  fieldTypes.includes(value as any) ? (value as FieldType) : 'string'

export type ConfigFieldConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'empty'
  | 'notEmpty'
  | 'in'
  | 'notIn'

export interface ConfigFieldCondition {
  field: string | '.meta.showOutput' | '.meta.showNextPrev'
  operator?: ConfigFieldConditionOperator
  value?: any
}

export interface ConfigFieldConditionAnd {
  and: ConfigFieldCondition[]
}

export interface AppConfigField {
  /** Unique config field keyword */
  name: string
  /** Human readable label */
  label: string
  /** Type of the field */
  type: AppConfigFieldType
  /** List of options for the field, only used if type is 'select' */
  options?: string[]
  /** Whether the path points at a file, a folder or either, only used if type is 'path' */
  pick?: PathFieldPick
  /** Allowed file extensions without the dot (e.g. ["jpg", "png"]), only used if type is 'path' */
  extensions?: string[]
  /** Whether the field is required */
  required?: boolean
  /** Whether the field is a secret and is hidden from display */
  secret?: boolean
  /** Default value for the field */
  value?: any
  /** Placeholder text for the field */
  placeholder?: string
  /** Info tooltip contents (markdown) */
  hint?: string
  /** Number of rows for the field, only used if type is 'text' */
  rows?: number
  /** Turn the field into a multidimensional array of fields. seq=[1, "rows"] --> for 1 to rows */
  seq?: [string, number | string, number | string][]
  /** Conditions on which to show the field */
  showIf?: (ConfigFieldCondition | ConfigFieldConditionAnd)[]
  /** Runtime-only: what this input port can negotiate. Never shown in the editor. */
  capabilities?: InputPortCapabilities
}

/**
 * Execution protocols a port declares, read by the frame's planner
 * (frameos/planner.nim) and never by the editor — see docs/value-pipeline.md.
 * Absent means "materialized", the floor every edge supports.
 */
export interface ProvidesTargetCapability {
  /** Config field carrying the fit (cover/contain/stretch) to ask the producer for */
  fitFrom?: string
  /** Fits this port can hand upstream */
  fits?: string[]
  /** Field -> values it must statically resolve to for the capability to apply */
  requireStatic?: Record<string, string[]>
  /**
   * Extra requireStatic constraints applied when the producer composites into the
   * target (a JS app drawing source-over) instead of overwriting every fitted pixel
   */
  compositingRequireStatic?: Record<string, string[]>
  /** Fields that must be neither configured nor wired */
  requireUnset?: string[]
  /** Field/value combinations where an app-owned scratch target changes the pixels */
  ownedTargetExcludes?: Record<string, string>[]
}

export interface IntoTargetCapability {
  fits?: string[]
  requireStatic?: Record<string, string[]>
  requireUnset?: string[]
  /**
   * Color fields that must statically resolve to a fully opaque color for the
   * capability to apply — the "output is opaque given these fields" promise
   * that lets a generator (gradient, solid color) fill the target in place.
   */
  requireOpaqueColor?: string[]
}

export interface ForwardsTargetCapability {
  /** Input port the target request is passed on to */
  input: string
  requireStatic?: Record<string, string[]>
}

export interface InputPortCapabilities {
  /** This input can hand its producer an image to write into */
  providesTarget?: ProvidesTargetCapability
}

export interface ForwardsBoundsCapability {
  /** Input port the consumer's useful-resolution bounds are passed on to */
  input: string
  /**
   * Field controlling the geometry (a rotation degree): values in `swap`
   * exchange width and height, values in `keep` pass them through, anything
   * else refuses the bounds plan.
   */
  swapWhen?: { field: string; swap: string[]; keep: string[] }
  /** Or replace the bounds with these fields' static values (a resize) */
  widthFrom?: string
  heightFrom?: string
}

export interface OutputPortCapabilities {
  /** This output writes into a caller-supplied image instead of allocating one */
  intoTarget?: IntoTargetCapability
  /** This output passes a target request upstream and mutates the result in place */
  forwardsTarget?: ForwardsTargetCapability
  /** This output passes useful-resolution bounds upstream (requestedBounds) */
  forwardsBounds?: ForwardsBoundsCapability
}

export interface OutputField {
  /** Name of the output field */
  name: string
  /** Type of the field */
  type: FieldType
  /** Example output (stringified) */
  example?: string
  /** Runtime-only: what this output port can negotiate. Never shown in the editor. */
  capabilities?: OutputPortCapabilities
}

/** config.json schema */
export interface AppConfig {
  /** Name for this app */
  name: string
  /** Category for this app */
  category?: string
  /** Description for this app */
  description?: string
  /** Version for this app */
  version?: string
  /** List of top level settings exported for this app */
  settings?: string[]
  /** List of apt packages to install (mode=rpios) */
  apt?: string[]
  /** Fields for app in diagram editor */
  fields?: (AppConfigField | MarkdownField)[]
  /** Returned fields */
  output?: OutputField[]
  /** Default cache settings */
  cache?: CacheConfig
  /** Origin app this app was created from, such as repo/apps/code/jsText */
  origin?: string
}

export interface SceneApp extends Partial<AppConfig> {
  sources: Record<string, string>
}

export interface FontMetadata {
  file: string
  name: string
  weight: number
  weight_title: string
  italic: boolean
}

export interface StateField extends AppConfigField {
  persist?: 'memory' | 'disk'
  access?: 'private' | 'public'
}

export interface MarkdownField {
  /** Block of markdown text to display between fields */
  markdown: string
  /** Conditions on which to show the field */
  showIf?: ConfigFieldCondition[]
}

export interface CacheConfig {
  enabled?: boolean

  inputEnabled?: boolean

  durationEnabled?: boolean
  duration?: string

  expressionEnabled?: boolean
  expression?: string
  expressionType?: FieldType
}

export type NodeType = 'app' | 'source' | 'dispatch' | 'code' | 'event' | 'state' | 'scene'
export type EdgeType = 'appNodeEdge' | 'codeNodeEdge'

export interface AppNodeData {
  keyword: string
  name?: string
  config: Record<string, any>
  sources?: Record<string, string>
  cache?: CacheConfig
}

export interface CodeArg {
  name: string
  type: FieldType
}

export interface CodeNodeData {
  code?: string
  codeJS?: string
  codeArgs?: CodeArg[]
  codeOutputs?: CodeArg[]
  cache?: CacheConfig
  logOutput?: boolean
}

export interface StateNodeData {
  keyword: string
}

export interface EventNodeData {
  keyword: string
  config?: Record<string, any>
}

export interface ButtonEventNodeData extends EventNodeData {
  keyword: 'button'
  label?: string
}

export interface DispatchNodeData {
  keyword: string
  config: Record<string, any>
}

export interface SceneNodeData {
  keyword: string
  config: Record<string, any>
}

export type NodeData = AppNodeData | CodeNodeData | EventNodeData | DispatchNodeData | StateNodeData | SceneNodeData

export type DiagramNode = Node<NodeData, NodeType>
// Scene edges are serialized JSON and only use custom string edge types, so `label` is
// narrowed to `string`: React 19 types ReactElement props as `unknown`, which kea-forms'
// DeepPartial can't recurse into, making the raw `Edge<any>` (whose `label` is a ReactNode)
// unusable in form value types.
export type DiagramEdge = Omit<Edge<any>, 'label'> & { label?: string }

export interface HandleType {
  handleId: string
  handleType: 'source' | 'target'
}

export interface PrevNodeHandle extends HandleType {
  handleId: 'prev'
  handleType: 'target'
}

export interface NextNodeHandle extends HandleType {
  handleId: 'next'
  handleType: 'source'
}

export interface AppInputHandle extends HandleType {
  handleId: `fieldInput/${string}`
  handleType: 'target'
}

export interface AppNodeOutputHandle extends HandleType {
  handleId: `field/${string}`
  handleType: 'source'
}

export interface NewCodeInputHandle extends HandleType {
  handleId: `codeField/+`
  handleType: 'target'
}

export interface CodeInputHandle extends HandleType {
  handleId: `codeField/${string}`
  handleType: 'target'
}

export interface CodeOutputHandle extends HandleType {
  handleId: `fieldOutput`
  handleType: 'source'
}

export interface StateOutputHandle extends HandleType {
  handleId: `stateOutput`
  handleType: 'source'
}

export interface EdgeConnectionType {
  sourceHandle: HandleType & { handleType: 'source' }
  targetHandle: HandleType & { handleType: 'target' }
  sourceNodeType: NodeType
  targetNodeType: NodeType
}

export interface ConnectionAppNextPrev extends EdgeConnectionType {
  sourceHandle: NextNodeHandle
  targetHandle: PrevNodeHandle
  sourceNodeType: 'app' | 'source' | 'scene' | 'event'
  targetNodeType: 'app' | 'source' | 'scene'
}

export interface ConnectionAppNodeOutputPrev extends EdgeConnectionType {
  sourceHandle: AppNodeOutputHandle
  targetHandle: PrevNodeHandle
  sourceNodeType: 'app' | 'source'
  targetNodeType: 'app' | 'source'
}

export interface F extends EdgeConnectionType {
  sourceHandle: CodeOutputHandle
  targetHandle: CodeInputHandle
  sourceNodeType: 'app' | 'source' | 'event'
  targetNodeType: 'app' | 'source'
}

export interface ConnectionCodeOutputAppInput extends EdgeConnectionType {
  sourceHandle: CodeOutputHandle
  targetHandle: AppInputHandle
  sourceNodeType: 'app' | 'source' | 'event'
  targetNodeType: 'app' | 'source'
}

export interface ConnectionAppOutputAppInput extends EdgeConnectionType {
  sourceHandle: AppNodeOutputHandle
  targetHandle: AppInputHandle
  sourceNodeType: 'app' | 'source'
  targetNodeType: 'app' | 'source'
}

export interface FrameSceneSettings {
  refreshInterval?: number
  backgroundColor?: string
  execution?: 'compiled' | 'interpreted'
  prompt?: string
  autoArrangeOnLoad?: boolean
  splitScreenLayout?: Record<string, any>
}

/** Where an installed scene came from, so we can offer updates when the source template changes. */
export interface SceneOrigin {
  /** Repository id, e.g. "system-gallery" or a database uuid. */
  repositoryId?: string
  repositoryUrl?: string
  /** Template id/slug within the repository; matching falls back to templateName when absent. */
  templateId?: string
  templateName?: string
  /** The scene's id inside the template's scenes.json, used to re-link scenes on update. */
  sceneId?: string
  /** Template version at install time. */
  version?: string
}

export interface FrameScene {
  id: string
  name: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  apps?: Record<string, SceneApp>
  fields?: StateField[]
  customEvents?: FrameEvent[]
  default?: boolean
  settings?: FrameSceneSettings
  origin?: SceneOrigin
}

export interface FrameSceneIndexed {
  id: string
  name: string
  nodes: Record<string, DiagramNode>
  edges: Record<string, DiagramEdge[]>
}

export type ChatContextType = 'scene' | 'frame' | 'app'

export interface ChatSummary {
  id: string
  frameId: FrameId
  sceneId?: string | null
  contextType?: ChatContextType | null
  contextId?: string | null
  createdAt: string
  updatedAt: string
  messageCount?: number
  isLocal?: boolean
}

export interface ChatMessageRecord {
  id: string
  role: 'user' | 'assistant'
  content: string
  tool?: string | null
  createdAt: string
}

/** config.json schema */
export interface FrameEvent {
  /** Name for this app */
  name: string
  /** Description for this event */
  description?: string
  /** Fields for app in diagram editor */
  fields?: AppConfigField[]
  /** Can this event be dispatched */
  canDispatch?: boolean
  /** Can this event be listened to */
  canListen?: boolean
}

export interface FrameOSSettings {
  defaults?: {
    timezone?: string
    wifiSSID?: string
    wifiPassword?: string
    backendHost?: string
    backendPort?: string | number
  }
  homeAssistant?: {
    url?: string
    accessToken?: string
    syncEnabled?: boolean
    mqttHost?: string
    mqttPort?: string | number
    mqttUsername?: string
    mqttPassword?: string
  }
  frameOS?: {
    apiKey?: string
  }
  github?: {
    api_key?: string
  }
  immich?: {
    url?: string
    apiKey?: string
  }
  openAI?: {
    apiKey?: string
    backendApiKey?: string
    model?: string
    chatModel?: string
    /** Cloud only: reasoning effort for the workspace chat's model
     * ("minimal" | "low" | "medium" | "high"; empty = the default). */
    chatReasoningEffort?: string
    sceneModel?: string
    reviewModel?: string
    appChatModel?: string
    appEditModel?: string
    appEnhanceModel?: string
  }
  posthog?: {
    backendApiKey?: string
    backendHost?: string
    backendEnableErrorTracking?: boolean
    backendEnableLlmAnalytics?: boolean
  }
  repositories?: RepositoryType[]
  personal?: {
    favouriteTemplateIds?: string[]
  }
  ssh_keys?: {
    keys?: SSHKeyEntry[]
    default?: string
    default_public?: string
  }
  unsplash?: {
    accessKey?: string
  }
  buildEnvironment?: {
    provider?: 'none' | 'docker' | 'buildHost' | 'modal'
  }
  buildHost?: {
    enabled?: boolean
    host?: string
    user?: string
    port?: number
    sshKey?: string
    sshPublicKey?: string
  }
  modalSandbox?: {
    enabled?: boolean
    tokenId?: string
    tokenSecret?: string
    appName?: string
    image?: string
    timeout?: number
    idleTimeout?: number
    cpu?: number
    memory?: number
    region?: string
    cloud?: string
    environmentName?: string
    enableDocker?: boolean
  }
}

/** Mirrors GET /api/cloud/status (backend/app/api/cloud.py and the frame's cloud_api_routes.nim) */
export interface CloudUsage {
  scenes: { private_bytes: number; private_max_bytes: number; public_bytes: number }
  backups: { bytes: number; max_bytes: number }
  frame_logs: { bytes: number; max_bytes: number }
}

export interface CloudStatus {
  enabled: boolean
  provider_url: string | null
  default_provider_url: string | null
  status: 'disconnected' | 'connecting' | 'connected'
  can_edit_provider: boolean
  poll_error: string | null
  connection: {
    user_code: string | null
    verification_uri: string | null
    verification_uri_complete: string | null
    expires_at: string | null
    interval_seconds: number
  } | null
  link: {
    linked_client_id: string | null
    scopes: string[]
    account_id: string | null
    account_email: string | null
    connected_at: string | null
    last_inventory_sync_at: string | null
    /** Storage usage + quota snapshot from the provider's grants poll.
     * Public scenes are quota-free, hence the private/public split. */
    usage?: CloudUsage | null
  } | null
  /** True unless cloud login is enforced (local passwords disabled). */
  local_fallback_enabled?: boolean
  /** Local switches: the backup scopes come with the account, but nothing is
   * uploaded until these are turned on. */
  backup_scenes_enabled?: boolean
  backup_frames_enabled?: boolean
  /** Short id (e.g. "AB12-CD34") of the key sealing every backup payload;
   * null until the key is generated with the first backup. */
  backup_key_fingerprint?: string | null
  /** A pending feature change awaiting owner approval on the provider. */
  upgrade?: {
    user_code: string | null
    verification_uri: string | null
    verification_uri_complete: string | null
    expires_at: string | null
    interval_seconds: number
  } | null
  /** The current user's linked cloud identity, if any. */
  identity?: {
    cloud_account_id: string | null
    email: string | null
    name: string | null
    provider_url: string | null
    last_login_at: string | null
  } | null
  /** Frame admin only: set once the frame is enrolled as cloud-managed. */
  mode?: 'managed'
  /** Frame admin only: a self-hosted backend controls this frame, so
   * cloud-managed enrollment is unavailable until serverHost is cleared. */
  backend_managed?: boolean
}

/** Mirrors GET /api/cloud/login/options (open endpoint for the login/setup screens) */
export interface CloudLoginOptions {
  available: boolean
  provider_url: string | null
  local_login_enabled: boolean
  setup_mode: boolean
}

/** GET /api/cloud/backup-key: the recovery code for the account backup key. */
export interface CloudBackupKey {
  fingerprint: string
  recovery_code: string
}

/** One backup as listed by GET /api/cloud/backups (proxied from the provider) */
export interface CloudBackupItem {
  id: string
  kind: 'templates' | 'frames' | string
  item_key: string
  name: string | null
  size_bytes: number
  sha256: string
  content_type: string | null
  created_at: string
  updated_at: string
}

export interface SSHKeyEntry {
  id: string
  name?: string
  private?: string
  public?: string
  use_for_new_frames?: boolean
}

export interface FrameStateCacheInfo {
  cached: boolean
  refreshing: boolean
  fetched_at?: number | null
  refresh_after?: number | null
  retry_after?: number | null
  error?: string | null
}

export interface FrameStateRecord {
  sceneId: string
  states: Record<string, Record<string, any>>
  cache?: FrameStateCacheInfo
}

export interface FrameUploadedScenesRecord {
  scenes: FrameScene[]
}

export interface Palette {
  name?: string
  colors: string[]
  colorNames?: string[]
}

export interface FrameBuildrootConfig {
  platform?: string
  compilationMode?: FrameCompilationModeOptionValue
  sdImage?: {
    status?: 'idle' | 'queued' | 'building' | 'ready' | 'error' | 'missing' | 'stale'
    buildId?: string
    requestId?: string
    queueJobId?: string
    platform?: string
    buildrootVersion?: string
    filename?: string
    rawFilename?: string
    path?: string
    compressed?: boolean
    customizationVersion?: number
    rawSize?: number
    rawSha256?: string
    size?: number
    sha256?: string
    downloadUrl?: string
    queuedAt?: string
    startedAt?: string
    completedAt?: string
    createdAt?: string
    error?: string
  }
}

export interface FrameRpiOSConfig {
  platform?: string
  crossCompilation?: '' | 'auto' | 'always' | 'never'
  compilationMode?: FrameCompilationModeOptionValue
}

export interface FrameEmbeddedConfig {
  platform?: string
  flashSize?: FrameEmbeddedFlashSize
  hardwarePreset?: FrameEmbeddedHardwarePreset
  lastBoot?: {
    at?: string
    source?: string
    version?: string
    frameosVersion?: string
    ip?: string
    width?: number
    height?: number
    pixelFormat?: number
    mode?: string
    renderMode?: string
    panel?: string
    wifi?: string
  }
  firmware?: {
    status?: 'idle' | 'queued' | 'building' | 'ready' | 'error' | 'missing' | 'stale'
    requestId?: string
    queueJobId?: string
    platform?: string
    flashSize?: FrameEmbeddedFlashSize
    flashBytes?: number
    partitionTable?: string
    otaSupported?: boolean
    filename?: string
    path?: string
    size?: number
    sha256?: string
    flashOffset?: string
    downloadUrl?: string
    panel?: string
    otaPath?: string
    otaSha256?: string
    otaElfSha256?: string
    otaSize?: number
    appSize?: number
    bootloaderSize?: number
    partitionTableSize?: number
    layout?: {
      flash?: {
        flashSize?: FrameEmbeddedFlashSize
        flashBytes?: number
        partitionTable?: string
        otaSupported?: boolean
        flashOffset?: string
        mergedBinaryBytes?: number | null
        appBinaryBytes?: number | null
        otaBinaryBytes?: number | null
        partitions?: {
          name: string
          type?: string
          subtype?: string
          offset: number
          size: number
          end?: number
          appSlot?: boolean
          usedBytes?: number | null
        }[]
      }
      ram?: {
        psramBytes?: number
        panel?: string
        width?: number
        height?: number
        pixelFormat?: number
        pixelFormatName?: string
        renderMode?: 'local' | 'remote'
        rgbaBufferBytes?: number
        canvasBufferBytes?: number
        canvasBytesPerPixel?: number
        packedBufferBytes?: number
        renderReserveBytes?: number
        renderWorkingBytes?: number
        quickJsHeapLimitBytes?: number
        previewSnapshotBytes?: number
        previewSnapshotReserveBytes?: number
        previewBmpBytes?: number
        displayStateBytes?: number
        httpResponseLimitBytes?: number
      }
    }
    queuedAt?: string
    startedAt?: string
    lastHeartbeatAt?: string
    completedAt?: string
    error?: string
    /** Ninja's edge count while `status` is "building", republished on the
     * build's 15-second heartbeat. A first build of a chip target is ~1100
     * edges, so this is the difference between "slow" and "hung". */
    buildProgress?: {
      done: number
      total: number
      percent: number
    }
  }
}
