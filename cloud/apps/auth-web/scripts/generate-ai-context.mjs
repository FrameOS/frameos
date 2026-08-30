#!/usr/bin/env node
// Bundle the knowledge the cloud AI chat's tools serve at runtime:
//
//   - app catalog: every builtin app's config.json (frameos/src/apps — the
//     configs only, never the app.nim sources: the cloud chat is deliberately
//     Nim-free) plus the repo JS/TS apps (repo/apps/code) WITH their sources,
//   - scene event keywords (frontend/schema/events.json),
//   - the QuickJS ambient type declarations JS code nodes / JS apps see,
//   - example scenes: every repo/scenes template, condensed for search plus
//     the full scenes.json for retrieval,
//   - docs: repo docs/*.md and cloud/docs/*.md, split into sections.
//
// Output is src/generated/ai-context.json, imported by src/lib/ai/context.ts.
// The file is committed (like frontend/src/generated/*) so tests and dev
// servers work without a build step; this script re-syncs it and runs from
// predev/prebuild.
/* global console */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const authWebRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(authWebRoot, '..', '..', '..')
const outputPath = path.join(authWebRoot, 'src', 'generated', 'ai-context.json')

const jsSourceFiles = ['app.ts', 'app.tsx', 'app.js', 'app.jsx']

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

// --- builtin apps (configs only, no Nim sources) ---
async function collectBuiltinApps() {
  const apps = {}
  const appsRoot = path.join(repoRoot, 'frameos', 'src', 'apps')
  for (const category of ['data', 'logic', 'render']) {
    const categoryDir = path.join(appsRoot, category)
    if (!(await pathExists(categoryDir))) {
      continue
    }
    const entries = await fs.readdir(categoryDir, { withFileTypes: true })
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const configPath = path.join(categoryDir, entry.name, 'config.json')
      if (!(await pathExists(configPath))) {
        continue
      }
      const config = await readJson(configPath)
      if (!config || typeof config !== 'object' || !config.name) {
        continue
      }
      const keyword = `${category}/${entry.name}`
      apps[keyword] = { ...config, keyword }
    }
  }
  return apps
}

// --- repo JS/TS apps (configs + sources; skip app.nim like generateRepoApps) ---
async function collectRepoApps() {
  const apps = {}
  const sourceRoot = path.join(repoRoot, 'repo', 'apps', 'code')
  if (!(await pathExists(sourceRoot))) {
    return apps
  }
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const appDir = path.join(sourceRoot, entry.name)
    const configPath = path.join(appDir, 'config.json')
    if (!(await pathExists(configPath))) {
      continue
    }
    const config = await readJson(configPath)
    if (!config || typeof config !== 'object' || !config.name) {
      continue
    }
    const keyword = `repo/apps/code/${entry.name}`
    const sources = {}
    const files = (await fs.readdir(appDir, { withFileTypes: true }))
      .filter((item) => item.isFile())
      .map((item) => item.name)
      .sort()
    const hasJsSource = files.some((file) => jsSourceFiles.includes(file))
    for (const file of files) {
      if (file === 'app_loader.nim' || file.endsWith('.nim')) {
        continue
      }
      if (!hasJsSource) {
        continue
      }
      sources[file] = await fs.readFile(path.join(appDir, file), 'utf8')
    }
    apps[keyword] = { ...config, keyword, origin: keyword, sources }
  }
  return apps
}

// --- example scenes ---
function condenseScene(scene) {
  const nodes = Array.isArray(scene?.nodes) ? scene.nodes : []
  const edges = Array.isArray(scene?.edges) ? scene.edges : []
  const appKeywords = [
    ...new Set(
      nodes
        .filter((node) => node?.type === 'app' && typeof node?.data?.keyword === 'string')
        .map((node) => node.data.keyword)
    ),
  ]
  return { nodeCount: nodes.length, edgeCount: edges.length, appKeywords }
}

async function collectExampleScenes() {
  const examples = []
  const scenesRoot = path.join(repoRoot, 'repo', 'scenes')
  for (const group of ['samples', 'gallery']) {
    const groupDir = path.join(scenesRoot, group)
    if (!(await pathExists(groupDir))) {
      continue
    }
    const entries = await fs.readdir(groupDir, { withFileTypes: true })
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const templatePath = path.join(groupDir, entry.name, 'template.json')
      const scenesPath = path.join(groupDir, entry.name, 'scenes.json')
      if (!(await pathExists(templatePath)) || !(await pathExists(scenesPath))) {
        continue
      }
      const template = await readJson(templatePath)
      const scenes = await readJson(scenesPath)
      if (!Array.isArray(scenes) || scenes.length === 0) {
        continue
      }
      examples.push({
        name: template.name ?? entry.name,
        slug: `${group}/${entry.name}`,
        description: template.description ?? '',
        summary: scenes.map(condenseScene),
        scenes,
      })
    }
  }
  return examples
}

