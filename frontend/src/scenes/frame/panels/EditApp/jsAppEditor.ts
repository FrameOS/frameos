import baseConfigSchema from '../../../../../schema/config_json.json'
import type { AppConfig, AppConfigField, MarkdownField, OutputField } from '../../../../types'

const GENERATED_TYPES_START = '// <frameos:generated-types>'
const GENERATED_TYPES_END = '// </frameos:generated-types>'

const fieldTypeToTsType: Record<string, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string',
  date: 'string',
  json: 'Record<string, any>',
  node: 'number',
  scene: 'string',
  image: 'FrameOSImageRef | null',
  font: 'string',
}

const outputTypeToTsType: Record<string, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string | FrameOSColorValue',
  date: 'string',
  json: 'Record<string, any> | any[]',
  node: 'number | FrameOSNodeValue',
  scene: 'string | FrameOSSceneValue',
  image: 'string | FrameOSImageValue | FrameOSImageRef',
  font: 'string',
}

export const KNOWN_GLOBAL_SETTING_KEYS = [
  'buildHost',
  'defaults',
  'frameOS',
  'github',
  'homeAssistant',
  'openAI',
  'posthog',
  'repositories',
  'ssh_keys',
  'unsplash',
]

function sanitizeComment(value: string): string {
  return value.replaceAll('*/', '* /').trim()
}

function isConfigField(field: AppConfigField | MarkdownField): field is AppConfigField {
  return !!field && typeof field === 'object' && 'name' in field && 'type' in field
}

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name)
}

function quoteTsProperty(name: string): string {
  return isValidIdentifier(name) ? name : JSON.stringify(name)
}

function fieldToTsType(field: Pick<AppConfigField, 'type' | 'options'>): string {
  if (field.type === 'select' && field.options?.length) {
    return field.options.map((option) => JSON.stringify(option)).join(' | ')
  }
  return fieldTypeToTsType[field.type] ?? 'any'
}

function outputFieldToTsType(field: Pick<OutputField, 'type'>): string {
  return outputTypeToTsType[field.type] ?? 'any'
}

function buildInterfaceBody(
  entries: { name: string; type: string; optional?: boolean; comment?: string }[],
  fallback = '[key: string]: any'
): string {
  if (!entries.length) {
    return `  ${fallback}\n`
  }

  return entries
    .map(({ name, type, optional, comment }) => {
      const lines = []
      if (comment) {
        lines.push(`  /** ${sanitizeComment(comment)} */`)
      }
      lines.push(`  ${quoteTsProperty(name)}${optional ? '?' : ''}: ${type}`)
      return lines.join('\n')
    })
    .join('\n')
    .concat('\n')
}

function buildConfigInterface(config: AppConfig | null): string {
  const fields = (config?.fields ?? []).filter(isConfigField)
  const entries = fields.map((field) => ({
    name: field.name,
    type: fieldToTsType(field),
    optional: !field.required,
    comment: field.label,
  }))
  return `interface Config {\n${buildInterfaceBody(entries)}}`
}

function buildOutputType(config: AppConfig | null): string {
  const firstOutput = config?.output?.[0]
  if (!firstOutput) {
    return 'type Output = any'
  }
  const comment = firstOutput.example
    ? `/** ${sanitizeComment(`${firstOutput.type} output. Example: ${firstOutput.example}`)} */\n`
    : `/** ${sanitizeComment(`${firstOutput.type} output`)} */\n`
  return `${comment}type Output = ${outputFieldToTsType(firstOutput)}`
}

function buildAppInterface(): string {
  return 'interface App extends FrameOSApp<Config> {}'
}

function buildGeneratedTypesBlock(config: AppConfig | null): string {
  return [
    GENERATED_TYPES_START,
    '// Generated from config.json. Edit config.json to update these types.',
    buildConfigInterface(config),
    '',
    buildOutputType(config),
    '',
    buildAppInterface(),
    GENERATED_TYPES_END,
  ].join('\n')
}

