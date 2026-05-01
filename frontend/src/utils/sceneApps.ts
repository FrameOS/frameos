import { AppConfig, FrameScene, SceneApp } from '../types'
import { apiFetch } from './apiFetch'
import { embeddedRepoAppConfigs, embeddedRepoAppSources } from '../generated/repoApps'

export const javascriptAppSourceFiles = ['app.ts', 'app.js', 'app.tsx', 'app.jsx']
export const javascriptCatalogAppKeywords = Object.keys(embeddedRepoAppConfigs)

const javascriptCatalogAppLabels: Record<string, string> = {
  'repo/apps/code/jsLogic': 'code: new logic app (JS)',
  'repo/apps/code/jsText': 'code: new text data app (JS)',
  'repo/apps/code/jsImage': 'code: new image data app (JS)',
  'repo/apps/code/jsSvg': 'code: new svg data app (JS)',
}

export function isRepoAppKeyword(keyword?: string | null): boolean {
  return !!keyword && keyword.startsWith('repo/')
}

export function isJavaScriptCatalogApp(keyword?: string | null): boolean {
  return !!keyword && javascriptCatalogAppKeywords.includes(keyword)
}

export function javascriptCatalogAppLabel(keyword: string, app?: Pick<AppConfig, 'name'> | null): string {
  return javascriptCatalogAppLabels[keyword] ?? `code: ${app?.name ?? keyword}`
}

export function hasJavaScriptAppSource(sources?: Record<string, string> | null): boolean {
  return !!sources && javascriptAppSourceFiles.some((file) => !!sources[file])
}

