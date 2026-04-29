import type { AppConfig, AppConfigField, AppConfigFieldType, MarkdownField } from '../types'

const fieldTypeToTsType: Record<AppConfigFieldType, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string',
  date: 'string',
  json: 'any',
  node: 'number',
  scene: 'string',
  image: 'any',
  font: 'string',
  select: 'string',
}

function isAppConfigField(field: AppConfigField | MarkdownField): field is AppConfigField {
  return 'name' in field
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function literalString(value: string): string {
  return JSON.stringify(value)
}

function fieldTsType(field: AppConfigField): string {
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
    return field.options.map((option) => literalString(String(option))).join(' | ')
  }
  return fieldTypeToTsType[field.type] ?? 'any'
}

function optionalMarker(field: AppConfigField): string {
  return field.required || field.value !== undefined ? '' : '?'
}

export function buildAppTypeDeclarations(config: Partial<AppConfig> | null | undefined): string {
  const fieldNames = new Set<string>()
  const fields = (config?.fields ?? []).filter(isAppConfigField).filter((field) => {
    if (fieldNames.has(field.name)) {
      return false
    }
    fieldNames.add(field.name)
    return true
  })
  const configFields =
    fields.length > 0
      ? fields
          .map((field) => `  ${propertyName(field.name)}${optionalMarker(field)}: ${fieldTsType(field)};`)
          .join('\n')
      : '  [key: string]: any;'

  return `type FrameOSJson = null | boolean | number | string | FrameOSJson[] | { [key: string]: FrameOSJson };

interface FrameOSAppConfig {
${configFields}
}

interface FrameOSImageSpec {
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  svg?: string;
  dataUrl?: string;
  base64?: string;
  [key: string]: any;
}

interface FrameOSImageRef {
  __frameosType: "imageRef";
  id: number;
  width: number;
  height: number;
}

interface FrameOSNodeRef {
  __frameosType: "node";
  nodeId: number;
}

interface FrameOSSceneRef {
  __frameosType: "scene";
  sceneId: string;
}

interface FrameOSColorRef {
  __frameosType: "color";
  color: string;
}

interface FrameOSApp {
  nodeId: number;
  nodeName: string;
  category: string;
  config: FrameOSAppConfig;
  state: Record<string, any>;
  frame: {
    width: number;
    height: number;
    rotate: number;
    assetsPath: string;
    timeZone: string;
  };
  initialized?: boolean;
  log(...args: any[]): void;
  logError(...args: any[]): void;
  [key: string]: any;
}

interface FrameOSContext {
  event: string;
  hasImage: boolean;
  payload: any;
  loopIndex: number;
  loopKey: string;
  nextSleep: number;
  image?: FrameOSImageRef;
  imageWidth?: number;
  imageHeight?: number;
  [key: string]: any;
}

declare const frameos: {
  image(spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image" };
  svg(svg: string, spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image"; svg: string };
  node(nodeId: number): FrameOSNodeRef;
  scene(sceneId: string): FrameOSSceneRef;
  color(color: string): FrameOSColorRef;
  log(...args: any[]): void;
  error(...args: any[]): void;
  setNextSleep(seconds: number): void;
};
`
}