function replaceOrInsertGeneratedTypes(source: string, block: string): string {
  const trimmedSource = source.trimStart()
  const generatedPattern = new RegExp(
    `${GENERATED_TYPES_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${GENERATED_TYPES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  )

  if (generatedPattern.test(source)) {
    return source.replace(generatedPattern, block)
  }

  if (!trimmedSource.length) {
    return `${block}\n`
  }

  return `${block}\n\n${source}`
}

function annotateTsEntryPointParameters(source: string): string {
  return source.replace(/export function (init|get|run)\s*\(([^)]*)\)/g, (match, _name, paramsSource) => {
    const params = paramsSource
      .split(',')
      .map((param: string) => param.trim())
      .filter(Boolean)

    if (
      params.length > 2 ||
      params.some((param: string) => param.includes('=') || param.includes('{') || param.includes('[') || param.startsWith('...'))
    ) {
      return match
    }

    const normalizedParams = params.map((param: string, index: number) => {
      const typedParam = param.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*(.+))?$/)

      if (!typedParam) {
        return null
      }

      const [, paramName, typeAnnotation] = typedParam

      if (index === 0) {
        if (!typeAnnotation || typeAnnotation === 'App' || typeAnnotation === 'FrameOSApp' || typeAnnotation === 'FrameOSApp<Config>') {
          return `${paramName}: App`
        }
        return `${paramName}: ${typeAnnotation}`
      }

      if (index === 1) {
        if (!typeAnnotation || typeAnnotation === 'Context' || typeAnnotation === 'FrameOSContext') {
          return `${paramName}: FrameOSContext`
        }
        return `${paramName}: ${typeAnnotation}`
      }

      return param
    })

    if (normalizedParams.some((param: string | null) => param === null)) {
      return match
    }

    return match.replace(paramsSource, normalizedParams.join(', '))
  })
}

function syncGetReturnType(source: string): string {
  return source.replace(/export function get\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g, (_match, paramsSource) => {
    return `export function get(${paramsSource}): Output {`
  })
}

export function parseAppConfigSource(source: string): AppConfig | null {
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === 'object' ? (parsed as AppConfig) : null
  } catch {
    return null
  }
}

export function buildGlobalSettingKeys(keys: string[] = []): string[] {
  return [...new Set([...KNOWN_GLOBAL_SETTING_KEYS, ...keys.filter((key) => typeof key === 'string')])].sort()
}

export function buildJsAppConfigJsonSchema(globalSettingKeys: string[]): Record<string, any> {
  const schema = JSON.parse(JSON.stringify(baseConfigSchema))
  const settingsItems = schema?.definitions?.AppConfig?.properties?.settings?.items

  if (settingsItems && globalSettingKeys.length > 0) {
    settingsItems.enum = globalSettingKeys
  }

  if (schema?.definitions?.AppConfig?.properties?.settings) {
    schema.definitions.AppConfig.properties.settings.uniqueItems = true
  }

  return schema
}

export function syncGeneratedTypesToAppTs(source: string, config: AppConfig | null): string {
  return syncGetReturnType(annotateTsEntryPointParameters(replaceOrInsertGeneratedTypes(source, buildGeneratedTypesBlock(config))))
}

export function convertJsSourceToTypeScript(source: string, config: AppConfig | null): string {
  return syncGeneratedTypesToAppTs(annotateTsEntryPointParameters(source), config)
}

export function buildJsAppEditorDeclarations(config: AppConfig | null, globalSettingKeys: string[]): string {
  const globalSettingsType = globalSettingKeys.length
    ? globalSettingKeys.map((key) => JSON.stringify(key)).join(' | ')
    : 'string'

  return `
interface FrameOSImageValue {
  __frameosType: 'image'
  width?: number
  height?: number
  color?: string
  opacity?: number
  svg?: string
  dataUrl?: string
  base64?: string
}

interface FrameOSImageRef {
  __frameosType: 'imageRef'
  id: number
  width: number
  height: number
}

interface FrameOSNodeValue {
  __frameosType: 'node'
  nodeId: number
}

interface FrameOSSceneValue {
  __frameosType: 'scene'
  sceneId: string
}

interface FrameOSColorValue {
  __frameosType: 'color'
  color: string
}

interface FrameOSAssetEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  mtime: number
}

interface FrameOSAssetsApi {
  readText(path: string): string
  writeText(path: string, content: string): FrameOSAssetEntry
  readDataUrl(path: string): string
  writeDataUrl(path: string, dataUrl: string): FrameOSAssetEntry
  list(path?: string): FrameOSAssetEntry[]
  stat(path?: string): FrameOSAssetEntry
  exists(path?: string): boolean
  mkdir(path: string): FrameOSAssetEntry
  rename(fromPath: string, toPath: string): FrameOSAssetEntry
  delete(path: string): boolean
}

interface FrameOSApi {
  image(spec?: Partial<FrameOSImageValue>): FrameOSImageValue
  svg(svg: string, spec?: Partial<FrameOSImageValue>): FrameOSImageValue
  node(nodeId: number): FrameOSNodeValue
  scene(sceneId: string): FrameOSSceneValue
  color(color: string): FrameOSColorValue
  log(...args: any[]): void
  error(...args: any[]): void
  setNextSleep(seconds: number): void
  assets: FrameOSAssetsApi
}

interface FrameOSAppFrame {
  width: number
  height: number
  rotate: number
  assetsPath: string
  timeZone: string
}

type FrameOSGlobalSettingKey = ${globalSettingsType}

interface FrameOSApp<TConfig = Record<string, any>> {
  nodeId: number
  nodeName: string
  category: string
  config: TConfig
  state: Record<string, any>
  frame: FrameOSAppFrame
  log(...args: any[]): void
  logError(...args: any[]): void
  [key: string]: any
}

interface FrameOSContext<TPayload = any> {
  event: string
  hasImage: boolean
  payload: TPayload | null
  loopIndex: number
  loopKey: string
  nextSleep: number
  image?: FrameOSImageRef
  imageWidth?: number
  imageHeight?: number
}

declare const frameos: FrameOSApi

${buildConfigInterface(config)}

${buildOutputType(config)}

${buildAppInterface()}
`.trim()
}
