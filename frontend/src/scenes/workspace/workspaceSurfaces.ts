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
//              verbs and a settings allowlist. No shell, no SSH, no compiled
//              builds — but it does have a deploy: the settings push plus one
//              checksummed set_scenes, and (for esp32 boards) USB
//              provisioning straight from the browser.
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
  // The cloud protocol has no shell or diagnostic verbs. Assets speak the
  // full assets_list/asset_get/asset_put/asset_mkdir/asset_delete/
  // asset_rename verb set (docs/cloud-frames.md); only font sync is absent.
  cloud: ['overview', 'settings', 'preview', 'schedule', 'logs', 'metrics', 'assets'],
}

/** The scene-tool shortcut row on the frame dashboard. Same verbs, same rules. */
export const allowedSceneToolPanels: Record<WorkspaceMode, readonly WorkspaceUtilityPanel[]> = {
  backend: ['settings', 'schedule', 'logs', 'metrics', 'assets', 'terminal', 'ping'],
  frameAdmin: ['settings', 'schedule', 'logs', 'metrics', 'assets'],
  cloud: ['settings', 'schedule', 'logs', 'metrics', 'assets'],
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
 * set_current_scene); `rename` maps onto its settings allowlist; `deploy`
 * opens the deploy dialog, whose contents are the control plane's business
 * (see below). Everything else needs SSH, a build host, or backend
 * bookkeeping.
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
  // Cloud only: enqueue notify_update_available — an advisory nudge; the
  // device downloads and signature-verifies the new firmware on its own
  // (docs/cloud-frames.md "Signed OTA"). The backend's firmware updates ride
  // its own deploy/OTA drawer instead.
  | 'updateFirmware'

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
  // `delete` = DELETE /api/frames/{id}: revoke the link, then drop the row
  // and everything cascaded to it. The device demotes to standalone.
  //
  // `deploy` is allowed here even though the cloud has no /deploy endpoint,
  // no build host and no fast/full distinction. It is the ENTRY POINT, not
  // the transport: it opens the deploy dialog, which on the cloud offers the
  // settings push + one checksummed set_scenes (framesModel.deployFrame's
  // cloud branch), the firmware-update nudge, and — for esp32 boards — USB
  // provisioning over WebSerial. Leaving it off the list is what used to
  // hide every deploy affordance on the cloud, so the only way to push
  // scenes was a bare button in the scene sidebar that opened no dialog at
  // all and gave no confirmation of what it would send. See
  // FrameDeployPlanDrawer's cloud branch for what the dialog renders.
  cloud: ['delete', 'deploy', 'reboot', 'rename', 'render', 'restart', 'updateFirmware'],
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
 * Sections of the GLOBAL settings page (scenes/settings/Settings.tsx) — not
 * the per-frame settings panel above. `null` means "everything the page
 * renders": the backend owns all of it, and the on-device admin never mounts
 * this page at all (urls.settings() routes it to the frame's own settings
 * panel instead). The cloud keeps only the service API keys scenes use —
 * there is no local account, deploy host, SSH, build environment, font
 * store, backend PostHog or backend system info to configure.
 */
export const allowedGlobalSettingsSections: Record<WorkspaceMode, readonly string[] | null> = {
  backend: null,
  frameAdmin: null,
  cloud: [
    'settings-gallery',
    'settings-openai',
    'settings-home-assistant',
    'settings-github',
    'settings-immich',
    'settings-unsplash',
  ],
}

