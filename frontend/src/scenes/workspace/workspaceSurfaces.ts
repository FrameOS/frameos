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

/**
 * What "Add frame" opens.
 *
 *   backendForm  the self-hosted creation form (POST /api/frames/new): SSH
 *                credentials, install method, build host — all backend-only.
 *   cloudPanel   the cloud enrollment panel (claim codes, SD images, ESP32
 *                flashing), supplied by the cloud bundle through
 *                addFramePanelRegistry.
 *
 * The cloud has no /api/frames/new — a frame gets there by enrolling itself
 * with a claim code — so showing the backend form there produced a 405 on
 * submit. The on-device panel manages the one frame it runs on and never
 * creates another, but it reaches FramesHome through the same component, so
 * it keeps the backend form rather than silently having no button at all.
 */
export type AddFrameFlow = 'backendForm' | 'cloudPanel'

export const addFrameFlows: Record<WorkspaceMode, AddFrameFlow> = {
  backend: 'backendForm',
  frameAdmin: 'backendForm',
  cloud: 'cloudPanel',
}

/**
 * Device-profile capabilities, layered UNDER the per-mode allow-lists above.
 *
 * The mode lists say what a control plane implements; this says what the
 * device on the other end implements. Cloud-managed frames report their
 * `hardware` object at enrollment, and a `platform: "esp32"` frame speaks
 * only a subset of the management verbs — it answers `unsupported_verb` for
 * `set_schedule`, `set_settings`, `get_logs`, `get_metrics` and
 * `notify_update_available` (docs/cloud-frames.md, "Device profiles";
 * device-side allowlist in embedded/esp32/main/fos_cloud.c). The UI hides
 * those controls instead of enqueueing commands that come back refused.
 *
 * Scene management, current scene, render, reboot, restart and state stay:
 * the ESP32 profile implements all of them.
 */
export type FrameCapability = 'schedule' | 'settings' | 'logs' | 'metrics' | 'updateNotify'

/**
 * The one frame field capability gating reads. Structurally a subset of
 * FrameType, declared locally so this module keeps importing nothing beyond
 * the two mode probes.
 */
export interface FrameCapabilityInput {
  hardware?: { platform?: string | null } | null
}

const allFrameCapabilities: readonly FrameCapability[] = ['schedule', 'settings', 'logs', 'metrics', 'updateNotify']

/** `platform: "esp32"` today; prefix-matched so "esp32-s3" variants gate too. */
function isEsp32Platform(platform: unknown): boolean {
  return typeof platform === 'string' && platform.toLowerCase().startsWith('esp32')
}

/**
 * The management verbs this frame's device profile supports. Only the cloud
 * control plane carries the profile distinction: backend- and admin-managed
 * ESP32 frames get their logs, schedule and settings through channels of
 * their own (serial, the on-device admin), not through the cloud WS verbs.
 * A frame that has not loaded yet (or predates the hardware report) keeps
 * the full set — the allow-lists above still bound what the mode offers.
 */
export function frameCapabilities(
  frame?: FrameCapabilityInput | null,
  mode: WorkspaceMode = workspaceMode()
): ReadonlySet<FrameCapability> {
  if (mode === 'cloud' && isEsp32Platform(frame?.hardware?.platform)) {
    // The ESP32 cloud profile: scenes, current scene, state, render, reboot,
    // restart_runtime — none of which are capability-gated surfaces. Every
    // gated capability rides a verb it answers `unsupported_verb` for.
    return new Set<FrameCapability>()
  }
  return new Set(allFrameCapabilities)
}

/** Which capability a gated frame-tool (and scene-tool shortcut) panel rides on. */
const panelCapabilities: Partial<Record<WorkspaceUtilityPanel, FrameCapability>> = {
  schedule: 'schedule', // set_schedule
  settings: 'settings', // set_settings
  logs: 'logs', // get_logs / telemetry:logs
  metrics: 'metrics', // get_metrics / telemetry:metrics
}

/** Which capability a gated "…" menu action rides on. */
const menuActionCapabilities: Partial<Record<FrameMenuAction, FrameCapability>> = {
  // Renaming a cloud frame is a `set_settings` push of `name` (framesModel
  // renameFrame → pushCloudFrameSettings), so it follows that verb's profile.
  rename: 'settings',
}

function allows<T extends string>(list: Record<WorkspaceMode, readonly T[]>, mode: WorkspaceMode, value: T): boolean {
  return list[mode].includes(value)
}

function capabilityAllows(
  capability: FrameCapability | undefined,
  mode: WorkspaceMode,
  frame?: FrameCapabilityInput | null
): boolean {
  return !capability || frameCapabilities(frame, mode).has(capability)
}

export function frameToolPanelIsAllowed(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): boolean {
  return allows(allowedFrameToolPanels, mode, panel) && capabilityAllows(panelCapabilities[panel], mode, frame)
}

export function sceneToolPanelIsAllowed(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): boolean {
  return allows(allowedSceneToolPanels, mode, panel) && capabilityAllows(panelCapabilities[panel], mode, frame)
}

export function sceneUtilityPanelIsAllowed(mode: WorkspaceMode, panel: WorkspaceUtilityPanel): boolean {
  return allows(allowedSceneUtilityPanels, mode, panel)
}

export function frameMenuActionIsAllowed(
  mode: WorkspaceMode,
  action: FrameMenuAction,
  frame?: FrameCapabilityInput | null
): boolean {
  return allows(allowedFrameMenuActions, mode, action) && capabilityAllows(menuActionCapabilities[action], mode, frame)
}

export function frameSettingsSectionIsAllowed(mode: WorkspaceMode, sectionId: string): boolean {
  return allowedFrameSettingsSections[mode].includes(sectionId)
}
