import { AppConfig, AppConfigUninstalled } from '../../types'

export function appConfigWithDefaults(keyword: string, app: AppConfig | AppConfigUninstalled): AppConfig {
  return {
    keyword: keyword,
    name: app.name,
    description: app.description,
    version: app.version,
    fields: app.fields,
    config: Object.fromEntries(
      app.fields
        .filter(({ name, required, value }) => !!required || value !== undefined)
        .map(({ name, value }) => [name, value])
    ),
  }
}