export function globalSettingsSectionIsAllowed(mode: WorkspaceMode, sectionId: string): boolean {
  const allowed = allowedGlobalSettingsSections[mode]
  return allowed === null || allowed.includes(sectionId)
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
 * the ESP32 profile of the management verbs — historically a subset that
 * answered `unsupported_verb` for schedule/settings/telemetry and
 * `notify_update_available`, all since implemented by the firmware
 * (docs/cloud-frames.md, "Device profiles"; device-side allowlist in
 * embedded/esp32/main/fos_cloud.c).
 *
 * A missing capability DISABLES the control with an explanation — it never
 * hides it. Hiding made the workspace look gutted for esp32 frames and gave
 * the user nothing to learn from; a disabled button with a tooltip says what
 * is missing and why. Visibility stays a property of the mode allow-lists
 * alone.
 *
 * Logs are the exception that proves the layering: the cloud's Logs panel
 * never uses the `get_logs` verb — frames PUSH log batches over the hub
 * WebSocket and the panel reads them back from the cloud's store
 * (GET /api/frames/{id}/logs + the `new_log` browser socket event), so the
 * esp32 profile keeps the `logs` capability even though its firmware refuses
 * `get_logs`.
 *
 * Scene management, current scene, render, reboot, restart and state stay:
 * the ESP32 profile implements all of them.
 */
export type FrameCapability = 'schedule' | 'settings' | 'logs' | 'metrics' | 'updateNotify'

/**
 * The frame fields capability gating reads. Structurally a subset of
 * FrameType, declared locally so this module keeps importing nothing beyond
 * the two mode probes.
 */
export interface FrameCapabilityInput {
  hardware?: { platform?: string | null } | null
  embedded?: { platform?: string | null } | null
}

const allFrameCapabilities: readonly FrameCapability[] = ['schedule', 'settings', 'logs', 'metrics', 'updateNotify']

/** What the esp32 cloud profile keeps of the gated set: logs are served from
 * the cloud's own store (pushed by the frame, read over HTTP); settings ride
 * the firmware's set_settings verb (interval/name subset — the control plane
 * refuses the rest for esp32 up front); schedule rides set_schedule
 * (evaluated on-device, fos_schedule.c); metrics arrive as pushed `metrics`
 * messages plus the get_metrics verb; updateNotify rides
 * notify_update_available — the firmware fetches the device-authed OTA
 * manifest and verifies the image signature itself before switching boot
 * slots (fos_ota.c; docs/cloud-frames.md "Signed OTA"). The profile
 * currently gates nothing, but the layering stays: the NEXT verb the
 * firmware lags on gets a disabled-with-reason control, not a hidden one. */
const esp32CloudCapabilities: readonly FrameCapability[] = ['logs', 'settings', 'schedule', 'metrics', 'updateNotify']

/** `platform: "esp32"` today; prefix-matched so "esp32-s3" variants gate too. */
function isEsp32Platform(platform: unknown): boolean {
  return typeof platform === 'string' && platform.toLowerCase().startsWith('esp32')
}

/** A cloud-managed frame whose enrollment hardware report says esp32. */
export function isEsp32CloudFrame(frame?: FrameCapabilityInput | null, mode: WorkspaceMode = workspaceMode()): boolean {
  return mode === 'cloud' && isEsp32Platform(frame?.hardware?.platform)
}

/**
 * An esp32 frame under any control plane: enrolled into the cloud (its
 * hardware report says esp32) or driven by a backend/on-device build (its
 * embedded platform does). Callers that care about the DEVICE rather than
 * the control plane want this — how much a microcontroller can be asked to
 * do at once does not depend on who is asking.
 */
export function isEsp32Frame(
  frame?: FrameCapabilityInput | null,
  mode: WorkspaceMode = workspaceMode()
): boolean {
  return isEsp32CloudFrame(frame, mode) || isEsp32Platform(frame?.embedded?.platform)
}

/**
 * An embedded-mode frame on the "virtual" platform (devices.ts
 * EMBEDDED_VIRTUAL; string literal here so this module stays import-free):
 * no hardware at all — the backend renders the frame and serves it as an
 * image/page URL.
 */
export function isVirtualFrame(frame?: FrameCapabilityInput | null): boolean {
  return frame?.embedded?.platform === 'virtual'
}

/**
 * Unlike the esp32 cloud profile above — which DISABLES controls, because the
 * verbs exist and the firmware merely doesn't answer them yet — a virtual
 * frame HIDES these surfaces: the concepts themselves don't exist. There is
 * no shell to open, no device to ping or reboot, and no host to chart
 * metrics for, so a disabled button would have nothing to explain. Assets
 * stay: the backend stores them (quota-limited) and preloads them into the
 * wasm renderer, so the panel works like on any other frame.
 */
const virtualFrameHiddenPanels: readonly WorkspaceUtilityPanel[] = ['terminal', 'ping', 'metrics']

const virtualFrameHiddenMenuActions: readonly FrameMenuAction[] = [
  'buildSdCard',
  'deployRemote',
  'localDeploy',
  'reboot',
  'restart',
  'restartRemote',
  'stop',
]

/**
 * An embedded-mode frame with real hardware (ESP32 or Pico family — any
 * embedded.platform except the no-hardware 'virtual' one above). The platform
 * string is the backend's embedded.platform ('esp32-s3', 'esp32-c3',
 * 'pico-w', ...), set for every embedded frame.
 */
export function isEmbeddedHardwareFrame(frame?: FrameCapabilityInput | null): boolean {
  const platform = frame?.embedded?.platform
  return typeof platform === 'string' && platform !== '' && platform !== 'virtual'
}

/**
 * Like virtual frames, embedded hardware HIDES rather than disables: a
 * microcontroller has no shell to open and the backend never pings it over
 * SSH, so a disabled Terminal/Ping button would have nothing to explain.
 * Assets, logs, metrics, schedule and settings stay — the firmware serves
 * all of them over its HTTP API.
 */
const embeddedHardwareHiddenPanels: readonly WorkspaceUtilityPanel[] = ['terminal', 'ping']

/**
 * SSH/agent verbs that don't exist on a microcontroller (the backend answers
 * 400 for them): SD-card builds are a Linux install path, FrameOS Remote
 * never runs on the chip, and "stop" is meaningless when the firmware IS the
 * runtime. Reboot, restart, render and deploy stay — they ride the device's
 * HTTP API and the firmware build/OTA pipeline.
 */
const embeddedHardwareHiddenMenuActions: readonly FrameMenuAction[] = [
  'buildSdCard',
  'deployRemote',
  'restartRemote',
  'stop',
]

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
  if (isEsp32CloudFrame(frame, mode)) {
    return new Set(esp32CloudCapabilities)
  }
  return new Set(allFrameCapabilities)
}

