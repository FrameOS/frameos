// frontend/src/utils/canRunInInterpreter.ts
import type { FrameScene, DiagramEdge, DiagramNode, NodeType } from '../types'

type CheckResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  details: {
    unsupportedNodes: string[]
    unsupportedEdges: string[]
    unknownApps: string[]
    dataAppsInRunChain: string[]
    cacheFeaturesUnsupported: string[]
  }
}

/** Mirror apps registered in frameos/src/apps/apps.nim */
const SUPPORTED_APPS_BY_CATEGORY: Record<'data' | 'logic' | 'render', ReadonlySet<string>> = {
  data: new Set([
    'data/beRecycle',
    'data/browserSnapshot',
    'data/clock',
    'data/downloadImage',
    'data/downloadUrl',
    'data/eventsToAgenda',
    'data/frameOSGallery',
    'data/haSensor',
    'data/icalJson',
    'data/localImage',
    'data/log',
    'data/newImage',
    'data/openaiImage',
    'data/openaiText',
    'data/prettyJson',
    'data/qr',
    'data/resizeImage',
    'data/rotateImage',
    'data/rstpSnapshot',
    'data/unsplash',
  ]),
  logic: new Set(['logic/breakIfRendering', 'logic/ifElse', 'logic/nextSleepDuration', 'logic/setAsState']),
  render: new Set([
    'render/calendar',
    'render/color',
    'render/gradient',
    'render/image',
    'render/opacity',
    'render/split',
    'render/text',
  ]),
}
const ALL_SUPPORTED_APPS = new Set<string>([
  ...SUPPORTED_APPS_BY_CATEGORY.data,
  ...SUPPORTED_APPS_BY_CATEGORY.logic,
  ...SUPPORTED_APPS_BY_CATEGORY.render,
])

const ALLOWED_NODE_TYPES: ReadonlySet<NodeType> = new Set(['app', 'event', 'state', 'scene'])

const isNextPrev = (e: DiagramEdge) => String(e.sourceHandle) === 'next' && String(e.targetHandle) === 'prev'

const isFieldPathToPrev = (e: DiagramEdge) =>
  String(e.sourceHandle).startsWith('field/') && String(e.targetHandle) === 'prev'

const isFieldOutputToAppInput = (e: DiagramEdge) =>
  String(e.sourceHandle) === 'fieldOutput' && String(e.targetHandle).startsWith('fieldInput/')

const isStateOutputToAppInput = (e: DiagramEdge) =>
  String(e.sourceHandle) === 'stateOutput' && String(e.targetHandle).startsWith('fieldInput/')

function appCategory(keyword: string): 'data' | 'logic' | 'render' | 'unknown' {
  if (SUPPORTED_APPS_BY_CATEGORY.data.has(keyword)) return 'data'
  if (SUPPORTED_APPS_BY_CATEGORY.logic.has(keyword)) return 'logic'
  if (SUPPORTED_APPS_BY_CATEGORY.render.has(keyword)) return 'render'
  return 'unknown'
}

