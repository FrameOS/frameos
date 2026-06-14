import { AppConfig, AppNodeData, CodeNodeData, FrameScene, FrameType, SceneApp, TemplateType } from '../types'
import { hasCompiledAppSource, hasJavaScriptAppSource, isJavaScriptCatalogApp, sceneAppToAppConfig } from './sceneApps'

export interface CompatibilityResult {
  supported: boolean
  reason?: string
}

const supported: CompatibilityResult = { supported: true }

const embeddedUnavailableApps: Record<string, string> = {
  'data/chromiumScreenshot': 'Requires Playwright/Chromium and child processes.',
  'data/localImage': 'Requires local assets or mounted files, which ESP32 frames do not support yet.',
  'data/rstpSnapshot': 'Requires FFmpeg and child processes.',
}

const embeddedIgnoredSettings = new Set(['frameOS', 'homeAssistant', 'openAI', 'unsplash'])

function unsupported(reason: string): CompatibilityResult {
  return { supported: false, reason }
}

function isEmbeddedMode(mode?: FrameType['mode'] | null): boolean {
  return mode === 'embedded'
}

function configFromSources(sources?: Record<string, string> | null): Partial<AppConfig> | null {
  const config = sources?.['config.json']
  if (!config) {
    return null
  }
  try {
    const parsed = JSON.parse(config)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function appCompatibilityForFrame(
  mode: FrameType['mode'] | undefined | null,
  keyword: string,
  app?: Partial<AppConfig> | null,
  sources?: Record<string, string> | null
): CompatibilityResult {
  if (!isEmbeddedMode(mode)) {
    return supported
  }

  if (embeddedUnavailableApps[keyword]) {
    return unsupported(embeddedUnavailableApps[keyword])
  }

  if (app?.category === 'legacy') {
    return unsupported('Legacy apps are not available in the ESP32 runtime.')
  }

  if (sources && hasCompiledAppSource(sources) && !hasJavaScriptAppSource(sources)) {
    return unsupported(
      'Custom Nim scene apps must be compiled into firmware; ESP32 supports built-in apps and JavaScript scene apps here.'
    )
  }

  if (app?.apt?.length) {
    return unsupported('Requires Linux packages, which are not available in ESP32 firmware.')
  }

  const unsupportedSettings = app?.settings?.filter((setting) => !embeddedIgnoredSettings.has(setting)) ?? []
  if (unsupportedSettings.length > 0) {
    return unsupported('Requires global service settings that are not available in ESP32 firmware.')
  }

  return supported
}

function appFromSceneSources(keyword: string, sources?: Record<string, string> | null): Partial<AppConfig> | null {
  const sourceConfig = configFromSources(sources)
  if (!sourceConfig) {
    return null
  }
  return {
    name: sourceConfig.name || keyword,
    category: sourceConfig.category,
    description: sourceConfig.description,
    version: sourceConfig.version,
    settings: sourceConfig.settings,
    apt: sourceConfig.apt,
    fields: sourceConfig.fields,
    output: sourceConfig.output,
    cache: sourceConfig.cache,
    origin: sourceConfig.origin,
  }
}

function sceneAppForKeyword(scene: FrameScene, keyword: string): SceneApp | null {
  const sceneApp = scene.apps?.[keyword]
  return sceneApp ?? null
}

export function templateCompatibilityForFrame(
  mode: FrameType['mode'] | undefined | null,
  template: TemplateType,
  apps: Record<string, AppConfig>
): CompatibilityResult {
  if (!isEmbeddedMode(mode)) {
    return supported
  }

  const scenes = Array.isArray(template.scenes) ? template.scenes : []
  if (scenes.length === 0) {
    return supported
  }

  for (const scene of scenes) {
    for (const node of scene.nodes ?? []) {
      if (node.type === 'source') {
        return unsupported(`"${scene.name || 'Untitled scene'}" uses a source node, which ESP32 cannot interpret yet.`)
      }

      if (node.type === 'code') {
        const codeData = node.data as CodeNodeData | undefined
        if (codeData?.code?.trim() && !codeData?.codeJS?.trim()) {
          return unsupported(`"${scene.name || 'Untitled scene'}" uses Nim inline code, which ESP32 cannot interpret.`)
        }
      }

      if (node.type !== 'app') {
        continue
      }

      const nodeData = node.data as AppNodeData | undefined
      const keyword = nodeData?.keyword
      if (!keyword) {
        continue
      }

      const nodeSources = nodeData?.sources
      const sceneApp = sceneAppForKeyword(scene, keyword)
      const sceneAppConfig = sceneApp ? sceneAppToAppConfig(sceneApp) : null
      const app = appFromSceneSources(keyword, nodeSources) ?? sceneAppConfig ?? apps[keyword]
      const sources = nodeSources ?? sceneApp?.sources

      if (!app && !isJavaScriptCatalogApp(keyword)) {
        return unsupported(`"${scene.name || 'Untitled scene'}" uses unknown app "${keyword}".`)
      }

      const compatibility = appCompatibilityForFrame(mode, keyword, app, sources)
      if (!compatibility.supported) {
        const appName = app?.name || keyword
        return unsupported(`"${scene.name || 'Untitled scene'}" uses ${appName}: ${compatibility.reason}`)
      }
    }
  }

  return supported
}