/** Which capability a gated frame-tool (and scene-tool shortcut) panel rides on. */
const panelCapabilities: Partial<Record<WorkspaceUtilityPanel, FrameCapability>> = {
  schedule: 'schedule', // set_schedule
  settings: 'settings', // set_settings
  logs: 'logs', // pushed telemetry, read back from the cloud store
  metrics: 'metrics', // get_metrics / telemetry:metrics
}

/**
 * Which capability a gated "…" menu action rides on. (Rename is deliberately
 * absent: it used to ride `settings`, but the frame's name is provider-side
 * data (frames.name) — the cloud updates its own row and only enqueues
 * set_settings for devices that accept it, so renaming works on every
 * platform, ESP32 included.)
 */
const menuActionCapabilities: Partial<Record<FrameMenuAction, FrameCapability>> = {
  updateFirmware: 'updateNotify', // notify_update_available
}

/**
 * Tooltip shown on a control its frame's device profile cannot serve. One
 * message per capability so every surface riding the same verb explains
 * itself the same way.
 */
const capabilityDisabledReasons: Record<FrameCapability, string> = {
  schedule: "This ESP32 frame's firmware does not support schedules yet.",
  settings: "This ESP32 frame's firmware does not accept settings changes from the cloud yet.",
  logs: 'This frame does not report logs to the cloud.',
  metrics: 'This ESP32 frame does not report metrics to the cloud.',
  updateNotify: 'This frame does not take update notifications.',
}

function allows<T extends string>(list: Record<WorkspaceMode, readonly T[]>, mode: WorkspaceMode, value: T): boolean {
  return list[mode].includes(value)
}

function capabilityDisabledReason(
  capability: FrameCapability | undefined,
  mode: WorkspaceMode,
  frame?: FrameCapabilityInput | null
): string | null {
  if (!capability || frameCapabilities(frame, mode).has(capability)) {
    return null
  }
  return capabilityDisabledReasons[capability]
}

// Visibility is the mode's business alone — see the capability block comment
// above for why the device profile disables rather than hides — with one
// exception: virtual and embedded-hardware frames hide the surfaces whose
// concepts don't exist for them at all (virtualFrameHiddenPanels/-MenuActions
// and embeddedHardwareHidden* above). Callers with a frame in hand pass it;
// without one the mode-level answer stands.

export function frameToolPanelIsAllowed(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): boolean {
  if (isVirtualFrame(frame) && virtualFrameHiddenPanels.includes(panel)) {
    return false
  }
  if (isEmbeddedHardwareFrame(frame) && embeddedHardwareHiddenPanels.includes(panel)) {
    return false
  }
  return allows(allowedFrameToolPanels, mode, panel)
}