export function canRunInInterpreter(scene: FrameScene): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  const unsupportedNodes: string[] = []
  const unsupportedEdges: string[] = []
  const unknownApps: string[] = []
  const dataAppsInRunChain: string[] = []
  const cacheFeaturesUnsupported: string[] = []

  const nodeById = new Map<string, DiagramNode>()
  for (const n of scene.nodes) nodeById.set(String(n.id), n)

  // 1) Node types (dispatch/source/code still not implemented)
  for (const n of scene.nodes) {
    if (!ALLOWED_NODE_TYPES.has(n.type as NodeType)) {
      unsupportedNodes.push(String(n.id))
    }
  }
  if (unsupportedNodes.length) {
    errors.push(
      `Unsupported node types for interpreted scenes (allowed: app, event, state, scene): ${unsupportedNodes.join(
        ', '
      )}.`
    )
  }

  // 2) App availability
  for (const n of scene.nodes) {
    if (n.type === 'app') {
      const keyword = (n.data as any)?.keyword
      if (!keyword || !ALL_SUPPORTED_APPS.has(keyword)) {
        unknownApps.push(`${String(n.id)}:${keyword ?? '(missing)'}`)
      }
    } else if (n.type === 'code') {
      const code = (n.data as any)?.code
      const codeJS = (n.data as any)?.codeJS
      if (code && !codeJS) {
        errors.push(`Code node ${String(n.id)} has Nim code but no JS code`)
      }
    }
  }
  if (unknownApps.length) {
    errors.push(`Unknown/uncompiled apps: ${unknownApps.join(', ')}.`)
  }

  // 3) Edges — mirror interpreter’s pass-2 allowances
  for (const e of scene.edges) {
    const sh = String(e.sourceHandle)
    const th = String(e.targetHandle)
    const edgeType = String((e as any).type)
    const src = nodeById.get(String(e.source))
    // Allowed wiring
    if (isNextPrev(e) || isFieldPathToPrev(e)) continue

    if (isFieldOutputToAppInput(e)) {
      // interpreter accepts app OR state sources here
      if (!src) {
        warnings.push(`Edge ${e.id}: source node ${String(e.source)} missing.`)
      } else if (src.type !== 'app' && src.type !== 'state') {
        unsupportedEdges.push(String(e.id))
        errors.push(`Edge ${e.id}: 'fieldOutput→fieldInput' must originate from app or state; found ${src.type}.`)
      }
      continue
    }

    if (isStateOutputToAppInput(e)) {
      if (!src) {
        warnings.push(`Edge ${e.id}: source node ${String(e.source)} missing.`)
      } else if (src.type !== 'state') {
        unsupportedEdges.push(String(e.id))
        errors.push(`Edge ${e.id}: 'stateOutput→fieldInput' requires a state node source; found ${src.type}.`)
      }
      continue
    }

    // // Explicitly reject code-field handle patterns (not implemented)
    // const looksLikeCodeField = sh.startsWith('codeField/') || th.startsWith('codeField/')
    // if (looksLikeCodeField) {
    //   unsupportedEdges.push(String(e.id))
    //   errors.push(`Edge ${e.id}: codeField handles are not supported in interpreter (${sh}→${th}).`)
    //   continue
    // }
    // TOOD: track

    // // Any other codeNodeEdge that didn’t match allowed patterns above is unsupported
    // if (edgeType === 'codeNodeEdge') {
    //   unsupportedEdges.push(String(e.id))
    //   errors.push(`Edge ${e.id}: codeNodeEdge pattern not supported in interpreter (${sh}→${th}).`)
    //   continue
    // }

    // Unknown pattern
    unsupportedEdges.push(String(e.id))
    errors.push(`Edge ${e.id}: unsupported connection (${sh}→${th}, type=${edgeType}).`)
  }

  // 4) Data apps cannot be on a run chain (next→prev)
  const runTargets = new Set(scene.edges.filter(isNextPrev).map((e) => String(e.target)))
  for (const id of runTargets) {
    const n = nodeById.get(id)
    if (n?.type === 'app') {
      const cat = appCategory((n.data as any)?.keyword || '')
      if (cat === 'data') dataAppsInRunChain.push(id)
    }
  }
  if (dataAppsInRunChain.length) {
    errors.push(`Data apps cannot be chained via next→prev: ${dataAppsInRunChain.join(', ')}.`)
  }

  // 5) Cache features — 'expression*' only flagged if enabled
  for (const n of scene.nodes) {
    const cache = (n.data as any)?.cache
    if (cache && cache.expressionEnabled) {
      cacheFeaturesUnsupported.push(String(n.id))
    }
  }
  if (cacheFeaturesUnsupported.length) {
    errors.push(
      `Cache 'expression*' options are not supported by the interpreter (supported: enabled, inputEnabled, durationEnabled, duration). Nodes: ${cacheFeaturesUnsupported.join(
        ', '
      )}.`
    )
  }

  console.log({ errors })

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: {
      unsupportedNodes,
      unsupportedEdges,
      unknownApps,
      dataAppsInRunChain,
      cacheFeaturesUnsupported,
    },
  }
}
