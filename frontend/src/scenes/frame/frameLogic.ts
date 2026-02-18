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

export interface ChangeDetail {
  label: string
  requiresFullDeploy: boolean
}

const DEFAULT_BROWSER_TITLE = 'FrameOS Backend'

function setBrowserTitle(frame?: FrameType | null): void {
  if (typeof document === 'undefined') {
    return
  }

  if (!frame) {
    document.title = DEFAULT_BROWSER_TITLE
    return
  }

  const frameTitle = frame.name || frame.frame_host || `Frame ${frame.id}`
  document.title = `${frameTitle} · ${DEFAULT_BROWSER_TITLE}`
}

const FRAME_KEYS: (keyof FrameType)[] = [
  'name',
  'mode',
  'frame_host',
  'frame_port',
  'frame_access_key',
  'frame_access',
  'https_proxy',
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

const FRAME_KEY_LABELS: Partial<Record<keyof FrameType, string>> = {
  name: 'Frame name',
  mode: 'Deployment mode',
  frame_host: 'Frame host',
  frame_port: 'Frame port',
  frame_access_key: 'Frame access key',
  frame_access: 'Frame access',
  https_proxy: 'HTTPS proxy',
  ssh_user: 'SSH user',
  ssh_pass: 'SSH password',
  ssh_port: 'SSH port',
  ssh_keys: 'SSH keys',
  server_host: 'Server host',
  server_port: 'Server port',
  server_api_key: 'Server API key',
  width: 'Width',
  height: 'Height',
  color: 'Color support',
  device: 'Device',
  device_config: 'Device config',
  interval: 'Refresh interval',
  metrics_interval: 'Metrics interval',
  scaling_mode: 'Scaling mode',
  rotate: 'Rotation',
  flip: 'Flip',
  background_color: 'Background color',
  scenes: 'Scenes',
  debug: 'Debug mode',
  log_to_file: 'Log to file',
  assets_path: 'Assets path',
  save_assets: 'Save assets',
  upload_fonts: 'Upload fonts',
  reboot: 'Reboot settings',
  control_code: 'Control code',
  schedule: 'Schedule',
  gpio_buttons: 'GPIO buttons',
  network: 'Network settings',
  agent: 'Agent settings',
  palette: 'Palette',
  nix: 'NixOS settings',
  buildroot: 'Buildroot settings',
  rpios: 'Raspberry Pi OS settings',
}

function keyLabel(key: keyof FrameType): string {
  return FRAME_KEY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function getRecompileFields(mode: FrameType['mode']): (keyof FrameType)[] {
  return mode === 'nixos'
    ? FRAME_KEYS_REQUIRE_RECOMPILE_NIXOS
    : mode === 'buildroot'
    ? FRAME_KEYS_REQUIRE_RECOMPILE_BUILDROOT
    : FRAME_KEYS_REQUIRE_RECOMPILE_RPIOS
}

function sceneChangeDetails(currentScenes: FrameScene[], deployedScenes: FrameScene[]): ChangeDetail[] {
  const details: ChangeDetail[] = []

  for (const scene of currentScenes) {
    const deployed = deployedScenes.find((s) => s.id === scene.id)
    const mode = scene.settings?.execution ?? 'compiled'
    const deployedMode = deployed?.settings?.execution ?? 'compiled'

    if (!deployed) {
      details.push({
        label: `Scene added: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
      continue
    }

    if (mode !== deployedMode) {
      details.push({
        label: `Scene mode changed: ${scene.name || scene.id} (${deployedMode} → ${mode})`,
        requiresFullDeploy: mode !== 'interpreted' || deployedMode !== 'interpreted',
      })
      continue
    }

    if (!equal(scene, deployed)) {
      details.push({
        label: `Scene updated: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
    }
  }

  for (const scene of deployedScenes) {
    if (!currentScenes.find((s) => s.id === scene.id)) {
      const mode = scene.settings?.execution ?? 'compiled'
      details.push({
        label: `Scene removed: ${scene.name || scene.id}`,
        requiresFullDeploy: mode !== 'interpreted',
      })
    }
  }

  return details
}

function computeChangeDetails(
  previous: Partial<FrameType> | null | undefined,
  next: Partial<FrameType> | null | undefined,
  mode: FrameType['mode']
): ChangeDetail[] {
  const recompileFields = new Set(getRecompileFields(mode).filter((key) => key !== 'scenes'))
  const details: ChangeDetail[] = []

  for (const key of FRAME_KEYS.filter((k) => k !== 'scenes')) {
    if (!equal(previous?.[key], next?.[key])) {
      details.push({
        label: keyLabel(key),
        requiresFullDeploy: recompileFields.has(key),
      })
    }
  }

  const sceneDetails = sceneChangeDetails(next?.scenes ?? [], previous?.scenes ?? [])
  return [...details, ...sceneDetails]
}

async function resolveTemplateImageUrl(template: Partial<TemplateType>): Promise<string | null> {
  if (template.id) {
    return `/api/templates/${template.id}/image`
  }

  if (typeof template.image === 'string') {
    const match = template.image.match(/^\/api\/(repositories\/system\/[^/]+\/templates\/[^/]+)\/image$/)
    if (match) {
      return `/api/${match[1]}/image`
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
    verifyTlsCertificates: true,
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
        https_proxy: {
          ...(values.frameForm.https_proxy || values.frame?.https_proxy || {}),
          certs: {
            ...((values.frameForm.https_proxy || values.frame?.https_proxy || {}).certs || {}),
            server: data.certs.server,
            server_key: data.certs.server_key,
            client_ca: data.certs.client_ca,
          },
          server_cert_not_valid_after: data.server_cert_not_valid_after,
          client_ca_cert_not_valid_after: data.client_ca_cert_not_valid_after,
        },
      })
      actions.touchFrameFormField('https_proxy.certs.server')
      actions.touchFrameFormField('https_proxy.certs.server_key')
      actions.touchFrameFormField('https_proxy.certs.client_ca')
    },
    verifyTlsCertificates: async () => {
      const frame = values.frameForm || values.frame
      if (
        !frame.https_proxy?.certs?.server ||
        !frame.https_proxy?.certs?.server_key ||
        !frame.https_proxy?.certs?.client_ca
      ) {
        console.warn('TLS enabled but certificates are missing, generating new certificates')
        actions.generateTlsCertificates()
      }
      if (!frame.https_proxy?.port) {
        actions.setFrameFormValues({
          https_proxy: {
            ...(frame.https_proxy || {}),
            port: 8443,
            expose_only_port: true,
          },
        })
      }
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
    unsavedChangeDetails: [
      (s) => [s.frame, s.frameForm, s.mode],
      (frame, frameForm, mode): ChangeDetail[] => computeChangeDetails(frame, frameForm, mode),
    ],
    undeployedChangeDetails: [
      (s) => [s.lastDeploy, s.frame, s.mode],
      (lastDeploy, frame, mode): ChangeDetail[] => computeChangeDetails(lastDeploy, frame, mode),
    ],
    requiresRecompilation: [
      (s) => [s.unsavedChangeDetails],
      (unsavedChangeDetails) => unsavedChangeDetails.some((change) => change.requiresFullDeploy),
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
  subscriptions(({ actions, values }) => ({
    frame: (frame?: FrameType, oldFrame?: FrameType) => {
      setBrowserTitle(frame)
      const frameFormMatchesPrevious = equal(oldFrame, values.frameForm)
      if (frame && (!oldFrame || frameFormMatchesPrevious)) {
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
    deployFrame: () =>
      framesModel.actions.deployFrame(
        props.frameId,
        Boolean(values.frame?.last_successful_deploy_at) && !values.requiresRecompilation
      ),
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
    setBrowserTitle(null)
    if (cache.keydownHandler) {
      window.removeEventListener('keydown', cache.keydownHandler)
      cache.keydownHandler = null
    }
  }),
])
