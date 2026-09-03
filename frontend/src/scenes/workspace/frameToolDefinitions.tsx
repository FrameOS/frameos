import {
  AdjustmentsHorizontalIcon,
  BoltIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  ClockIcon,
  CommandLineIcon,
  DocumentTextIcon,
  EyeIcon,
  SignalIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import type { FrameType } from '../../types'
import type { WorkspaceUtilityPanel } from './workspaceLogic'
import {
  frameToolPanelDisabledReason,
  frameToolPanelIsAllowed,
  workspaceMode,
  type WorkspaceMode,
} from './workspaceSurfaces'

// The frame tools (/frames/<id>/<tool>), shared by the frame workspace rail
// (FrameWorkspace) and the frames-home sidebar's per-frame quick links
// (FramesHome) — FrameWorkspace imports FramesHome, so the list lives here.
export interface FrameToolDefinition {
  panel: WorkspaceUtilityPanel
  label: string
  description: string
  icon: JSX.Element
  // Non-null when the panel stays visible but this frame's device profile
  // cannot serve it (e.g. Schedule on an esp32 cloud frame): the rail shows
  // it disabled with this explanation instead of hiding it.
  disabledReason?: string | null
}

export const frameToolDefinitions: FrameToolDefinition[] = [
  {
    panel: 'overview',
    label: 'Scenes',
    description: 'Frame overview',
    icon: <Squares2X2Icon className="h-5 w-5" />,
  },
  {
    panel: 'settings',
    label: 'Settings',
    description: 'Frame config',
    icon: <AdjustmentsHorizontalIcon className="h-5 w-5" />,
  },
  { panel: 'preview', label: 'Preview', description: 'Current image', icon: <EyeIcon className="h-5 w-5" /> },
  {
    panel: 'schedule',
    label: 'Schedule',
    description: 'Scene timing',
    icon: <CalendarDaysIcon className="h-5 w-5" />,
  },
  { panel: 'logs', label: 'Logs', description: 'Runtime output', icon: <DocumentTextIcon className="h-5 w-5" /> },
  { panel: 'metrics', label: 'Metrics', description: 'Health charts', icon: <ChartBarIcon className="h-5 w-5" /> },
  { panel: 'assets', label: 'Assets', description: 'Files on frame', icon: <CircleStackIcon className="h-5 w-5" /> },
  { panel: 'terminal', label: 'Terminal', description: 'Shell access over SSH', icon: <CommandLineIcon className="h-5 w-5" /> },
  { panel: 'ping', label: 'Ping', description: 'Connectivity', icon: <SignalIcon className="h-5 w-5" /> },
  { panel: 'debug', label: 'Debug', description: 'Diagnostics', icon: <BoltIcon className="h-5 w-5" /> },
  { panel: 'activity', label: 'Activity', description: 'Audit trail', icon: <ClockIcon className="h-5 w-5" /> },
]

// Allow-list, not deny-list: see workspaceSurfaces.ts. A panel added above is
// invisible in every mode until it is listed there. The frame's device
// profile never hides a panel — it disables it with an explanation (e.g.
// Schedule on an esp32 cloud frame, whose firmware refuses `set_schedule`),
// so the workspace keeps its shape whatever the hardware. Virtual frames are
// the one exception: panels whose concepts don't exist for them (terminal,
// ping, metrics) are hidden outright — see workspaceSurfaces.ts.
export function frameToolDefinitionsForMode(
  mode: WorkspaceMode = workspaceMode(),
  frame?: FrameType | null
): FrameToolDefinition[] {
  return frameToolDefinitions
    .filter((definition) => frameToolPanelIsAllowed(mode, definition.panel, frame))
    .map((definition) => ({
      ...definition,
      disabledReason: frameToolPanelDisabledReason(mode, definition.panel, frame),
    }))
}