export function hasCompiledAppSource(sources?: Record<string, string> | null): boolean {
  return !!(sources?.['app.nim'] || sources?.['config.nim'])
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

type LegacyAppOrigin = { source?: string }

export function appOrigin(app?: (Partial<Pick<AppConfig, 'origin'>> & LegacyAppOrigin) | null): string | undefined {
  return app?.origin ?? app?.source
}

export function sceneAppWithOrigin(sceneApp: SceneApp, fallbackOrigin?: string): SceneApp {
  const { source: _legacySource, ...sceneAppWithoutLegacySource } = sceneApp as SceneApp & LegacyAppOrigin
  return {
    ...sceneAppWithoutLegacySource,
    origin: appOrigin(sceneApp) || fallbackOrigin,
  }
}

export function normalizeSceneApps(sceneApps?: Record<string, SceneApp> | null): Record<string, SceneApp> {
  return Object.fromEntries(
    Object.entries(sceneApps ?? {}).map(([keyword, sceneApp]) => [keyword, sceneAppWithOrigin(sceneApp, keyword)])
  )
}

export function sceneAppToAppConfig(sceneApp: SceneApp): AppConfig {
  const sourceConfig = parseAppConfigFromSources(sceneApp.sources)
  const origin = appOrigin(sceneApp)
  return {
    name: sceneApp.name || sourceConfig.name || origin || 'Scene app',
    category: sceneApp.category || sourceConfig.category,
    description: sceneApp.description || sourceConfig.description,
    version: sceneApp.version || sourceConfig.version,
    settings: sceneApp.settings || sourceConfig.settings,
    apt: sceneApp.apt || sourceConfig.apt,
    fields: sceneApp.fields || sourceConfig.fields,
    output: sceneApp.output || sourceConfig.output,
    cache: sceneApp.cache || sourceConfig.cache,
    origin,
  }
}

export function sceneAppsToAppConfigs(scene?: FrameScene | null): Record<string, AppConfig> {
  return Object.fromEntries(
    Object.entries(normalizeSceneApps(scene?.apps)).map(([keyword, sceneApp]) => [
      keyword,
      sceneAppToAppConfig(sceneApp),
    ])
  )
}

export function mergeSceneAndCatalogApps(
  apps: Record<string, AppConfig>,
  scene?: FrameScene | null
): Record<string, AppConfig> {
  return { ...apps, ...sceneAppsToAppConfigs(scene) }
}

export function appTag(app?: (Pick<AppConfig, 'origin'> & LegacyAppOrigin) | null): string | null {
  const origin = appOrigin(app)
  if (!origin) {
    return null
  }
  const parts = origin.split('/')
  if (parts[0] === 'repo' && parts[1] === 'apps' && parts[2]) {
    return parts[2]
  }
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

export function embeddedRepoAppSourceFiles(keyword: string): Record<string, string> | null {
  const sources = embeddedRepoAppSources[keyword]
  return sources ? { ...sources } : null
}

export async function loadAppSources(keyword: string): Promise<Record<string, string>> {
  const embeddedSources = embeddedRepoAppSourceFiles(keyword)
  if (embeddedSources) {
    return embeddedSources
  }

  const response = await apiFetch(`/api/apps/source?keyword=${encodeURIComponent(keyword)}`)
  if (!response.ok) {
    return {}
  }
  return await response.json()
}

export function sceneAppKeyBase(keyword: string, app?: Partial<Pick<AppConfig, 'name'>> | null): string {
  const keywordParts = keyword.split('/').filter(Boolean)
  const rawBase = keywordParts[keywordParts.length - 1] || app?.name || 'app'
  return rawBase.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/(^-|-$)/g, '') || 'app'
}

export function nextSceneAppKey(
  sceneApps: Record<string, SceneApp>,
  keyword: string,
  app?: Partial<Pick<AppConfig, 'name'>> | null
): string {
  const base = sceneAppKeyBase(keyword, app)
  if (!sceneApps[base]) {
    return base
  }
  let index = 2
  let key = `${base}-${index}`
  while (sceneApps[key]) {
    index += 1
    key = `${base}-${index}`
  }
  return key
}

export function buildSceneApp(
  keyword: string,
  app: Partial<AppConfig> | undefined,
  sources: Record<string, string>,
  previous?: Partial<SceneApp>
): SceneApp {
  const sourceConfig = parseAppConfigFromSources(sources)
  const origin = appOrigin(previous) || appOrigin(app) || (isRepoAppKeyword(keyword) ? keyword : undefined)
  const { source: _legacySource, ...previousWithoutLegacySource } = (previous ?? {}) as Partial<SceneApp> &
    LegacyAppOrigin
  return {
    ...previousWithoutLegacySource,
    origin,
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

export interface InstalledSceneApp {
  sceneApps: Record<string, SceneApp>
  keyword: string
  app: AppConfig | null
}

export async function installSceneAppForKeyword(
  sceneApps: Record<string, SceneApp>,
  keyword: string,
  app: Partial<AppConfig> | undefined
): Promise<InstalledSceneApp> {
  if (!isRepoAppKeyword(keyword)) {
    return {
      sceneApps,
      keyword,
      app: (app as AppConfig | undefined) ?? null,
    }
  }
  const sources = await loadAppSources(keyword)
  const sceneKeyword = nextSceneAppKey(sceneApps, keyword, app)
  const sceneApp = buildSceneApp(sceneKeyword, app, sources, { origin: appOrigin(app) || keyword })
  return {
    sceneApps: {
      ...sceneApps,
      [sceneKeyword]: sceneApp,
    },
    keyword: sceneKeyword,
    app: sceneAppToAppConfig(sceneApp),
  }
}

export function forkSceneAppKey(
  sceneApps: Record<string, SceneApp>,
  keyword: string,
  app?: AppConfig | null
): string {
  return nextSceneAppKey(sceneApps, keyword, app)
}

export function updateSceneAppsInScenes(
  scenes: FrameScene[] | undefined,
  sceneId: string,
  apps: Record<string, SceneApp>,
  forceCompiled = false,
  nodes?: FrameScene['nodes']
): FrameScene[] | undefined {
  const normalizedApps = normalizeSceneApps(apps)
  const needsCompiled =
    forceCompiled && Object.values(normalizedApps).some((app) => hasCompiledAppSource(app.sources))
  return scenes?.map((scene) =>
    scene.id === sceneId
      ? {
          ...scene,
          apps: normalizedApps,
          ...(nodes ? { nodes } : {}),
          settings:
            needsCompiled && scene.settings?.execution === 'interpreted'
              ? { ...scene.settings, execution: 'compiled' }
              : scene.settings,
        }
      : scene
  )
}
