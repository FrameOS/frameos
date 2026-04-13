import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { AppNodeData, DiagramNode, FrameScene, FrameType, SceneNodeData, TemplateType } from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'
import { v4 as uuidv4 } from 'uuid'
import { duplicateScenes } from '../../utils/duplicateScenes'
import { apiFetch } from '../../utils/apiFetch'
import { getBasePath } from '../../utils/getBasePath'
import { entityImagesModel } from '../../models/entityImagesModel'
import { arrangeNodes } from '../../utils/arrangeNodes'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { secureToken } from '../../utils/secureToken'
import versions from '../../../../versions.json'

export interface FrameLogicProps {
  frameId: number
}

export interface ChangeDetail {
  label: string
  requiresFullDeploy: boolean
}

export interface SummaryItem {
  label: string
  value: string
}

export interface FastDeployPlanResponse {
  reload_supported: boolean
  tls_settings_changed: boolean
  action: string
}

export interface FullDeployPlanResponse {
  target: {
    arch: string
    distro: string
    version: string
    total_memory_mb: number
  }
  low_memory: boolean
  drivers: string[]
  binary: {
    will_attempt_cross_compile?: boolean
    cross_compile_supported?: boolean
    build_host_configured?: boolean
    prebuilt_target?: string | null
    has_prebuilt_entry?: boolean
  }
  packages: {
    name: string
    reason: string
    installed: boolean
    needs_install: boolean
  }[]
  package_alternatives: {
    names: string[]
    reason: string
    installed_package?: string | null
    satisfied: boolean
  }[]
  lgpio: {
    required: boolean
    installed: boolean
  }
  quickjs: {
    required_if_remote_build: boolean
    dirname?: string | null
    installed: boolean
  }
  ssh_keys_need_install: boolean
  post_deploy?: {
    i2c?: {
      needs_boot_config_line?: boolean
      needs_runtime_enable?: boolean
    }
    spi_action?: 'enable' | 'disable' | 'unchanged'
    reboot_schedule?: {
      needs_update?: boolean
      needs_remove?: boolean
    }
    bootconfig_changes?: { action: 'add' | 'remove'; line: string }[]
    disable_userconfig?: boolean
    final_action?: 'reboot' | 'restart_frameos'
  }
}

export interface DeployPlanResponse {
  mode: 'fast' | 'full' | 'combined'
  frame_id: number
  frame_name: string
  build_id: string
  previous_frameos_version?: string | null
  notes: string[]
  fast_deploy?: FastDeployPlanResponse | null
  full_deploy?: FullDeployPlanResponse | null
}

interface DeployPlanApiResponse {
  plan: DeployPlanResponse
}

export interface DeployRecommendation {
  mode: 'fast' | 'full'
  title: string
  description: string
}

const DEFAULT_BROWSER_TITLE = 'FrameOS Backend'
const CURRENT_FRAMEOS_VERSION = (versions.frameos || 'dev').split('+')[0]

function setBrowserTitle(frame?: FrameType | null): void {
  if (typeof document === 'undefined') {
    return
  }

  if (!frame) {
    document.title = DEFAULT_BROWSER_TITLE
    return
  }

  const frameTitle = frame.name || frame.frame_host || `Frame ${frame.id}`
  document.title = `${frameTitle} · ${DEFAULT_BROWSER_TITLE}`
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
  'interval',
  'metrics_interval',
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
  'palette',
  'buildroot',
  'rpios',
]

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
  interval: 'Refresh interval',
  metrics_interval: 'Metrics interval',
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
  agent: 'Agent settings',
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
  'interval',
  'metrics_interval',
  'scaling_mode',
  'rotate',
  'flip',
  'background_color',
  'debug',
  'log_to_file',
  'assets_path',
  'save_assets',
]

