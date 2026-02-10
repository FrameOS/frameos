import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { AppNodeData, DiagramNode, FrameScene, FrameType, SceneNodeData, TemplateType } from '../../types'
import { forms } from 'kea-forms'
import equal from 'fast-deep-equal'
import { v4 as uuidv4 } from 'uuid'
import { duplicateScenes } from '../../utils/duplicateScenes'
import { apiFetch } from '../../utils/apiFetch'
import { getBasePath } from '../../utils/getBasePath'
import { entityImagesModel } from '../../models/entityImagesModel'
import { arrangeNodes } from '../../utils/arrangeNodes'

export interface FrameLogicProps {
  frameId: number
}
const FRAME_KEYS: (keyof FrameType)[] = [
  'name',
  'mode',
  'frame_host',
  'frame_port',
  'frame_access_key',
  'frame_access',
  'enable_tls',
  'tls_port',
  'expose_only_tls_port',
  'tls_server_cert',
  'tls_server_key',
  'tls_client_ca_cert',
  'ssh_user',
  'ssh_pass',
  'ssh_port',
  'ssh_keys',
  'server_host',
  'server_port',
  'server_api_key',
  'width',
  'height',
  'color',
  'device',
  'device_config',
  'interval',
  'metrics_interval',
  'scaling_mode',
  'rotate',
  'flip',
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
  'gpio_buttons',
  'network',
  'agent',
  'palette',
  'nix',
  'buildroot',
  'rpios',
]

const FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS: (keyof FrameType)[] = ['device', 'scenes', 'reboot', 'rpios']
const FRAME_KEYS_REQUIRE_RECOMPILE_NIXOS: (keyof FrameType)[] = [
  'device',
  'scenes',
  'reboot',
  'ssh_user',
  'ssh_port',
  'ssh_pass',
  'ssh_keys',
  'log_to_file',
  'assets_path',
  'network',
  'agent',
  'nix',
]

const FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT: (keyof FrameType)[] = [
  'device',
  'scenes',
  'reboot',
  'ssh_user',
  'ssh_port',
  'ssh_pass',
  'log_to_file',
  'assets_path',
  'network',
  'agent',
  'buildroot',
]

async function resolveTemplateImageUrl(template: Partial<TemplateType>): Promise<string | null> {
  if (template.id) {
    const response = await apiFetch(`/api/templates/${template.id}/image_token`)
    if (response.ok) {
      const data = await response.json()
      return `/api/templates/${template.id}/image?token=${encodeURIComponent(data.token)}`
    }
  }

  if (typeof template.image === 'string') {
    const match = template.image.match(/^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/)
    if (match) {
      const response = await apiFetch(`/api/${match[1]}/image_token`)
      if (response.ok) {
        const data = await response.json()
        return `/api/${match[1]}/image?token=${encodeURIComponent(data.token)}`
      }
    }
    return template.image
  }

  return null
}

async function fetchTemplateImageBlob(template: Partial<TemplateType>): Promise<Blob | null> {
  if (template.image instanceof Blob) {
    return template.image
  }

  const imageUrl = await resolveTemplateImageUrl(template)
  if (!imageUrl) {
    return null
  }

  const basePath = getBasePath()
  const resolvedUrl = imageUrl.startsWith('/api/') && basePath ? `${basePath}${imageUrl}` : imageUrl
  const response = await fetch(resolvedUrl)
  if (!response.ok) {
    return null
  }
  return await response.blob()
}

function getScenesWithoutParents(scenes: FrameScene[]): FrameScene[] {
  if (scenes.length <= 1) {
    return scenes
  }

  const linkedSceneIds = new Set<string>()
  for (const scene of scenes) {
    for (const node of scene.nodes) {
      if (node.type === 'scene') {
        const linkedSceneId = (node.data as SceneNodeData)?.keyword
        if (linkedSceneId) {
          linkedSceneIds.add(linkedSceneId)
        }
      }
    }
  }

  return scenes.filter((scene) => !linkedSceneIds.has(scene.id))
}

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

function hasValidPosition(node: DiagramNode): boolean {
  return Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)
}

