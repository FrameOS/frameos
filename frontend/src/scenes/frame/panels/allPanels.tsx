import { Apps } from './Apps/Apps'
import { Asset } from './Assets/Asset'
import { Assets } from './Assets/Assets'
import { Debug } from './Debug/Debug'
import { Diagram } from './Diagram/Diagram'
import { EditApp } from './EditApp/EditApp'
import { Events } from './Events/Events'
import { FrameSettings } from './FrameSettings/FrameSettings'
import { Image } from './Image/Image'
import { Logs } from './Logs/Logs'
import { Metrics } from './Metrics/Metrics'
import { Panel } from '../../../types'
import { SceneJSON } from './SceneJSON/SceneJSON'
import { Scenes } from './Scenes/Scenes'
import { SceneSource } from './SceneSource/SceneSource'
import { SceneState } from './SceneState/SceneState'
import { Schedule } from './Schedule/Schedule'
import { Templates } from './Templates/Templates'
import { Terminal } from './Terminal/Terminal'

export const allPanels: Record<Panel, (...props: any[]) => JSX.Element> = {
  Action: () => <div />, // back button when fullscreen
  Apps,
  Asset,
  Assets,
  Debug,
  Diagram,
  EditApp,
  Events,
  FrameSettings,
  Image,
  Logs,
  Metrics,
  SceneJSON,
  Scenes,
  SceneSource,
  SceneState,
  Schedule,
  Templates,
  Terminal,
}
