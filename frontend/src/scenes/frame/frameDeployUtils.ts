import type { FrameType } from '../../types'
import versions from '../../../../versions.json'

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

export interface DeployRecommendation {
  mode: 'fast' | 'full'
  title: string
  description: string
}

export const CURRENT_FRAMEOS_VERSION = (versions.frameos || 'dev').split('+')[0]

function stringifyList(values: unknown[]): string {
  if (values.length === 0) {
    return 'None'
  }
  return values.map((value) => String(value)).join(', ')
}

function previousFrameosVersion(plan?: DeployPlanResponse | null): string {
  return plan?.previous_frameos_version ? String(plan.previous_frameos_version).split('+')[0] : 'Not deployed'
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
  const items: SummaryItem[] = [
    {
      label: 'FrameOS version',
      value: previousVersion === CURRENT_FRAMEOS_VERSION ? CURRENT_FRAMEOS_VERSION : `${previousVersion} -> ${CURRENT_FRAMEOS_VERSION}`,
    },
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

export function buildDeployRecommendation(
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
    description: 'No pending changes require rebuilding FrameOS, so a fast deploy (reload) is enough to bring the frame up to date.',
  }
}
