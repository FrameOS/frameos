import type { FrameType } from '../../types'
import versions from '../../../../versions.json'
import { type FrameCompilationMode, normalizeFrameCompilationMode } from '../../utils/frameBuildOptions'
import { sceneIsCompiledForFrame } from '../../utils/sceneExecution'

export interface ChangeDetail {
  label: string
  requiresFullDeploy: boolean
  frameosVersionChange?: {
    kind: 'install' | 'upgrade'
    previousVersion?: string | null
    currentVersion: string
  }
  remoteVersionChange?: {
    previousVersion?: string | null
    currentVersion: string
  }
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
    requested_compilation_mode?: FrameCompilationMode
    compilation_mode?: FrameCompilationMode
    will_attempt_cross_compile?: boolean
    will_attempt_precompiled?: boolean
    cross_compile_supported?: boolean
    build_host_configured?: boolean
    build_executor?: string | null
    prebuilt_target?: string | null
    has_prebuilt_entry?: boolean
    precompiled_release_url?: string | null
    precompiled_skip_reason?: string | null
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
  quickjs: {
    required_if_remote_build: boolean
    dirname?: string | null
    installed: boolean
  }
  ssh_keys_need_install: boolean
  remote_upgrade?: {
    previous_version?: string | null
    current_version: string
    transport: 'remote' | 'ssh' | string
  } | null
  post_deploy?: {
    i2c?: {
      needs_boot_config_line?: boolean
      needs_runtime_enable?: boolean
    }
    spi_action?: 'enable' | 'disable' | 'unchanged'
    reboot_schedule?: {
      enabled?: boolean
      crontab?: string
      type?: 'frameos' | 'raspberry' | string | null
      command?: string
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

export interface DeployRecommendation {
  mode: 'none' | 'fast' | 'full'
  title: string
  description: string
  descriptionEmphasis?: string
}

export interface RemoteUpgradeNotice {
  previousVersion: string | null
  currentVersion: string
}

type PlannedRebootSchedule = NonNullable<NonNullable<FullDeployPlanResponse['post_deploy']>['reboot_schedule']>

export const CURRENT_FRAMEOS_VERSION = (versions.frameos || 'dev').split('+')[0]
export const CURRENT_FRAMEOS_REMOTE_VERSION = ((versions as any).remote || (versions as any).agent || 'dev').split('+')[0]
export const FRAMEOS_GITHUB_RELEASES_URL = 'https://github.com/FrameOS/frameos/releases'

const INKY_BUTTON_DEVICES = new Set([
  'pimoroni.inky_impression',
  'pimoroni.inky_impression_7_3',
  'pimoroni.inky_impression_7_color',
  'pimoroni.inky_impression_5_7',
  'pimoroni.inky_impression_5_7_color',
  'pimoroni.inky_impression_4_7_color',
  'pimoroni.inky_impression_4',
  'pimoroni.inky_impression_4_2025',
  'pimoroni.inky_impression_4_spectra6',
  'pimoroni.inky_impression_7',
  'pimoroni.inky_impression_7_2025',
  'pimoroni.inky_impression_13',
  'pimoroni.inky_impression_13_2025',
])
const INKY_NATIVE_DEVICES = new Set([
  'pimoroni.inky_impression_7_3',
  'pimoroni.inky_impression_7_color',
  'pimoroni.inky_impression_5_7',
  'pimoroni.inky_impression_5_7_color',
  'pimoroni.inky_impression_4_7_color',
  'pimoroni.inky_impression_4',
  'pimoroni.inky_impression_4_2025',
  'pimoroni.inky_impression_4_spectra6',
  'pimoroni.inky_impression_7',
  'pimoroni.inky_impression_7_2025',
  'pimoroni.inky_impression_13',
  'pimoroni.inky_impression_13_2025',
  'pimoroni.inky_phat_4',
  'pimoroni.inky_phat_4_color',
  'pimoroni.inky_phat_jd79661',
  'pimoroni.inky_phat_black',
  'pimoroni.inky_phat_red',
  'pimoroni.inky_phat_red_ht',
  'pimoroni.inky_phat_yellow',
  'pimoroni.inky_phat_ssd1608',
  'pimoroni.inky_phat_ssd1608_black',
  'pimoroni.inky_phat_ssd1608_red',
  'pimoroni.inky_phat_ssd1608_yellow',
  'pimoroni.inky_what_4',
  'pimoroni.inky_what_4_color',
  'pimoroni.inky_what_jd79668',
  'pimoroni.inky_what_black',
  'pimoroni.inky_what_red',
  'pimoroni.inky_what_red_ht',
  'pimoroni.inky_what_yellow',
  'pimoroni.inky_what_legacy_yellow',
  'pimoroni.inky_what_ssd1683',
  'pimoroni.inky_what_ssd1683_black',
  'pimoroni.inky_what_ssd1683_red',
  'pimoroni.inky_what_ssd1683_yellow',
])
const VIRTUAL_OUTPUT_DEVICES = new Set(['http.upload', 'web_only'])
const WAVESHARE_NO_SPI_VARIANTS = new Set(['EPD_12in48', 'EPD_12in48b', 'EPD_12in48b_V2', 'EPD_13in3e'])
const WAVESHARE_BOOT_CONFIG_SPI_VARIANTS = new Set(['EPD_10in3'])
const WAVESHARE_BOOT_CONFIG_VARIANTS = new Set(['EPD_10in3', 'EPD_13in3e'])

function stringifyList(values: unknown[]): string {
  if (values.length === 0) {
    return 'None'
  }
  return values.map((value) => String(value)).join(', ')
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function frameCompilationMode(frame?: Partial<FrameType> | null): FrameCompilationMode {
  return normalizeFrameCompilationMode(
    frame?.mode === 'buildroot' ? frame?.buildroot?.compilationMode : frame?.rpios?.compilationMode
  )
}

function frameCompiledSceneCount(frame?: Partial<FrameType> | null): number {
  return (frame?.scenes ?? []).filter((scene) => sceneIsCompiledForFrame(scene, frame?.mode)).length
}

function inferFrameDriverNames(frame?: Partial<FrameType> | null): string[] {
  const device = frame?.device
  if (!device) {
    return []
  }

  const drivers = new Set<string>()
  if (INKY_NATIVE_DEVICES.has(device)) {
    drivers.add('bootconfig')
    drivers.add('inky')
    drivers.add('spi')
    if (INKY_BUTTON_DEVICES.has(device)) {
      drivers.add('gpioButton')
    }
  } else if (device === 'pimoroni.inky_impression' || device === 'pimoroni.inky_python') {
    drivers.add('i2c')
    drivers.add('inkyPython')
    drivers.add('spi')
    if (INKY_BUTTON_DEVICES.has(device)) {
      drivers.add('gpioButton')
      drivers.add('bootconfig')
    }
  } else if (device === 'pimoroni.hyperpixel2r') {
    drivers.add('inkyHyperPixel2rLegacyFb')
  } else if (device === 'pimoroni.hyperpixel2r_native') {
    drivers.add('inkyHyperPixel2r')
  } else if (device === 'framebuffer') {
    drivers.add('frameBuffer')
  } else if (device === 'http.upload') {
    drivers.add('httpUpload')
  } else if (device.startsWith('waveshare.')) {
    const variant = device.split('.')[1]
    drivers.add('waveshare')
    if (WAVESHARE_BOOT_CONFIG_SPI_VARIANTS.has(variant)) {
      drivers.add('bootconfig')
    } else if (WAVESHARE_NO_SPI_VARIANTS.has(variant)) {
      drivers.add('noSpi')
    } else {
      drivers.add('spi')
    }
    if (WAVESHARE_BOOT_CONFIG_VARIANTS.has(variant)) {
      drivers.add('bootconfig')
    }
  }

  if (!INKY_BUTTON_DEVICES.has(device) && !device.startsWith('waveshare.') && !VIRTUAL_OUTPUT_DEVICES.has(device)) {
    drivers.add('evdev')
  }
  if (!drivers.has('gpioButton') && (frame?.gpio_buttons ?? []).length > 0) {
    drivers.add('gpioButton')
  }

  return [...drivers].sort()
}

function precompiledSkipReason(frame?: Partial<FrameType> | null): string | null {
  const compiledSceneCount = frameCompiledSceneCount(frame)
  return compiledSceneCount > 0 ? `${pluralize(compiledSceneCount, 'compiled scene')} configured` : null
}

function canUsePrecompiledFrameos(frame?: Partial<FrameType> | null, plan?: DeployPlanResponse | null): boolean {
  if (frameCompiledSceneCount(frame) > 0) {
    return false
  }
  if (plan?.full_deploy?.binary?.will_attempt_precompiled !== undefined) {
    return plan.full_deploy.binary.will_attempt_precompiled === true
  }
  const compilationMode = frameCompilationMode(frame)
  if (frame?.mode === 'buildroot') {
    return compilationMode === 'precompiled' && !precompiledSkipReason(frame)
  }

  return compilationMode === 'precompiled' && !precompiledSkipReason(frame)
}

function inferBuildStrategy(frame?: Partial<FrameType> | null): string {
  const isBuildroot = frame?.mode === 'buildroot'
  const compilationMode = frameCompilationMode(frame)
  const skipReason = precompiledSkipReason(frame)
  let crossCompileText = 'Use the global build environment'
  if (isBuildroot) {
    crossCompileText = 'Cross-compile for Buildroot'
  }

  if (compilationMode === 'precompiled') {
    if (!skipReason) {
      return 'Download and install the precompiled FrameOS release'
    }
    if (skipReason.includes('compiled scene')) {
      return `${crossCompileText} with scenes bundled in scenes.so; precompiled release skipped (${skipReason})`
    }
    return `${crossCompileText} as a single executable; precompiled release skipped (${skipReason})`
  }

  return crossCompileText
}

function inferCompilationSummary(frame?: Partial<FrameType> | null): string {
  const compilationMode = frameCompilationMode(frame)
  if (compilationMode === 'shared') {
    return 'Shared libraries deployed next to the FrameOS binary'
  }
  if (compilationMode === 'shared-scenes') {
    return 'Compiled scenes bundled into scenes.so next to the FrameOS binary'
  }
  if (compilationMode === 'precompiled' && !precompiledSkipReason(frame)) {
    return 'Precompiled FrameOS binary and shared driver libraries'
  }
  return 'Single FrameOS executable'
}

function formatCronSchedule(crontab?: string | null): string {
  const cron = crontab?.trim() || '0 0 * * *'
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/)
  if (
    Number.isInteger(Number(minute)) &&
    Number.isInteger(Number(hour)) &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`
  }
  return cron
}

function rebootScheduleTarget(type?: string | null): string {
  return type === 'raspberry' ? 'system reboot' : 'FrameOS restart'
}

function rebootScheduleSummary(reboot?: Partial<FrameType>['reboot'] | PlannedRebootSchedule): string | null {
  if (!reboot) {
    return null
  }
  if ('needs_remove' in reboot && reboot.needs_remove) {
    return 'Remove the existing automatic reboot schedule'
  }
  const plannedSchedule = 'needs_update' in reboot || 'needs_remove' in reboot
  if (!plannedSchedule && reboot.enabled !== true && reboot.enabled !== 'true') {
    return null
  }
  if (reboot.enabled === false || reboot.enabled === 'false') {
    return null
  }

  const target = rebootScheduleTarget(reboot.type)
  return `${target} at ${formatCronSchedule(reboot.crontab)}`
}

function mountpointsSummary(frame?: Partial<FrameType> | null): string | null {
  if (!frame?.mountpoints?.enabled) {
    return null
  }
  const enabledItems = (frame.mountpoints.items ?? []).filter(
    (item) => item.enabled !== false && item.source?.trim() && item.target?.trim()
  )
  if (enabledItems.length === 0) {
    return null
  }
  return `${enabledItems.length} Samba mountpoint${enabledItems.length === 1 ? '' : 's'}`
}

export function normalizeFrameosVersion(version: unknown): string | null {
  return typeof version === 'string' && version.trim() ? version.split('+')[0] : null
}

export function frameosGitHubReleaseUrl(version: unknown): string {
  const normalizedVersion = normalizeFrameosVersion(version)
  if (!normalizedVersion || !parseFrameosVersion(normalizedVersion)) {
    return FRAMEOS_GITHUB_RELEASES_URL
  }
  return `${FRAMEOS_GITHUB_RELEASES_URL}/tag/v${encodeURIComponent(normalizedVersion)}`
}

export function buildRemoteUpgradeNotice(frame?: Partial<FrameType> | null): RemoteUpgradeNotice | null {
  const currentVersion = normalizeFrameosVersion(CURRENT_FRAMEOS_REMOTE_VERSION)
  if (!currentVersion || currentVersion === 'dev' || (frame?.active_connections ?? 0) <= 0) {
    return null
  }

  const previousVersion = normalizeFrameosVersion(frame?.agent?.agentVersion)
  if (previousVersion === currentVersion) {
    return null
  }

  return { previousVersion, currentVersion }
}

function parseFrameosVersion(version: string | null): [number, number, number] | null {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function isFrameosVersionBefore(version: string | null, minimumVersion: string): boolean {
  const current = parseFrameosVersion(normalizeFrameosVersion(version))
  const minimum = parseFrameosVersion(normalizeFrameosVersion(minimumVersion))

  if (!current || !minimum) {
    return false
  }

  for (let index = 0; index < current.length; index++) {
    if (current[index] !== minimum[index]) {
      return current[index] < minimum[index]
    }
  }

  return false
}

export function deployedFrameosVersion(deploy?: Partial<FrameType> | Record<string, unknown> | null): string | null {
  return normalizeFrameosVersion((deploy as Record<string, unknown> | null | undefined)?.frameos_version)
}

export function deployPlanPreviousFrameosVersion(plan?: DeployPlanResponse | null): string | null {
  return normalizeFrameosVersion(plan?.previous_frameos_version)
}

function previousFrameosVersion(plan?: DeployPlanResponse | null): string {
  return deployPlanPreviousFrameosVersion(plan) ?? 'Not deployed'
}

export function buildDeployPlanRequestBody(
  frame: Partial<FrameType>,
  frameKeys: readonly (keyof FrameType)[]
): Record<string, any> {
  const json: Record<string, any> = {}
  for (const key of frameKeys) {
    json[key] = frame[key]
  }
  return json
}

export function buildFastDeployPlanSummary(plan?: DeployPlanResponse | null): SummaryItem[] {
  const fastPlan = plan?.fast_deploy
  if (!fastPlan || !fastPlan.tls_settings_changed) {
    return []
  }

  return [{ label: 'Fast deploy behavior', value: 'Restart FrameOS because TLS settings changed' }]
}

export function buildFullDeployPlanSummary(
  plan?: DeployPlanResponse | null,
  frame?: Partial<FrameType> | null
): SummaryItem[] {
  const fullPlan = plan?.full_deploy
  if (!fullPlan) {
    return []
  }

  const packagesToInstall = fullPlan.packages.filter((pkg) => pkg.needs_install).map((pkg) => pkg.name)
  const previousVersion = previousFrameosVersion(plan)
  const buildStrategyItem: SummaryItem = {
    label: 'Build strategy',
    value: fullPlan.binary.will_attempt_precompiled
      ? 'Download and install the precompiled FrameOS release'
      : fullPlan.binary.will_attempt_cross_compile
      ? fullPlan.binary.build_executor
        ? `Cross-compile via ${fullPlan.binary.build_executor}`
        : 'Cross-compile locally on this server'
      : fullPlan.binary.cross_compile_supported
      ? 'Build on device because the global build environment is disabled'
      : 'Build on device because cross-compilation is unavailable for this target',
  }
  let compilationItem: SummaryItem | null = null
  const items: SummaryItem[] = [
    {
      label: 'FrameOS version',
      value:
        previousVersion === CURRENT_FRAMEOS_VERSION
          ? CURRENT_FRAMEOS_VERSION
          : `${previousVersion} -> ${CURRENT_FRAMEOS_VERSION}`,
    },
    ...(frame?.device ? [{ label: 'Device', value: String(frame.device) }] : []),
    {
      label: 'Target',
      value: `${fullPlan.target.distro} ${fullPlan.target.version} · ${fullPlan.target.arch} · ${fullPlan.target.total_memory_mb} MiB`,
    },
  ]

  if (fullPlan.drivers.length > 0) {
    items.push({ label: 'Drivers', value: stringifyList(fullPlan.drivers) })
  }
  const requestedCompilationMode = fullPlan.binary.requested_compilation_mode ?? fullPlan.binary.compilation_mode
  if (fullPlan.binary.compilation_mode === 'shared' && requestedCompilationMode !== 'precompiled') {
    compilationItem = { label: 'Compilation', value: 'Shared libraries deployed next to the FrameOS binary' }
  }
  if (fullPlan.binary.compilation_mode === 'shared-scenes' && requestedCompilationMode === 'precompiled') {
    compilationItem = {
      label: 'Compilation',
      value: 'Compiled scenes bundled into scenes.so next to the FrameOS binary',
    }
  }
  if (requestedCompilationMode === 'precompiled') {
    const fallbackMode =
      fullPlan.binary.compilation_mode === 'static'
        ? 'Single executable'
        : fullPlan.binary.compilation_mode === 'shared-scenes'
        ? 'Bundled scenes library'
        : 'Shared libraries'
    compilationItem = {
      label: 'Compilation',
      value: fullPlan.binary.will_attempt_precompiled
        ? 'Precompiled FrameOS binary and shared driver libraries'
        : `${fallbackMode}; precompiled release skipped${
            fullPlan.binary.precompiled_skip_reason ? ` (${fullPlan.binary.precompiled_skip_reason})` : ''
          }`,
    }
  }
  if (packagesToInstall.length > 0) {
    items.push({ label: 'Packages to install', value: stringifyList(packagesToInstall) })
  }
  const mounts = mountpointsSummary(frame)
  if (mounts) {
    items.push({ label: 'Mountpoints', value: mounts })
  }
  if (
    !fullPlan.binary.will_attempt_precompiled &&
    !fullPlan.binary.will_attempt_cross_compile &&
    fullPlan.quickjs.required_if_remote_build &&
    !fullPlan.quickjs.installed
  ) {
    items.push({
      label: 'QuickJS',
      value: `${fullPlan.quickjs.dirname || 'Required'} will be prepared for the on-device build`,
    })
  }
  if (fullPlan.ssh_keys_need_install) {
    items.push({ label: 'SSH keys', value: 'Selected deploy keys will be installed on the frame' })
  }
  if (fullPlan.remote_upgrade) {
    items.push({
      label: 'FrameOS Remote',
      value: `Upgrade ${fullPlan.remote_upgrade.previous_version ?? 'unreported'} -> ${
        fullPlan.remote_upgrade.current_version
      } before full deploy`,
    })
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
    const schedule = rebootScheduleSummary(fullPlan.post_deploy.reboot_schedule)
    if (schedule) {
      items.push({ label: 'Reboot schedule', value: `Install automatic ${schedule}` })
    }
  }
  if (fullPlan.post_deploy?.reboot_schedule?.needs_remove) {
    const schedule = rebootScheduleSummary(fullPlan.post_deploy.reboot_schedule)
    if (schedule) {
      items.push({ label: 'Reboot schedule', value: schedule })
    }
  }
  if (fullPlan.low_memory && !fullPlan.binary.will_attempt_precompiled && !fullPlan.binary.will_attempt_cross_compile) {
    items.push({ label: 'Low memory', value: 'FrameOS will be stopped before the on-device build' })
  }
  if (fullPlan.post_deploy?.final_action === 'reboot') {
    items.push({ label: 'After deploy', value: 'Device reboot required' })
  }

  items.push(buildStrategyItem)
  if (compilationItem) {
    items.push(compilationItem)
  }

  return items
}

export function buildInferredFullDeployPlanSummary(
  lastDeploy: Partial<FrameType> | Record<string, unknown> | null,
  frame?: Partial<FrameType> | null
): SummaryItem[] {
  const previousVersion = deployedFrameosVersion(lastDeploy)
  const items: SummaryItem[] = [
    {
      label: 'FrameOS version',
      value:
        previousVersion && previousVersion === CURRENT_FRAMEOS_VERSION
          ? CURRENT_FRAMEOS_VERSION
          : `${previousVersion ?? 'Not deployed'} -> ${CURRENT_FRAMEOS_VERSION}`,
    },
    ...(frame?.device ? [{ label: 'Device', value: String(frame.device) }] : []),
  ]
  const drivers = inferFrameDriverNames(frame)
  if (drivers.length > 0) {
    items.push({ label: 'Drivers', value: stringifyList(drivers) })
  }
  const rebootSchedule = rebootScheduleSummary(frame?.reboot)
  if (rebootSchedule) {
    items.push({ label: 'Reboot schedule', value: `Automatic ${rebootSchedule}` })
  }
  const mounts = mountpointsSummary(frame)
  if (mounts) {
    items.push({ label: 'Mountpoints', value: mounts })
  }
  items.push({ label: 'Build strategy', value: inferBuildStrategy(frame) })
  items.push({ label: 'Compilation', value: inferCompilationSummary(frame) })

  return items
}

export function buildDeployRecommendation(
  previousVersion: string | null,
  hasPreviousDeploy: boolean,
  deployChangeDetails: ChangeDetail[],
  frame?: Partial<FrameType> | null,
  plan?: DeployPlanResponse | null
): DeployRecommendation {
  const versionChanged = previousVersion !== CURRENT_FRAMEOS_VERSION
  const fullDeployChanges = deployChangeDetails
    .filter((change) => change.requiresFullDeploy && !change.label.startsWith('FrameOS upgrade'))
    .map((change) => change.label)

  if (!hasPreviousDeploy) {
    return {
      mode: 'full',
      title: 'Suggested: full deploy',
      description:
        'This frame has not been deployed yet, so FrameOS, dependencies, and system changes need a full deploy.',
    }
  }

  if (fullDeployChanges.length > 0) {
    const usesPrecompiledFrameos = canUsePrecompiledFrameos(frame, plan)
    return {
      mode: 'full',
      title: 'Suggested: full deploy',
      description: usesPrecompiledFrameos
        ? 'You have changes that require reinstalling FrameOS.'
        : 'You have changes that require rebuilding FrameOS.',
      descriptionEmphasis: usesPrecompiledFrameos ? undefined : 'rebuilding',
    }
  }

  if (versionChanged) {
    return {
      mode: 'full',
      title: 'Suggested: full deploy',
      description: `Updating FrameOS from ${
        previousVersion ?? 'unknown'
      } to ${CURRENT_FRAMEOS_VERSION} requires a full deploy.`,
    }
  }

  if (deployChangeDetails.length === 0) {
    return {
      mode: 'none',
      title: 'Up to date',
      description: 'This frame is already up to date. Refresh the plan if you want to re-check the target details.',
    }
  }

  return {
    mode: 'fast',
    title: 'Suggested: fast deploy',
    description:
      'No pending changes require rebuilding FrameOS, so a fast deploy (reload) is enough to bring the frame up to date.',
  }
}
