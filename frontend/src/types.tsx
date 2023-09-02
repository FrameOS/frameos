import { Edge, Node } from 'reactflow'

export interface FrameType {
  id: number
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
  scaling_mode: string
  rotate?: number
  background_color: string
  scenes?: FrameScene[]
}

export interface LogType {
  id: number
  timestamp: string
  type: string
  line: string
  frame_id: number
}

export interface ConfigField {
  name: string
  label: string
  type: string
  options?: string[]
  required?: boolean
  secret?: boolean
  value?: any
  placeholder?: string
}

export interface App {
  name: string
  category: string
  description: string
  version: string
  fields: ConfigField[]
}

export interface AppNodeData {
  keyword: string
  config: Record<string, any>
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
  Diagram = 'Diagram',
  FrameDetails = 'FrameDetails',
  FrameSettings = 'FrameSettings',
  Image = 'Image',
  Logs = 'Logs',
  Apps = 'Apps',
  Events = 'Events',
}

export type PanelWithMetadata = {
  panel: Panel
  label?: string
  active?: boolean
  hidden?: boolean
  metadata?: Record<string, any>
}
