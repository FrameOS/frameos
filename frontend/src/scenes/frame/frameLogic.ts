import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { AppNodeData, DiagramNode, FrameScene, FrameType, TemplateType } from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'
import { v4 as uuidv4 } from 'uuid'
import { duplicateScenes } from '../../utils/duplicateScenes'
import { apiFetch } from '../../utils/apiFetch'

export interface FrameLogicProps {
  frameId: number
}
const FRAME_KEYS: (keyof FrameType)[] = [
  'name',
  'frame_host',
  'frame_port',
  'frame_access_key',
  'frame_access',
  'ssh_user',
  'ssh_pass',
  'ssh_port',
  'server_host',
  'server_port',
  'server_api_key',
  'width',
  'height',
  'color',
  'device',
  'interval',
  'metrics_interval',
  'scaling_mode',
  'rotate',
  'background_color',
  'scenes',
  'debug',
  'log_to_file',
  'assets_path',
  'save_assets',
  'upload_fonts',
  'reboot',
  'control_code',
  'schedule',
]

const FRAME_KEYS_REQUIRE_RECOMPILE: (keyof FrameType)[] = [
  'device',
  'background_color',
  'scenes',
  'control_code',
  'reboot',
]

function cleanBackgroundColor(color: string): string {
  // convert the format "(r: 0, g: 0, b: 0)"
  if (color.startsWith('(r:')) {
    const [r, g, b] = color
      .replace(/[\(\)]/g, '')
      .split(',')
      .map((c) => parseInt(c.split(':')[1].trim(), 10))
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }
  if (color.match(/^#[a-fA-F0-9]{6}$/)) {
    return color
  }
  return '#000000'
}

const legacyAppMapping: Record<string, string> = {
  // image data apps. todo: make migration to get rid of them
  downloadImage: 'legacy/downloadImage',
  unsplash: 'legacy/unsplash',
  frameOSGallery: 'legacy/frameOSGallery',
  openai: 'legacy/openai',
  resize: 'legacy/resize',
  rotate: 'legacy/rotate',
  localImage: 'legacy/localImage',
  qr: 'legacy/qr',
  haSensor: 'legacy/haSensor',
  openaiText: 'legacy/openaiText',
  clock: 'legacy/clock',

  // render app
  color: 'render/color',
  gradient: 'render/gradient',
  text: 'render/text',
  renderImage: 'render/image',
  split: 'render/split',

  // logic app
  setAsState: 'logic/setAsState',
  breakIfRendering: 'logic/breakIfRendering',
  ifElse: 'logic/ifElse',
}

export function sanitizeNodes(nodes: DiagramNode[]): DiagramNode[] {
  let changed = false
  const newNodes = nodes.map((node) => {
    if (node.type === 'app' && legacyAppMapping[(node.data as AppNodeData).keyword]) {
      changed = true
      return {
        ...node,
        data: {
          ...node.data,
          keyword: legacyAppMapping[(node.data as AppNodeData).keyword],
        },
      } as DiagramNode
    }
    return node
  })
  return changed ? newNodes : nodes
}

export function sanitizeScene(scene: Partial<FrameScene>, frame: FrameType): FrameScene {
  const settings = scene.settings ?? {}
  return {
    ...scene,
    id: scene.id ?? uuidv4(),
    name: scene.name || 'Untitled scene',
    nodes: sanitizeNodes(scene.nodes ?? []),
    edges: scene.edges ?? [],
    fields: scene.fields ?? [],
    settings: {
      ...settings,
      refreshInterval: settings.refreshInterval || frame.interval || 300,
      backgroundColor: cleanBackgroundColor(settings.backgroundColor || '#000000'),
    },
  } satisfies FrameScene
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.frameId),
  connect({ values: [framesModel, ['frames']] }),
  actions({
    updateScene: (sceneId: string, scene: Partial<FrameScene>) => ({ sceneId, scene }),
    updateNodeData: (sceneId: string, nodeId: string, nodeData: Record<string, any>) => ({ sceneId, nodeId, nodeData }),
    saveFrame: true,
    renderFrame: true,
    restartFrame: true,
    stopFrame: true,
    deployFrame: true,
    applyTemplate: (template: Partial<TemplateType>, replaceScenes?: boolean) => ({
      template,
      replaceScenes: replaceScenes ?? false,
    }),
    closeScenePanels: (sceneIds: string[]) => ({ sceneIds }),
    sendEvent: (event: string, payload: Record<string, any>) => ({ event, payload }),
  }),
  forms(({ actions, values }) => ({
    frameForm: {
      options: {
        showErrorsOnTouch: true,
      },
      defaults: {} as FrameType,
      errors: (state: Partial<FrameType>) => ({
        scenes: (state.scenes ?? []).map((scene: Record<string, any>) => ({
          fields: (scene.fields ?? []).map((field: Record<string, any>) => ({
            name: field.name ? '' : 'Name is required',
            label: field.label ? '' : 'Label is required',
            type: field.type ? '' : 'Type is required',
          })),
        })),
      }),
      submit: async (frame, breakpoint) => {
        const json: Record<string, any> = {}
        for (const key of FRAME_KEYS) {
          json[key] = frame[key as keyof typeof frame]
        }
        if (values.nextAction) {
          json['next_action'] = values.nextAction
        }
        const response = await apiFetch(`/api/frames/${values.frameId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json),
        })
        if (!response.ok) {
          throw new Error('Failed to update frame')
        }
      },
    },
  })),
  reducers({
    nextAction: [
      null as 'render' | 'restart' | 'stop' | 'deploy' | null,
      {
        saveFrame: () => null,
        renderFrame: () => 'render',
        restartFrame: () => 'restart',
        stopFrame: () => 'stop',
        deployFrame: () => 'deploy',
      },
    ],
  }),
  selectors(() => ({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    frame: [(s) => [s.frames, s.frameId], (frames, frameId) => frames[frameId] || null],
    scenes: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): FrameScene[] => frameForm?.scenes ?? frame.scenes ?? [],
    ],
    unsavedChanges: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm) =>
        FRAME_KEYS.some((key) => !equal(frame?.[key as keyof FrameType], frameForm?.[key as keyof FrameType])),
    ],
    lastDeploy: [(s) => [s.frame], (frame) => frame?.last_successful_deploy ?? null],
    undeployedChanges: [
      (s) => [s.frame, s.lastDeploy],
      (frame, lastDeploy) =>
        FRAME_KEYS.some((key) => !equal(frame?.[key as keyof FrameType], lastDeploy?.[key as keyof FrameType])),
    ],
    requiresRecompilation: [
      (s) => [s.frame, s.lastDeploy],
      (frame, lastDeploy) =>
        !lastDeploy ||
        FRAME_KEYS_REQUIRE_RECOMPILE.some(
          (key) => !equal(lastDeploy?.[key as keyof FrameType], frame?.[key as keyof FrameType])
        ),
    ],
    defaultScene: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm) => {
        const allScenes = frameForm?.scenes ?? frame?.scenes ?? []
        return (allScenes.find((scene) => scene.id === 'default' || scene.default) || allScenes[0])?.id ?? null
      },
    ],
    width: [
      (s) => [s.frameForm],
      (frameForm) => (frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.height : frameForm.width),
    ],
    height: [
      (s) => [s.frameForm],
      (frameForm) => (frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.width : frameForm.height),
    ],
    defaultInterval: [(s) => [s.frameForm], (frameForm) => frameForm.interval ?? 300],
  })),
  subscriptions(({ actions }) => ({
    frame: (frame?: FrameType, oldFrame?: FrameType) => {
      if (frame && !oldFrame) {
        actions.resetFrameForm({ ...frame, scenes: frame.scenes?.map((scene) => sanitizeScene(scene, frame)) ?? [] })
      }
    },
  })),
  listeners(({ actions, values, props }) => ({
    saveFrame: () => actions.submitFrameForm(),
    renderFrame: () => framesModel.actions.renderFrame(props.frameId),
    restartFrame: () => framesModel.actions.restartFrame(props.frameId),
    stopFrame: () => framesModel.actions.stopFrame(props.frameId),
    deployFrame: () => framesModel.actions.deployFrame(props.frameId, !values.requiresRecompilation),
    updateScene: ({ sceneId, scene }) => {
      const { frameForm } = values
      const hasScene = frameForm.scenes?.some(({ id }) => id === sceneId)
      const scenes = hasScene
        ? frameForm.scenes?.map((s) => (s.id === sceneId ? sanitizeScene({ ...s, ...scene }, frameForm) : s))
        : [...(frameForm.scenes ?? []), sanitizeScene({ ...scene, id: sceneId }, frameForm)]
      actions.setFrameFormValues({ scenes })
    },
    updateNodeData: ({ sceneId, nodeId, nodeData }) => {
      const { frame, frameForm } = values
      const scenes = frameForm.scenes ?? frame.scenes
      const scene = scenes?.find(({ id }) => id === sceneId)
      const currentNode = scene?.nodes?.find(({ id }) => id === nodeId)
      if (currentNode) {
        actions.setFrameFormValues({
          scenes: scenes?.map((s) =>
            s.id === sceneId
              ? {
                  ...s,
                  nodes: s.nodes?.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...nodeData } } : n
                  ),
                }
              : s
          ),
        })
      } else {
        console.error(`Node ${nodeId} not found in scene ${sceneId}`)
      }
    },
    applyTemplate: ({ template, replaceScenes }) => {
      if ('scenes' in template) {
        const oldScenes = values.frameForm?.scenes || []
        const newScenes = duplicateScenes(
          (template.scenes ?? []).map((scene) => sanitizeScene(scene, values.frameForm))
        )
        if (newScenes.length === 1) {
          newScenes[0].name = template?.name || newScenes[0].name || 'Untitled scene'
        }
        if (replaceScenes) {
          actions.closeScenePanels(oldScenes.map((scene) => scene.id))
          actions.setFrameFormValues({ scenes: newScenes })
        } else {
          for (const scene of newScenes) {
            if ('default' in scene) {
              delete scene.default
            }
          }
          actions.setFrameFormValues({
            scenes: [...oldScenes, ...newScenes],
          })
        }
      }
    },
    sendEvent: async ({ event, payload }) => {
      await apiFetch(`/api/frames/${props.frameId}/event/${event}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  })),
  afterMount(({ actions, values }) => {
    const defaultScene = values.frame?.scenes?.find((scene) => scene.id === 'default' && !scene.default)
    if (defaultScene) {
      const { name, id, default: _def, ...rest } = defaultScene
      actions.updateScene('default', { name: 'Default Scene', id: uuidv4(), default: true, ...rest })
    }
  }),
])