function keyLabel(key: keyof FrameType): string {
  return FRAME_KEY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function getRecompileFields(mode: FrameType['mode']): (keyof FrameType)[] {
  return mode === 'buildroot' ? FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT : FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS
}

function sceneChangeDetails(currentScenes: FrameScene[], deployedScenes: FrameScene[]): ChangeDetail[] {
  const details: ChangeDetail[] = []

  for (const scene of currentScenes) {
    const deployed = deployedScenes.find((s) => s.id === scene.id)
    const mode = scene.settings?.execution ?? 'compiled'
    const deployedMode = deployed?.settings?.execution ?? 'compiled'

    if (!deployed) {
      details.push({
        label: `Scene added: ${scene.name || scene.id}`,
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

    if (!equal(scene, deployed)) {
      details.push({
        label: `Scene updated: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
    }
  }

  for (const scene of deployedScenes) {
    if (!currentScenes.find((s) => s.id === scene.id)) {
      const mode = scene.settings?.execution ?? 'compiled'
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
  mode: FrameType['mode']
): ChangeDetail[] {
  const recompileFields = new Set(getRecompileFields(mode).filter((key) => key !== 'scenes'))
  const details: ChangeDetail[] = []

  for (const key of FRAME_KEYS.filter((k) => k !== 'scenes')) {
    if (!frameKeyEqual(key, previous?.[key], next?.[key])) {
      details.push({
        label: keyLabel(key),
        requiresFullDeploy: recompileFields.has(key),
      })
    }
  }

  const sceneDetails = sceneChangeDetails(next?.scenes ?? [], previous?.scenes ?? [])

  const previousFrameosVersion =
    typeof (previous as Record<string, unknown> | null | undefined)?.frameos_version === 'string'
      ? String((previous as Record<string, unknown>).frameos_version).split('+')[0]
      : null

  if (!previousFrameosVersion || previousFrameosVersion !== CURRENT_FRAMEOS_VERSION) {
    details.push({
      label: `FrameOS upgrade ${previousFrameosVersion ?? ''} -> ${CURRENT_FRAMEOS_VERSION}`,
      requiresFullDeploy: true,
    })
  }

  return [...details, ...sceneDetails]
}

function normalizeFrameKeyValueForComparison(key: keyof FrameType, value: unknown): unknown {
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

function buildDeployPlanRequestBody(frame: Partial<FrameType>): Record<string, any> {
  const json: Record<string, any> = {}
  for (const key of FRAME_KEYS) {
    json[key] = frame[key]
  }
  return json
}

function buildFrameosVersionSummary(plan?: DeployPlanResponse | null): SummaryItem[] {
  if (!plan) {
    return []
  }

  const previousVersion = plan.previous_frameos_version ? String(plan.previous_frameos_version).split('+')[0] : 'Not deployed'
  return [
    {
      label: 'FrameOS version',
      value: previousVersion === CURRENT_FRAMEOS_VERSION ? CURRENT_FRAMEOS_VERSION : `${previousVersion} -> ${CURRENT_FRAMEOS_VERSION}`,
    },
  ]
}

function buildFastDeployPlanSummary(plan?: DeployPlanResponse | null): SummaryItem[] {
  const fastPlan = plan?.fast_deploy
  if (!fastPlan) {
    return []
  }

  if (!fastPlan.tls_settings_changed) {
    return []
  }

  return [{ label: 'Fast deploy behavior', value: 'Restart FrameOS because TLS settings changed' }]
}

function buildFullDeployPlanSummary(plan?: DeployPlanResponse | null, frame?: Partial<FrameType> | null): SummaryItem[] {
  const fullPlan = plan?.full_deploy
  if (!fullPlan) {
    return []
  }

  const packagesToInstall = fullPlan.packages.filter((pkg) => pkg.needs_install).map((pkg) => pkg.name)
  const items: SummaryItem[] = [
    ...(frame?.device ? [{ label: 'Device', value: String(frame.device) }] : []),
    {
      label: 'Target',
      value: `${fullPlan.target.distro} ${fullPlan.target.version} · ${fullPlan.target.arch} · ${fullPlan.target.total_memory_mb} MiB`,
    },
    {
      label: 'Build strategy',
      value: fullPlan.binary.will_attempt_cross_compile
        ? fullPlan.binary.build_host_configured
          ? 'Cross-compile on the configured build host'
          : 'Cross-compile locally on this server'
        : fullPlan.binary.cross_compile_supported
        ? 'Build on device because cross-compilation is disabled'
        : 'Build on device because cross-compilation is unavailable for this target',
    },
  ]

  if (fullPlan.drivers.length > 0) {
    items.push({ label: 'Drivers', value: stringifyList(fullPlan.drivers) })
  }
  if (packagesToInstall.length > 0) {
    items.push({ label: 'Packages to install', value: stringifyList(packagesToInstall) })
  }
  if (!fullPlan.binary.will_attempt_cross_compile && fullPlan.quickjs.required_if_remote_build && !fullPlan.quickjs.installed) {
    items.push({
      label: 'QuickJS',
      value: `${fullPlan.quickjs.dirname || 'Required'} will be prepared for the on-device build`,
    })
  }
  if (fullPlan.lgpio.required && !fullPlan.lgpio.installed) {
    items.push({ label: 'lgpio', value: 'Will be installed for the selected drivers' })
  }
  if (fullPlan.ssh_keys_need_install) {
    items.push({ label: 'SSH keys', value: 'Selected deploy keys will be installed on the frame' })
  }
  if (fullPlan.post_deploy?.bootconfig_changes?.length) {
    items.push({
      label: 'Boot config',
      value: fullPlan.post_deploy.bootconfig_changes
        .map((change) => `${change.action === 'add' ? 'Add' : 'Remove'} ${change.line}`)
        .join(', '),
    })
  }
  if (fullPlan.post_deploy?.i2c?.needs_boot_config_line || fullPlan.post_deploy?.i2c?.needs_runtime_enable) {
    items.push({ label: 'I2C', value: 'Will be enabled for the selected drivers' })
  }
  if (fullPlan.post_deploy?.spi_action === 'enable') {
    items.push({ label: 'SPI', value: 'Will be enabled for the selected drivers' })
  }
  if (fullPlan.post_deploy?.spi_action === 'disable') {
    items.push({ label: 'SPI', value: 'Will be disabled for the selected drivers' })
  }
  if (fullPlan.post_deploy?.disable_userconfig) {
    items.push({ label: 'User config', value: 'First-deploy setup will disable the system userconfig service' })
  }
  if (fullPlan.post_deploy?.reboot_schedule?.needs_update) {
    items.push({ label: 'Reboot schedule', value: 'Scheduled reboot config will be installed or updated' })
  }
  if (fullPlan.post_deploy?.reboot_schedule?.needs_remove) {
    items.push({ label: 'Reboot schedule', value: 'Old scheduled reboot config will be removed' })
  }
  if (fullPlan.low_memory && !fullPlan.binary.will_attempt_cross_compile) {
    items.push({ label: 'Low memory', value: 'FrameOS will be stopped before the on-device build' })
  }
  if (fullPlan.post_deploy?.final_action === 'reboot') {
    items.push({ label: 'After deploy', value: 'Device reboot required' })
  }

  return items
}

function buildDeployRecommendation(
  plan: DeployPlanResponse | null,
  hasPreviousDeploy: boolean,
  deployChangeDetails: ChangeDetail[]
): DeployRecommendation | null {
  if (!plan) {
    return null
  }

  const previousVersion = plan.previous_frameos_version ? String(plan.previous_frameos_version).split('+')[0] : null
  const versionChanged = previousVersion !== CURRENT_FRAMEOS_VERSION
  const fullDeployChanges = deployChangeDetails
    .filter((change) => change.requiresFullDeploy && !change.label.startsWith('FrameOS upgrade'))
    .map((change) => change.label)

  if (!hasPreviousDeploy) {
    return {
      mode: 'full',
      title: 'Suggested: full deploy',
      description: 'This frame has not been deployed yet, so FrameOS, dependencies, and system changes need a full deploy.',
    }
  }

  if (fullDeployChanges.length > 0) {
    return {
      mode: 'full',
      title: 'Suggested: full deploy',
      description: `These changes require rebuilding or reinstalling FrameOS: ${fullDeployChanges.join(', ')}.`,
    }
  }

  if (versionChanged) {
    return {
      mode: 'fast',
      title: 'Suggested: fast deploy',
      description: `Fast deploy is enough to push the latest frame config and interpreted scenes. Use full deploy only if you also want to update the FrameOS runtime from ${previousVersion ?? 'unknown'} to ${CURRENT_FRAMEOS_VERSION}.`,
    }
  }

  return {
    mode: 'fast',
    title: 'Suggested: fast deploy',
    description: 'No pending changes require rebuilding FrameOS, so a fast deploy will bring the frame up to date with less work on the device.',
  }
}

async function resolveTemplateImageUrl(template: Partial<TemplateType>): Promise<string | null> {
  if (template.id) {
    return `/api/templates/${template.id}/image`
  }

  if (typeof template.image === 'string') {
    const match = template.image.match(/^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/)
    if (match) {
      return `/api/${match[1]}/image`
    }
    return template.image
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
  const resolvedUrl = imageUrl.startsWith('/api/') && basePath ? `${basePath}${imageUrl}` : imageUrl
  const response = await fetch(resolvedUrl)
  if (!response.ok) {
    return null
  }
  return await response.blob()
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

  return {
    ...frame,
    frame_admin_auth: {
      enabled: frame.frame_admin_auth?.enabled ?? false,
      user: frameAdminAuthUser,
      pass: frameAdminAuthPass,
    },
    scenes: frame.scenes?.map((scene) => sanitizeScene(scene, frame)) ?? [],
  }
}

export function sanitizeScene(scene: Partial<FrameScene>, frame: Partial<FrameType>): FrameScene {
  const settings = scene.settings ?? {}
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
  return {
    ...scene,
    id: scene.id ?? uuidv4(),
    name: scene.name || 'Untitled scene',
    nodes: shouldArrange ? arrangeNodes(normalizedNodes, edges) : normalizedNodes,
    edges,
    fields: scene.fields ?? [],
    settings: {
      ...settings,
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
    renderFrame: true,
    rebootFrame: true,
    restartFrame: true,
    stopFrame: true,
    deployFrame: true,
    fastDeployFrame: true,
    fullDeployFrame: true,
    deployAgent: true,
    restartAgent: true,
    updateDeployedSshKeys: true,
    clearNextAction: true,
    resetUnsavedChanges: true,
    resetUndeployedChanges: true,
    applyTemplate: (template: Partial<TemplateType>) => ({
      template,
    }),
    closeScenePanels: (sceneIds: string[]) => ({ sceneIds }),
    sendEvent: (event: string, payload: Record<string, any>) => ({ event, payload }),
    setDeployWithAgent: (deployWithAgent: boolean) => ({ deployWithAgent }),
    generateFrameAdminCredentials: true,
    generateTlsCertificates: true,
    verifyTlsCertificates: true,
    showDeployPlanModal: true,
    hideDeployPlanModal: true,
    loadDeployPlans: true,
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
        frame_admin_auth: state.frame_admin_auth?.enabled
          ? {
              user: state.frame_admin_auth?.user ? undefined : 'Username is required',
              pass: state.frame_admin_auth?.pass ? undefined : 'Password is required',
            }
          : undefined,
        scenes: (state.scenes ?? []).map((scene: Record<string, any>) => ({
          fields: (scene.fields ?? []).map((field: Record<string, any>) => ({
            name: field.name ? '' : 'Name is required',
            label: field.label ? '' : 'Label is required',
            type: field.type ? '' : 'Type is required',
          })),
        })),
      }),
      submit: async (frame) => {
        const json = buildDeployPlanRequestBody(frame)
        if (values.nextAction) {
          json['next_action'] = values.nextAction
        }
        const response = await apiFetch(`/api/frames/${values.frameId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json),
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
      },
    },
  })),
  reducers({
    nextAction: [
      null as 'render' | 'restart' | 'reboot' | 'stop' | 'deploy' | null,
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
    deployPlansError: [
      null as string | null,
      {
        loadDeployPlans: () => null,
        loadDeployPlansSuccess: () => null,
        loadDeployPlansFailure: (_, { error }) => error,
      },
    ],
    deployPlanModalOpen: [
      false,
      {
        showDeployPlanModal: () => true,
        hideDeployPlanModal: () => false,
      },
    ],
  }),
  listeners(({ actions, values }) => ({
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
      await actions.submitFrameForm()
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
      const response = await apiFetch(`/api/frames/${values.frameId}/deploy_plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildDeployPlanRequestBody(values.frameForm)),
      })
      if (!response.ok) {
        actions.loadDeployPlansFailure('Failed to load deploy plans')
        return
      }

      const payload = (await response.json()) as DeployPlanApiResponse
      actions.loadDeployPlansSuccess(payload.plan)
    },
    showDeployPlanModal: async () => {
      if (!values.deployPlans) {
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
      (frame, frameForm): FrameScene[] => frameForm?.scenes ?? frame.scenes ?? [],
    ],
    sortedScenes: [
      (s) => [s.scenes],
      (scenes): FrameScene[] => scenes.toSorted((a, b) => a.name.localeCompare(b.name)),
    ],
    unsavedChanges: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm) =>
        FRAME_KEYS.some(
          (key) => !frameKeyEqual(key, frame?.[key as keyof FrameType], frameForm?.[key as keyof FrameType])
        ),
    ],
    changedScenes: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): Set<string> => {
        const frameScenes = frame?.scenes ?? []
        const unsavedScenes = frameForm?.scenes ?? frameScenes
        const changed = new Set<string>()

        unsavedScenes.forEach((scene) => {
          const original = frameScenes.find((candidate) => candidate.id === scene.id)
          if (!original || !equal(original, scene)) {
            changed.add(scene.id)
          }
        })

        return changed
      },
    ],
    lastDeploy: [(s) => [s.frame], (frame) => frame?.last_successful_deploy ?? null],
    undeployedChanges: [
      (s) => [s.frame, s.lastDeploy, s.mode, s.isFrameAdminMode],
      (frame: FrameType, lastDeploy: Partial<FrameType> | null, mode: FrameType['mode'], isFrameAdminMode: boolean) =>
        !isFrameAdminMode && computeChangeDetails(lastDeploy, frame, mode).length > 0,
    ],
    unsavedChangeDetails: [
      (s) => [s.frame, s.frameForm, s.mode],
      (frame, frameForm, mode): ChangeDetail[] => computeChangeDetails(frame, frameForm, mode),
    ],
    undeployedChangeDetails: [
      (s) => [s.lastDeploy, s.frame, s.mode, s.isFrameAdminMode],
      (lastDeploy, frame, mode, isFrameAdminMode): ChangeDetail[] =>
        isFrameAdminMode ? [] : computeChangeDetails(lastDeploy, frame, mode),
    ],
    requiresRecompilation: [
      (s) => [s.undeployedChangeDetails],
      (undeployedChangeDetails) => undeployedChangeDetails.some((change) => change.requiresFullDeploy),
    ],
    deployChangeDetails: [
      (s) => [s.lastDeploy, s.frameForm, s.mode, s.isFrameAdminMode],
      (lastDeploy, frameForm, mode, isFrameAdminMode): ChangeDetail[] =>
        isFrameAdminMode ? [] : computeChangeDetails(lastDeploy, frameForm, mode),
    ],
    undeployedSummaryItems: [
      (s) => [s.lastDeploy, s.frame, s.requiresRecompilation, s.isFrameAdminMode],
      (lastDeploy, frame, requiresRecompilation, isFrameAdminMode): SummaryItem[] =>
        isFrameAdminMode ? [] : buildUndeployedSummaryItems(lastDeploy, frame, requiresRecompilation),
    ],
    frameosVersionSummary: [(s) => [s.deployPlan], (deployPlan): SummaryItem[] => buildFrameosVersionSummary(deployPlan)],
    deployPlan: [(s) => [s.deployPlans], (deployPlans) => deployPlans],
    fastDeployPlan: [(s) => [s.deployPlan], (deployPlan) => deployPlan],
    fullDeployPlan: [(s) => [s.deployPlan], (deployPlan) => deployPlan],
    fastDeployPlanSummary: [
      (s) => [s.fastDeployPlan],
      (fastDeployPlan): SummaryItem[] => buildFastDeployPlanSummary(fastDeployPlan),
    ],
    fullDeployPlanSummary: [
      (s) => [s.fullDeployPlan, s.frameForm],
      (fullDeployPlan: DeployPlanResponse | null, frameForm: Partial<FrameType>): SummaryItem[] =>
        buildFullDeployPlanSummary(fullDeployPlan, frameForm),
    ],
    deployRecommendation: [
      (s) => [s.deployPlan, s.lastDeploy, s.deployChangeDetails],
      (deployPlan, lastDeploy, deployChangeDetails): DeployRecommendation | null =>
        buildDeployRecommendation(deployPlan, Boolean(lastDeploy), deployChangeDetails),
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
        return agent?.deployWithAgent ?? (agent?.agentEnabled && agent?.agentRunCommands) ?? false
      },
    ],
  })),
  subscriptions(({ actions, values }) => ({
    frame: (frame?: FrameType, oldFrame?: FrameType) => {
      setBrowserTitle(frame)
      const frameFormMatchesPrevious = equal(oldFrame, values.frameForm)
      if (frame && (!oldFrame || frameFormMatchesPrevious)) {
        actions.resetFrameForm(sanitizeFrame(frame) as FrameType)
      }
    },
  })),
  listeners(({ actions, values, props }) => ({
    saveFrame: () => actions.submitFrameForm(),
    renderFrame: () => framesModel.actions.renderFrame(props.frameId),
    restartFrame: () => framesModel.actions.restartFrame(props.frameId),
    rebootFrame: () => framesModel.actions.rebootFrame(props.frameId),
    stopFrame: () => framesModel.actions.stopFrame(props.frameId),
    deployFrame: () => {
      framesModel.actions.deployFrame(
        props.frameId,
        Boolean(values.frame?.last_successful_deploy_at) && !values.requiresRecompilation
      )
    },
    fastDeployFrame: () => framesModel.actions.deployFrame(props.frameId, true),
    fullDeployFrame: () => framesModel.actions.deployFrame(props.frameId, false),
    deployAgent: () => framesModel.actions.deployAgent(props.frameId),
    restartAgent: () => framesModel.actions.restartAgent(props.frameId),
    setDeployWithAgent: ({ deployWithAgent }) => framesModel.actions.setDeployWithAgent(props.frameId, deployWithAgent),
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
        const oldScenes = values.frameForm?.scenes || []
        const newScenes = duplicateScenes(
          (template.scenes ?? []).map((scene) => sanitizeScene(scene, values.frameForm))
        )
        if (newScenes.length === 1) {
          newScenes[0].name = template?.name || newScenes[0].name || 'Untitled scene'
        }
        for (const scene of newScenes) {
          if ('default' in scene) {
            delete scene.default
          }
        }
        actions.setFrameFormValues({
          scenes: [...oldScenes, ...newScenes],
        })

        if (newScenes.length) {
          try {
            const imageBlob = await fetchTemplateImageBlob(template)
            if (imageBlob) {
              const targetScenes = getScenesWithoutParents(newScenes)
              if (!targetScenes.length) {
                return
              }
              await Promise.all(
                targetScenes.map((scene) =>
                  apiFetch(`/api/frames/${props.frameId}/scene_images/${scene.id}`, {
                    method: 'POST',
                    body: imageBlob,
                  })
                )
              )
              targetScenes.forEach((scene) =>
                entityImagesModel.actions.updateEntityImage(`frames/${props.frameId}`, `scene_images/${scene.id}`)
              )
            }
          } catch (error) {
            console.error('Failed to save template image for scenes', error)
          }
        }
      }
    },
    sendEvent: async ({ event, payload }) => {
      await apiFetch(`/api/frames/${props.frameId}/event/${event}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  })),
  afterMount(({ actions, values, cache }) => {
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
      event.preventDefault()
      actions.saveFrame()
    }
    window.addEventListener('keydown', cache.keydownHandler)
  }),
  beforeUnmount(({ cache }) => {
    setBrowserTitle(null)
    if (cache.keydownHandler) {
      window.removeEventListener('keydown', cache.keydownHandler)
      cache.keydownHandler = null
    }
  }),
])
