import { Diagram } from './Diagram/Diagram'
import { FrameDetails } from './FrameDetails/FrameDetails'
import { FrameSettings } from './FrameSettings/FrameSettings'
import { Image } from './Image/Image'
import { Logs } from './Logs/Logs'
import { Apps } from './Apps/Apps'
import { Events } from './Events/Events'
import { Panel } from '../../../types'
import { EditApp } from './EditApp/EditApp'

export const allPanels: Record<Panel, (...props: any[]) => JSX.Element> = {
  Diagram,
  FrameDetails,
  FrameSettings,
  Image,
  Logs,
  Apps,
  Events,
  EditApp,
}
