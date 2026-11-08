// What can be a layout (docs/scene-layouts.md). No imports at all: the cloud's
// store and the frame hub, which compiles it, read this too.

export type SceneLayoutProblem = 'render' | 'app' | 'yield'

/**
 * What stops this scene being a layout, null when nothing does: a layout's
 * render is one JSX app, drawn to the frame, with a `<yield />`. That shape is
 * what lets the runtime draw around the scene it wraps (docs/scene-layouts.md).
 * docs/scene-layout-fixtures.json pins this and the backend's copy
 * (app/utils/scene_layouts.py).
 */
export function sceneLayoutProblem(scene: unknown): SceneLayoutProblem | null {
  const { nodes, edges, apps } = (scene ?? {}) as { nodes?: any[]; edges?: any[]; apps?: Record<string, any> }
  const allNodes = Array.isArray(nodes) ? nodes : []
  const allEdges = Array.isArray(edges) ? edges : []
  const flowFrom = (id: unknown): any[] =>
    allEdges.filter((edge) => edge?.source === id && edge?.sourceHandle === 'next')
  const renders = allNodes.filter((node) => node?.type === 'event' && node?.data?.keyword === 'render')
  if (renders.length !== 1) {
    return 'render'
  }
  const flow = flowFrom(renders[0].id)
  const draw = flow.length === 1 ? allNodes.find((node) => node?.id === flow[0].target) : undefined
  if (draw?.type !== 'app' || draw?.data?.keyword !== 'render/image' || flowFrom(draw.id).length > 0) {
    return 'render'
  }
  const feed = allEdges.find((edge) => edge?.target === draw.id && edge?.targetHandle === 'fieldInput/image')
  const app = feed ? allNodes.find((node) => node?.id === feed.source) : undefined
  if (app?.type !== 'app') {
    return 'app'
  }
  const sources: Record<string, unknown> = app.data?.sources ?? apps?.[app.data?.keyword]?.sources ?? {}
  const jsx = Object.entries(sources).filter(([name, source]) => /\.[jt]sx$/.test(name) && typeof source === 'string')
  if (jsx.length === 0) {
    return 'app'
  }
  return jsx.some(([, source]) => /<\s*[Yy]ield\b/.test(source as string)) ? null : 'yield'
}

const SCENE_LAYOUT_PROBLEM_TEXT: Record<SceneLayoutProblem, string> = {
  render: 'A layout draws one JSX app to the frame and nothing else.',
  app: 'A layout has to be a JSX app (an app.tsx).',
  yield: 'A layout needs a <yield /> where the scene it wraps goes.',
}

/** sceneLayoutProblem in words, for whoever is trying to make this scene a layout. */
export function sceneLayoutProblemText(scene: unknown): string | null {
  const problem = sceneLayoutProblem(scene)
  return problem ? SCENE_LAYOUT_PROBLEM_TEXT[problem] : null
}

/** Whether this scene is marked as a layout and cannot be one. */
export function isBrokenLayout(scene: unknown): boolean {
  const settings = (scene as { settings?: { isLayout?: unknown } } | null | undefined)?.settings
  return settings?.isLayout === true && sceneLayoutProblem(scene) !== null
}
