import { AppConfig, AppNodeData, DiagramNode, FrameScene } from '../../../types'

export const CUSTOM_APP_KEYWORD_PREFIX = '@custom/'

export interface SceneCustomApp {
  id: string
  nodeId: string
  keyword: string
  name: string
  description?: string
  config: AppConfig | null
  sources: Record<string, string>
}

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(16)
}

function normalizeSources(sources: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sources)
      .filter(([, source]) => typeof source === 'string')
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function parseCustomAppConfig(sources: Record<string, string>): AppConfig | null {
  const configJson = sources['config.json']
  if (!configJson) {
    return null
  }
  try {
    const parsed = JSON.parse(configJson)
    return parsed && typeof parsed === 'object' ? (parsed as AppConfig) : null
  } catch {
    return null
  }
}

function customAppSignature(keyword: string, sources: Record<string, string>): string {
  return JSON.stringify([keyword, Object.entries(sources)])
}

function nodeToSceneCustomApp(node: DiagramNode): SceneCustomApp | null {
  if (node.type !== 'app') {
    return null
  }

  const data = (node.data ?? {}) as AppNodeData
  if (!data.sources || Object.keys(data.sources).length === 0) {
    return null
  }

  const sources = normalizeSources(data.sources)
  const config = parseCustomAppConfig(sources)
  const keyword = data.keyword || `app_${node.id}`
  const name = config?.name || data.name || keyword

  return {
    id: hashString(customAppSignature(keyword, sources)),
    nodeId: node.id,
    keyword,
    name,
    description: config?.description,
    config,
    sources,
  }
}

export function getSceneCustomApps(scene: FrameScene | null | undefined): Record<string, SceneCustomApp> {
  const customApps: Record<string, SceneCustomApp> = {}

  for (const node of scene?.nodes ?? []) {
    const customApp = nodeToSceneCustomApp(node)
    if (!customApp || customApps[customApp.id]) {
      continue
    }
    customApps[customApp.id] = customApp
  }

  return customApps
}

export function buildCustomAppKeyword(customAppId: string): string {
  return `${CUSTOM_APP_KEYWORD_PREFIX}${customAppId}`
}

export function getCustomAppId(keyword: string): string | null {
  return keyword.startsWith(CUSTOM_APP_KEYWORD_PREFIX) ? keyword.slice(CUSTOM_APP_KEYWORD_PREFIX.length) : null
}

export function isCustomAppKeyword(keyword: string): boolean {
  return getCustomAppId(keyword) !== null
}

export function buildCustomAppNodeData(customApp: SceneCustomApp): AppNodeData {
  const nodeData: AppNodeData = {
    keyword: customApp.keyword,
    config: {},
    sources: { ...customApp.sources },
  }

  if (customApp.config?.cache) {
    nodeData.cache = { ...customApp.config.cache }
  }

  return nodeData
}