// --- docs, split into sections on ## headings ---
function splitMarkdownSections(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let current = { heading: '(intro)', lines: [] }
  for (const line of lines) {
    const match = /^#{1,3}\s+(.*)$/.exec(line)
    if (match) {
      if (current.lines.join('').trim()) {
        sections.push({ heading: current.heading, content: current.lines.join('\n').trim() })
      }
      current = { heading: match[1].trim(), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.lines.join('').trim()) {
    sections.push({ heading: current.heading, content: current.lines.join('\n').trim() })
  }
  return sections
}

async function collectDocs() {
  const docs = []
  const sets = [
    { dir: path.join(repoRoot, 'docs'), prefix: 'docs' },
    { dir: path.join(repoRoot, 'cloud', 'docs'), prefix: 'cloud/docs' },
  ]
  for (const { dir, prefix } of sets) {
    if (!(await pathExists(dir))) {
      continue
    }
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
      // todo.md is a task list, not documentation.
      if (entry.name === 'todo.md') {
        continue
      }
      const markdown = await fs.readFile(path.join(dir, entry.name), 'utf8')
      docs.push({ path: `${prefix}/${entry.name}`, sections: splitMarkdownSections(markdown) })
    }
  }
  return docs
}

// The ambient declarations JS code nodes and JS apps run against. Mirrors
// frontend/src/utils/appTypeDeclarations.ts (buildAppTypeDeclarations with a
// generic config) — kept as text here because this script cannot import TS.
const jsTypeDeclarations = `type FrameOSJson = null | boolean | number | string | FrameOSJson[] | { [key: string]: FrameOSJson };

interface FrameOSAppConfig {
  [key: string]: any;
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

interface FrameOSImageRef { __frameosType: "imageRef"; id: number; width: number; height: number; }
interface FrameOSNodeRef { __frameosType: "node"; nodeId: number; }
interface FrameOSSceneRef { __frameosType: "scene"; sceneId: string; }
interface FrameOSColorRef { __frameosType: "color"; color: string; }
interface FrameOSStreamRef { __frameosType: "streamRef"; id: number; }

interface FrameOSApp {
  nodeId: number;
  nodeName: string;
  category: string;
  config: FrameOSAppConfig;
  state: Record<string, any>;
  frame: { width: number; height: number; rotate: number; assetsPath: string; timeZone: string; };
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
  fetchText(url: string): string;
  fetchJson(url: string): any;
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      base64?: boolean;
      timeoutMs?: number;
    }
  ): { status: number; body?: string; bodyBase64?: string; error?: string };
  listAssets(dir?: string): string[];
  assetExists(path: string): boolean;
  assetSize(path: string): number;
  readAsset(path: string, options?: { offset?: number; length?: number }): string | null;
  writeAsset(path: string, base64: string): boolean;
  appendAsset(path: string, base64: string): boolean;
  deleteAsset(path: string): boolean;
  loadAssetImage(path: string): FrameOSImageRef | null;
  openAssetStream(path: string, mode?: "r" | "w" | "a"): FrameOSStreamRef | null;
  createStream(base64: string): FrameOSStreamRef | null;
  streamRead(stream: FrameOSStreamRef | number, length: number): string | null;
  streamWrite(stream: FrameOSStreamRef | number, base64: string): boolean;
  streamAtEnd(stream: FrameOSStreamRef | number): boolean;
  streamRewind(stream: FrameOSStreamRef | number): boolean;
  streamClose(stream: FrameOSStreamRef | number): boolean;
  getSetting(...path: string[]): any;
  setState(key: string, value: FrameOSJson): void;
};
`

const builtinApps = await collectBuiltinApps()
const repoApps = await collectRepoApps()
const examples = await collectExampleScenes()
const docs = await collectDocs()
const events = await readJson(path.join(repoRoot, 'frontend', 'schema', 'events.json'))

const context = {
  generatedFrom: 'scripts/generate-ai-context.mjs',
  apps: { ...builtinApps, ...repoApps },
  events,
  jsTypeDeclarations,
  examples,
  docs,
}

await fs.mkdir(path.dirname(outputPath), { recursive: true })
await fs.writeFile(outputPath, JSON.stringify(context, null, 1))
const stat = await fs.stat(outputPath)
console.log(
  `ai-context.json: ${Object.keys(context.apps).length} apps, ${examples.length} example scenes, ` +
    `${docs.length} docs, ${(stat.size / 1024).toFixed(0)} KB`
)
