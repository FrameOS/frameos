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
  image_url?: string
  interval: number
}
export interface LogType {
  id: number
  timestamp: string
  type: string
  line: string
  frame_id: number
}
