import { isCloudMode } from '../../utils/cloudMode'
import { isInFrameAdminMode } from '../../utils/frameAdmin'

// Defined here rather than in workspaceLogic (which re-exports it) so this
// module imports nothing beyond two zero-import mode probes: the cloud app's
// node test suite loads it directly to assert what cloud mode hides.
export type WorkspaceUtilityPanel =
  | 'overview'
  | 'info'
  | 'state'
  | 'stateVariables'
  | 'apps'
  | 'events'
  | 'templates'
  | 'scenes'
  | 'schedule'
  | 'logs'
  | 'metrics'
  | 'assets'
  | 'terminal'
  | 'settings'
  | 'source'
  | 'json'
  | 'preview'
  | 'ping'
  | 'debug'

// One SPA, three control planes. Which surfaces exist is a property of the
// control plane, not of the component that happens to render them:
//
//   backend    the FrameOS backend — SSH, compiled deploys, shell, files
//   frameAdmin the on-device admin panel — local frame, no SSH/ping
//   cloud      FrameOS Cloud — an outbound WebSocket carrying four command
//              verbs and a settings allowlist. No shell, no files, no deploy.
//
// These are ALLOW-lists on purpose. The gating used to be `isCloudMode()`
// booleans sprinkled across eight components, so every panel added to
// `frameToolDefinitions` was cloud-visible by default and shipped a button
// that always errored. Now a new surface is hidden until someone lists it
// here and can say which control plane implements it.
//
// This module is deliberately free of React, kea and the DOM so the gating can
// be unit-tested in node.

export type WorkspaceMode = 'backend' | 'cloud' | 'frameAdmin'

/** The mode this bundle is running as. Constant for the app's lifetime. */
export function workspaceMode(): WorkspaceMode {
  if (isCloudMode()) {
    return 'cloud'
  }
  if (isInFrameAdminMode()) {
    return 'frameAdmin'
  }
  return 'backend'
}

/** Frame-level tool panels (the workspace's left rail). */
export const allowedFrameToolPanels: Record<WorkspaceMode, readonly WorkspaceUtilityPanel[]> = {
  backend: ['overview', 'settings', 'preview', 'schedule', 'logs', 'metrics', 'assets', 'terminal', 'ping', 'debug'],
  // The on-device panel is the frame: no SSH shell, and pinging yourself is
  // pointless.
  frameAdmin: ['overview', 'settings', 'preview', 'schedule', 'logs', 'metrics', 'assets', 'debug'],
  // The cloud protocol has no shell, file, or diagnostic verbs.
  cloud: ['overview', 'settings', 'preview', 'schedule', 'logs', 'metrics'],
}

/** The scene-tool shortcut row on the frame dashboard. Same verbs, same rules. */
export const allowedSceneToolPanels: Record<WorkspaceMode, readonly WorkspaceUtilityPanel[]> = {
  backend: ['settings', 'schedule', 'logs', 'metrics', 'assets', 'terminal', 'ping'],
  frameAdmin: ['settings', 'schedule', 'logs', 'metrics', 'assets'],
  cloud: ['settings', 'schedule', 'logs', 'metrics'],
}

/** Per-scene utility panels in the scene workspace. */
export const allowedSceneUtilityPanels: Record<WorkspaceMode, readonly WorkspaceUtilityPanel[]> = {
  backend: ['state', 'stateVariables', 'apps', 'events', 'source', 'json', 'info'],
  frameAdmin: ['state', 'stateVariables', 'apps', 'events', 'source', 'json', 'info'],
  // `source` renders generated Nim; cloud frames are interpreted-only.
  cloud: ['state', 'stateVariables', 'apps', 'events', 'json', 'info'],
}

/**
 * Actions in the frame's "…" menu. `render`, `reboot` and `restart` map onto
 * the cloud's allowedFrameCommandTypes (reboot, render, restart_runtime,
 * set_current_scene); `rename` maps onto its settings allowlist. Everything
 * else needs SSH, a build host, or backend bookkeeping.
 */
