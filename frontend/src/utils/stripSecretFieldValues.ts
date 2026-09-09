import type { AppConfig, AppNodeData, DiagramNode, FrameScene } from '../types'
import { mergeSceneAndCatalogApps } from './sceneApps'

/**
 * Field values marked `secret: true` (an API key typed into a custom app's
 * config) are hidden behind RevealDots in the node UI, but every export path
 * — copy to clipboard, "Copy scene JSON", template export and store publish —
 * used to carry them in plain text. Neither the cloud nor the backend strips
 * them server-side, so a user who marks a key secret gets one in the zip they
 * publish. Strip them wherever a scene or node leaves the editor.
 */
function secretFieldNames(app: AppConfig | undefined, node: DiagramNode): Set<string> {
  const names = new Set<string>()
  for (const field of app?.fields ?? []) {
    if ('name' in field && field.secret && typeof field.name === 'string') {
      names.add(field.name)
    }
  }
  // A `source` node carries its own config.json; the catalog may not know it.
  if (node.type === 'source') {
    const configJson = (node.data as AppNodeData | undefined)?.sources?.['config.json']
    if (typeof configJson === 'string') {
      try {
        const parsed = JSON.parse(configJson) as AppConfig
        for (const field of parsed.fields ?? []) {
          if ('name' in field && field.secret && typeof field.name === 'string') {
            names.add(field.name)
          }
        }
      } catch {
        // Not valid JSON: nothing to learn from it.
      }
    }
  }
  return names
}

/** The node with every secret config value removed. Non-app nodes pass through untouched. */
export function stripSecretNodeConfig(node: DiagramNode, apps: Record<string, AppConfig>): DiagramNode {
  if (node.type !== 'app' && node.type !== 'source') {
    return node
  }
  const data = node.data as AppNodeData | undefined
  const config = data?.config
  if (!config || typeof config !== 'object') {
    return node
  }
  const keyword = typeof data?.keyword === 'string' ? data.keyword : ''
  const secrets = secretFieldNames(apps[keyword], node)
  if (secrets.size === 0) {
    return node
  }
  const nextConfig: Record<string, any> = {}
  let changed = false
  for (const [key, value] of Object.entries(config)) {
    if (secrets.has(key)) {
      changed = true
      continue
    }
    nextConfig[key] = value
  }
  return changed ? { ...node, data: { ...data, config: nextConfig } as AppNodeData } : node
}

/** The scene with every secret app-config value removed from its nodes. */
export function stripSecretFieldValues(scene: FrameScene, catalog: Record<string, AppConfig>): FrameScene {
  const apps = mergeSceneAndCatalogApps(catalog, scene)
  const nodes = (scene.nodes ?? []).map((node) => stripSecretNodeConfig(node, apps))
  return nodes.some((node, index) => node !== scene.nodes[index]) ? { ...scene, nodes } : scene
}