export function sanitizeScene(scene: Partial<FrameScene>, frame: Partial<FrameType>): FrameScene {
  const settings = scene.settings ?? {}
  const sanitizedNodes = sanitizeNodes(scene.nodes ?? [])
  const normalizedNodes = sanitizedNodes.map((node) =>
    hasValidPosition(node)
      ? node
      : {
          ...node,
          data: {
            ...node.data,
            ...(node.type === 'app' || node.type === 'event'
              ? { config: { ...((node.data as AppNodeData).config ?? {}) } }
              : {}),
          },
          position: { x: 0, y: 0 },
        }
  )
  const edges = scene.edges ?? []
  const shouldArrange = normalizedNodes.length > 0 && sanitizedNodes.every((node) => !hasValidPosition(node))
  return {
    ...scene,
    id: scene.id ?? uuidv4(),
    name: scene.name || 'Untitled scene',
    nodes: shouldArrange ? arrangeNodes(normalizedNodes, edges) : normalizedNodes,
    edges,
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
  connect(() => ({ values: [framesModel, ['frames']] })),
  actions({
    updateScene: (sceneId: string, scene: Partial<FrameScene>) => ({ sceneId, scene }),
    updateNodeData: (sceneId: string, nodeId: string, nodeData: Record<string, any>) => ({ sceneId, nodeId, nodeData }),
    saveFrame: true,
    renderFrame: true,
    rebootFrame: true,
    restartFrame: true,
    stopFrame: true,
    deployFrame: true,
    fastDeployFrame: true,
    fullDeployFrame: true,
    deployAgent: true,
    restartAgent: true,
    updateDeployedSshKeys: true,
    clearNextAction: true,
    applyTemplate: (template: Partial<TemplateType>) => ({
      template,
    }),
    closeScenePanels: (sceneIds: string[]) => ({ sceneIds }),
    sendEvent: (event: string, payload: Record<string, any>) => ({ event, payload }),
    setDeployWithAgent: (deployWithAgent: boolean) => ({ deployWithAgent }),
    generateTlsCertificates: true,
  }),
  forms(({ values }) => ({
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
      submit: async (frame) => {
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
      null as 'render' | 'restart' | 'reboot' | 'stop' | 'deploy' | null,
      {
        saveFrame: () => null,
        clearNextAction: () => null,
        renderFrame: () => 'render',
        restartFrame: () => 'restart',
        rebootFrame: () => 'reboot',
        stopFrame: () => 'stop',
        deployFrame: () => 'deploy',
      },
    ],
    frameForm: [
      {} as Partial<FrameType>,
      {
        setDeployWithAgent: (state, { deployWithAgent }) => {
          const frame = state
          if (!frame) return state
          return {
            ...state,
            agent: { ...frame.agent, deployWithAgent },
          }
        },
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    updateDeployedSshKeys: async () => {
      actions.clearNextAction()
      await actions.submitFrameForm()
      const response = await apiFetch(`/api/frames/${values.frameId}/ssh_keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssh_keys: values.frameForm.ssh_keys ?? [] }),
      })
      if (!response.ok) {
        throw new Error('Failed to update deployed SSH keys')
      }
    },
    generateTlsCertificates: async () => {
      const response = await apiFetch(`/api/frames/${values.frameId}/tls/generate`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error('Failed to generate TLS certificates')
      }
      const data = await response.json()
      actions.setFrameFormValues({
        tls_server_cert: data.tls_server_cert,
        tls_server_key: data.tls_server_key,
        tls_client_ca_cert: data.tls_client_ca_cert,
      })
      actions.touchFrameFormField('tls_server_cert')
      actions.touchFrameFormField('tls_server_key')
      actions.touchFrameFormField('tls_client_ca_cert')
    },
  })),
  selectors(() => ({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    frame: [(s) => [s.frames, s.frameId], (frames, frameId) => frames[frameId] || null],
    mode: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm?.mode || frame?.mode || 'rpios'],
    scenes: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): FrameScene[] => frameForm?.scenes ?? frame.scenes ?? [],
    ],
    sortedScenes: [
      (s) => [s.scenes],
      (scenes): FrameScene[] => scenes.toSorted((a, b) => a.name.localeCompare(b.name)),
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
      (s) => [s.frame, s.frameForm, s.lastDeploy, s.mode],
      (frame, frameForm, lastDeploy, mode) => {
        if (!lastDeploy) {
          return true
        }
        const fields = (
          mode === 'nixos'
            ? FRAME_KEYS_REQUIRE_RECOMPILE_NIXOS
            : mode === 'buildroot'
            ? FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT
            : FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS
        ).filter((k) => k !== 'scenes')
        const resp = fields.some(
          (key) => !equal(lastDeploy?.[key as keyof FrameType], (frameForm || frame)?.[key as keyof FrameType])
        )
        if (resp) {
          return true
        }
        // check scenes separately
        const currentScenes: FrameScene[] = (frameForm || frame)?.scenes ?? []
        const deployedScenes: FrameScene[] = lastDeploy?.scenes ?? []

        const needRedeploy = currentScenes.filter((scene) => {
          const deployed = deployedScenes.find((s) => s.id === scene.id)
          const mode = scene.settings?.execution ?? 'compiled'
          const deployedMode = deployed?.settings?.execution ?? 'compiled'
          if (mode === 'interpreted') {
            return deployed && deployedMode !== 'interpreted'
          }
          return !deployed || !equal(scene, deployed)
        })
        const needRemoval = deployedScenes.filter((scene) => {
          return (
            !currentScenes.find((s) => s.id === scene.id) && (scene.settings?.execution ?? 'compiled') !== 'interpreted'
          )
        })
        if (needRedeploy.length > 0 || needRemoval.length > 0) {
          return true
        }
        return false
      },
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
    deployWithAgent: [
      (s) => [s.frameForm, s.frame],
      (frameForm, frame) => {
        const agent = frameForm?.agent ?? frame?.agent
        return agent?.deployWithAgent ?? (agent?.agentEnabled && agent?.agentRunCommands) ?? false
      },
    ],
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
    rebootFrame: () => framesModel.actions.rebootFrame(props.frameId),
    stopFrame: () => framesModel.actions.stopFrame(props.frameId),
    deployFrame: () => framesModel.actions.deployFrame(props.frameId, !values.requiresRecompilation),
    fastDeployFrame: () => framesModel.actions.deployFrame(props.frameId, true),
    fullDeployFrame: () => framesModel.actions.deployFrame(props.frameId, false),
    deployAgent: () => framesModel.actions.deployAgent(props.frameId),
    restartAgent: () => framesModel.actions.restartAgent(props.frameId),
    setDeployWithAgent: ({ deployWithAgent }) => framesModel.actions.setDeployWithAgent(props.frameId, deployWithAgent),
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
    applyTemplate: async ({ template }) => {
      if ('scenes' in template) {
        const oldScenes = values.frameForm?.scenes || []
        const newScenes = duplicateScenes(
          (template.scenes ?? []).map((scene) => sanitizeScene(scene, values.frameForm))
        )
        if (newScenes.length === 1) {
          newScenes[0].name = template?.name || newScenes[0].name || 'Untitled scene'
        }
        for (const scene of newScenes) {
          if ('default' in scene) {
            delete scene.default
          }
        }
        actions.setFrameFormValues({
          scenes: [...oldScenes, ...newScenes],
        })

        if (newScenes.length) {
          try {
            const imageBlob = await fetchTemplateImageBlob(template)
            if (imageBlob) {
              const targetScenes = getScenesWithoutParents(newScenes)
              if (!targetScenes.length) {
                return
              }
              await Promise.all(
                targetScenes.map((scene) =>
                  apiFetch(`/api/frames/${props.frameId}/scene_images/${scene.id}`, {
                    method: 'POST',
                    body: imageBlob,
                  })
                )
              )
              targetScenes.forEach((scene) =>
                entityImagesModel.actions.updateEntityImage(`frames/${props.frameId}`, `scene_images/${scene.id}`)
              )
            }
          } catch (error) {
            console.error('Failed to save template image for scenes', error)
          }
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
  afterMount(({ actions, values, cache }) => {
    const defaultScene = values.frame?.scenes?.find((scene) => scene.id === 'default' && !scene.default)
    if (defaultScene) {
      const { name, id, default: _def, ...rest } = defaultScene
      actions.updateScene('default', { name: 'Default Scene', id: uuidv4(), default: true, ...rest })
    }

    cache.keydownHandler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!(event.metaKey || event.ctrlKey) || key !== 's') {
        return
      }
      event.preventDefault()
      actions.saveFrame()
    }
    window.addEventListener('keydown', cache.keydownHandler)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.keydownHandler) {
      window.removeEventListener('keydown', cache.keydownHandler)
      cache.keydownHandler = null
    }
  }),
])
