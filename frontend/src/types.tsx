import { Edge, Node } from 'reactflow'

export interface FrameType {
  id: number
  name: string
  frame_host: string
  frame_port: number
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
  background_color: string
  scenes?: FrameScene[]
}

export interface TemplateType {
  id?: string
  name: string
  description?: string
  scenes?: FrameScene[]
  image?: any
  image_width?: number
  image_height?: number
  config?: {
    interval?: number
    background_color?: string
    scaling_mode?: string
    rotate?: number
  }
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

export interface ConfigField {
  /** Unique config field keyword */
  name: string
  /** Human readable label */
  label: string
  /** Type of the field, only 'string' is supported for now */
  type: 'string' | 'text' | 'select'
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

export interface AppNodeData {
  keyword: string
  name?: string
  config: Record<string, any>
  sources?: Record<string, string>
}

export interface EventNodeData {
  keyword: string
}

export interface FrameScene {
  id: string
  name: string
  nodes: Node[]
  edges: Edge[]
}

export interface FrameSceneIndexed {
  id: string
  name: string
  nodes: Record<string, Node[]>
  edges: Record<string, Edge[]>
}

export enum Area {
  TopLeft = 'TopLeft',
  TopRight = 'TopRight',
  BottomLeft = 'BottomLeft',
  BottomRight = 'BottomRight',
}

export enum Panel {
  Debug = 'Debug',
  Diagram = 'Diagram',
  FrameDetails = 'FrameDetails',
  FrameSettings = 'FrameSettings',
  Image = 'Image',
  Logs = 'Logs',
  Apps = 'Apps',
  Events = 'Events',
  EditApp = 'EditApp',
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
