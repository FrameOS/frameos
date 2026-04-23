import { AppConfig, FrameScene, SceneApp } from '../types'
import { apiFetch } from './apiFetch'

export function isRepoAppKeyword(keyword?: string | null): boolean {
  return !!keyword && keyword.startsWith('repo/')
}

export function parseAppConfigFromSources(sources?: Record<string, string> | null): Partial<AppConfig> {
  if (!sources?.['config.json']) {
    return {}
  }
  try {
    const config = JSON.parse(sources['config.json'])
    return typeof config === 'object' && config ? config : {}
  } catch {
    return {}
  }
}

export function sceneAppToAppConfig(sceneApp: SceneApp): AppConfig {
  const sourceConfig = parseAppConfigFromSources(sceneApp.sources)
  return {
    name: sceneApp.name || sourceConfig.name || sceneApp.source || 'Scene app',
    category: sceneApp.category || sourceConfig.category,
    description: sceneApp.description || sourceConfig.description,
    version: sceneApp.version || sourceConfig.version,
    settings: sceneApp.settings || sourceConfig.settings,
    apt: sceneApp.apt || sourceConfig.apt,
    fields: sceneApp.fields || sourceConfig.fields,
    output: sceneApp.output || sourceConfig.output,
    cache: sceneApp.cache || sourceConfig.cache,
    source: sceneApp.source,
  }
}

export function sceneAppsToAppConfigs(scene?: FrameScene | null): Record<string, AppConfig> {
  return Object.fromEntries(
    Object.entries(scene?.apps ?? {}).map(([keyword, sceneApp]) => [keyword, sceneAppToAppConfig(sceneApp)])
  )
}

export function mergeSceneAndCatalogApps(
  apps: Record<string, AppConfig>,
  scene?: FrameScene | null
): Record<string, AppConfig> {
  return { ...apps, ...sceneAppsToAppConfigs(scene) }
}

export function appTag(app?: Pick<AppConfig, 'source'> | null): string | null {
  if (!app?.source) {
    return null
  }
  const parts = app.source.split('/')
  if (parts[0] === 'repo' && parts[1]) {
    return parts[1]
  }
  if (parts[0] === 'scene') {
    return 'scene'
  }
  return parts[0] || null
}

export function appLabel(app: AppConfig, prefix?: string): string {
  const tag = appTag(app)
  return `${prefix ? `${prefix}: ` : ''}${app.name}${tag ? ` [${tag}]` : ''}`
}

export async function loadAppSources(keyword: string): Promise<Record<string, string>> {
  const response = await apiFetch(`/api/apps/source?keyword=${encodeURIComponent(keyword)}`)
  return await response.json()
}

export function buildSceneApp(
  keyword: string,
  app: Partial<AppConfig> | undefined,
  sources: Record<string, string>,
  previous?: Partial<SceneApp>
): SceneApp {
  const sourceConfig = parseAppConfigFromSources(sources)
  const source = previous?.source || app?.source || (isRepoAppKeyword(keyword) ? keyword : undefined)
  return {
    ...previous,
    source,
    name: sourceConfig.name || previous?.name || app?.name || keyword,
    category: sourceConfig.category || previous?.category || app?.category,
    description: sourceConfig.description || previous?.description || app?.description,
    version: sourceConfig.version || previous?.version || app?.version,
    settings: sourceConfig.settings || previous?.settings || app?.settings,
    apt: sourceConfig.apt || previous?.apt || app?.apt,
    fields: sourceConfig.fields || previous?.fields || app?.fields,
    output: sourceConfig.output || previous?.output || app?.output,
    cache: sourceConfig.cache || previous?.cache || app?.cache,
    sources,
  }
}

export async function sceneAppsWithKeyword(
  sceneApps: Record<string, SceneApp>,
  keyword: string,
  app: Partial<AppConfig> | undefined
): Promise<Record<string, SceneApp>> {
  if (sceneApps[keyword] || !isRepoAppKeyword(keyword)) {
    return sceneApps
  }
  const sources = await loadAppSources(keyword)
  return {
    ...sceneApps,
    [keyword]: buildSceneApp(keyword, app, sources),
  }
}

export function forkSceneAppKey(sceneApps: Record<string, SceneApp>, keyword: string, app?: AppConfig | null): string {
  const keywordParts = keyword.split('/')
  const rawBase = app?.name || keywordParts[keywordParts.length - 1] || 'app'
  const base = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'app'
  let index = 1
  let key = `scene/${base}`
  while (sceneApps[key]) {
    index += 1
    key = `scene/${base}-${index}`
  }
  return key
}

export function updateSceneAppsInScenes(
  scenes: FrameScene[] | undefined,
  sceneId: string,
  apps: Record<string, SceneApp>,
  forceCompiled = false,
  nodes?: FrameScene['nodes']
): FrameScene[] | undefined {
  return scenes?.map((scene) =>
    scene.id === sceneId
      ? {
          ...scene,
          apps,
          ...(nodes ? { nodes } : {}),
          settings:
            forceCompiled && scene.settings?.execution === 'interpreted'
              ? { ...scene.settings, execution: 'compiled' }
              : scene.settings,
        }
      : scene
  )
}
