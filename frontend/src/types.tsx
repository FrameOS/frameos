import { Edge, Node } from 'reactflow'

export interface FrameType {
  id: number
  name: string
  frame_host: string
  frame_port: number
  frame_access_key: string
  frame_access: string
  ssh_user?: string
  ssh_pass?: string
  ssh_port: number
  server_host?: string
  server_port: number
  server_api_key?: string
  status: string
  version?: string
  width?: number
  height?: number
  device?: string
  color?: string
  interval: number
  metrics_interval: number
  scaling_mode: string
  rotate?: number
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
}

export interface FrameSchedule {
  events: ScheduledEvent[]
}

export interface ScheduledEvent {
  id: string
  minute: number
  hour: number
  weekday: number // undefined/null/''/0 for every day, 1-7 mon-sun, 8 for every weekday, 9 for every weekend
  event: 'setCurrentScene'
  payload: { sceneId: string; state: Record<string, any> }
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
  type: string
  line: string
  frame_id: number
}

export interface AssetType {
  path: string
  size: number
  mtime: number
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
  'json',
  'node',
  'scene',
  'image',
  'font',
] as const

export type AppConfigFieldType = FieldType | 'select' | 'font'
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
  /** Fields for app in diagram editor */
  fields?: (AppConfigField | MarkdownField)[]
  /** Returned fields */
  output?: OutputField[]
  /** Default cache settings */
  cache?: CacheConfig
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

export type NodeType = 'app' | 'source' | 'dispatch' | 'code' | 'event' | 'state'
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
  code: string
  codeArgs?: CodeArg[]
  codeOutputs?: CodeArg[]
  cache?: CacheConfig
}

export interface StateNodeData {
  keyword: string
}

export interface EventNodeData {
  keyword: string
}

export interface DispatchNodeData {
  keyword: string
  config: Record<string, any>
}

export type NodeData = AppNodeData | CodeNodeData | EventNodeData | DispatchNodeData | StateNodeData

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
  sourceNodeType: 'app' | 'source' | 'event'
  targetNodeType: 'app' | 'source'
}

export interface ConnectionAppNodeOutputPrev extends EdgeConnectionType {
  sourceHandle: AppNodeOutputHandle
  targetHandle: PrevNodeHandle
  sourceNodeType: 'app' | 'source'
  targetNodeType: 'app' | 'source'
}

export interface ConnectionCodeInputOutput extends EdgeConnectionType {
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

export interface FrameSceneSettings {
  refreshInterval?: number
  backgroundColor?: string
}

export interface FrameScene {
  id: string
  name: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
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

export enum Area {
  TopLeft = 'TopLeft',
  TopRight = 'TopRight',
  BottomLeft = 'BottomLeft',
  BottomRight = 'BottomRight',
}

export enum Panel {
  Action = 'Action',
  Apps = 'Apps',
  Asset = 'Asset',
  Assets = 'Assets',
  Debug = 'Debug',
  Diagram = 'Diagram',
  EditApp = 'EditApp',
  Events = 'Events',
  FrameDetails = 'FrameDetails',
  FrameSettings = 'FrameSettings',
  Image = 'Image',
  Logs = 'Logs',
  Metrics = 'Metrics',
  SceneJSON = 'SceneJSON',
  Scenes = 'Scenes',
  SceneSource = 'SceneSource',
  SceneState = 'SceneState',
  Schedule = 'Schedule',
  Templates = 'Templates',
  Terminal = 'Terminal',
}

export type PanelWithMetadata = {
  panel: Panel
  key?: string
  title?: string
  active?: boolean
  hidden?: boolean
  metadata?: Record<string, any>
  closable?: boolean
}

export interface FrameOSSettings {
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
  sentry?: {
    controller_dsn?: string
    frame_dsn?: string
  }
  openAI?: {
    apiKey?: string
  }
  repositories?: RepositoryType[]
  ssh_keys?: {
    default?: string
    default_public?: string
  }
  unsplash?: {
    accessKey?: string
  }
}

export interface FrameStateRecord {
  sceneId: string
  states: Record<string, Record<string, any>>
}
