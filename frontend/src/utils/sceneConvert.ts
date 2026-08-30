import type { FrameId, FrameScene } from '../types'
import { apiFetch } from './apiFetch'
import { isCloudMode } from './cloudMode'

// The Nim → interpreted converter (docs/nim-to-js-conversion.md), called from
// the editor. Cloud mode talks to the cloud's own POST /api/scenes/convert;
// a self-hosted backend forwards through POST /api/frames/{id}/scenes/{sceneId}/convert
// (which adds the operator's OpenAI key when one is set). Either way the
// editor's unsaved copy of the scene is what gets converted, and the reply
// is applied in place — nothing is saved until the user saves.

export interface ConversionReportItem {
  kind: 'code' | 'app' | 'source' | 'arg' | 'edge'
  status: string
  nodeId?: string
  id?: string
  name?: string
  via?: string
  reason?: string
  from?: string
  to?: string
}

export interface ConversionReport {
  sceneId: string
  sceneName: string
  executionBefore: string
  executionAfter: 'compiled' | 'interpreted'
  items: ConversionReportItem[]
  needsModel: string[]
  needsManualPort: string[]
  modelCalls: number
  model?: string
}

export interface SceneConversionResult {
  ok: boolean
  scene?: FrameScene
  report?: ConversionReport
  error?: string
}

const errorMessages: Record<string, string> = {
  invalid_openai_key: 'The OpenAI key in Settings was not accepted by OpenAI.',
  invalid_scenes: 'The converter did not recognise this scene.',
  model_budget_exhausted:
    'The free AI pass on FrameOS Cloud is out of budget right now. Try again later, or set your own OpenAI key under Settings → OpenAI.',
  model_failed: 'The AI pass failed on the model side — try again in a moment.',
  rate_limited: 'Too many conversions right now — wait a minute and try again.',
  scenes_payload_too_large: 'The scene is too large for the converter (3 MB max).',
}

export async function requestSceneConversion(frameId: FrameId, scene: FrameScene): Promise<SceneConversionResult> {
  const path = isCloudMode() ? '/api/scenes/convert' : `/api/frames/${frameId}/scenes/${scene.id}/convert`
  let response: Response
  try {
    response = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the converter — check your connection.' }
  }
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    scene?: FrameScene
    reports?: ConversionReport[]
    error?: string
    hint?: string
    detail?: string
  }
  if (!response.ok) {
    const code = payload.error ?? String(response.status)
    return {
      ok: false,
      error: errorMessages[code] ?? `Conversion failed: ${code}${payload.hint ?? payload.detail ? ` — ${payload.hint ?? payload.detail}` : ''}`,
    }
  }
  const report = payload.reports?.[0]
  return { ok: Boolean(payload.ok), scene: payload.scene, report }
}

/** One line per thing the converter did, for the summary shown after a run. */
export function describeConversion(report: ConversionReport | undefined): string[] {
  if (!report) {
    return []
  }
  const lines: string[] = []
  const converted = report.items.filter((item) => item.status === 'converted')
  const codeNodes = converted.filter((item) => item.kind === 'code')
  const apps = converted.filter((item) => item.kind === 'app')
  if (codeNodes.length) {
    lines.push(`${codeNodes.length} code node${codeNodes.length === 1 ? '' : 's'} ported to JavaScript`)
  }
  for (const app of apps) {
    lines.push(`app "${app.name ?? app.id}" ported to a JavaScript app`)
  }
  const renamed = report.items.filter((item) => item.kind === 'arg')
  if (renamed.length) {
    lines.push(`${renamed.length} reserved argument name${renamed.length === 1 ? '' : 's'} renamed (${renamed.map((item) => `${item.from} → ${item.to}`).join(', ')})`)
  }
  const dropped = report.items.filter((item) => item.kind === 'edge' && item.status === 'dropped')
  if (dropped.length) {
    lines.push(`${dropped.length} stale edge${dropped.length === 1 ? '' : 's'} removed`)
  }
  for (const item of report.items) {
    if (item.status === 'needs_manual_port' || item.status === 'needs_model') {
      lines.push(`NOT converted — ${item.kind === 'app' ? `app "${item.name ?? item.id}"` : `${item.kind} node ${item.nodeId}`}: ${item.reason ?? item.status}`)
    }
  }
  if (report.modelCalls > 0) {
    lines.push(`${report.modelCalls} AI call${report.modelCalls === 1 ? '' : 's'}${report.model ? ` (${report.model})` : ''}`)
  }
  return lines
}
