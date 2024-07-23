import { Apps } from './Apps/Apps'
import { Asset } from './Assets/Asset'
import { Assets } from './Assets/Assets'
import { Control } from './Control/Control'
import { Debug } from './Debug/Debug'
import { Diagram } from './Diagram/Diagram'
import { EditApp } from './EditApp/EditApp'
import { Events } from './Events/Events'
import { FrameDetails } from './FrameDetails/FrameDetails'
import { FrameSettings } from './FrameSettings/FrameSettings'
import { Image } from './Image/Image'
import { Logs } from './Logs/Logs'
import { Metrics } from './Metrics/Metrics'
import { Panel } from '../../../types'
import { SceneJSON } from './SceneJSON/SceneJSON'
import { Scenes } from './Scenes/Scenes'
import { SceneSource } from './SceneSource/SceneSource'
import { SceneState } from './SceneState/SceneState'
import { Templates } from './Templates/Templates'
import { Terminal } from './Terminal/Terminal'

export const allPanels: Record<Panel, (...props: any[]) => JSX.Element> = {
  Action: () => <div />, // back button when fullscreen
  Apps,
  Asset,
  Assets,
  Control,
  Debug,
  Diagram,
  EditApp,
  Events,
  FrameDetails,
  FrameSettings,
  Image,
  Logs,
  Metrics,
  SceneJSON,
  Scenes,
  SceneSource,
  SceneState,
  Templates,
  Terminal,
}
