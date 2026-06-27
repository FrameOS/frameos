import { Edge, Node } from 'reactflow'
import type { FrameCompilationModeOptionValue } from './utils/frameBuildOptions'

export type FrameErrorBehaviorMode = 'safe_mode' | 'show_error_retry' | 'silent_retry'
export type FrameEmbeddedFlashSize = '4MB' | '8MB' | '16MB' | '32MB'

export interface FrameErrorBehavior {
  mode?: FrameErrorBehaviorMode
  retry_seconds?: number
  silent_retry_seconds?: number
  silent_retry_forever?: boolean
  silent_window_minutes?: number
  show_error_retry_seconds?: number
}

export interface FrameType {
  id: number
  project_id: number
  name: string
  mode?: 'rpios' | 'buildroot' | 'embedded'
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
    renderMode?: 'local' | 'remote' | 'on_device' | 'thin_client' | 'backend'
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
    }
  }
  color?: string
  interval: number
  metrics_interval: number
  max_http_response_bytes?: number
  scaling_mode: string
  image_engine?: '' | 'pixie' | 'imagemagick'
  rotate?: number
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

export type FrameMode = 'rpios' | 'buildroot' | 'embedded' | 'import'
export type FrameInstallMethod = 'sd_card' | 'ssh' | 'script' | 'embedded'
export interface NewFrameFormType {
  mode: FrameMode
  install_method?: FrameInstallMethod
  name?: string | null
  frame_host?: string | null
  device?: string | null
  device_config?: FrameType['device_config']
  timezone?: string | null
  server_host?: string | null
  ssh_pass?: string | null
  ssh_keys?: string[]
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
  event: 'setCurrentScene'
  payload: { sceneId: string; state: Record<string, any> }
  disabled?: boolean
}

export interface TemplateType {
  id?: string
  name: string
  description?: string
  scenes?: FrameScene[]
  image?: any
  imageWidth?: number
  imageHeight?: number
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
  frame_id: number
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
  frame_id: number
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
] as const

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
}

export interface OutputField {
  /** Name of the output field */
  name: string
  /** Type of the field */
  type: FieldType
  /** Example output (stringified) */
  example?: string
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
export type DiagramEdge = Edge<any>

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

export interface FrameScene {
  id: string
  name: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  apps?: Record<string, SceneApp>
  fields?: StateField[]
  default?: boolean
  settings?: FrameSceneSettings
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
  frameId: number
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
  }
  homeAssistant?: {
    url?: string
    accessToken?: string
  }
  frameOS?: {
    apiKey?: string
  }
  github?: {
    api_key?: string
  }
  openAI?: {
    apiKey?: string
    backendApiKey?: string
    model?: string
    chatModel?: string
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
    queuedAt?: string
    startedAt?: string
    lastHeartbeatAt?: string
    completedAt?: string
    error?: string
  }
}
