import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { router } from 'kea-router'
import { framesModel, type AgentTaskTransport } from '../../models/framesModel'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import {
  AppNodeData,
  DiagramNode,
  FrameErrorBehavior,
  FrameScene,
  FrameType,
  SceneNodeData,
  TemplateType,
} from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'
import { v4 as uuidv4 } from 'uuid'
import { duplicateScenes } from '../../utils/duplicateScenes'
import { apiFetch } from '../../utils/apiFetch'
import { getBasePath } from '../../utils/getBasePath'
import { projectApiPath, projectApiPathFromCache } from '../../utils/projectApi'
import { entityImagesModel } from '../../models/entityImagesModel'
import { arrangeSceneGraph } from '../../utils/arrangeNodes'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { secureToken } from '../../utils/secureToken'
import { normalizeSceneApps } from '../../utils/sceneApps'
import {
  type ChangeDetail,
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
import { frameRunsScenesInterpreted, sceneExecutionForFrame } from '../../utils/sceneExecution'

export type { ChangeDetail, DeployPlanResponse, DeployRecommendation, SummaryItem } from './frameDeployUtils'

export const DEFAULT_TIMEZONE_UPDATE_URL = 'https://tz.frameos.net/tzdata.json.gz'
export const DEFAULT_TIMEZONE_UPDATE_HOUR = 3

interface DeployPlanApiResponse {
  plan: DeployPlanResponse
}

export type DeployDrawerView = 'main' | 'sdCard' | 'script' | 'embedded'

export interface FrameLogicProps {
  frameId: number
}

export type FrameNextAction = 'render' | 'restart' | 'reboot' | 'stop' | 'deploy' | null

function isAgentDeployConfigured(agent?: FrameType['agent']): boolean {
  return Boolean(agent?.agentEnabled && agent?.agentRunCommands && agent?.agentSharedSecret)
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
  'image_engine',
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
  'rpios',
]

// When adding a runtime-consumed field to FRAME_KEYS, add its introduced version here.
// During active development, use the next patch after versions.json's frameos base version
// (for example, 2026.6.9 while versions.json says 2026.6.8).
const FRAME_KEY_INTRODUCED_FRAMEOS_VERSION: Partial<Record<keyof FrameType, string>> = {
  mountpoints: '2026.6.0',
  error_behavior: '2026.6.1',
  buildroot: '2026.6.2',
  image_engine: '2026.6.3',
  max_http_response_bytes: '2026.6.4',
  rpios: '2026.6.7',
  timezone_updater: '2026.6.7',
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
  image_engine: 'Image engine',
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
  'image_engine',
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

function frameSubmitKeys(frame: Partial<FrameType>): (keyof FrameType)[] {
  return FRAME_KEYS
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

function computeChangeDetails(
  previous: Partial<FrameType> | null | undefined,
  next: Partial<FrameType> | null | undefined,
  mode: FrameType['mode'],
  includeFrameosVersion = true
): ChangeDetail[] {
  const recompileFields = new Set(getRecompileFields(mode).filter((key) => key !== 'scenes'))
  const details: ChangeDetail[] = []
  const previousFrameosVersion = includeFrameosVersion ? deployedFrameosVersion(previous) : null

  for (const key of FRAME_KEYS.filter((k) => k !== 'scenes')) {
    if (!frameKeyEqual(key, previous?.[key], next?.[key])) {
      details.push({
        label: keyLabel(key),
        requiresFullDeploy:
          recompileFields.has(key) ||
          (includeFrameosVersion && frameKeyRequiresVersionUpgrade(key, previousFrameosVersion)),
      })
    }
  }

  const sceneDetails = sceneChangeDetails(next?.scenes ?? [], previous?.scenes ?? [], mode)

  if (includeFrameosVersion && (!previousFrameosVersion || previousFrameosVersion !== CURRENT_FRAMEOS_VERSION)) {
    details.push({
      label: `FrameOS upgrade ${previousFrameosVersion ?? ''} -> ${CURRENT_FRAMEOS_VERSION}`,
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

  return details
}

function sortDeployChangeDetails(changes: ChangeDetail[]): ChangeDetail[] {
  return changes
    .map((change, index) => ({ change, index }))
    .sort((first, second) => {
      const firstPriority = first.change.label.startsWith('FrameOS upgrade')
        ? 0
        : first.change.requiresFullDeploy
        ? 1
        : 2
      const secondPriority = second.change.label.startsWith('FrameOS upgrade')
        ? 0
        : second.change.requiresFullDeploy
        ? 1
        : 2

      return firstPriority - secondPriority || first.index - second.index
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

function normalizeAgentForComparison(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    agentEnabled: Boolean(source.agentEnabled),
    agentRunCommands: Boolean(source.agentRunCommands),
    agentSharedSecret: source.agentSharedSecret ?? '',
  }
}

function normalizeFrameKeyValueForComparison(key: keyof FrameType, value: unknown): unknown {
  if (key === 'image_engine') {
    return value ?? ''
  }

  if (key === 'agent') {
    return normalizeAgentForComparison(value)
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
  if (key === 'image_engine') {
    if (value === 'imagemagick') {
      return 'ImageMagick'
    }
    if (value === 'pixie') {
      return 'Pixie'
    }
    return 'Default (Pixie)'
  }

  if (value === null || value === undefined || value === '') {
    return 'Not set'
  }

  switch (key) {
    case 'frame_access_key':
    case 'server_api_key':
    case 'ssh_pass':
      return summarizeSecret(value)
    case 'mode':
      return value === 'buildroot' ? 'Buildroot' : 'Raspberry Pi OS'
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

async function resolveTemplateImageUrl(template: Partial<TemplateType>): Promise<string | null> {
  if (template.id) {
    return await projectApiPath(`/api/templates/${template.id}/image`)
  }

  if (typeof template.image === 'string') {
    const match = template.image.match(/^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/)
    if (match) {
      return `/api/${match[1]}/image`
    }
    return projectApiPathFromCache(template.image)
  }

  return null
}

async function fetchTemplateImageBlob(template: Partial<TemplateType>): Promise<Blob | null> {
  if (template.image instanceof Blob) {
    return template.image
  }

  const imageUrl = await resolveTemplateImageUrl(template)
  if (!imageUrl) {
    return null
  }

  const basePath = getBasePath()
  const scopedImageUrl = imageUrl.startsWith('/api/') ? await projectApiPath(imageUrl) : imageUrl
  const resolvedUrl = scopedImageUrl.startsWith('/api/') && basePath ? `${basePath}${scopedImageUrl}` : scopedImageUrl
  const response = await fetch(resolvedUrl)
  if (!response.ok) {
    return null
  }
  return await response.blob()
}

function buildScenesFromTemplate(template: Partial<TemplateType>, frame: Partial<FrameType>): FrameScene[] {
  if (!('scenes' in template)) {
    return []
  }

  const newScenes = duplicateScenes((template.scenes ?? []).map((scene) => sanitizeScene(scene, frame)))
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

async function saveTemplateSceneImages(
  frameId: number,
  template: Partial<TemplateType>,
  newScenes: FrameScene[]
): Promise<void> {
  if (!newScenes.length) {
    return
  }

  try {
    const imageBlob = await fetchTemplateImageBlob(template)
    if (!imageBlob) {
      return
    }

    const targetScenes = getScenesWithoutParents(newScenes)
    if (!targetScenes.length) {
      return
    }

    await Promise.all(
      targetScenes.map((scene) =>
        apiFetch(`/api/frames/${frameId}/scene_images/${scene.id}`, {
          method: 'POST',
          body: imageBlob,
        })
      )
    )
    targetScenes.forEach((scene) =>
      entityImagesModel.actions.updateEntityImage(`frames/${frameId}`, `scene_images/${scene.id}`)
    )
  } catch (error) {
    console.error('Failed to save template image for scenes', error)
  }
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

const legacyAppMapping: Record<string, string> = {
  // image data apps. todo: make migration to get rid of them
  downloadImage: 'legacy/downloadImage',
  unsplash: 'legacy/unsplash',
  frameOSGallery: 'legacy/frameOSGallery',
  openai: 'legacy/openai',
  resize: 'legacy/resize',
  rotate: 'legacy/rotate',
  localImage: 'legacy/localImage',
  qr: 'legacy/qr',
  haSensor: 'legacy/haSensor',
  openaiText: 'legacy/openaiText',
  clock: 'legacy/clock',

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
    image_engine: frame.image_engine ?? '',
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
  }
  return normalizedFrame.mode === 'buildroot' ? { ...normalizedFrame, assets_path: '/srv/assets' } : normalizedFrame
}

function preferSshTransportWhenAgentUnavailable(
  frame: Partial<FrameType>,
  agentConnected: boolean
): Partial<FrameType> {
  const agent = frame.agent
  if (!agentConnected && isAgentDeployConfigured(agent) && agent?.deployWithAgent !== false) {
    return { ...frame, agent: { ...agent, deployWithAgent: false } }
  }
  return frame
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

async function saveFrameForm(frame: Partial<FrameType>, frameId: number, nextAction: FrameNextAction): Promise<void> {
  const normalizedFrame = normalizeFrameForSubmit(frame)
  const json = buildDeployPlanRequestBody(normalizedFrame, frameSubmitKeys(normalizedFrame))
  if (nextAction) {
    json['next_action'] = nextAction
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

function openSceneControlDrawer(frameId: number, sceneId: string): void {
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
  const edges = (scene.edges ?? []).map((edge) => normalizeEdge(edge))
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
    settings: {
      ...settings,
      ...(frameRunsInterpreted ? { execution: 'interpreted' as const } : {}),
      refreshInterval: settings.refreshInterval || frame.interval || 300,
      backgroundColor: cleanBackgroundColor(settings.backgroundColor || '#000000'),
    },
  } satisfies FrameScene
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.frameId),
  connect(() => ({ values: [framesModel, ['frames']] })),
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
    deployRemote: (recompile?: boolean, transport: AgentTaskTransport = 'auto') => ({
      recompile: recompile || false,
      transport,
    }),
    restartRemote: (transport: AgentTaskTransport = 'auto') => ({ transport }),
    updateDeployedSshKeys: true,
    clearNextAction: true,
    resetUnsavedChanges: true,
    resetUndeployedChanges: true,
    applyTemplate: (template: Partial<TemplateType>) => ({
      template,
    }),
    applyTemplateAndSave: (template: Partial<TemplateType>, openDrawer?: boolean) => ({
      openDrawer: openDrawer ?? false,
      template,
    }),
    createBlankSceneAndSave: (name?: string, openEditor?: boolean, openDrawer?: boolean) => ({
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
        scenes: (state.scenes ?? []).map((scene: Record<string, any>) => ({
          fields: (scene.fields ?? []).map((field: Record<string, any>) => ({
            name: String(field.name ?? '').trim() ? '' : 'Codename is required',
            type: field.type ? '' : 'Type is required',
          })),
        })),
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
        await saveFrameForm(frame, values.frameId, values.nextAction)
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
      const response = await apiFetch(`/api/frames/${values.frameId}/tls/generate`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error('Failed to generate TLS certificates')
      }
      const data = await response.json()
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
      const deployPlanMode = (currentFrameForm.mode ?? 'rpios') === 'embedded' ? 'fast' : 'combined'
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
    showDeployPlanModal: () => {
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
    frame: [(s) => [s.frames, s.frameId], (frames, frameId) => frames[frameId] || null],
    mode: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm?.mode || frame?.mode || 'rpios'],
    isFrameAdminMode: [() => [], () => isInFrameAdminMode()],
    scenes: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): FrameScene[] => frameForm?.scenes ?? frame?.scenes ?? [],
    ],
    sortedScenes: [
      (s) => [s.scenes],
      (scenes): FrameScene[] => scenes.toSorted((a, b) => a.name.localeCompare(b.name)),
    ],
    unsavedChanges: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm) => {
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
      (frame, frameForm): Set<string> => {
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
    lastDeploy: [(s) => [s.frame], (frame) => deployedFrameBaseline(frame)],
    undeployedChanges: [
      (s) => [s.frame, s.lastDeploy, s.mode, s.isFrameAdminMode],
      (frame: FrameType, lastDeploy: Partial<FrameType> | null, mode: FrameType['mode'], isFrameAdminMode: boolean) =>
        !isFrameAdminMode && !frame?.archived && computeChangeDetails(lastDeploy, frame, mode).length > 0,
    ],
    unsavedChangeDetails: [
      (s) => [s.frame, s.frameForm, s.mode],
      (frame, frameForm, mode): ChangeDetail[] => computeChangeDetails(frame, frameForm, mode, false),
    ],
    undeployedChangeDetails: [
      (s) => [s.lastDeploy, s.frame, s.mode, s.isFrameAdminMode],
      (lastDeploy, frame, mode, isFrameAdminMode): ChangeDetail[] =>
        isFrameAdminMode || frame?.archived ? [] : computeChangeDetails(lastDeploy, frame, mode),
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
        if (isFrameAdminMode || frame?.archived) {
          return false
        }
        const pendingFrame = Object.keys(frameForm ?? {}).length > 0 ? frameForm : frame
        return computeChangeDetails(lastDeploy, pendingFrame, mode).some((change) => change.requiresFullDeploy)
      },
    ],
    deployChangeDetails: [
      (s) => [s.lastDeploy, s.frameForm, s.mode, s.isFrameAdminMode],
      (lastDeploy, frameForm, mode, isFrameAdminMode): ChangeDetail[] =>
        isFrameAdminMode
          ? []
          : lastDeploy
          ? sortDeployChangeDetails(computeChangeDetails(lastDeploy, frameForm, mode))
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
    deployPlan: [(s) => [s.deployPlans], (deployPlans) => deployPlans],
    fastDeployPlan: [(s) => [s.deployPlan], (deployPlan) => deployPlan],
    fullDeployPlan: [(s) => [s.deployPlan], (deployPlan) => deployPlan],
    fastDeployPlanSummary: [
      (s) => [s.fastDeployPlan],
      (fastDeployPlan): SummaryItem[] => buildFastDeployPlanSummary(fastDeployPlan),
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
      (deployPlan, lastDeploy, deployChangeDetails, frameForm): DeployRecommendation | null =>
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
      (frame, frameForm) => {
        const allScenes = frameForm?.scenes ?? frame?.scenes ?? []
        return (allScenes.find((scene) => scene.id === 'default' || scene.default) || allScenes[0])?.id ?? null
      },
    ],
    width: [
      (s) => [s.frameForm],
      (frameForm) => (frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.height : frameForm.width),
    ],
    height: [
      (s) => [s.frameForm],
      (frameForm) => (frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.width : frameForm.height),
    ],
    defaultInterval: [(s) => [s.frameForm], (frameForm) => frameForm.interval ?? 300],
    deployWithAgent: [
      (s) => [s.frameForm, s.frame],
      (frameForm, frame) => {
        const agent = frameForm?.agent ?? frame?.agent
        if (!isAgentDeployConfigured(agent)) {
          return false
        }
        if ((frame?.active_connections ?? 0) <= 0) {
          return false
        }
        return agent?.deployWithAgent ?? true
      },
    ],
    deployTransportToggleVisible: [
      (s) => [s.frameForm, s.frame],
      (frameForm, frame): boolean => {
        const agent = frameForm?.agent ?? frame?.agent
        return isAgentDeployConfigured(agent)
      },
    ],
    remoteDeployConnected: [(s) => [s.frame], (frame): boolean => (frame?.active_connections ?? 0) > 0],
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
    },
  })),
  listeners(({ asyncActions, actions, values, props }) => ({
    saveFrame: () => actions.submitFrameForm(),
    submitFrameFormSuccess: () => {
      framesModel.actions.loadFrame(props.frameId)
    },
    saveAndDeployFrame: async () => {
      const frameForm = preferSshTransportWhenAgentUnavailable(values.frameForm, values.remoteDeployConnected)
      if (frameForm !== values.frameForm) {
        actions.setFrameFormValues({ agent: frameForm.agent })
        await saveFrameForm(frameForm, props.frameId, values.nextAction)
        framesModel.actions.loadFrame(props.frameId)
      } else {
        await asyncActions.submitFrameForm()
      }
      framesModel.actions.deployFrame(
        props.frameId,
        frameCanUseFastDeploy(values.frame, values.requiresRecompilation)
      )
    },
    saveAndFastDeployFrame: async () => {
      const frameForm = preferSshTransportWhenAgentUnavailable(values.frameForm, values.remoteDeployConnected)
      if (frameForm !== values.frameForm) {
        actions.setFrameFormValues({ agent: frameForm.agent })
        await saveFrameForm(frameForm, props.frameId, values.nextAction)
        framesModel.actions.loadFrame(props.frameId)
      } else {
        await asyncActions.submitFrameForm()
      }
      framesModel.actions.deployFrame(props.frameId, true)
    },
    saveAndFullDeployFrame: async () => {
      const frameForm = preferSshTransportWhenAgentUnavailable(values.frameForm, values.remoteDeployConnected)
      if (frameForm !== values.frameForm) {
        actions.setFrameFormValues({ agent: frameForm.agent })
        await saveFrameForm(frameForm, props.frameId, values.nextAction)
        framesModel.actions.loadFrame(props.frameId)
      } else {
        await asyncActions.submitFrameForm()
      }
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
    applyTemplate: async ({ template }) => {
      if ('scenes' in template) {
        const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
        const oldScenes = frameForm.scenes || []
        const newScenes = buildScenesFromTemplate(template, frameForm)
        actions.setFrameFormValues({
          scenes: [...oldScenes, ...newScenes],
        })

        await saveTemplateSceneImages(props.frameId, template, newScenes)
      }
    },
    applyTemplateAndSave: async ({ template, openDrawer }) => {
      const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
      const oldScenes = frameForm.scenes || []
      const newScenes = buildScenesFromTemplate(template, frameForm)
      if (!newScenes.length) {
        return
      }

      const scenes = [...oldScenes, ...newScenes]
      const nextFrameForm = { ...frameForm, scenes }
      actions.setFrameFormValues({ scenes })
      await saveFrameForm(nextFrameForm, props.frameId, values.nextAction)
      framesModel.actions.loadFrame(props.frameId)
      if (openDrawer) {
        openSceneControlDrawer(props.frameId, newScenes[0].id)
      }
      await saveTemplateSceneImages(props.frameId, template, newScenes)
    },
    createBlankSceneAndSave: async ({ name, openEditor, openDrawer }) => {
      const frameForm = getCurrentFrameForm(values.frame, values.frameForm)
      const scene = buildBlankScene(frameForm, name)
      const scenes = [...(frameForm.scenes ?? []), scene]
      const nextFrameForm = { ...frameForm, scenes }
      actions.setFrameFormValues({ scenes })
      await saveFrameForm(nextFrameForm, props.frameId, values.nextAction)
      framesModel.actions.loadFrame(props.frameId)
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
  })),
  afterMount(({ actions, values, cache, props }) => {
    const defaultScene = values.frame?.scenes?.find((scene) => scene.id === 'default' && !scene.default)
    if (defaultScene) {
      const { name, id, default: _def, ...rest } = defaultScene
      actions.updateScene('default', { name: 'Default Scene', id: uuidv4(), default: true, ...rest })
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
