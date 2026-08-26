import {
  MakeLogicType,
  actions,
  afterMount,
  beforeUnmount,
  connect,
  kea,
  key,
  listeners,
  path,
  props,
  reducers,
  selectors,
} from 'kea'
import { router } from 'kea-router'
import { framesModel, type RemoteTaskTransport } from '../../models/framesModel'
import { publishedReleaseModel } from '../../models/publishedReleaseModel'
import { subscriptions } from '../../utils/keaSubscriptions'
import {
  AppNodeData,
  DiagramEdge,
  DiagramNode,
  FrameErrorBehavior,
  FrameScene,
  FrameSyncChoice,
  FrameSyncSceneChoice,
  FrameSyncSectionId,
  FrameSyncStatus,
  FrameType,
  SceneNodeData,
  TemplateType,
  FrameId,
} from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'
import { v4 as uuidv4 } from 'uuid'
import { duplicateScenes } from '../../utils/duplicateScenes'
import { apiFetch } from '../../utils/apiFetch'
import { isCloudMode } from '../../utils/cloudMode'
import { pushCloudFrameSchedule, pushCloudFrameSettings } from '../../utils/cloudFrameApi'
import { cloudFrameSettingKeys, extendedCloudFrameSettingKeys } from '../../utils/cloudFrameSettings'
import { persistAndPushCloudFrameScenes, type CloudScenePersistOptions } from '../../utils/cloudFrameScenesSave'
import { clearCloudSceneJsonCache } from '../../models/framesModel'
import { getBasePath } from '../../utils/getBasePath'
import { projectApiPath, projectApiPathFromCache } from '../../utils/projectApi'
import { longRunningTasksModel } from '../../models/longRunningTasksModel'
import { assignSceneImages, reportSceneImageFailure, type SceneImageSource } from '../../utils/sceneImages'
import { arrangeSceneGraph } from '../../utils/arrangeNodes'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { secureToken } from '../../utils/secureToken'
import { generateFrameTlsMaterial } from '../../utils/tlsCertificates'
import { normalizeSceneApps } from '../../utils/sceneApps'
import {
  type ChangeDetail,
  CURRENT_FRAMEOS_REMOTE_VERSION,
  CURRENT_FRAMEOS_VERSION,
  type DeployPlanResponse,
  type DeployRecommendation,
  type SummaryItem,
  buildDeployPlanRequestBody,
  buildDeployRecommendation,
  buildFastDeployPlanSummary,
  buildFullDeployPlanSummary,
  buildInferredFullDeployPlanSummary,
  deployedFrameosVersion,
  deployPlanPreviousFrameosVersion,
  isFrameosVersionBefore,
} from './frameDeployUtils'
import { getDeployPlanErrorMessage } from './frameDeployErrors'
import { urls } from '../../urls'
import { normalizeFrameCompilationMode } from '../../utils/frameBuildOptions'
import { frameHasActivityLog } from '../../decorators/frame'
import { frameRunsScenesInterpreted, normalizeSceneExecution, sceneExecutionForFrame } from '../../utils/sceneExecution'
import { normalizeCustomEvent } from '../../utils/frameEvents'
import { frameFormSceneErrors } from './frameFormSceneErrors'
import {
  cloneSplitScreenSceneLayout,
  defaultSplitScreenBackground,
  type SplitLayoutBranch,
  type SplitLayoutNode,
  type SplitScreenBackground,
  type SplitScreenSceneLayout,
} from '../../utils/splitScreenLayouts'
import type { FrameSyncSection } from '../../types'
import type { DeepPartial, DeepPartialMap, FieldName, ValidationErrorType } from 'kea-forms'

export type { ChangeDetail, DeployPlanResponse, DeployRecommendation, SummaryItem } from './frameDeployUtils'

export const DEFAULT_TIMEZONE_UPDATE_URL = 'https://tz.frameos.net/tzdata.json.gz'
export const DEFAULT_TIMEZONE_UPDATE_HOUR = 3

interface DeployPlanApiResponse {
  plan: DeployPlanResponse
}

interface FrameSyncApiResponse {
  sync: FrameSyncStatus
  frame?: FrameType
}

export interface FrameSyncChoices {
  frame_json: Record<string, FrameSyncChoice>
  scenes_json: Record<string, FrameSyncSceneChoice>
}
export type FrameSyncView = 'diff' | 'backend' | 'frame'
export type FrameSyncViews = Partial<Record<FrameSyncSectionId, FrameSyncView>>

export function frameSyncChangeKey(change: { choice_key?: string; path: string }): string {
  return change.choice_key ?? change.path
}

function syncHintIsNewerThanStatus(frame: FrameType | null, sync: FrameSyncStatus): boolean {
  const hintTime = Date.parse(frame?.frame_sync_hint?.checked_at || '')
  const statusTime = Date.parse(sync.checked_at || '')
  return Number.isFinite(hintTime) && (!Number.isFinite(statusTime) || hintTime > statusTime)
}

function defaultFrameSyncChoices(sync: FrameSyncStatus | null): FrameSyncChoices {
  const choices: FrameSyncChoices = { frame_json: {}, scenes_json: {} }
  for (const section of sync?.sections ?? []) {
    if (!section.has_changes) {
      continue
    }
    for (const change of section.changes) {
      choices[section.id][frameSyncChangeKey(change)] =
        section.id === 'scenes_json' && change.kind === 'added' ? 'frame' : 'backend'
    }
  }
  return choices
}

function hasSelectedFrameSyncChoices(choices: FrameSyncChoices): boolean {
  return (
    Object.values(choices.frame_json).some((choice) => choice !== 'ignore') ||
    Object.values(choices.scenes_json).some((choice) => choice !== 'ignore')
  )
}

function frameSyncStatusToken(sync: FrameSyncStatus | null): string | null {
  if (!sync?.has_changes) {
    return null
  }
  return JSON.stringify({
    frame: {
      current_revision: sync.frame?.current_revision ?? null,
      deployed_revision: sync.frame?.deployed_revision ?? null,
      frame_config_modified_at: sync.frame?.frame_config_modified_at ?? null,
      scenes_modified_at: sync.frame?.scenes_modified_at ?? null,
    },
    sections: sync.sections
      .filter((section) => section.has_changes)
      .map((section) => ({
        id: section.id,
        changes: section.changes.map((change) => ({
          key: frameSyncChangeKey(change),
          kind: change.kind,
          backend: change.backend,
          frame: change.frame,
        })),
      })),
  })
}

function frameSyncHintToken(frame: FrameType | null): string | null {
  const hint = frame?.frame_sync_hint
  if (!hint?.has_changes) {
    return null
  }
  return JSON.stringify({
    current_revision: hint.current_revision ?? null,
    deployed_revision: hint.deployed_revision ?? null,
    frame_config_modified_at: hint.frame_config_modified_at ?? null,
    scenes_modified_at: hint.scenes_modified_at ?? null,
    last_successful_deploy_at: hint.last_successful_deploy_at ?? null,
  })
}

function currentFrameSyncToken(frame: FrameType | null, sync: FrameSyncStatus | null): string | null {
  if (sync && syncHintIsNewerThanStatus(frame, sync)) {
    return frameSyncHintToken(frame)
  }
  return frameSyncStatusToken(sync) ?? frameSyncHintToken(frame)
}

function frameHasSyncCredentials(frame: FrameType | null): boolean {
  const frameAdminAuth = frame?.frame_admin_auth
  return Boolean(frameAdminAuth?.enabled && frameAdminAuth.user && frameAdminAuth.pass)
}

function shouldLoadFrameSyncStatus(
  frame: FrameType | null,
  sync: FrameSyncStatus | null,
  ignoredToken: string | null
): boolean {
  if (
    isInFrameAdminMode() ||
    !frame ||
    frame.archived ||
    !frame.frame_sync_hint?.has_changes ||
    !frameHasSyncCredentials(frame)
  ) {
    return false
  }
  const syncToken = currentFrameSyncToken(frame, sync)
  if (syncToken && syncToken === ignoredToken) {
    return false
  }
  return !sync || syncHintIsNewerThanStatus(frame, sync)
}

function defaultFrameSyncViews(sync: FrameSyncStatus | null): FrameSyncViews {
  const views: FrameSyncViews = {}
  for (const section of sync?.sections ?? []) {
    if (section.has_changes) {
      views[section.id] = 'diff'
    }
  }
  return views
}

// 'cloudOta' / 'cloudUsb' are the cloud drawer's two deploy paths (over the
// frame's own cloud connection vs. over a USB cable to this computer); the
// rest are backend views.
export type DeployDrawerView = 'main' | 'sdCard' | 'script' | 'embedded' | 'cloudOta' | 'cloudUsb'

export interface FrameLogicProps {
  frameId: FrameId
}

export type FrameNextAction = 'render' | 'restart' | 'reboot' | 'stop' | 'deploy' | null

type TemplateBatchPayload = Partial<TemplateType> & { __templateBatch?: Partial<TemplateType>[] }

function isRemoteDeployConfigured(agent?: FrameType['agent']): boolean {
  return Boolean(agent?.agentEnabled && agent?.agentRunCommands && agent?.agentSharedSecret)
}

function remoteCanBeDeployed(agent?: FrameType['agent']): boolean {
  return Boolean(agent?.agentEnabled && agent?.agentSharedSecret)
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const version = value.trim()
  return version ? version.split('+')[0] : null
}

function frameCanUseFastDeploy(frame: FrameType | null | undefined, requiresRecompilation: boolean): boolean {
  if (!frame || requiresRecompilation) {
    return false
  }
  if (frame.last_successful_deploy_at) {
    return true
  }
  return (frame.mode ?? 'rpios') === 'embedded' && frameHasActivityLog(frame)
}

function deployedFrameBaseline(frame: FrameType | null | undefined): Partial<FrameType> | null {
  if (!frame) {
    return null
  }
  if (frame.last_successful_deploy) {
    return frame.last_successful_deploy
  }
  if ((frame.mode ?? 'rpios') === 'embedded' && frameHasActivityLog(frame)) {
    return { ...frame, frameos_version: CURRENT_FRAMEOS_VERSION } as Partial<FrameType>
  }
  return null
}

function isCloudManagedFrame(frame: FrameType | null | undefined): boolean {
  return isCloudMode() || frame?.managed_by === 'cloud'
}

/**
 * The cloud has no deploy records — deployedFrameBaseline() reads
 * last_successful_deploy, a backend column the cloud never serves, so the
 * backend diff called every cloud frame permanently undeployed ("deploy
 * now" forever). The cloud's deployed-ness is its checksum pair: what the
 * control plane assigned vs what the device last acked applying (the same
 * signal frameNeedsInitialDeploy uses). A mismatch means a push is already
 * queued and travels on its own when the frame syncs, so it is reported as
 * waiting, not as something to deploy again.
 *
 * The other thing a cloud frame can be behind on is the FrameOS release
 * itself, which needs `latestPublishedRelease` (publishedReleaseModel) because
 * the cloud never ships a version of its own the way a backend does.
 */
export function cloudUndeployedChangeDetails(
  frame: FrameType | null | undefined,
  latestPublishedRelease?: string | null
): ChangeDetail[] {
  const details: ChangeDetail[] = []
  if (frame?.assigned_checksum && frame.assigned_checksum !== frame.scenes_checksum) {
    details.push({ label: 'Waiting for the frame to apply the last push', requiresFullDeploy: false })
  }
  // A device a release behind is something to DO on this frame — it was the
  // deploy drawer's own `2026.8.20 → 2026.8.21` row, while the button that
  // opens that drawer stayed idle-white. `null` means the lookup has not
  // landed (or failed): never claim an upgrade nobody confirmed exists.
  const deviceVersion = (frame?.frameos_version ?? '').trim().replace(/^v/i, '')
  if (latestPublishedRelease && deviceVersion && deviceVersion !== latestPublishedRelease) {
    details.push({
      label: `FrameOS ${deviceVersion} → ${latestPublishedRelease}`,
      requiresFullDeploy: false,
      // Tagged so the dashboard status line reads "upgrade" rather than
      // "waiting to sync": nothing is queued here, the frame is simply behind
      // and someone has to ask it to update.
      frameosVersionChange: {
        kind: 'upgrade',
        previousVersion: deviceVersion,
        currentVersion: latestPublishedRelease,
      },
    })
  }
  return details
}

const FRAME_KEYS: (keyof FrameType)[] = [
  'name',
  'mode',
  'frame_host',
  'frame_port',
  'frame_access_key',
  'frame_access',
  'frame_admin_auth',
  'https_proxy',
  'ssh_user',
  'ssh_pass',
  'ssh_port',
  'ssh_keys',
  'server_host',
  'server_port',
  'server_api_key',
  'server_send_logs',
  'width',
  'height',
  'color',
  'device',
  'device_config',
  'timezone',
  'timezone_updater',
  'interval',
  'metrics_interval',
  'max_http_response_bytes',
  'scaling_mode',
  'rotate',
  'flip',
  'background_color',
  'scenes',
  'debug',
  'log_to_file',
  'assets_path',
  'save_assets',
  'upload_fonts',
  'reboot',
  'control_code',
  'schedule',
  'gpio_buttons',
  'network',
  'agent',
  'mountpoints',
  'error_behavior',
  'palette',
  'buildroot',
  'embedded',
  'rpios',
]

// When adding a runtime-consumed field to FRAME_KEYS, add its introduced version here.
// During active development, use the next patch after versions.json's frameos base version
// (for example, 2026.6.9 while versions.json says 2026.6.8).
const FRAME_KEY_INTRODUCED_FRAMEOS_VERSION: Partial<Record<keyof FrameType, string>> = {
  mountpoints: '2026.6.0',
  error_behavior: '2026.6.1',
  buildroot: '2026.6.2',
  max_http_response_bytes: '2026.6.4',
  rpios: '2026.6.7',
  timezone_updater: '2026.6.7',
  embedded: '2026.6.26',
}

// These fields are edited through text inputs, so frameForm may hold strings like
// "1080" while the backend returns numbers. Normalize before comparing or submitting,
// otherwise a saved frame still counts as having unsaved changes.
const NUMERIC_FRAME_KEYS = new Set<keyof FrameType>([
  'frame_port',
  'ssh_port',
  'server_port',
  'width',
  'height',
  'interval',
  'metrics_interval',
  'max_http_response_bytes',
  'rotate',
])

function normalizeNumericFrameValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS: (keyof FrameType)[] = ['device', 'scenes', 'reboot', 'rpios']
const FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT: (keyof FrameType)[] = [
  'device',
  'scenes',
  'reboot',
  'ssh_user',
  'ssh_port',
  'ssh_pass',
  'log_to_file',
  'assets_path',
  'network',
  'agent',
  'buildroot',
]
const FRAME_KEYS_REQUIRE_RECOMPILE_EMBEDDED: (keyof FrameType)[] = [
  'device',
  'device_config',
  'embedded',
  'frame_host',
  'gpio_buttons',
  'interval',
  'max_http_response_bytes',
  'network',
  'scenes',
  'server_api_key',
  'server_host',
  'server_port',
]

const FRAME_KEY_LABELS: Partial<Record<keyof FrameType, string>> = {
  name: 'Frame name',
  mode: 'Deployment mode',
  frame_host: 'Frame host',
  frame_port: 'Frame port',
  frame_access_key: 'Frame access key',
  frame_access: 'Frame access',
  frame_admin_auth: 'Frame admin auth',
  https_proxy: 'HTTPS proxy',
  ssh_user: 'SSH user',
  ssh_pass: 'SSH password',
  ssh_port: 'SSH port',
  ssh_keys: 'SSH keys',
  server_host: 'Server host',
  server_port: 'Server port',
  server_api_key: 'Server API key',
  server_send_logs: 'Server Send Logs',
  width: 'Width',
  height: 'Height',
  color: 'Color support',
  device: 'Device',
  device_config: 'Device config',
  timezone: 'Timezone',
  timezone_updater: 'Timezone data updates',
  interval: 'Refresh interval',
  metrics_interval: 'Metrics interval',
  max_http_response_bytes: 'HTTP response size limit',
  scaling_mode: 'Scaling mode',
  rotate: 'Rotation',
  flip: 'Flip',
  background_color: 'Background color',
  scenes: 'Scenes',
  debug: 'Debug mode',
  log_to_file: 'Log to file',
  assets_path: 'Assets path',
  save_assets: 'Save assets',
  upload_fonts: 'Upload fonts',
  reboot: 'Reboot settings',
  control_code: 'Control code',
  schedule: 'Schedule',
  gpio_buttons: 'GPIO buttons',
  network: 'Network settings',
  agent: 'Remote settings',
  mountpoints: 'Mountpoints',
  error_behavior: 'Global error handling',
  palette: 'Palette',
  buildroot: 'Buildroot settings',
  embedded: 'Embedded settings',
  rpios: 'Raspberry Pi OS settings',
}

const DEPLOYMENT_SUMMARY_KEYS: (keyof FrameType)[] = [
  'name',
  'mode',
  'frame_host',
  'frame_port',
  'frame_access_key',
  'frame_access',
  'frame_admin_auth',
  'https_proxy',
  'ssh_user',
  'ssh_pass',
  'ssh_port',
  'ssh_keys',
  'server_host',
  'server_port',
  'server_api_key',
  'server_send_logs',
  'width',
  'height',
  'color',
  'device',
  'device_config',
  'timezone',
  'timezone_updater',
  'interval',
  'metrics_interval',
  'max_http_response_bytes',
  'scaling_mode',
  'rotate',
  'flip',
  'background_color',
  'debug',
  'log_to_file',
  'assets_path',
  'save_assets',
  'mountpoints',
  'error_behavior',
]