/** Non-null when the panel is visible for the mode but the frame's device profile cannot serve it. */
export function frameToolPanelDisabledReason(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): string | null {
  return capabilityDisabledReason(panelCapabilities[panel], mode, frame)
}

export function sceneToolPanelIsAllowed(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): boolean {
  if (isVirtualFrame(frame) && virtualFrameHiddenPanels.includes(panel)) {
    return false
  }
  if (isEmbeddedHardwareFrame(frame) && embeddedHardwareHiddenPanels.includes(panel)) {
    return false
  }
  return allows(allowedSceneToolPanels, mode, panel)
}

export function sceneToolPanelDisabledReason(
  mode: WorkspaceMode,
  panel: WorkspaceUtilityPanel,
  frame?: FrameCapabilityInput | null
): string | null {
  return capabilityDisabledReason(panelCapabilities[panel], mode, frame)
}

export function sceneUtilityPanelIsAllowed(mode: WorkspaceMode, panel: WorkspaceUtilityPanel): boolean {
  return allows(allowedSceneUtilityPanels, mode, panel)
}

export function frameMenuActionIsAllowed(
  mode: WorkspaceMode,
  action: FrameMenuAction,
  frame?: FrameCapabilityInput | null
): boolean {
  if (isVirtualFrame(frame) && virtualFrameHiddenMenuActions.includes(action)) {
    return false
  }
  if (isEmbeddedHardwareFrame(frame) && embeddedHardwareHiddenMenuActions.includes(action)) {
    return false
  }
  return allows(allowedFrameMenuActions, mode, action)
}

export function frameMenuActionDisabledReason(
  mode: WorkspaceMode,
  action: FrameMenuAction,
  frame?: FrameCapabilityInput | null
): string | null {
  return capabilityDisabledReason(menuActionCapabilities[action], mode, frame)
}

/**
 * Whether the workspace should offer streaming this frame's USB serial
 * console into the Logs panel (WebSerial). True for cloud-managed ESP32
 * frames: a board that never joins WiFi can still be debugged from the
 * browser over its USB console. The backend/on-device planes have their own
 * probe (frame.mode === 'embedded' in Logs.tsx); callers must additionally
 * feature-detect WebSerial before showing anything.
 */
export function frameSupportsUsbSerialConsole(
  frame?: FrameCapabilityInput | null,
  mode: WorkspaceMode = workspaceMode()
): boolean {
  return isEsp32CloudFrame(frame, mode)
}

/**
 * The esp32 cloud profile replaces the whole settings form with one compact
 * block (name + interval) — see `esp32CloudProfile` in FrameSettings.tsx — so
 * every other nav entry would scroll to an anchor that is never rendered.
 */
const esp32CloudFrameSettingsSections: readonly string[] = ['frame-settings-info']

/**
 * Sections FrameSettings.tsx renders only for a full host OS (its
 * `isEmbeddedMode` gate): a microcontroller has no mountpoints to mount, no
 * host log files to rotate, no reboot-behaviour knobs, and no configurable
 * assets path. Applies to virtual frames too — they are embedded mode as
 * well, and the backend, not the "device", holds their assets.
 */
const embeddedModeHiddenFrameSettingsSections: readonly string[] = [
  'frame-settings-mountpoints',
  'frame-settings-assets',
  'frame-settings-logs',
  'frame-settings-reboot',
]

/**
 * Callers with a frame in hand MUST pass it: the mode alone cannot tell a
 * cloud esp32 (one section) from a cloud Pi (all of them), and the contract
 * above is that a nav entry which scrolls to nothing is worse than a missing
 * one. `frame` stays optional so mode-only probes still compile.
 */
export function frameSettingsSectionIsAllowed(
  mode: WorkspaceMode,
  sectionId: string,
  frame?: FrameCapabilityInput | null
): boolean {
  if (isEsp32CloudFrame(frame, mode) && !esp32CloudFrameSettingsSections.includes(sectionId)) {
    return false
  }
  if (
    (isEmbeddedHardwareFrame(frame) || isVirtualFrame(frame)) &&
    embeddedModeHiddenFrameSettingsSections.includes(sectionId)
  ) {
    return false
  }
  return allowedFrameSettingsSections[mode].includes(sectionId)
}
