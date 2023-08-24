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
  background_color: string
  apps?: AppConfig[]
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
  value?: any
  placeholder?: string
}

export interface AppConfigUninstalled {
  name: string
  description: string
  version: string
  fields: ConfigField[]
}

export interface AppConfig extends AppConfigUninstalled {
  keyword: string
  config: Record<string, any>
}
