export interface FrameType {
  id: number
  host: string
  ssh_user?: string
  ssh_pass?: string
  ssh_port: number
  api_key?: string
  api_port: number
  status: string
  version?: string
}
export interface LogType {
  id: number
  timestamp: string
  type: string
  line: string
  frame_id: number
}
