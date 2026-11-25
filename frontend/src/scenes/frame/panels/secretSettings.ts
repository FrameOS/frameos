import { AppConfig, FrameOSSettings, FrameScene } from '../../../types'
import { sceneAppToAppConfig } from '../../../utils/sceneApps'
import { SERVICE_REGISTRY } from '../../../generated/services.gen'
import {
  type ServiceDefinition,
  appServiceDefinitions,
  isServiceId,
  serviceDefinition,
} from '../../../utils/serviceKeys'

/** How the SPA draws one service's default key: from the registry (repo/services.json, docs/service-keys.md). */
export interface ServiceSettingsDetails {
  title: string
  tagLabel: string
  description?: string
  help?: string
  freeLimitedUsage?: boolean
  fields: {
    label: string
    secret?: boolean
    path: (keyof FrameOSSettings | string)[]
    placeholder?: string
    hint?: string
  }[]
  registered: boolean
}

function detailsOf(definition: ServiceDefinition): ServiceSettingsDetails {
  return {
    title: definition.title,
    tagLabel: `${definition.title} key missing`,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.help ? { help: definition.help } : {}),
    ...(definition.optional ? { freeLimitedUsage: true } : {}),
    fields: definition.fields.map((field) => ({
      label: field.label,
      secret: field.secret,
      path: [definition.id, field.name],
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.hint ? { hint: field.hint } : {}),
    })),
    registered: definition.registered,
  }
}

/** Every registered service, by id. A service the registry lacks: settingsDetailsFor. */
export const settingsDetails: Readonly<Record<string, ServiceSettingsDetails>> = Object.fromEntries(
  Object.keys(SERVICE_REGISTRY).map((id) => [id, detailsOf(serviceDefinition(id))])
)

/**
 * Any service's details: the registry's, else what an app defines for it
 * (`appDefinitions`, appServiceDefinitionsFromScenes), else the bare id with
 * the fields a stored value has (`storedValues`).
 */
export function settingsDetailsFor(
  service: string,
  appDefinitions?: Record<string, ServiceDefinition> | null,
  storedValues?: unknown
): ServiceSettingsDetails {
  return settingsDetails[service] ?? detailsOf(serviceDefinition(service, appDefinitions, storedValues))
}

export function resolveAppConfig(apps: Record<string, AppConfig>, keyword?: string): AppConfig | undefined {
  if (!keyword) {
    return undefined
  }
  if (apps[keyword]) {
    return apps[keyword]
  }
  if (!keyword.includes('/')) {
    const match = Object.keys(apps).find((key) => key.endsWith(`/${keyword}`))
    if (match) {
      return apps[match]
    }
  }
  return undefined
}

export function getSettingsValue(
  settings: FrameOSSettings | null | undefined,
  path: (keyof FrameOSSettings | string)[]
) {
  return path.reduce<any>((acc, key) => (acc ? acc[key as keyof typeof acc] : undefined), settings)
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && (typeof value === 'string' ? value.trim() !== '' : true)
}

function sceneAppConfigs(scenes: FrameScene[] | undefined, apps: Record<string, AppConfig>): AppConfig[] {
  const configs: AppConfig[] = []
  for (const scene of scenes ?? []) {
    for (const node of scene.nodes ?? []) {
      if (node.type === 'app') {
        const keyword = (node.data as { keyword?: string } | undefined)?.keyword
        const sceneApp = keyword ? scene.apps?.[keyword] : undefined
        const appConfig = sceneApp ? sceneAppToAppConfig(sceneApp) : resolveAppConfig(apps, keyword)
        if (appConfig) {
          configs.push(appConfig)
        }
      }
    }
  }
  return configs
}

/** The services the scenes' apps declare (their config.json `settings`), registered or not. */
export function collectSecretSettingsFromScenes(
  scenes: FrameScene[] | undefined,
  apps: Record<string, AppConfig>
): string[] {
  const settingsKeys = new Set<string>()
  for (const appConfig of sceneAppConfigs(scenes, apps)) {
    for (const setting of appConfig?.settings ?? []) {
      if (isServiceId(setting)) {
        settingsKeys.add(setting)
      }
    }
  }
  return Array.from(settingsKeys)
}

/** The services the scenes' apps define for themselves (config.json `services`), for the forms' labels. */
export function appServiceDefinitionsFromScenes(
  scenes: FrameScene[] | undefined,
  apps: Record<string, AppConfig>
): Record<string, ServiceDefinition> {
  const definitions: Record<string, ServiceDefinition> = {}
  for (const appConfig of sceneAppConfigs(scenes, apps)) {
    for (const [id, definition] of Object.entries(appServiceDefinitions(appConfig))) {
      definitions[id] ??= definition
    }
  }
  return definitions
}

export function getMissingSecretSettingKeys(
  settingKeys: string[],
  settings: FrameOSSettings | null | undefined
): Set<string> {
  const missing = new Set<string>()
  for (const settingKey of settingKeys) {
    const details = settingsDetailsFor(settingKey, null, settings?.[settingKey])
    const secretFields = details.fields.filter((field) => field.secret)
    if (!secretFields.length) {
      continue
    }
    if (secretFields.some((field) => !hasValue(getSettingsValue(settings, field.path)))) {
      missing.add(settingKey)
    }
  }
  return missing
}
