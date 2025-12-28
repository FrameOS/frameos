import { AppConfig, FrameOSSettings, FrameScene } from '../../../types'

export const settingsDetails: Record<
  string,
  {
    title: string
    tagLabel: string
    description?: string
    fields: { label: string; secret?: boolean; path: (keyof FrameOSSettings | string)[] }[]
  }
> = {
  openAI: {
    title: 'OpenAI',
    tagLabel: 'Uses OpenAI API key',
    description: 'The OpenAI API key is used within OpenAI apps.',
    fields: [{ label: 'API key', secret: true, path: ['openAI', 'apiKey'] }],
  },
  unsplash: {
    title: 'Unsplash API',
    tagLabel: 'Uses Unsplash access key',
    fields: [{ label: 'Access key', secret: true, path: ['unsplash', 'accessKey'] }],
  },
  homeAssistant: {
    title: 'Home Assistant',
    tagLabel: 'Uses Home Assistant access token',
    fields: [
      { label: 'Home assistant URL', path: ['homeAssistant', 'url'] },
      {
        label: 'Access token (Profile → Long-Lived Access Tokens)',
        secret: true,
        path: ['homeAssistant', 'accessToken'],
      },
    ],
  },
  // frameOS: {
  //   title: 'FrameOS Gallery',
  //   tagLabel: 'Uses FrameOS Gallery API key',
  //   description: 'Premium AI slop to get you started.',
  //   fields: [{ label: 'API key', secret: true, path: ['frameOS', 'apiKey'] }],
  // },
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

export function getSettingsValue(settings: FrameOSSettings | null | undefined, path: (keyof FrameOSSettings | string)[]) {
  return path.reduce<any>((acc, key) => (acc ? acc[key as keyof typeof acc] : undefined), settings)
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && (typeof value === 'string' ? value.trim() !== '' : true)
}

export function collectSecretSettingsFromScenes(
  scenes: FrameScene[] | undefined,
  apps: Record<string, AppConfig>
): string[] {
  const settingsKeys = new Set<string>()
  for (const scene of scenes ?? []) {
    for (const node of scene.nodes ?? []) {
      if (node.type === 'app') {
        const keyword = (node.data as { keyword?: string } | undefined)?.keyword
        const appConfig = resolveAppConfig(apps, keyword)
        for (const setting of appConfig?.settings ?? []) {
          if (settingsDetails[setting]) {
            settingsKeys.add(setting)
          }
        }
      }
    }
  }
  return Array.from(settingsKeys)
}

export function getMissingSecretSettingKeys(
  settingKeys: string[],
  settings: FrameOSSettings | null | undefined
): Set<string> {
  const missing = new Set<string>()
  for (const settingKey of settingKeys) {
    const details = settingsDetails[settingKey]
    if (!details) {
      continue
    }
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