export type FrameMenuAction =
  | 'archive'
  | 'buildSdCard'
  | 'cancelDeploy'
  | 'delete'
  | 'deploy'
  | 'deployRemote'
  // The on-device panel's own deploy menu (rebuild/restart locally) — not the
  // backend's deploy drawer, and nonexistent on the cloud.
  | 'localDeploy'
  | 'reboot'
  | 'rename'
  | 'render'
  | 'restart'
  | 'restartRemote'
  | 'stop'

export const allowedFrameMenuActions: Record<WorkspaceMode, readonly FrameMenuAction[]> = {
  backend: [
    'archive',
    'buildSdCard',
    'cancelDeploy',
    'delete',
    'deploy',
    'deployRemote',
    'reboot',
    'rename',
    'render',
    'restart',
    'restartRemote',
    'stop',
  ],
  frameAdmin: ['localDeploy', 'rename', 'render'],
  cloud: ['reboot', 'rename', 'render', 'restart'],
}

/**
 * Anchors in the settings sub-navigation. Every id here must be a section
 * FrameSettings actually renders in that mode — a nav entry that scrolls to
 * nothing is worse than a missing one.
 */
export const allowedFrameSettingsSections: Record<WorkspaceMode, readonly string[]> = {
  backend: [
    'frame-settings-info',
    'frame-settings-device',
    'frame-settings-ssh',
    'frame-settings-agent',
    'frame-settings-backend',
    'frame-http-api-section',
    'frame-settings-admin',
    'frame-http-proxy-section',
    'frame-settings-network',
    'frame-settings-mountpoints',
    'frame-settings-defaults',
    'frame-settings-error-behavior',
    'frame-settings-palette',
    'frame-settings-qr',
    'frame-settings-assets',
    'frame-settings-gpio',
    'frame-settings-logs',
    'frame-settings-reboot',
  ],
  // The on-device panel hides the whole SSH block, and the FrameOS Remote
  // agent section lives inside it.
  frameAdmin: [
    'frame-settings-info',
    'frame-settings-device',
    'frame-settings-backend',
    'frame-http-api-section',
    'frame-settings-admin',
    'frame-http-proxy-section',
    'frame-settings-network',
    'frame-settings-mountpoints',
    'frame-settings-defaults',
    'frame-settings-error-behavior',
    'frame-settings-palette',
    'frame-settings-qr',
    'frame-settings-assets',
    'frame-settings-gpio',
    'frame-settings-logs',
    'frame-settings-reboot',
  ],
  // No SSH, no FrameOS Remote agent, and no "frame → backend" reporting: the
  // cloud frame talks to the hub and nothing else.
  cloud: [
    'frame-settings-info',
    'frame-settings-device',
    'frame-http-api-section',
    'frame-settings-admin',
    'frame-http-proxy-section',
    'frame-settings-network',
    'frame-settings-mountpoints',
    'frame-settings-defaults',
    'frame-settings-error-behavior',
    'frame-settings-palette',
    'frame-settings-qr',
    'frame-settings-assets',
    'frame-settings-gpio',
    'frame-settings-logs',
    'frame-settings-reboot',
  ],
}

function allows<T extends string>(list: Record<WorkspaceMode, readonly T[]>, mode: WorkspaceMode, value: T): boolean {
  return list[mode].includes(value)
}

export function frameToolPanelIsAllowed(mode: WorkspaceMode, panel: WorkspaceUtilityPanel): boolean {
  return allows(allowedFrameToolPanels, mode, panel)
}

export function sceneToolPanelIsAllowed(mode: WorkspaceMode, panel: WorkspaceUtilityPanel): boolean {
  return allows(allowedSceneToolPanels, mode, panel)
}

export function sceneUtilityPanelIsAllowed(mode: WorkspaceMode, panel: WorkspaceUtilityPanel): boolean {
  return allows(allowedSceneUtilityPanels, mode, panel)
}

export function frameMenuActionIsAllowed(mode: WorkspaceMode, action: FrameMenuAction): boolean {
  return allows(allowedFrameMenuActions, mode, action)
}

export function frameSettingsSectionIsAllowed(mode: WorkspaceMode, sectionId: string): boolean {
  return allowedFrameSettingsSections[mode].includes(sectionId)
}