export const DEFAULT_FRAME_ERROR_BEHAVIOR: Required<FrameErrorBehavior> = {
  mode: 'show_error_retry',
  retry_seconds: 60,
  silent_retry_seconds: 60,
  silent_retry_forever: false,
  silent_window_minutes: 10,
  show_error_retry_seconds: 60,
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function optionalTimezoneUpdateHour(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const hour = Number(value)
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : undefined
}

function normalizeTimezoneUpdater(
  value: FrameType['timezone_updater'] | null | undefined
): NonNullable<FrameType['timezone_updater']> {
  const settings: NonNullable<FrameType['timezone_updater']> = {
    enabled: value?.enabled ?? true,
  }
  const hour = optionalTimezoneUpdateHour(value?.hour)
  if (hour !== undefined) {
    settings.hour = hour
  }
  if (value?.url) {
    settings.url = value.url
  }
  return settings
}

function compactTimezoneUpdaterForSubmit(
  value: FrameType['timezone_updater'] | null | undefined
): FrameType['timezone_updater'] | null {
  const settings = normalizeTimezoneUpdater(value)
  const compact: NonNullable<FrameType['timezone_updater']> = {}
  if (settings.enabled === false) {
    compact.enabled = false
  }
  if (settings.hour !== undefined && settings.hour !== DEFAULT_TIMEZONE_UPDATE_HOUR) {
    compact.hour = settings.hour
  }
  if (settings.url && settings.url !== DEFAULT_TIMEZONE_UPDATE_URL) {
    compact.url = settings.url
  }
  return Object.keys(compact).length ? compact : null
}

export function normalizeFrameErrorBehavior(errorBehavior?: Partial<FrameErrorBehavior> | null): FrameErrorBehavior {
  const rawMode = errorBehavior?.mode
  const mode: FrameErrorBehavior['mode'] =
    rawMode === 'safe_mode' || rawMode === 'show_error_retry' || rawMode === 'silent_retry'
      ? rawMode
      : DEFAULT_FRAME_ERROR_BEHAVIOR.mode
  const silentWindowMinutes =
    errorBehavior?.silent_window_minutes ??
    (errorBehavior as (Partial<FrameErrorBehavior> & { silent_retry_minutes?: number }) | null | undefined)
      ?.silent_retry_minutes

  return {
    mode,
    retry_seconds: positiveNumber(errorBehavior?.retry_seconds, DEFAULT_FRAME_ERROR_BEHAVIOR.retry_seconds),
    silent_retry_seconds: positiveNumber(
      errorBehavior?.silent_retry_seconds,
      DEFAULT_FRAME_ERROR_BEHAVIOR.silent_retry_seconds
    ),
    silent_retry_forever: errorBehavior?.silent_retry_forever ?? DEFAULT_FRAME_ERROR_BEHAVIOR.silent_retry_forever,
    silent_window_minutes: positiveNumber(silentWindowMinutes, DEFAULT_FRAME_ERROR_BEHAVIOR.silent_window_minutes),
    show_error_retry_seconds: positiveNumber(
      errorBehavior?.show_error_retry_seconds,
      DEFAULT_FRAME_ERROR_BEHAVIOR.show_error_retry_seconds
    ),
  }
}

function keyLabel(key: keyof FrameType): string {
  return FRAME_KEY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function deploymentModeLabel(mode: unknown): string {
  if (mode === 'buildroot') {
    return 'Buildroot'
  }
  if (mode === 'embedded') {
    return 'ESP32'
  }
  return 'Raspberry Pi OS'
}

function getRecompileFields(mode: FrameType['mode']): (keyof FrameType)[] {
  if (mode === 'buildroot') {
    return FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT
  }
  if (mode === 'embedded') {
    return FRAME_KEYS_REQUIRE_RECOMPILE_EMBEDDED
  }
  return FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS
}

function frameKeyRequiresVersionUpgrade(key: keyof FrameType, previousFrameosVersion: string | null): boolean {
  const introducedVersion = FRAME_KEY_INTRODUCED_FRAMEOS_VERSION[key]
  return introducedVersion ? isFrameosVersionBefore(previousFrameosVersion, introducedVersion) : false
}

function frameosVersionRequiresDeploy(previousFrameosVersion: string | null): boolean {
  if (!previousFrameosVersion) {
    return true
  }
  if (previousFrameosVersion === CURRENT_FRAMEOS_VERSION) {
    return false
  }
  if (!/^\d+\.\d+\.\d+$/.test(previousFrameosVersion)) {
    return true
  }
  if (isFrameosVersionBefore(previousFrameosVersion, CURRENT_FRAMEOS_VERSION)) {
    return true
  }
  return false
}

// The keys a diff between server truth and the form may consider. On the
// cloud only the declarative settings allowlist (plus scenes) round-trips:
// GET /api/frames/{id} never returns fields like frame_admin_auth or
// error_behavior, while sanitizeFrame materializes defaults for them in the
// form — so diffing the full key list pinned "Frame admin auth" and "Global
// error handling" into Pending save forever, unsaveable by construction.
function frameDiffKeys(): (keyof FrameType)[] {
  if (isCloudMode()) {
    // `schedule` rides its own verb (POST /api/frames/{id}/schedule →
    // set_schedule), not the settings allowlist — but it round-trips through
    // GET /api/frames/{id} like the settings do, so it diffs cleanly.
    // The extended batch diffs on every cloud frame, supported or not: a
    // frame below the firmware floor renders the fields disabled, so they
    // never change, and normalizeFrameKeyValueForComparison keeps the form's
    // materialized defaults from reading as edits.
    return [
      ...(cloudFrameSettingKeys as readonly (keyof FrameType)[]),
      ...(extendedCloudFrameSettingKeys as readonly (keyof FrameType)[]),
      'scenes',
      'schedule',
    ]
  }
  return FRAME_KEYS
}

function frameSubmitKeys(frame: Partial<FrameType>): (keyof FrameType)[] {
  return frameDiffKeys()
}

export function normalizeSceneForComparison(
  scene: Partial<FrameScene> | null | undefined
): Partial<FrameScene> | null | undefined {
  if (!scene) {
    return scene
  }
  return {
    ...scene,
    apps: normalizeSceneApps(scene.apps),
  }
}

export function sceneEqualForComparison(
  first: Partial<FrameScene> | null | undefined,
  second: Partial<FrameScene> | null | undefined
): boolean {
  return equal(normalizeSceneForComparison(first), normalizeSceneForComparison(second))
}

function sceneChangeDetails(
  currentScenes: FrameScene[],
  deployedScenes: FrameScene[],
  frameMode: FrameType['mode']
): ChangeDetail[] {
  const details: ChangeDetail[] = []

  for (const scene of currentScenes) {
    const deployed = deployedScenes.find((s) => s.id === scene.id)
    const mode = sceneExecutionForFrame(scene, frameMode)
    const deployedMode = sceneExecutionForFrame(deployed, frameMode)

    if (!deployed) {
      details.push({
        label: `${mode === 'interpreted' ? 'Scene' : 'Compiled scene'} added: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
      continue
    }

    if (mode !== deployedMode) {
      details.push({
        label: `Scene mode changed: ${scene.name || scene.id} (${deployedMode} → ${mode})`,
        requiresFullDeploy: mode !== 'interpreted' || deployedMode !== 'interpreted',
      })
      continue
    }

    if (!sceneEqualForComparison(scene, deployed)) {
      details.push({
        label: `Scene updated: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
    }
  }

  for (const scene of deployedScenes) {
    if (!currentScenes.find((s) => s.id === scene.id)) {
      const mode = sceneExecutionForFrame(scene, frameMode)
      details.push({
        label: `Scene removed: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
    }
  }

  return details
}

function frameChangeDetailLabel(key: keyof FrameType, previousValue: unknown, nextValue: unknown): string {
  if (key === 'mode') {
    return `${deploymentModeLabel(previousValue)} → ${deploymentModeLabel(nextValue)}`
  }
  return keyLabel(key)
}

function remoteUpgradeChangeDetail(frame: Partial<FrameType> | null | undefined): ChangeDetail | null {
  const currentVersion = normalizeVersion(CURRENT_FRAMEOS_REMOTE_VERSION)
  if (!currentVersion || currentVersion === 'dev' || !remoteCanBeDeployed(frame?.agent)) {
    return null
  }

  const previousVersion = normalizeVersion(frame?.agent?.agentVersion)
  if (previousVersion === currentVersion) {
    return null
  }

  return {
    label: `FrameOS Remote ${previousVersion ?? 'unreported'} -> ${currentVersion}`,
    requiresFullDeploy: true,
    remoteVersionChange: {
      previousVersion,
      currentVersion,
    },
  }
}

function deployChangeDetails(
  previous: Partial<FrameType> | null | undefined,
  next: Partial<FrameType> | null | undefined,
  mode: FrameType['mode'],
  includeFrameosVersion = true
): ChangeDetail[] {
  const details = computeChangeDetails(previous, next, mode, includeFrameosVersion)
  const remoteUpgrade = remoteUpgradeChangeDetail(next)
  return remoteUpgrade ? [...details, remoteUpgrade] : details
}

function computeChangeDetails(
  previous: Partial<FrameType> | null | undefined,
  next: Partial<FrameType> | null | undefined,
  mode: FrameType['mode'],
  includeFrameosVersion = true
): ChangeDetail[] {
  const recompileFields = new Set(getRecompileFields(mode).filter((key) => key !== 'scenes'))
  const details: ChangeDetail[] = []
  const previousFrameosVersion = includeFrameosVersion ? deployedFrameosVersion(previous) : null

  for (const key of frameDiffKeys().filter((k) => k !== 'scenes')) {
    if (!frameKeyEqual(key, previous?.[key], next?.[key])) {
      details.push({
        label: frameChangeDetailLabel(key, previous?.[key], next?.[key]),
        requiresFullDeploy:
          key === 'mode' ||
          recompileFields.has(key) ||
          (includeFrameosVersion && frameKeyRequiresVersionUpgrade(key, previousFrameosVersion)),
      })
    }
  }

  const sceneDetails = sceneChangeDetails(next?.scenes ?? [], previous?.scenes ?? [], mode)

  if (includeFrameosVersion && frameosVersionRequiresDeploy(previousFrameosVersion)) {
    details.push({
      label: `FrameOS ${previousFrameosVersion ?? 'unreported'} -> ${CURRENT_FRAMEOS_VERSION}`,
      requiresFullDeploy: true,
      frameosVersionChange: {
        kind: 'upgrade',
        previousVersion: previousFrameosVersion,
        currentVersion: CURRENT_FRAMEOS_VERSION,
      },
    })
  }

  return [...details, ...sceneDetails]
}

function firstDeploySceneLabel(scenes?: FrameScene[] | null): string | null {
  const sceneCount = scenes?.length ?? 0
  if (sceneCount === 0) {
    return null
  }
  return `Deploy ${sceneCount} scene${sceneCount === 1 ? '' : 's'}`
}

function firstDeployChangeDetails(
  frame: Partial<FrameType> | null | undefined,
  mode: FrameType['mode']
): ChangeDetail[] {
  const details: ChangeDetail[] = [
    {
      label: 'Initial full deploy',
      requiresFullDeploy: true,
    },
    {
      label: `Install FrameOS ${CURRENT_FRAMEOS_VERSION}`,
      requiresFullDeploy: true,
      frameosVersionChange: {
        kind: 'install',
        currentVersion: CURRENT_FRAMEOS_VERSION,
      },
    },
  ]
  const device = frame?.device
  if (device) {
    details.push({
      label: `Install device support: ${device}`,
      requiresFullDeploy: true,
    })
  }
  const sceneLabel = firstDeploySceneLabel(frame?.scenes)
  if (sceneLabel) {
    details.push({
      label: sceneLabel,
      requiresFullDeploy: true,
    })
  }
  details.push({
    label:
      mode === 'buildroot' ? 'Install Buildroot target and frame services' : 'Install Raspberry Pi OS frame services',
    requiresFullDeploy: true,
  })
  const remoteUpgrade = remoteUpgradeChangeDetail(frame)
  if (remoteUpgrade) {
    details.push(remoteUpgrade)
  }

  return details
}

function sortDeployChangeDetails(changes: ChangeDetail[]): ChangeDetail[] {
  const priority = (change: ChangeDetail): number => {
    if (change.remoteVersionChange) {
      return 0
    }
    if (change.frameosVersionChange) {
      return 1
    }
    return change.requiresFullDeploy ? 2 : 3
  }

  return changes
    .map((change, index) => ({ change, index }))
    .sort((first, second) => {
      return priority(first.change) - priority(second.change) || first.index - second.index
    })
    .map(({ change }) => change)
}

function normalizeRpiosForComparison(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const { platform: _platform, compilationMode, crossCompilation: _crossCompilation, ...rest } = source

  return {
    ...rest,
    compilationMode: normalizeFrameCompilationMode(compilationMode),
  }
}

function normalizeMountpointsForComparison(value: unknown): Record<string, any> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items = rawItems
    .filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    )
    .map((item) => ({
      enabled: item.enabled !== false,
      source: String(item.source ?? '').trim(),
      target: String(item.target ?? '').trim(),
      username: String(item.username ?? ''),
      password: String(item.password ?? ''),
      domain: String(item.domain ?? ''),
      options: String(item.options ?? '').trim(),
    }))

  return {
    enabled: Boolean(source.enabled),
    items,
  }
}

function normalizeTimezoneForComparison(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRemoteForComparison(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    agentEnabled: Boolean(source.agentEnabled),
    agentRunCommands: Boolean(source.agentRunCommands),
    agentSharedSecret: source.agentSharedSecret ?? '',
  }
}

function normalizeFrameKeyValueForComparison(key: keyof FrameType, value: unknown): unknown {
  if (NUMERIC_FRAME_KEYS.has(key)) {
    return normalizeNumericFrameValue(value)
  }

  if (key === 'agent') {
    return normalizeRemoteForComparison(value)
  }

  if (key === 'timezone') {
    return normalizeTimezoneForComparison(value)
  }

  if (key === 'rpios') {
    return normalizeRpiosForComparison(value)
  }

  if (key === 'mountpoints') {
    return normalizeMountpointsForComparison(value)
  }

  if (key === 'timezone_updater') {
    return compactTimezoneUpdaterForSubmit(value as FrameType['timezone_updater'] | null | undefined)
  }

  // Both blocks are materialized with defaults by sanitizeFrame (error
  // handling) or arrive from the cloud in the runtime's shape (a boolean
  // control-code `enabled`, numbers) while the form keeps the Select-friendly
  // strings — compare canonical forms so neither reads as an unsaved edit.
  if (key === 'error_behavior') {
    return normalizeFrameErrorBehavior(value as Partial<FrameErrorBehavior> | null | undefined)
  }

  if (key === 'control_code') {
    return normalizeControlCodeForComparison(value)
  }

  if (key === 'flip') {
    return value || ''
  }

  if (key !== 'https_proxy' || !value || typeof value !== 'object') {
    return value
  }

  const httpsProxy = value as Record<string, unknown>
  const {
    server_cert_not_valid_after: _serverCertNotValidAfter,
    client_ca_cert_not_valid_after: _clientCaCertNotValidAfter,
    ...rest
  } = httpsProxy

  return rest
}

function normalizeControlCodeForComparison(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [subKey, subValue] of Object.entries(raw)) {
    if (subValue === undefined || subValue === null || subValue === '') {
      continue
    }
    if (subKey === 'enabled') {
      out.enabled = subValue === true || subValue === 'true'
    } else if (['size', 'padding', 'offsetX', 'offsetY'].includes(subKey)) {
      out[subKey] = normalizeNumericFrameValue(subValue)
    } else {
      out[subKey] = subValue
    }
  }
  // A control code that is off (and says nothing else) equals no control code.
  if (Object.keys(out).length === 0 || (Object.keys(out).length === 1 && out.enabled === false)) {
    return null
  }
  return out
}

function frameKeyEqual(key: keyof FrameType, previous: unknown, next: unknown): boolean {
  return equal(normalizeFrameKeyValueForComparison(key, previous), normalizeFrameKeyValueForComparison(key, next))
}

function summarizeSecret(value: unknown): string {
  return value ? 'Configured' : 'Not set'
}

function stringifyList(values: unknown[]): string {
  if (values.length === 0) {
    return 'None'
  }
  return values.map((value) => String(value)).join(', ')
}

function summarizeFrameFieldValue(key: keyof FrameType, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'Not set'
  }

  switch (key) {
    case 'frame_access_key':
    case 'server_api_key':
    case 'ssh_pass':
      return summarizeSecret(value)
    case 'mode':
      return deploymentModeLabel(value)
    case 'frame_admin_auth': {
      const auth = value as FrameType['frame_admin_auth']
      if (!auth?.enabled) {
        return 'Disabled'
      }
      return auth.user ? `Enabled (${auth.user})` : 'Enabled'
    }
    case 'https_proxy': {
      const proxy = value as FrameType['https_proxy']
      if (!proxy?.enable) {
        return 'Disabled'
      }
      const parts = [`Enabled on ${proxy.port || 8443}`]
      if (proxy.expose_only_port) {
        parts.push('port-only')
      }
      return parts.join(' · ')
    }
    case 'mountpoints': {
      const mountpoints = normalizeMountpointsForComparison(value)
      if (!mountpoints.enabled) {
        return 'Disabled'
      }
      const enabledItems = mountpoints.items.filter(
        (item: Record<string, unknown>) => item.enabled !== false && item.source && item.target
      ).length
      return enabledItems > 0 ? `${enabledItems} mountpoint${enabledItems === 1 ? '' : 's'}` : 'Enabled'
    }
    case 'error_behavior': {
      const behavior = normalizeFrameErrorBehavior(value as FrameErrorBehavior)
      if (behavior.mode === 'show_error_retry') {
        return `Show error, retry after ${behavior.retry_seconds}s`
      }
      if (behavior.mode === 'silent_retry') {
        return behavior.silent_retry_forever
          ? `Retry silently every ${behavior.silent_retry_seconds}s forever`
          : `Retry silently for ${behavior.silent_window_minutes}m`
      }
      return 'Fail hard into safe mode'
    }
    case 'ssh_keys': {
      const keys = Array.isArray(value) ? value : []
      return keys.length > 0 ? `${keys.length} selected` : 'None'
    }
    case 'server_send_logs':
    case 'debug':
      return value ? 'Enabled' : 'Disabled'
    case 'save_assets':
      if (typeof value === 'boolean') {
        return value ? 'Enabled' : 'Disabled'
      }
      if (value && typeof value === 'object') {
        const enabledKeys = Object.entries(value as Record<string, boolean>)
          .filter(([, enabled]) => Boolean(enabled))
          .map(([app]) => app)
        return enabledKeys.length > 0 ? stringifyList(enabledKeys) : 'Disabled'
      }
      return 'Disabled'
    case 'device_config':
      return value && typeof value === 'object' ? 'Configured' : 'Not set'
    default:
      return String(value)
  }
}

function buildUndeployedSummaryItems(
  previous: Partial<FrameType> | null | undefined,
  next: Partial<FrameType> | null | undefined,
  requiresRecompilation: boolean
): SummaryItem[] {
  const firstDeploy = !previous || Object.keys(previous).length === 0
  const items: SummaryItem[] = [
    {
      label: 'Full deploy',
      value: requiresRecompilation || firstDeploy ? 'Required' : 'Not required',
    },
  ]

  for (const key of DEPLOYMENT_SUMMARY_KEYS) {
    const nextValue = next?.[key]
    const previousValue = previous?.[key]
    const include = firstDeploy ? true : !frameKeyEqual(key, previousValue, nextValue)

    if (!include) {
      continue
    }

    items.push({
      label: keyLabel(key),
      value: summarizeFrameFieldValue(key, nextValue),
    })
  }

  return items
}

const SYSTEM_TEMPLATE_IMAGE_PATH = /^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/
const LOCAL_TEMPLATE_IMAGE_PATH = /^\/api\/(?:projects\/\d+\/)?templates\/([^/]+)\/image$/

/** Where the backend should copy this template's cover image from.
 *
 * The bytes must not travel through the browser unless we already hold them:
 * repository covers live on third-party origins (the FrameOS Cloud store
 * serves them from scenes.frameos.net with no CORS header), so `fetch()`ing
 * them to re-upload is blocked and every store install silently ended up with
 * "no snapshot". Same-origin proxy paths we cannot name to the backend (the
 * cloud drive proxy) still go through the blob path, which works because they
 * are same-origin.
 */
async function templateImageSource(template: Partial<TemplateType>): Promise<SceneImageSource | null> {
  if (template.image instanceof Blob) {
    return { blob: template.image }
  }

  // Deliberately keyed off `image`, never off `template.id`: repository
  // templates carry an id too ("bird-field-journal", a template folder name),
  // and treating that as a locally saved template's id resolves to a template
  // that does not exist here.
  if (typeof template.image === 'string' && template.image) {
    if (/^https?:\/\//i.test(template.image)) {
      return { url: template.image }
    }
    const systemMatch = template.image.match(SYSTEM_TEMPLATE_IMAGE_PATH)
    if (systemMatch) {
      return { url: `/api/${systemMatch[1]}/image` }
    }
    const localMatch = template.image.match(LOCAL_TEMPLATE_IMAGE_PATH)
    if (localMatch) {
      return { templateId: localMatch[1] }
    }
    // A FrameOS Cloud store cover (/api/store/scenes/<id>/image?v=N): the
    // route redirects to the CDN, so the browser must not fetch it — hand the
    // backend an absolute URL to copy from instead.
    if (template.image.startsWith('/api/store/')) {
      return { url: new URL(template.image, window.location.origin).toString() }
    }

    // Same-origin, but not a shape the backend can resolve on its own (e.g.
    // /api/cloud/store/drive/image/{sceneId}, which the backend proxies with
    // the cloud link token): fetching it here is safe, no CORS involved.
    const blob = await fetchSameOriginImageBlob(projectApiPathFromCache(template.image))
    return blob ? { blob } : null
  }

  return null
}

async function fetchSameOriginImageBlob(imageUrl: string): Promise<Blob | null> {
  const basePath = getBasePath()
  const scopedImageUrl = imageUrl.startsWith('/api/') ? await projectApiPath(imageUrl) : imageUrl
  const resolvedUrl = scopedImageUrl.startsWith('/api/') && basePath ? `${basePath}${scopedImageUrl}` : scopedImageUrl
  const response = await fetch(resolvedUrl, { credentials: 'include' })
  if (!response.ok) {
    return null
  }
  return await response.blob()
}

/**
 * @param preserveSceneIds keep the template's own scene ids instead of minting
 *   fresh ones. Only correct where those ids are a JOIN KEY rather than a local
 *   detail: a cloud store install is assigned server-side by store scene uuid,
 *   and the runtime ids inside its published zip are what
 *   /api/frames/{id}/scene_images resolves a cover through and what the save
 *   path matches a form scene back to its assignment by. Re-iding the local
 *   copy left the tile with an id the server could not resolve (blank forever)
 *   and made the next save create a duplicate private scene out of it.
 *   Everywhere else a template is a copy, and copies need new ids.
 */
export function buildScenesFromTemplate(
  template: Partial<TemplateType>,
  frame: Partial<FrameType>,
  preserveSceneIds = false
): FrameScene[] {
  if (!('scenes' in template)) {
    return []
  }

  const sanitized = (template.scenes ?? []).map((scene) => sanitizeScene(scene, frame))
  // Keeping ids means they can collide with what is already on the frame;
  // those scenes are literally already there, so drop them rather than
  // adding a second copy under the same id.
  const existingIds = new Set((frame.scenes ?? []).map((scene) => scene.id))
  const newScenes = preserveSceneIds
    ? sanitized.filter((scene) => !existingIds.has(scene.id))
    : duplicateScenes(sanitized)
  if (newScenes.length === 1) {
    newScenes[0].name = template?.name || newScenes[0].name || 'Untitled scene'
  }
  for (const scene of newScenes) {
    if ('default' in scene) {
      delete scene.default
    }
  }
  return newScenes
}

function templatesFromPayload(template: Partial<TemplateType>): Partial<TemplateType>[] {
  const batch = (template as TemplateBatchPayload).__templateBatch
  return Array.isArray(batch) ? batch : [template]
}

async function saveTemplateSceneImages(
  frameId: FrameId,
  template: Partial<TemplateType>,
  newScenes: FrameScene[]
): Promise<void> {
  if (!newScenes.length) {
    return
  }

  const targetScenes = getScenesWithoutParents(newScenes)
  if (!targetScenes.length) {
    return
  }

  // The cloud resolves store covers itself (assignSceneImages skips every
  // source but raw bytes there), so resolving a URL source would only fetch
  // bytes to throw away — and a store cover 307s to the CDN, which answers
  // without CORS headers, so that fetch failed and raised a "failed to copy"
  // toast. Bytes we already hold (an uploaded zip's cover) do go through.
  if (isCloudMode() && !(template.image instanceof Blob)) {
    return
  }

  let source: SceneImageSource | null = null
  try {
    source = await templateImageSource(template)
  } catch (error) {
    reportSceneImageFailure(frameId, targetScenes[0].id, 'cover image', error)
    return
  }

  await assignSceneImages(
    frameId,
    targetScenes.map((scene) => scene.id),
    source,
    { label: 'cover image' }
  )
}

function getScenesWithoutParents(scenes: FrameScene[]): FrameScene[] {
  if (scenes.length <= 1) {
    return scenes
  }

  const linkedSceneIds = new Set<string>()
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      if (node.type === 'scene') {
        const linkedSceneId = (node.data as SceneNodeData)?.keyword
        if (linkedSceneId) {
          linkedSceneIds.add(linkedSceneId)
        }
      }
    }
  }

  return scenes.filter((scene) => !linkedSceneIds.has(scene.id))
}

function cleanBackgroundColor(color: string): string {
  // convert the format "(r: 0, g: 0, b: 0)"
  if (color.startsWith('(r:')) {
    const [r, g, b] = color
      .replace(/[\(\)]/g, '')
      .split(',')
      .map((c) => parseInt(c.split(':')[1].trim(), 10))
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }
  if (color.match(/^#[a-fA-F0-9]{6}$/)) {
    return color
  }
  return '#000000'
}

// Renames for apps in scenes that predate the current keywords. Nodes using
// the removed legacy/* apps are rewritten server-side by the alembic
// migration and app/utils/legacy_app_migration.py.
const legacyAppMapping: Record<string, string> = {
  // render app
  color: 'render/color',
  gradient: 'render/gradient',
  text: 'render/text',
  renderImage: 'render/image',
  split: 'render/split',

  // logic app
  setAsState: 'logic/setAsState',
  breakIfRendering: 'logic/breakIfRendering',
  ifElse: 'logic/ifElse',

  // later renames
  'data/browserSnapshot': 'data/chromiumScreenshot',
}

export function sanitizeNodes(nodes: DiagramNode[]): DiagramNode[] {
  let changed = false
  const newNodes = nodes.map((node) => {
    if (node.type === 'app' && legacyAppMapping[(node.data as AppNodeData).keyword]) {
      changed = true
      return {
        ...node,
        data: {
          ...node.data,
          keyword: legacyAppMapping[(node.data as AppNodeData).keyword],
        },
      } as DiagramNode
    }
    return node
  })
  return changed ? newNodes : nodes
}

function normalizeNode(node: DiagramNode): DiagramNode {
  const normalizedType = node.type ?? (node as DiagramNode & { nodeType?: DiagramNode['type'] }).nodeType
  if (!normalizedType) {
    return node
  }
  return {
    ...node,
    type: normalizedType,
  } as DiagramNode
}

function normalizeEdge(edge: any): any {
  const normalizedType = edge.type ?? edge.edgeType
  if (!normalizedType) {
    return edge
  }
  return {
    ...edge,
    type: normalizedType,
  }
}

function sanitizeEdgesForNodes(edges: DiagramEdge[], nodes: DiagramNode[]): DiagramEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id))
  let changed = false
  const sanitizedEdges = edges.filter((edge) => {
    const valid =
      typeof edge.source === 'string' &&
      typeof edge.target === 'string' &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target)
    if (!valid) {
      changed = true
    }
    return valid
  })
  return changed ? sanitizedEdges : edges
}

function hasValidPosition(node: DiagramNode): boolean {
  return Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)
}

function sanitizeFrame(frame: Partial<FrameType>): Partial<FrameType> {
  const frameAdminAuthUser = frame.frame_admin_auth?.user ?? ''
  const frameAdminAuthPass = frame.frame_admin_auth?.pass ?? ''
  const mountpoints = normalizeMountpointsForComparison(frame.mountpoints) as FrameType['mountpoints']
  const assetsPath = frame.mode === 'buildroot' ? '/srv/assets' : frame.assets_path
  const buildroot =
    frame.mode === 'buildroot'
      ? {
          ...(frame.buildroot ?? {}),
          compilationMode: frame.buildroot?.compilationMode ?? '',
        }
      : frame.buildroot
  const rpios = frame.rpios
    ? (() => {
        const { crossCompilation: _crossCompilation, ...rpiosConfig } = frame.rpios
        return {
          ...rpiosConfig,
          compilationMode: frame.rpios.compilationMode ?? '',
        }
      })()
    : frame.rpios

  return {
    ...frame,
    timezone_updater: normalizeTimezoneUpdater(frame.timezone_updater),
    assets_path: assetsPath,
    rpios,
    frame_admin_auth: {
      enabled: frame.frame_admin_auth?.enabled ?? false,
      user: frameAdminAuthUser,
      pass: frameAdminAuthPass,
    },
    error_behavior: normalizeFrameErrorBehavior(frame.error_behavior),
    mountpoints,
    buildroot,
    scenes: frame.scenes?.map((scene) => sanitizeScene(scene, frame)) ?? [],
  }
}

function normalizeFrameForSubmit(frame: Partial<FrameType>): Partial<FrameType> {
  const normalizedFrame = {
    ...frame,
    timezone_updater: compactTimezoneUpdaterForSubmit(frame.timezone_updater),
    scenes: frame.scenes?.map((scene) => sanitizeScene(scene, frame)),
  }
  for (const key of NUMERIC_FRAME_KEYS) {
    if (key in normalizedFrame && normalizedFrame[key] !== undefined) {
      ;(normalizedFrame as Record<string, unknown>)[key] = normalizeNumericFrameValue(normalizedFrame[key])
    }
  }
  return normalizedFrame.mode === 'buildroot' ? { ...normalizedFrame, assets_path: '/srv/assets' } : normalizedFrame
}

function getCurrentFrameForm(frame: FrameType | null | undefined, frameForm: Partial<FrameType>): Partial<FrameType> {
  return Object.keys(frameForm ?? {}).length > 0 ? frameForm : frame ? sanitizeFrame(frame) : frameForm
}

function buildBlankScene(frame: Partial<FrameType>, name: string = 'New blank scene'): FrameScene {
  return sanitizeScene(
    {
      id: uuidv4(),
      name,
      nodes: [
        {
          id: uuidv4(),
          type: 'event',
          position: { x: 121, y: 113 },
          data: { keyword: 'render' },
        },
      ],
      edges: [],
      fields: [],
      settings: { execution: 'interpreted' },
    },
    frame
  )
}

function splitRatioString(ratios: number[], length: number): string {
  return Array.from({ length }, (_, index) => {
    const ratio = Number(ratios[index])
    return Number.isFinite(ratio) && ratio > 0 ? Number(ratio.toFixed(3)).toString() : '1'
  }).join(' ')
}

function splitLayoutBorderWidth(layout: SplitScreenSceneLayout): number {
  return Math.max(0, Math.min(48, Math.round(Number(layout.borderWidth) || 0)))
}

function splitLayoutOuterBorderWidth(layout: SplitScreenSceneLayout): number {
  const value = layout.outerBorderWidth ?? ((layout as any).outerBorder ? layout.borderWidth : 0)
  return Math.max(0, Math.min(48, Math.round(Number(value) || 0)))
}

function splitLayoutBackground(layout: SplitScreenSceneLayout): SplitScreenBackground {
  return {
    ...defaultSplitScreenBackground,
    ...(layout.background ?? {}),
    opacity: Math.max(0, Math.min(1, Number(layout.background?.opacity ?? defaultSplitScreenBackground.opacity) || 0)),
  }
}

function splitNodeConfig(branch: SplitLayoutBranch, gapWidth: number, outerBorderWidth: number): Record<string, any> {
  const rows = branch.direction === 'column' ? branch.children.length : 1
  const columns = branch.direction === 'row' ? branch.children.length : 1
  return {
    rows: String(rows),
    columns: String(columns),
    hideEmpty: false,
    gap: String(gapWidth),
    margin: String(outerBorderWidth),
    ...(branch.direction === 'row'
      ? { width_ratios: splitRatioString(branch.ratios, branch.children.length) }
      : { height_ratios: splitRatioString(branch.ratios, branch.children.length) }),
  }
}

export function buildSplitScene(
  frame: Partial<FrameType>,
  layout: SplitScreenSceneLayout,
  sceneId?: string | null
): FrameScene {
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  let visualIndex = 0
  const borderWidth = splitLayoutBorderWidth(layout)
  const outerBorderWidth = splitLayoutOuterBorderWidth(layout)
  const background = splitLayoutBackground(layout)

  const eventNode: DiagramNode = {
    id: uuidv4(),
    type: 'event',
    position: { x: 121, y: 113 },
    data: { keyword: 'render' },
  }
  nodes.push(eventNode)

  const addEdge = (source: string, sourceHandle: string, target: string, targetHandle = 'prev'): void => {
    edges.push({
      id: uuidv4(),
      source,
      sourceHandle,
      target,
      targetHandle,
      type: 'appNodeEdge',
    })
  }

  const addBackgroundNode = (): { firstNodeId: string; lastNodeId: string } | null => {
    let firstNodeId: string | null = null
    let lastNodeId: string | null = null

    if (background.sceneId) {
      const nodeId = uuidv4()
      nodes.push({
        id: nodeId,
        type: 'scene',
        position: { x: 390, y: -70 },
        data: { keyword: background.sceneId, config: {} } satisfies SceneNodeData,
      })
      firstNodeId = nodeId
      lastNodeId = nodeId
    }

    if (firstNodeId && lastNodeId && background.opacity < 1) {
      const opacityNodeId = uuidv4()
      nodes.push({
        id: opacityNodeId,
        type: 'app',
        position: { x: 390, y: 20 },
        data: {
          keyword: 'render/opacity',
          name: 'Background opacity',
          config: { opacity: background.opacity },
        } satisfies AppNodeData,
      })
      addEdge(lastNodeId, 'next', opacityNodeId)
      lastNodeId = opacityNodeId
    }

    return firstNodeId && lastNodeId ? { firstNodeId, lastNodeId } : null
  }

  const addSceneNode = (child: SplitLayoutNode, depth: number): string | null => {
    if (child.type !== 'leaf' || !child.sceneId) {
      return null
    }
    const nodeId = uuidv4()
    nodes.push({
      id: nodeId,
      type: 'scene',
      position: { x: 760 + depth * 320, y: 120 + visualIndex * 110 },
      data: { keyword: child.sceneId, config: { ...(child.state ?? {}) } } satisfies SceneNodeData,
    })
    visualIndex += 1
    return nodeId
  }

  const addSplitNode = (branch: SplitLayoutBranch, depth: number): string => {
    const nodeId = uuidv4()
    nodes.push({
      id: nodeId,
      type: 'app',
      position: { x: 400 + depth * 320, y: 100 + visualIndex * 40 },
      data: {
        keyword: 'render/split',
        name: depth === 0 ? 'Split screen' : 'Nested split',
        config: splitNodeConfig(branch, borderWidth, depth === 0 ? outerBorderWidth : 0),
      } satisfies AppNodeData,
    })

    branch.children.forEach((child, index) => {
      const targetNodeId = child.type === 'split' ? addSplitNode(child, depth + 1) : addSceneNode(child, depth + 1)
      if (!targetNodeId) {
        return
      }
      const row = branch.direction === 'column' ? index + 1 : 1
      const column = branch.direction === 'row' ? index + 1 : 1
      addEdge(nodeId, `field/render_functions[${row}][${column}]`, targetNodeId)
    })

    return nodeId
  }

  const rootNodeId = addSplitNode(layout.root, 0)
  const backgroundNodes = addBackgroundNode()
  if (backgroundNodes) {
    addEdge(eventNode.id, 'next', backgroundNodes.firstNodeId)
    addEdge(backgroundNodes.lastNodeId, 'next', rootNodeId)
  } else {
    addEdge(eventNode.id, 'next', rootNodeId)
  }

  return sanitizeScene(
    {
      id: sceneId || uuidv4(),
      name: layout.name || 'Split screen',
      nodes,
      edges,
      fields: [],
      settings: {
        backgroundColor: background.color,
        execution: 'interpreted',
        splitScreenLayout: cloneSplitScreenSceneLayout(layout) as unknown as Record<string, any>,
      },
    },
    frame
  )
}

/**
 * What the cloud scene save needs to tell an edited scene from an unedited
 * one, and a hydrated scene from an orphan. The form holds SANITIZED scenes
 * (positions filled, defaults materialized), so the store's raw scenes.json
 * has to go through the same sanitizer — against the server's frame, the one
 * the form was hydrated with — before the workspace's own scene equality can
 * judge it. Without this every settings save republished every owned scene
 * and forked every assigned scene the account does not own into a private
 * copy ("Abstract Architecture 2" … "8"). `sources` is the hydration record
 * of which assignment each runtime scene came from, so a pack whose
 * scenes.json cannot be re-read mid-save keeps its scenes claimed instead of
 * having them created again.
 */
function cloudScenePersistOptions(frameId: FrameId, fallbackFrame: Partial<FrameType>): CloudScenePersistOptions {
  const serverFrame = framesModel.findMounted()?.values.frames?.[frameId]
  const frame = serverFrame ?? fallbackFrame
  return {
    sceneUnchanged: (stored, form) => sceneEqualForComparison(sanitizeScene(stored, frame), sanitizeScene(form, frame)),
    sources: serverFrame?.cloud_scene_sources ?? null,
  }
}

async function saveFrameForm(frame: Partial<FrameType>, frameId: FrameId, nextAction: FrameNextAction): Promise<void> {
  const normalizedFrame = normalizeFrameForSubmit(frame)
  if (isCloudMode()) {
    // Cloud frames have no POST /api/frames/{id} — the control plane only
    // accepts the declarative settings allowlist, and applies it on the
    // device immediately (which is why Save stays visible with no deploy
    // step). Edited scene graphs go through the same store-scene persistence
    // Deploy uses (new immutable versions of assigned scenes, new private
    // scenes for unclaimed ones, then the checksummed assignment push).
    // Save used to skip scenes entirely, which silently dropped a newly
    // added scene while still reporting success because the name pushed.
    const settingsPushed = await pushCloudFrameSettings(frameId, normalizedFrame)
    // The schedule is its own verb (set_schedule via POST .../schedule), not
    // a settings key — push it only when the form's schedule differs from
    // server truth, so a name-only save does not re-enqueue an unchanged
    // schedule toward a sleeping battery frame.
    const schedule = normalizedFrame.schedule
    const savedSchedule = framesModel.findMounted()?.values.frames?.[frameId]?.schedule
    const schedulePushed = schedule !== undefined && !equal(schedule, savedSchedule)
    if (schedulePushed && schedule) {
      await pushCloudFrameSchedule(frameId, schedule)
    }
    const scenes = normalizedFrame.scenes ?? []
    if (scenes.length > 0) {
      const outcome = await persistAndPushCloudFrameScenes(
        frameId,
        scenes,
        normalizedFrame.active_scene_id,
        cloudScenePersistOptions(frameId, normalizedFrame)
      )
      for (const storeSceneId of outcome.changedStoreSceneIds) {
        clearCloudSceneJsonCache(storeSceneId)
      }
      framesModel.actions.hydrateCloudFrameScenes(frameId, true)
    } else if (!settingsPushed && !schedulePushed) {
      throw new Error('Nothing in these settings can be pushed to a cloud-managed frame')
    }
    return
  }
  const json = buildDeployPlanRequestBody(normalizedFrame, frameSubmitKeys(normalizedFrame))
  if (nextAction) {
    json['next_action'] = nextAction
  } else if (isInFrameAdminMode()) {
    json['skip_runtime_reload'] = true
  }
  const response = await apiFetch(`/api/frames/${frameId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  })
  if (!response.ok) {
    throw new Error('Failed to update frame')
  }
}

function openSceneControlDrawer(frameId: FrameId, sceneId: string): void {
  const searchParams = {
    ...router.values.searchParams,
    drawer: 'scene',
    sceneId,
    frameId: String(frameId),
  }
  router.actions.push(router.values.location.pathname, searchParams, router.values.hashParams)
}

export function sanitizeScene(scene: Partial<FrameScene>, frame: Partial<FrameType>): FrameScene {
  const settings = scene.settings ?? {}
  const frameRunsInterpreted = frameRunsScenesInterpreted(frame.mode)
  const normalizedRawNodes = (scene.nodes ?? []).map((node) => normalizeNode(node as DiagramNode))
  const sanitizedNodes = sanitizeNodes(normalizedRawNodes)
  const normalizedNodes = sanitizedNodes.map((node) =>
    hasValidPosition(node)
      ? node
      : {
          ...node,
          data: {
            ...node.data,
            ...(node.type === 'app' || node.type === 'event'
              ? { config: { ...((node.data as AppNodeData).config ?? {}) } }
              : {}),
          },
          position: { x: 0, y: 0 },
        }
  )
  const edges = sanitizeEdgesForNodes(
    (scene.edges ?? []).map((edge) => normalizeEdge(edge)),
    normalizedNodes
  )
  const shouldArrange = normalizedNodes.length > 0 && sanitizedNodes.every((node) => !hasValidPosition(node))
  const arranged = shouldArrange ? arrangeSceneGraph(normalizedNodes, edges) : { nodes: normalizedNodes, edges }
  return {
    ...scene,
    id: scene.id ?? uuidv4(),
    name: scene.name || 'Untitled scene',
    nodes: arranged.nodes,
    edges: arranged.edges,
    apps: normalizeSceneApps(scene.apps),
    fields: scene.fields ?? [],
    customEvents: (scene.customEvents ?? []).map((event) => normalizeCustomEvent(event)),
    settings: {
      ...settings,
      // Always materialized: templates, imports and chat scenes arrive
      // without it, and "absent" used to be read as compiled downstream.
      execution: frameRunsInterpreted ? ('interpreted' as const) : normalizeSceneExecution(scene),
      refreshInterval: settings.refreshInterval || frame.interval || 300,
      backgroundColor: cleanBackgroundColor(settings.backgroundColor || '#000000'),
    },
  } satisfies FrameScene
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface frameLogicValues {
  frames: Record<FrameId, FrameType> // framesModel
  latestPublishedRelease: string | null // publishedReleaseModel
  changedScenes: Set<string>
  defaultInterval: number
  defaultScene: string
  deployChangeDetails: ChangeDetail[]
  deployDrawerView: DeployDrawerView
  deployPlan: DeployPlanResponse | null
  deployPlanModalOpen: boolean
  deployPlans: DeployPlanResponse | null
  deployPlansError: string | null
  deployPlansLoading: boolean
  deployPlansLoadingStartedAt: string | null
  deployRecommendation: DeployRecommendation | null
  deployTransportToggleVisible: boolean
  deployWithAgent: boolean
  fastDeployPlan: DeployPlanResponse | null
  fastDeployPlanSummary: SummaryItem[]
  frame: FrameType
  frameForm: Partial<FrameType>
  frameFormAllErrors: Record<string, any>
  frameFormChanged: boolean
  frameFormErrors: DeepPartialMap<FrameType, ValidationErrorType>
  frameFormHasErrors: boolean
  frameFormManualErrors: Record<string, any>
  frameFormTouched: boolean
  frameFormTouches: Record<string, boolean>
  frameFormValidationErrors: DeepPartialMap<FrameType, ValidationErrorType>
  frameId: any
  frameSyncApplyMode: 'commit' | null
  frameSyncApplying: boolean
  frameSyncChoices: FrameSyncChoices
  frameSyncError: string | null
  frameSyncIgnoredToken: string | null
  frameSyncSectionsWithChanges: FrameSyncSection[]
  frameSyncStatus: FrameSyncStatus | null
  frameSyncStatusLoading: boolean
  frameSyncViews: FrameSyncViews
  fullDeployPlan: DeployPlanResponse | null
  fullDeployPlanSummary: SummaryItem[]
  hasFrameSyncChanges: boolean
  hasPendingFrameosUpgrade: boolean
  height: number | undefined
  isFrameAdminMode: boolean
  isFrameFormSubmitting: boolean
  isFrameFormValid: boolean
  lastDeploy: Partial<FrameType> | null
  mode: 'buildroot' | 'embedded' | 'rpios'
  nextAction: FrameNextAction
  remoteDeployConnected: boolean
  requiresRecompilation: boolean
  scenes: FrameScene[]
  showFrameFormErrors: boolean
  sortedScenes: FrameScene[]
  undeployedChangeDetails: ChangeDetail[]
  undeployedChanges: boolean
  undeployedSummaryItems: SummaryItem[]
  unsavedChangeDetails: ChangeDetail[]
  unsavedChanges: boolean
  width: number | undefined
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface frameLogicActions {
  applyFrameSync: () => {
    value: true
  }
  applyFrameSyncFailure: (error: string) => {
    error: string
  }
  applyFrameSyncSuccess: (sync: FrameSyncStatus | null) => {
    sync: FrameSyncStatus | null
  }
  applyTemplate: (
    template: Partial<TemplateType>,
    openDrawer?: boolean,
    preserveSceneIds?: boolean
  ) => {
    openDrawer: boolean
    preserveSceneIds: boolean
    template: Partial<TemplateType>
  }
  clearNextAction: () => {
    value: true
  }
  createBlankScene: (
    name?: string,
    openEditor?: boolean,
    openDrawer?: boolean
  ) => {
    name: string | undefined
    openDrawer: boolean
    openEditor: boolean
  }
  deleteSceneAndSave: (sceneId: string) => {
    sceneId: string
  }
  deployFrame: () => {
    value: true
  }
  deployRemote: (
    recompile?: boolean,
    transport?: RemoteTaskTransport
  ) => {
    recompile: boolean
    transport: RemoteTaskTransport
  }
  fastDeployFrame: () => {
    value: true
  }
  fullDeployFrame: () => {
    value: true
  }
  generateFrameAdminCredentials: () => {
    value: true
  }
  generateTlsCertificates: () => {
    value: true
  }
  hideDeployPlanModal: () => {
    value: true
  }
  ignoreFrameSyncChanges: () => {
    value: true
  }
  loadDeployPlans: () => {
    startedAt: string
  }
  loadDeployPlansFailure: (error: string) => {
    error: string
  }
  loadDeployPlansSuccess: (plan: DeployPlanResponse | null) => {
    plan: DeployPlanResponse | null
  }
  loadFrameSyncStatus: () => {
    value: true
  }
  loadFrameSyncStatusFailure: (error: string) => {
    error: string
  }
  loadFrameSyncStatusSuccess: (sync: FrameSyncStatus | null) => {
    sync: FrameSyncStatus | null
  }
  rebootFrame: () => {
    value: true
  }
  renderFrame: () => {
    value: true
  }
  resetFrameForm: (values?: FrameType) => {
    values?: FrameType
  }
  resetUndeployedChanges: () => {
    value: true
  }
  resetUnsavedChanges: () => {
    value: true
  }
  restartFrame: () => {
    value: true
  }
  restartRemote: (transport?: RemoteTaskTransport) => {
    transport: RemoteTaskTransport
  }
  saveAndDeployFrame: () => {
    value: true
  }
  saveAndFastDeployFrame: () => {
    value: true
  }
  saveAndFullDeployFrame: () => {
    value: true
  }
  saveFrame: () => {
    value: true
  }
  sendEvent: (
    event: string,
    payload: Record<string, any>
  ) => {
    event: string
    payload: Record<string, any>
  }
  setDeployDrawerView: (view: DeployDrawerView) => {
    view: DeployDrawerView
  }
  setDeployWithAgent: (deployWithAgent: boolean) => {
    deployWithAgent: boolean
  }
  setFrameFormManualErrors: (errors: Record<string, any>) => {
    errors: Record<string, any>
  }
  setFrameFormValue: (
    key: FieldName,
    value: any
  ) => {
    name: FieldName
    value: any
  }
  setFrameFormValues: (values: DeepPartial<FrameType>) => {
    values: DeepPartial<FrameType>
  }
  setFrameSyncChoices: (choices: FrameSyncChoices) => {
    choices: FrameSyncChoices
  }
  setFrameSyncIgnoredToken: (token: string | null) => {
    token: string | null
  }
  setFrameSyncItemChoice: (
    sectionId: FrameSyncSectionId,
    choiceKey: string,
    choice: FrameSyncChoice | FrameSyncSceneChoice
  ) => {
    choice: 'backend' | 'both' | 'frame' | 'ignore'
    choiceKey: string
    sectionId: FrameSyncSectionId
  }
  setFrameSyncView: (
    sectionId: FrameSyncSectionId,
    view: FrameSyncView
  ) => {
    sectionId: FrameSyncSectionId
    view: FrameSyncView
  }
  showDeployPlanModal: () => {
    value: true
  }
  stopFrame: () => {
    value: true
  }
  submitFrameForm: () => {
    value: boolean
  }
  submitFrameFormFailure: (
    error: Error,
    errors: Record<string, any>
  ) => {
    error: Error
    errors: Record<string, any>
  }
  submitFrameFormRequest: (frameForm: FrameType) => {
    frameForm: FrameType
  }
  submitFrameFormSuccess: (frameForm: FrameType) => {
    frameForm: FrameType
  }
  touchFrameFormField: (key: string) => {
    key: string
  }
  updateDeployedSshKeys: () => {
    value: true
  }
  updateNodeData: (
    sceneId: string,
    nodeId: string,
    nodeData: Record<string, any>
  ) => {
    nodeData: Record<string, any>
    nodeId: string
    sceneId: string
  }
  updateScene: (
    sceneId: string,
    scene: Partial<FrameScene>
  ) => {
    scene: Partial<FrameScene>
    sceneId: string
  }
  verifyTlsCertificates: () => {
    value: true
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface frameLogicMeta {
  key: FrameId
  __keaTypeGenInternalSelectorTypes: {
    frameId: (arg: any) => any
    frame: (frames: Record<FrameId, FrameType>, frameId: any) => FrameType
    mode: (frame: FrameType, frameForm: Partial<FrameType>) => 'buildroot' | 'embedded' | 'rpios'
    scenes: (frame: FrameType, frameForm: Partial<FrameType>) => FrameScene[]
    sortedScenes: (scenes: FrameScene[]) => FrameScene[]
    unsavedChanges: (frame: FrameType, frameForm: Partial<FrameType>) => boolean
    changedScenes: (frame: FrameType, frameForm: Partial<FrameType>) => Set<string>
    lastDeploy: (frame: FrameType) => Partial<FrameType> | null
    undeployedChanges: (
      frame: FrameType,
      lastDeploy: Partial<FrameType> | null,
      mode: 'buildroot' | 'embedded' | 'rpios',
      isFrameAdminMode: boolean,
      latestPublishedRelease: string | null
    ) => boolean
    unsavedChangeDetails: (
      frame: FrameType,
      frameForm: Partial<FrameType>,
      mode: 'buildroot' | 'embedded' | 'rpios'
    ) => ChangeDetail[]
    undeployedChangeDetails: (
      lastDeploy: Partial<FrameType> | null,
      frame: FrameType,
      mode: 'buildroot' | 'embedded' | 'rpios',
      isFrameAdminMode: boolean,
      latestPublishedRelease: string | null
    ) => ChangeDetail[]
    requiresRecompilation: (
      lastDeploy: Partial<FrameType> | null,
      frame: FrameType,
      frameForm: Partial<FrameType>,
      mode: 'buildroot' | 'embedded' | 'rpios',
      isFrameAdminMode: boolean
    ) => boolean
    deployChangeDetails: (
      lastDeploy: Partial<FrameType> | null,
      frameForm: Partial<FrameType>,
      mode: 'buildroot' | 'embedded' | 'rpios',
      isFrameAdminMode: boolean
    ) => ChangeDetail[]
    undeployedSummaryItems: (
      lastDeploy: Partial<FrameType> | null,
      frame: FrameType,
      frameForm: Partial<FrameType>,
      requiresRecompilation: boolean,
      isFrameAdminMode: boolean
    ) => SummaryItem[]
    deployPlan: (deployPlans: DeployPlanResponse | null) => DeployPlanResponse | null
    fastDeployPlan: (deployPlan: DeployPlanResponse | null) => DeployPlanResponse | null
    fullDeployPlan: (deployPlan: DeployPlanResponse | null) => DeployPlanResponse | null
    fastDeployPlanSummary: (fastDeployPlan: DeployPlanResponse | null) => SummaryItem[]
    fullDeployPlanSummary: (
      fullDeployPlan: DeployPlanResponse | null,
      frameForm: Partial<FrameType>,
      lastDeploy: Partial<FrameType> | null
    ) => SummaryItem[]
    deployRecommendation: (
      deployPlan: DeployPlanResponse | null,
      lastDeploy: Partial<FrameType> | null,
      deployChangeDetails: ChangeDetail[],
      frameForm: Partial<FrameType>
    ) => DeployRecommendation | null
    hasPendingFrameosUpgrade: (lastDeploy: Partial<FrameType> | null) => boolean
    defaultScene: (frame: FrameType, frameForm: Partial<FrameType>) => string
    width: (frameForm: Partial<FrameType>) => number | undefined
    height: (frameForm: Partial<FrameType>) => number | undefined
    defaultInterval: (frameForm: Partial<FrameType>) => number
    deployWithAgent: (frameForm: Partial<FrameType>, frame: FrameType) => boolean
    deployTransportToggleVisible: (frameForm: Partial<FrameType>, frame: FrameType) => boolean
    frameSyncSectionsWithChanges: (frameSyncStatus: FrameSyncStatus | null) => FrameSyncSection[]
    hasFrameSyncChanges: (
      frameSyncStatus: FrameSyncStatus | null,
      isFrameAdminMode: boolean,
      frame: FrameType,
      frameSyncIgnoredToken: string | null
    ) => boolean
    remoteDeployConnected: (frame: FrameType) => boolean
  }
}

export type frameLogicType = MakeLogicType<frameLogicValues, frameLogicActions, FrameLogicProps> & frameLogicMeta

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.frameId),
  connect(() => ({
    values: [framesModel, ['frames'], publishedReleaseModel, ['latestPublishedRelease']],
  })),
  actions({
    updateScene: (sceneId: string, scene: Partial<FrameScene>) => ({ sceneId, scene }),
    updateNodeData: (sceneId: string, nodeId: string, nodeData: Record<string, any>) => ({ sceneId, nodeId, nodeData }),
    saveFrame: true,
    saveAndDeployFrame: true,
    saveAndFastDeployFrame: true,
    saveAndFullDeployFrame: true,
    renderFrame: true,
    rebootFrame: true,
    restartFrame: true,
    stopFrame: true,
    deployFrame: true,
    fastDeployFrame: true,
    fullDeployFrame: true,
    deployRemote: (recompile?: boolean, transport: RemoteTaskTransport = 'auto') => ({
      recompile: recompile || false,
      transport,
    }),
    restartRemote: (transport: RemoteTaskTransport = 'auto') => ({ transport }),
    updateDeployedSshKeys: true,
    clearNextAction: true,
    resetUnsavedChanges: true,
    resetUndeployedChanges: true,
    applyTemplate: (template: Partial<TemplateType>, openDrawer?: boolean, preserveSceneIds?: boolean) => ({
      openDrawer: openDrawer ?? false,
      preserveSceneIds: preserveSceneIds ?? false,
      template,
    }),
    createBlankScene: (name?: string, openEditor?: boolean, openDrawer?: boolean) => ({
      name,
      openEditor: openEditor ?? false,
      openDrawer: openDrawer ?? false,
    }),
    deleteSceneAndSave: (sceneId: string) => ({ sceneId }),
    sendEvent: (event: string, payload: Record<string, any>) => ({ event, payload }),
    setDeployWithAgent: (deployWithAgent: boolean) => ({ deployWithAgent }),
    generateFrameAdminCredentials: true,
    generateTlsCertificates: true,
    verifyTlsCertificates: true,
    showDeployPlanModal: true,
    hideDeployPlanModal: true,
    setDeployDrawerView: (view: DeployDrawerView) => ({ view }),
    loadDeployPlans: () => ({ startedAt: new Date().toISOString() }),
    loadDeployPlansSuccess: (plan: DeployPlanResponse | null) => ({ plan }),
    loadDeployPlansFailure: (error: string) => ({ error }),
    loadFrameSyncStatus: true,
    loadFrameSyncStatusSuccess: (sync: FrameSyncStatus | null) => ({ sync }),
    loadFrameSyncStatusFailure: (error: string) => ({ error }),
    setFrameSyncItemChoice: (
      sectionId: FrameSyncSectionId,
      choiceKey: string,
      choice: FrameSyncChoice | FrameSyncSceneChoice
    ) => ({ sectionId, choiceKey, choice }),
    setFrameSyncChoices: (choices: FrameSyncChoices) => ({ choices }),
    setFrameSyncView: (sectionId: FrameSyncSectionId, view: FrameSyncView) => ({ sectionId, view }),
    applyFrameSync: true,
    ignoreFrameSyncChanges: true,
    setFrameSyncIgnoredToken: (token: string | null) => ({ token }),
    applyFrameSyncSuccess: (sync: FrameSyncStatus | null) => ({ sync }),
    applyFrameSyncFailure: (error: string) => ({ error }),
  }),
  forms(({ values }) => ({
    frameForm: {
      options: {
        showErrorsOnTouch: true,
      },
      defaults: {} as FrameType,
      errors: (state: Partial<FrameType>) => ({
        error_behavior: {},
        frame_admin_auth: state.frame_admin_auth?.enabled
          ? {
              user: state.frame_admin_auth?.user ? undefined : 'Username is required',
              pass: state.frame_admin_auth?.pass ? undefined : 'Password is required',
            }
          : undefined,
        scenes: frameFormSceneErrors(state.scenes),
        mountpoints: state.mountpoints?.enabled
          ? {
              items: (state.mountpoints.items ?? []).map((item) =>
                item.enabled === false
                  ? undefined
                  : {
                      source: item.source?.trim() ? undefined : 'Source is required',
                      target: item.target?.trim() ? undefined : 'Mount path is required',
                    }
              ),
            }
          : undefined,
      }),
      submit: async (frame) => {
        // A cloud Save is not the one quick POST it looks like: it pushes the
        // settings, may push the schedule, then persists every scene as a new
        // store-scene version and pushes the assignment list — seconds of
        // network on a frame with a few scenes, with nothing on screen saying
        // so. Only the FAILURE path used to report anything, so a slow save
        // was indistinguishable from a click that did nothing.
        //
        // Registered here rather than in the buttons because Save has several
        // entry points (the unsaved-changes drawer, the scene-control notice,
        // the frame actions menu, ⌘S); this covers all of them at once, and
        // the buttons additionally spin off isFrameFormSubmitting.
        longRunningTasksModel.actions.startTask({
          frameId: values.frameId,
          kind: 'save',
          title: 'Saving frame',
          detail: isCloudMode() ? 'Saving settings and scenes to your cloud account' : null,
        })
        // A throw is left to submitFrameFormFailure below, which fails this
        // very task with the reason — it is the one place that knows how to
        // word it.
        await saveFrameForm(frame, values.frameId, values.nextAction)
        longRunningTasksModel.actions.finishTask({
          frameId: values.frameId,
          kind: 'save',
          status: 'success',
          detail: 'Saved',
        })
      },
    },
  })),
  reducers({
    nextAction: [
      null as FrameNextAction,
      {
        saveFrame: () => null,
        clearNextAction: () => null,
        renderFrame: () => 'render',
        restartFrame: () => 'restart',
        rebootFrame: () => 'reboot',
        stopFrame: () => 'stop',
        deployFrame: () => 'deploy',
      },
    ],
    frameForm: [
      {} as Partial<FrameType>,
      {
        setDeployWithAgent: (state, { deployWithAgent }) => {
          const frame = state
          if (!frame) return state
          return {
            ...state,
            agent: { ...frame.agent, deployWithAgent },
          }
        },
      },
    ],
    deployPlans: [
      null as DeployPlanResponse | null,
      {
        loadDeployPlans: () => null,
        loadDeployPlansSuccess: (_, { plan }) => plan,
        resetFrameForm: () => null,
        setFrameFormValue: () => null,
        setFrameFormValues: () => null,
        setDeployWithAgent: () => null,
      },
    ],
    deployPlansLoading: [
      false,
      {
        loadDeployPlans: () => true,
        loadDeployPlansSuccess: () => false,
        loadDeployPlansFailure: () => false,
      },
    ],
    deployPlansLoadingStartedAt: [
      null as string | null,
      {
        loadDeployPlans: (_, { startedAt }) => startedAt,
      },
    ],
    deployPlansError: [
      null as string | null,
      {
        loadDeployPlans: () => null,
        loadDeployPlansSuccess: () => null,
        loadDeployPlansFailure: (_, { error }) => error,
        resetFrameForm: () => null,
        setFrameFormValue: () => null,
        setFrameFormValues: () => null,
        showDeployPlanModal: () => null,
        hideDeployPlanModal: () => null,
      },
    ],
    deployPlanModalOpen: [
      false,
      {
        showDeployPlanModal: () => true,
        hideDeployPlanModal: () => false,
        submitFrameFormSuccess: () => false,
      },
    ],
    deployDrawerView: [
      'main' as DeployDrawerView,
      {
        setDeployDrawerView: (_, { view }) => view,
        hideDeployPlanModal: () => 'main',
      },
    ],
    frameSyncStatus: [
      null as FrameSyncStatus | null,
      {
        loadFrameSyncStatusSuccess: (_, { sync }) => sync,
        applyFrameSyncSuccess: (_, { sync }) => sync,
        setFrameFormValue: () => null,
        setFrameFormValues: () => null,
      },
    ],
    frameSyncChoices: [
      defaultFrameSyncChoices(null),
      {
        loadFrameSyncStatusSuccess: (_, { sync }) => defaultFrameSyncChoices(sync),
        applyFrameSyncSuccess: (_, { sync }) => defaultFrameSyncChoices(sync),
        setFrameSyncItemChoice: (state, { sectionId, choiceKey, choice }) =>
          sectionId === 'frame_json'
            ? {
                ...state,
                frame_json: { ...state.frame_json, [choiceKey]: choice as FrameSyncChoice },
              }
            : {
                ...state,
                scenes_json: { ...state.scenes_json, [choiceKey]: choice as FrameSyncSceneChoice },
              },
        setFrameSyncChoices: (_, { choices }) => choices,
        setFrameFormValue: () => defaultFrameSyncChoices(null),
        setFrameFormValues: () => defaultFrameSyncChoices(null),
      },
    ],
    frameSyncViews: [
      {} as FrameSyncViews,
      {
        loadFrameSyncStatusSuccess: (_, { sync }) => defaultFrameSyncViews(sync),
        applyFrameSyncSuccess: (_, { sync }) => defaultFrameSyncViews(sync),
        setFrameSyncView: (state, { sectionId, view }) => ({ ...state, [sectionId]: view }),
        setFrameFormValue: () => ({}),
        setFrameFormValues: () => ({}),
      },
    ],
    frameSyncStatusLoading: [
      false,
      {
        loadFrameSyncStatus: () => true,
        loadFrameSyncStatusSuccess: () => false,
        loadFrameSyncStatusFailure: () => false,
      },
    ],
    frameSyncApplying: [
      false,
      {
        applyFrameSync: () => true,
        applyFrameSyncSuccess: () => false,
        applyFrameSyncFailure: () => false,
      },
    ],
    frameSyncApplyMode: [
      null as 'commit' | null,
      {
        applyFrameSync: () => 'commit',
        applyFrameSyncSuccess: () => null,
        applyFrameSyncFailure: () => null,
      },
    ],
    frameSyncIgnoredToken: [
      null as string | null,
      {
        setFrameSyncIgnoredToken: (_, { token }) => token,
      },
    ],
    frameSyncError: [
      null as string | null,
      {
        loadFrameSyncStatus: () => null,
        loadFrameSyncStatusSuccess: () => null,
        loadFrameSyncStatusFailure: (_, { error }) => error,
        applyFrameSync: () => null,
        applyFrameSyncSuccess: () => null,
        applyFrameSyncFailure: (_, { error }) => error,
        hideDeployPlanModal: () => null,
        setFrameFormValue: () => null,
        setFrameFormValues: () => null,
      },
    ],
  }),
  listeners(({ asyncActions, actions, values }) => ({
    resetUnsavedChanges: () => {
      if (!values.frame) {
        return
      }

      actions.resetFrameForm(sanitizeFrame(values.frame) as FrameType)
    },
    resetUndeployedChanges: async () => {
      if (!values.lastDeploy) {
        return
      }

      actions.clearNextAction()
      actions.resetFrameForm(sanitizeFrame(values.lastDeploy) as FrameType)
    },
    updateDeployedSshKeys: async () => {
      actions.clearNextAction()
      await asyncActions.submitFrameForm()
      const response = await apiFetch(`/api/frames/${values.frameId}/ssh_keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssh_keys: values.frameForm.ssh_keys ?? [] }),
      })
      if (!response.ok) {
        throw new Error('Failed to update deployed SSH keys')
      }
    },
    generateFrameAdminCredentials: () => {
      const frameAdminAuth = values.frameForm.frame_admin_auth || values.frame?.frame_admin_auth || {}
      actions.setFrameFormValues({
        frame_admin_auth: {
          ...frameAdminAuth,
          enabled: true,
          user: 'admin',
          pass: secureToken(24),
        },
      })
      actions.touchFrameFormField('frame_admin_auth.enabled')
      actions.touchFrameFormField('frame_admin_auth.user')
      actions.touchFrameFormField('frame_admin_auth.pass')
    },
    generateTlsCertificates: async () => {
      let data
      if (isInFrameAdminMode()) {
        data = generateFrameTlsMaterial(values.frameForm.frame_host || values.frame?.frame_host || '')
      } else {
        const response = await apiFetch(`/api/frames/${values.frameId}/tls/generate`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to generate TLS certificates')
        }
        data = await response.json()
      }
      actions.setFrameFormValues({
        https_proxy: {
          ...(values.frameForm.https_proxy || values.frame?.https_proxy || {}),
          certs: {
            ...((values.frameForm.https_proxy || values.frame?.https_proxy || {}).certs || {}),
            server: data.certs.server,
            server_key: data.certs.server_key,
            client_ca: data.certs.client_ca,
          },
          server_cert_not_valid_after: data.server_cert_not_valid_after,
          client_ca_cert_not_valid_after: data.client_ca_cert_not_valid_after,
        },
      })
      actions.touchFrameFormField('https_proxy.certs.server')
      actions.touchFrameFormField('https_proxy.certs.server_key')
      actions.touchFrameFormField('https_proxy.certs.client_ca')
    },
    verifyTlsCertificates: async () => {
      const frame = values.frameForm || values.frame
      if (
        !frame.https_proxy?.certs?.server ||
        !frame.https_proxy?.certs?.server_key ||
        !frame.https_proxy?.certs?.client_ca
      ) {
        console.warn('TLS enabled but certificates are missing, generating new certificates')
        actions.generateTlsCertificates()
      }
      if (!frame.https_proxy?.port) {
        actions.setFrameFormValues({
          https_proxy: {
            ...(frame.https_proxy || {}),
            port: 8443,
            expose_only_port: true,
          },
        })
      }
    },
    loadDeployPlans: async () => {
      const currentFrameForm = {
        ...(values.frame ?? {}),
        ...(values.frameForm ?? {}),
      }
      // Embedded frames use 'combined' too: the backend's combined plan for
      // them carries the fast (HTTP scene upload) section and, for ESP32
      // targets with OTA support, the full (firmware rebuild + OTA) section.
      const deployPlanMode = 'combined'
      const response = await apiFetch(`/api/frames/${values.frameId}/deploy_plan?mode=${deployPlanMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildDeployPlanRequestBody(normalizeFrameForSubmit(currentFrameForm), frameSubmitKeys(currentFrameForm))
        ),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.loadDeployPlansFailure(getDeployPlanErrorMessage(payload))
        return
      }

      const payload = (await response.json()) as DeployPlanApiResponse
      actions.loadDeployPlansSuccess(payload.plan)
    },
    loadFrameSyncStatus: async () => {
      if (isInFrameAdminMode() || !values.frame || values.frame.archived) {
        actions.loadFrameSyncStatusSuccess(null)
        return
      }
      const response = await apiFetch(`/api/frames/${values.frameId}/sync`)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.loadFrameSyncStatusFailure(
          typeof payload?.detail === 'string' ? payload.detail : 'Failed to check frame sync'
        )
        return
      }
      const payload = (await response.json()) as FrameSyncApiResponse
      actions.loadFrameSyncStatusSuccess(payload.sync)
      if (payload.frame) {
        framesModel.actions.loadFrame(values.frameId)
      }
    },
    applyFrameSync: async () => {
      const body = {
        frame_json_choices: values.frameSyncChoices.frame_json,
        scenes_json_choices: values.frameSyncChoices.scenes_json,
      }
      if (!hasSelectedFrameSyncChoices(values.frameSyncChoices)) {
        actions.applyFrameSyncFailure('Choose what to sync first')
        return
      }
      const response = await apiFetch(`/api/frames/${values.frameId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.applyFrameSyncFailure(typeof payload?.detail === 'string' ? payload.detail : 'Failed to sync frame')
        return
      }
      const payload = (await response.json()) as FrameSyncApiResponse
      actions.applyFrameSyncSuccess(payload.sync)
      framesModel.actions.loadFrame(values.frameId)
    },
    ignoreFrameSyncChanges: () => {
      actions.setFrameSyncIgnoredToken(currentFrameSyncToken(values.frame, values.frameSyncStatus))
      if (!values.deployPlansLoading && !values.deployPlans && !isInFrameAdminMode()) {
        actions.loadDeployPlans()
      }
    },
    showDeployPlanModal: () => {
      // The cloud's deploy dialog (FrameDeployPlanDrawer's cloud branch)
      // shows no build plan: there is no POST /api/frames/{id}/deploy_plan
      // and no /sync on that control plane, so fetching either only parked a
      // 404 in the drawer's error slot. Its own state — unsaved changes,
      // scene count, connection — comes from the frame row.
      if (isCloudMode()) {
        return
      }
      if (
        !values.frameSyncStatusLoading &&
        shouldLoadFrameSyncStatus(values.frame, values.frameSyncStatus, values.frameSyncIgnoredToken)
      ) {
        actions.loadFrameSyncStatus()
      }
      const isBuildroot = (values.frameForm?.mode || values.frame?.mode || 'rpios') === 'buildroot'
      const buildrootFirstInstall =
        isBuildroot && !values.frame?.last_successful_deploy && !values.frame?.last_successful_deploy_at
      if (buildrootFirstInstall) {
        return
      }
      if (isBuildroot && !values.deployPlansLoading && !values.deployPlans) {
        actions.loadDeployPlans()
        return
      }
      const hasUsableLocalPlan =
        Boolean(values.deployRecommendation) ||
        values.fullDeployPlanSummary.length > 0 ||
        values.deployChangeDetails.length > 0
      if (!hasUsableLocalPlan && !values.deployPlansLoading && !values.deployPlans) {
        actions.loadDeployPlans()
      }
    },
  })),
  selectors(() => ({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    frame: [(s) => [s.frames, s.frameId], (frames: frameLogicValues['frames'], frameId) => frames[frameId] || null],
    mode: [
      (s) => [s.frame, s.frameForm],
      (frame: frameLogicValues['frame'], frameForm: frameLogicValues['frameForm']) =>
        frameForm?.mode || frame?.mode || 'rpios',
    ],
    isFrameAdminMode: [() => [], () => isInFrameAdminMode()],
    scenes: [
      (s) => [s.frame, s.frameForm],
      (frame: frameLogicValues['frame'], frameForm: frameLogicValues['frameForm']): FrameScene[] =>
        frameForm?.scenes ?? frame?.scenes ?? [],
    ],
    sortedScenes: [
      (s) => [s.scenes],
      (scenes: frameLogicValues['scenes']): FrameScene[] => scenes.toSorted((a, b) => a.name.localeCompare(b.name)),
    ],
    unsavedChanges: [
      (s) => [s.frame, s.frameForm],
      (frame: frameLogicValues['frame'], frameForm: frameLogicValues['frameForm']) => {
        const currentFrameForm = {
          ...(frame ?? {}),
          ...(frameForm ?? {}),
        }
        const keys = frameSubmitKeys(currentFrameForm)
        return keys.some(
          (key) => !frameKeyEqual(key, frame?.[key as keyof FrameType], frameForm?.[key as keyof FrameType])
        )
      },
    ],
    changedScenes: [
      (s) => [s.frame, s.frameForm],
      (frame: frameLogicValues['frame'], frameForm: frameLogicValues['frameForm']): Set<string> => {
        const frameScenes = frame?.scenes ?? []
        const unsavedScenes = frameForm?.scenes ?? frameScenes
        const changed = new Set<string>()

        unsavedScenes.forEach((scene) => {
          const original = frameScenes.find((candidate) => candidate.id === scene.id)
          if (!original || !sceneEqualForComparison(original, scene)) {
            changed.add(scene.id)
          }
        })

        return changed
      },
    ],
    lastDeploy: [(s) => [s.frame], (frame: frameLogicValues['frame']) => deployedFrameBaseline(frame)],
    undeployedChanges: [
      (s) => [s.frame, s.lastDeploy, s.mode, s.isFrameAdminMode, s.latestPublishedRelease],
      (
        frame: FrameType,
        lastDeploy: Partial<FrameType> | null,
        mode: FrameType['mode'],
        isFrameAdminMode: boolean,
        latestPublishedRelease: string | null
      ) => {
        if (isCloudManagedFrame(frame)) {
          return !frame?.archived && cloudUndeployedChangeDetails(frame, latestPublishedRelease).length > 0
        }
        return !isFrameAdminMode && !frame?.archived && deployChangeDetails(lastDeploy, frame, mode).length > 0
      },
    ],
    unsavedChangeDetails: [
      (s) => [s.frame, s.frameForm, s.mode],
      (
        frame: frameLogicValues['frame'],
        frameForm: frameLogicValues['frameForm'],
        mode: frameLogicValues['mode']
      ): ChangeDetail[] => computeChangeDetails(frame, frameForm, mode, false),
    ],
    undeployedChangeDetails: [
      (s) => [s.lastDeploy, s.frame, s.mode, s.isFrameAdminMode, s.latestPublishedRelease],
      (
        lastDeploy: frameLogicValues['lastDeploy'],
        frame: frameLogicValues['frame'],
        mode: frameLogicValues['mode'],
        isFrameAdminMode: frameLogicValues['isFrameAdminMode'],
        latestPublishedRelease: frameLogicValues['latestPublishedRelease']
      ): ChangeDetail[] => {
        if (isCloudManagedFrame(frame)) {
          return frame?.archived ? [] : cloudUndeployedChangeDetails(frame, latestPublishedRelease)
        }
        return isFrameAdminMode || frame?.archived ? [] : deployChangeDetails(lastDeploy, frame, mode)
      },
    ],
    requiresRecompilation: [
      (s) => [s.lastDeploy, s.frame, s.frameForm, s.mode, s.isFrameAdminMode],
      (
        lastDeploy: Partial<FrameType> | null,
        frame: FrameType,
        frameForm: Partial<FrameType>,
        mode: FrameType['mode'],
        isFrameAdminMode: boolean
      ): boolean => {
        // Cloud pushes are interpreted-only — nothing is ever compiled.
        if (isFrameAdminMode || frame?.archived || isCloudManagedFrame(frame)) {
          return false
        }
        const pendingFrame = Object.keys(frameForm ?? {}).length > 0 ? frameForm : frame
        return deployChangeDetails(lastDeploy, pendingFrame, mode).some((change) => change.requiresFullDeploy)
      },
    ],
    deployChangeDetails: [
      (s) => [s.lastDeploy, s.frameForm, s.mode, s.isFrameAdminMode],
      (
        lastDeploy: frameLogicValues['lastDeploy'],
        frameForm: frameLogicValues['frameForm'],
        mode: frameLogicValues['mode'],
        isFrameAdminMode: frameLogicValues['isFrameAdminMode']
      ): ChangeDetail[] =>
        isFrameAdminMode
          ? []
          : lastDeploy
          ? sortDeployChangeDetails(deployChangeDetails(lastDeploy, frameForm, mode))
          : firstDeployChangeDetails(frameForm, mode),
    ],
    undeployedSummaryItems: [
      (s) => [s.lastDeploy, s.frame, s.frameForm, s.requiresRecompilation, s.isFrameAdminMode],
      (
        lastDeploy: Partial<FrameType> | null,
        frame: FrameType,
        frameForm: Partial<FrameType>,
        requiresRecompilation: boolean,
        isFrameAdminMode: boolean
      ): SummaryItem[] => {
        const pendingFrame = Object.keys(frameForm ?? {}).length > 0 ? frameForm : frame
        return isFrameAdminMode ? [] : buildUndeployedSummaryItems(lastDeploy, pendingFrame, requiresRecompilation)
      },
    ],
    deployPlan: [(s) => [s.deployPlans], (deployPlans: frameLogicValues['deployPlans']) => deployPlans],
    fastDeployPlan: [(s) => [s.deployPlan], (deployPlan: frameLogicValues['deployPlan']) => deployPlan],
    fullDeployPlan: [(s) => [s.deployPlan], (deployPlan: frameLogicValues['deployPlan']) => deployPlan],
    fastDeployPlanSummary: [
      (s) => [s.fastDeployPlan],
      (fastDeployPlan: frameLogicValues['fastDeployPlan']): SummaryItem[] => buildFastDeployPlanSummary(fastDeployPlan),
    ],
    fullDeployPlanSummary: [
      (s) => [s.fullDeployPlan, s.frameForm, s.lastDeploy],
      (
        fullDeployPlan: DeployPlanResponse | null,
        frameForm: Partial<FrameType>,
        lastDeploy: Partial<FrameType> | null
      ): SummaryItem[] => {
        const probedSummary = buildFullDeployPlanSummary(fullDeployPlan, frameForm)
        return probedSummary.length > 0 ? probedSummary : buildInferredFullDeployPlanSummary(lastDeploy, frameForm)
      },
    ],
    deployRecommendation: [
      (s) => [s.deployPlan, s.lastDeploy, s.deployChangeDetails, s.frameForm],
      (
        deployPlan: frameLogicValues['deployPlan'],
        lastDeploy: frameLogicValues['lastDeploy'],
        deployChangeDetails: frameLogicValues['deployChangeDetails'],
        frameForm: frameLogicValues['frameForm']
      ): DeployRecommendation | null =>
        buildDeployRecommendation(
          deployPlanPreviousFrameosVersion(deployPlan) ?? deployedFrameosVersion(lastDeploy),
          Boolean(lastDeploy),
          deployChangeDetails,
          frameForm,
          deployPlan
        ),
    ],
    hasPendingFrameosUpgrade: [
      (s) => [s.lastDeploy],
      (lastDeploy: Partial<FrameType> | null): boolean => {
        const previousVersion = deployedFrameosVersion(lastDeploy)
        return Boolean(previousVersion && previousVersion !== CURRENT_FRAMEOS_VERSION)
      },
    ],
    defaultScene: [
      (s) => [s.frame, s.frameForm],
      (frame: frameLogicValues['frame'], frameForm: frameLogicValues['frameForm']) => {
        const allScenes = frameForm?.scenes ?? frame?.scenes ?? []
        return (allScenes.find((scene) => scene.id === 'default' || scene.default) || allScenes[0])?.id ?? null
      },
    ],
    width: [
      (s) => [s.frameForm],
      (frameForm: frameLogicValues['frameForm']) =>
        frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.height : frameForm.width,
    ],
    height: [
      (s) => [s.frameForm],
      (frameForm: frameLogicValues['frameForm']) =>
        frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.width : frameForm.height,
    ],
    defaultInterval: [(s) => [s.frameForm], (frameForm: frameLogicValues['frameForm']) => frameForm.interval ?? 300],
    deployWithAgent: [
      (s) => [s.frameForm, s.frame],
      (frameForm: frameLogicValues['frameForm'], frame: frameLogicValues['frame']) => {
        const agent = frameForm?.agent ?? frame?.agent
        if (!isRemoteDeployConfigured(agent)) {
          return false
        }
        // Deliberately not clamped to the live connection state: this is the
        // user's chosen transport, not a reachability report. The dot next to
        // the Remote button shows whether it is currently connected.
        return agent?.deployWithAgent ?? true
      },
    ],
    deployTransportToggleVisible: [
      (s) => [s.frameForm, s.frame],
      (frameForm: frameLogicValues['frameForm'], frame: frameLogicValues['frame']): boolean => {
        const agent = frameForm?.agent ?? frame?.agent
        return isRemoteDeployConfigured(agent)
      },
    ],
    frameSyncSectionsWithChanges: [
      (s) => [s.frameSyncStatus],
      (frameSyncStatus: FrameSyncStatus | null) =>
        frameSyncStatus?.sections.filter((section) => section.has_changes) ?? [],
    ],
    hasFrameSyncChanges: [
      (s) => [s.frameSyncStatus, s.isFrameAdminMode, s.frame, s.frameSyncIgnoredToken],
      (
        frameSyncStatus: FrameSyncStatus | null,
        isFrameAdminMode: boolean,
        frame: FrameType | null,
        frameSyncIgnoredToken: string | null
      ): boolean => {
        if (isFrameAdminMode) {
          return false
        }
        const syncToken = currentFrameSyncToken(frame, frameSyncStatus)
        if (syncToken && syncToken === frameSyncIgnoredToken) {
          return false
        }
        if (frameSyncStatus) {
          if (syncHintIsNewerThanStatus(frame, frameSyncStatus)) {
            return Boolean(frame?.frame_sync_hint?.has_changes)
          }
          return Boolean(frameSyncStatus.has_changes)
        }
        return Boolean(frame?.frame_sync_hint?.has_changes)
      },
    ],
    remoteDeployConnected: [
      (s) => [s.frame],
      (frame: frameLogicValues['frame']): boolean => (frame?.active_connections ?? 0) > 0,
    ],
  })),
  subscriptions(({ actions, values }) => ({
    frame: (frame?: FrameType, oldFrame?: FrameType) => {
      const previousMode = values.frameForm?.mode || oldFrame?.mode || 'rpios'
      const frameFormMatchesPrevious = oldFrame
        ? computeChangeDetails(oldFrame, values.frameForm, previousMode, false).length === 0
        : false
      if (frame && (!oldFrame || frameFormMatchesPrevious)) {
        actions.resetFrameForm(sanitizeFrame(frame) as FrameType)
      }
      if (
        !values.frameSyncStatusLoading &&
        shouldLoadFrameSyncStatus(frame ?? null, values.frameSyncStatus, values.frameSyncIgnoredToken)
      ) {
        actions.loadFrameSyncStatus()
      }
    },
  })),
  listeners(({ asyncActions, actions, values, props }) => {
    // Adds the templates' scenes to the frame form without saving; the user
    // reviews and saves/deploys the change through the normal flow.
    const appendTemplates = async (
      templates: Partial<TemplateType>[],
      openDrawer: boolean,
      preserveSceneIds = false
    ): Promise<void> => {
      const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
      const oldScenes = frameForm.scenes || []
      const sceneGroups = templates
        .map((template) => ({
          scenes: buildScenesFromTemplate(template, frameForm, preserveSceneIds),
          template,
        }))
        .filter(({ scenes }) => scenes.length > 0)
      const newScenes = sceneGroups.flatMap(({ scenes }) => scenes)
      if (!newScenes.length) {
        return
      }

      actions.setFrameFormValues({ scenes: [...oldScenes, ...newScenes] })
      if (openDrawer) {
        openSceneControlDrawer(props.frameId, newScenes[0].id)
      }
      await Promise.all(
        sceneGroups.map(({ template, scenes }) => saveTemplateSceneImages(props.frameId, template, scenes))
      )
    }

    // Cloud Save & Deploy. The cloud's "save" is the declarative settings
    // push (the same call saveFrameForm makes) — but a form whose only
    // pending changes are scenes maps onto no settings at all, which
    // saveFrameForm treats as an error on a plain Save. Here it is fine: the
    // scenes are persisted separately — each edited scene becomes a new
    // version of its private cloud scene (new scenes are created), the
    // assignment list is updated, and POST /api/frames/{id}/scenes pushes the
    // checksummed result to the device. That push IS the deploy; the ad-hoc
    // uploadScenes shim stays as the fallback when persistence fails, so the
    // frame still updates even if the cloud refuses a scene.
    const cloudSaveAndDeploy = async (): Promise<void> => {
      try {
        await pushCloudFrameSettings(props.frameId, normalizeFrameForSubmit(values.frameForm))
        framesModel.actions.loadFrame(props.frameId)
      } catch (error) {
        // Same surfacing as submitFrameFormFailure: a silent failure looks
        // like the click did nothing.
        const message = error instanceof Error ? error.message : 'Failed to save the frame'
        const detail = message.includes('frame_not_active')
          ? 'This frame is still pending — confirm it on its dashboard before saving changes to it.'
          : message
        longRunningTasksModel.actions.startTask({
          frameId: props.frameId,
          kind: 'save',
          title: 'Saving frame',
          detail: null,
        })
        longRunningTasksModel.actions.taskFailed({ frameId: props.frameId, kind: 'save', detail })
        throw error
      }
      const scenes = values.frameForm?.scenes ?? values.frame?.scenes ?? []
      if (!scenes.length) {
        framesModel.actions.deployFrame(props.frameId, false)
        return
      }
      longRunningTasksModel.actions.startTask({
        frameId: props.frameId,
        kind: 'deploy',
        title: 'Deploying scenes',
        detail: 'Saving scenes to your cloud account',
      })
      try {
        const outcome = await persistAndPushCloudFrameScenes(
          props.frameId,
          scenes,
          values.frame?.active_scene_id,
          cloudScenePersistOptions(props.frameId, values.frameForm ?? values.frame ?? {})
        )
        for (const storeSceneId of outcome.changedStoreSceneIds) {
          clearCloudSceneJsonCache(storeSceneId)
        }
        framesModel.actions.hydrateCloudFrameScenes(props.frameId, true)
        framesModel.actions.loadFrame(props.frameId)
        longRunningTasksModel.actions.finishTask({
          frameId: props.frameId,
          kind: 'deploy',
          status: 'success',
          detail: [
            values.frame?.connected === false
              ? 'Deploy queued — the frame is offline right now and applies the scenes when it reconnects'
              : 'Deployed — the frame applies the scenes as soon as it syncs',
            // The scene graphs themselves live in the account's cloud scene
            // library (that IS the storage for cloud frames), mentioned so
            // the library entries this creates are not a mystery.
            'Also saved to your cloud scenes',
            ...outcome.notes,
          ].join('. '),
        })
      } catch (error) {
        // Persistence failed (rate limit, moderation, offline store…) — the
        // ad-hoc push still deploys the edited scenes to the device, it just
        // cannot save them; deployFrame reports its own outcome.
        const message = error instanceof Error ? error.message : String(error)
        longRunningTasksModel.actions.taskFailed({
          frameId: props.frameId,
          kind: 'deploy',
          detail: `Could not save the scenes to your cloud account (${message}) — pushing them straight to the frame instead`,
        })
        framesModel.actions.deployFrame(props.frameId, false)
      }
    }

    return {
      saveFrame: () => actions.submitFrameForm(),
      submitFrameFormSuccess: () => {
        framesModel.actions.loadFrame(props.frameId)
      },
      submitFrameFormFailure: ({ error }) => {
        // Nothing listened to this before, so a failed Save vanished without
        // a trace — most visibly on the cloud, where saving to a frame the
        // owner has not confirmed yet is refused with `frame_not_active`
        // (409) and the workspace just sat there still saying "unsaved".
        // Field-level validation renders inline; skip its sentinel error —
        // but the running task the submit handler started is still spinning,
        // so it has to be closed either way.
        if (error?.message === 'Validation Failed') {
          longRunningTasksModel.actions.taskFailed({
            frameId: props.frameId,
            kind: 'save',
            detail: 'Some fields need fixing before this can be saved',
          })
          return
        }
        const detail =
          error?.message?.includes('frame_not_active') && isCloudMode()
            ? 'This frame is still pending — confirm it on its dashboard before saving changes to it.'
            : error?.message || 'Failed to save the frame'
        // No startTask: the submit handler opened one, and this fails it.
        longRunningTasksModel.actions.taskFailed({ frameId: props.frameId, kind: 'save', detail })
      },
      saveAndDeployFrame: async () => {
        if (isCloudMode()) {
          await cloudSaveAndDeploy()
          return
        }
        // No transport rewriting here: the backend resolves "auto" against the
        // live connection and falls back to SSH by itself, so a disconnected
        // remote is not a reason to silently overwrite the user's saved
        // choice of how this frame is reached.
        await asyncActions.submitFrameForm()
        framesModel.actions.deployFrame(
          props.frameId,
          frameCanUseFastDeploy(values.frame, values.requiresRecompilation)
        )
      },
      saveAndFastDeployFrame: async () => {
        if (isCloudMode()) {
          await cloudSaveAndDeploy()
          return
        }
        // No transport rewriting here: the backend resolves "auto" against the
        // live connection and falls back to SSH by itself, so a disconnected
        // remote is not a reason to silently overwrite the user's saved
        // choice of how this frame is reached.
        await asyncActions.submitFrameForm()
        framesModel.actions.deployFrame(props.frameId, true)
      },
      saveAndFullDeployFrame: async () => {
        if (isCloudMode()) {
          await cloudSaveAndDeploy()
          return
        }
        // No transport rewriting here: the backend resolves "auto" against the
        // live connection and falls back to SSH by itself, so a disconnected
        // remote is not a reason to silently overwrite the user's saved
        // choice of how this frame is reached.
        await asyncActions.submitFrameForm()
        framesModel.actions.deployFrame(props.frameId, false)
      },
      renderFrame: () => framesModel.actions.renderFrame(props.frameId),
      restartFrame: () => framesModel.actions.restartFrame(props.frameId),
      rebootFrame: () => framesModel.actions.rebootFrame(props.frameId),
      stopFrame: () => framesModel.actions.stopFrame(props.frameId),
      deployFrame: () => {
        framesModel.actions.deployFrame(
          props.frameId,
          frameCanUseFastDeploy(values.frame, values.requiresRecompilation)
        )
      },
      fastDeployFrame: () => framesModel.actions.deployFrame(props.frameId, true),
      fullDeployFrame: () => framesModel.actions.deployFrame(props.frameId, false),
      deployRemote: ({ recompile, transport }) => framesModel.actions.deployRemote(props.frameId, recompile, transport),
      restartRemote: ({ transport }) => framesModel.actions.restartRemote(props.frameId, transport),
      setDeployWithAgent: ({ deployWithAgent }) => {
        framesModel.actions.setDeployWithAgent(props.frameId, deployWithAgent)
      },
      updateScene: ({ sceneId, scene }) => {
        const { frameForm } = values
        const hasScene = frameForm.scenes?.some(({ id }) => id === sceneId)
        const scenes = hasScene
          ? frameForm.scenes?.map((s) => (s.id === sceneId ? sanitizeScene({ ...s, ...scene }, frameForm) : s))
          : [...(frameForm.scenes ?? []), sanitizeScene({ ...scene, id: sceneId }, frameForm)]
        actions.setFrameFormValues({ scenes })
      },
      updateNodeData: ({ sceneId, nodeId, nodeData }) => {
        const { frame, frameForm } = values
        const scenes = frameForm.scenes ?? frame.scenes
        const scene = scenes?.find(({ id }) => id === sceneId)
        const currentNode = scene?.nodes?.find(({ id }) => id === nodeId)
        if (currentNode) {
          actions.setFrameFormValues({
            scenes: scenes?.map((s) =>
              s.id === sceneId
                ? {
                    ...s,
                    nodes: s.nodes?.map((n) =>
                      n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...nodeData } } : n
                    ),
                  }
                : s
            ),
          })
        } else {
          console.error(`Node ${nodeId} not found in scene ${sceneId}`)
        }
      },
      applyTemplate: async ({ template, openDrawer, preserveSceneIds }) => {
        await appendTemplates(templatesFromPayload(template), openDrawer, preserveSceneIds)
      },
      createBlankScene: async ({ name, openEditor, openDrawer }) => {
        const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
        const scene = buildBlankScene(frameForm, name)
        actions.setFrameFormValues({ scenes: [...(frameForm.scenes ?? []), scene] })
        if (openEditor) {
          router.actions.push(urls.scenes(props.frameId, scene.id))
        } else if (openDrawer) {
          openSceneControlDrawer(props.frameId, scene.id)
        }
      },
      deleteSceneAndSave: async ({ sceneId }) => {
        const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
        const scenes = frameForm.scenes ?? []
        if (!scenes.some((scene) => scene.id === sceneId)) {
          return
        }

        const nextScenes = scenes.filter((scene) => scene.id !== sceneId)
        const nextFrameForm = { ...frameForm, scenes: nextScenes }
        actions.setFrameFormValues({ scenes: nextScenes })
        await saveFrameForm(nextFrameForm, props.frameId, values.nextAction)
        framesModel.actions.loadFrame(props.frameId)
      },
      sendEvent: async ({ event, payload }) => {
        await apiFetch(`/api/frames/${props.frameId}/event/${event}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      },
    }
  }),
  afterMount(({ actions, values, cache, props }) => {
    const defaultScene = values.frame?.scenes?.find((scene) => scene.id === 'default' && !scene.default)
    if (defaultScene) {
      const { name, id, default: _def, ...rest } = defaultScene
      actions.updateScene('default', { name: 'Default Scene', id: uuidv4(), default: true, ...rest })
    }
    if (
      !values.frameSyncStatusLoading &&
      shouldLoadFrameSyncStatus(values.frame, values.frameSyncStatus, values.frameSyncIgnoredToken)
    ) {
      actions.loadFrameSyncStatus()
    }

    cache.keydownHandler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!(event.metaKey || event.ctrlKey) || key !== 's') {
        return
      }
      // frameLogic is mounted per frame card on the dashboard, so without this
      // guard Cmd+S would save EVERY frame at once. Only save when this frame's
      // editor (frames/scenes/apps view) is the one actually being viewed.
      const pathname = router.values.location.pathname
      const editorPaths = [urls.frame(props.frameId), urls.scenes(props.frameId), urls.apps(props.frameId)]
      const isThisFrameVisible = editorPaths.some((p) => pathname === p || pathname.startsWith(p + '/'))
      if (!isThisFrameVisible) {
        return
      }
      event.preventDefault()
      actions.saveFrame()
    }
    window.addEventListener('keydown', cache.keydownHandler)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.keydownHandler) {
      window.removeEventListener('keydown', cache.keydownHandler)
      cache.keydownHandler = null
    }
  }),
])
