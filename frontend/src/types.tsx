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

export interface MetricsType {
  id: string
  timestamp: string
  frame_id: number
  metrics: Record<string, any>
}

export const configFieldTypes = [
  'string',
  'text',
  'float',
  'integer',
  'boolean',
  'color',
  'select',
  'json',
  'node',
] as const

export interface ConfigField {
  /** Unique config field keyword */
  name: string
  /** Human readable label */
  label: string
  /** Type of the field, only 'string' is supported for now */
  type: 'string' | 'text' | 'float' | 'integer' | 'boolean' | 'color' | 'select' | 'json' | 'node' | 'scene'
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
  /** Number of rows for the field, only used if type is 'text' */
  rows?: number
}

export interface StateField extends ConfigField {
  persist?: 'memory' | 'disk'
  access?: 'private' | 'public'
}

export interface MarkdownField {
  /** Block of markdown text to display between fields */
  markdown: string
}

/** config.json schema */
export interface App {
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
  fields?: (ConfigField | MarkdownField)[]
}

export type NodeType = 'app' | 'source' | 'dispatch' | 'code' | 'event'

export interface AppNodeData {
  keyword: string
  name?: string
  config: Record<string, any>
  sources?: Record<string, string>
}

export interface CodeNodeData {
  code: string
}

export interface EventNodeData {
  keyword: string
}

export interface DispatchNodeData {
  keyword: string
  config: Record<string, any>
}

export type NodeData = AppNodeData | CodeNodeData | EventNodeData | DispatchNodeData

export type DiagramNode = Node<NodeData, NodeType>

export interface FrameSceneSettings {
  refreshInterval?: number
  backgroundColor?: string
}

export interface FrameScene {
  id: string
  name: string
  nodes: DiagramNode[]
  edges: Edge[]
  fields?: StateField[]
  default?: boolean
  settings?: FrameSceneSettings
}

export interface FrameSceneIndexed {
  id: string
  name: string
  nodes: Record<string, DiagramNode>
  edges: Record<string, Edge[]>
}

/** config.json schema */
export interface FrameEvent {
  /** Name for this app */
  name: string
  /** Description for this event */
  description?: string
  /** Fields for app in diagram editor */
  fields?: ConfigField[]
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
  Debug = 'Debug',
  Diagram = 'Diagram',
  FrameDetails = 'FrameDetails',
  FrameSettings = 'FrameSettings',
  Image = 'Image',
  Logs = 'Logs',
  SceneState = 'SceneState',
  Control = 'Control',
  Apps = 'Apps',
  Events = 'Events',
  Metrics = 'Metrics',
  EditApp = 'EditApp',
  Terminal = 'Terminal',
  SceneSource = 'SceneSource',
  Scenes = 'Scenes',
  Templates = 'Templates',
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
