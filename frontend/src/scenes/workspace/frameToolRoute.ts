import {
  frameToolPanelDisabledReason,
  frameToolPanelIsAllowed,
  type FrameCapabilityInput,
  type WorkspaceMode,
  type WorkspaceUtilityPanel,
} from './workspaceSurfaces'

// The tool segment of a frame URL (/frames/<id>/<tool>) resolved against the
// control plane's allow-list. Kept free of React, kea and the DOM so the
// cloud's node suite can pin it: a segment the mode does not implement used
// to be validated against EVERY panel and then quietly fell back to the
// overview, so /frames/<id>/terminal on the cloud rendered the scenes page
// with nothing to say about it.

/** Every panel a frame URL may name, across all modes. */
export const frameToolPanels = [
  'overview',
  'preview',
  'schedule',
  'logs',
  'metrics',
  'assets',
  'terminal',
  'ping',
  'debug',
  'settings',
  'activity',
] as const satisfies readonly WorkspaceUtilityPanel[]

export type FrameToolPanel = (typeof frameToolPanels)[number]

export function isFrameToolPanel(panel: unknown): panel is FrameToolPanel {
  return typeof panel === 'string' && (frameToolPanels as readonly string[]).includes(panel)
}

export type FrameToolRouteResolution =
  /** A panel this control plane renders for this frame. */
  | { kind: 'panel'; panel: FrameToolPanel }
  /**
   * A panel the mode lists but the frame's device profile cannot serve (a
   * schedule on firmware without `set_schedule`): the rail shows it disabled
   * with this reason, and a deep link lands on the same explanation instead
   * of a different tool.
   */
  | { kind: 'disabled'; panel: FrameToolPanel; reason: string }
  /**
   * No such tool here: not a panel at all, or one another control plane
   * implements (the terminal on the cloud, ping on the on-device admin) or
   * one hidden for this device (a shell on a virtual frame). A 404, not the
   * overview.
   */
  | { kind: 'notFound'; segment: string }

/**
 * Resolve the tool a frame route asks for. `segment` is the raw path segment
 * (or the legacy `?tool=` value); null, undefined and '' mean the bare frame
 * URL, which is the overview.
 */
export function resolveFrameToolRoute(
  segment: unknown,
  mode: WorkspaceMode,
  frame?: FrameCapabilityInput | null
): FrameToolRouteResolution {
  if (segment === null || segment === undefined || segment === '') {
    return { kind: 'panel', panel: 'overview' }
  }
  if (!isFrameToolPanel(segment)) {
    return { kind: 'notFound', segment: typeof segment === 'string' ? segment : String(segment) }
  }
  if (!frameToolPanelIsAllowed(mode, segment, frame)) {
    return { kind: 'notFound', segment }
  }
  const reason = frameToolPanelDisabledReason(mode, segment, frame)
  if (reason) {
    return { kind: 'disabled', panel: segment, reason }
  }
  return { kind: 'panel', panel: segment }
}

const controlPlaneNames: Record<WorkspaceMode, string> = {
  backend: 'this FrameOS backend',
  frameAdmin: "the frame's own admin panel",
  cloud: 'FrameOS Cloud',
}

/** The 404 page's explanation for a tool segment this control plane does not implement. */
export function frameToolNotFoundMessage(segment: string, mode: WorkspaceMode): string {
  return isFrameToolPanel(segment)
    ? `There is no "${segment}" tool for this frame on ${controlPlaneNames[mode]}.`
    : `This frame has no "${segment}" page.`
}
