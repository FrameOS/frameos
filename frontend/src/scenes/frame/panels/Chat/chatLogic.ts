import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'
import { apiFetch } from '../../../../utils/apiFetch'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { diagramLogic } from '../Diagram/diagramLogic'
import type { DiagramEdge, DiagramNode, FrameScene } from '../../../../types'
import { Area, Panel } from '../../../../types'
import { socketLogic } from '../../../socketLogic'

import type { chatLogicType } from './chatLogicType'

const MAX_HISTORY = 8

export interface ChatLogicProps {
  frameId: number
  sceneId?: string | null
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  tool?: string
  isPlaceholder?: boolean
  isStreaming?: boolean
}

export const chatLogic = kea<chatLogicType>([
  path(['src', 'scenes', 'frame', 'chatLogic']),
  props({} as ChatLogicProps),
  key((props) => props.frameId),
  connect((props: ChatLogicProps) => ({
    logic: [socketLogic],
    values: [
      frameLogic(props),
      ['frameForm', 'scenes'],
      panelsLogic(props),
      ['selectedSceneId', 'panels'],
      diagramLogic({ frameId: props.frameId, sceneId: props.sceneId ?? '' }),
      ['selectedNodes', 'selectedEdges'],
    ],
    actions: [frameLogic(props), ['applyTemplate', 'updateScene']],
  })),
  actions({
    setInput: (input: string) => ({ input }),
    submitMessage: (content: string) => ({ content }),
    setSubmitting: (isSubmitting: boolean) => ({ isSubmitting }),
    setError: (error: string | null) => ({ error }),
    appendMessage: (message: ChatMessage) => ({ message }),
    updateMessage: (id: string, updates: Partial<ChatMessage>) => ({ id, updates }),
    clearChat: true,
    setActiveRequestId: (requestId: string | null) => ({ requestId }),
    setActiveLogMessageId: (messageId: string | null) => ({ messageId }),
    setActiveLogStartTime: (timestamp: string | null) => ({ timestamp }),
  }),
  reducers({
    input: [
      '',
      {
        setInput: (_, { input }) => input,
        submitMessage: () => '',
        clearChat: () => '',
      },
    ],
    isSubmitting: [
      false,
      {
        setSubmitting: (_, { isSubmitting }) => isSubmitting,
        submitMessage: () => true,
      },
    ],
    error: [
      null as string | null,
      {
        setError: (_, { error }) => error,
        submitMessage: () => null,
      },
    ],
    messages: [
      [] as ChatMessage[],
      {
        appendMessage: (state, { message }) => [...state, message],
        updateMessage: (state, { id, updates }) =>
          state.map((message) => (message.id === id ? { ...message, ...updates } : message)),
        clearChat: () => [],
      },
    ],
    activeRequestId: [
      null as string | null,
      {
        setActiveRequestId: (_, { requestId }) => requestId,
        clearChat: () => null,
      },
    ],
    activeLogMessageId: [
      null as string | null,
      {
        setActiveLogMessageId: (_, { messageId }) => messageId,
        clearChat: () => null,
      },
    ],
    activeLogStartTime: [
      null as string | null,
      {
        setActiveLogStartTime: (_, { timestamp }) => timestamp,
        clearChat: () => null,
      },
    ],
  }),
  selectors({
    selectedScene: [
      (s) => [s.scenes, s.selectedSceneId, s.panels],
      (scenes, selectedSceneId, panels) => {
        const activeTopLeftPanel = panels?.[Area.TopLeft]?.find((panel) => panel.active)?.panel
        if (activeTopLeftPanel === Panel.Scenes) {
          return null
        }
        return scenes?.find((scene: FrameScene) => scene.id === selectedSceneId) ?? null
      },
    ],
    chatSceneName: [(s) => [s.selectedScene], (selectedScene) => selectedScene?.name ?? null],
    historyForRequest: [
      (s) => [s.messages],
      (messages: ChatMessage[]) =>
        messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-MAX_HISTORY)
          .map((message) => ({ role: message.role, content: message.content })),
    ],
  }),
  listeners(({ actions, values, props }) => ({
    submitMessage: async ({ content }) => {
      const prompt = content.trim()
      if (!prompt) {
        actions.setSubmitting(false)
        actions.setError('Add a message to send.')
        return
      }
      const requestId = uuidv4()
      const logMessageId = uuidv4()
      actions.setActiveRequestId(requestId)
      actions.setActiveLogMessageId(logMessageId)
      actions.setActiveLogStartTime(null)
      actions.appendMessage({ id: uuidv4(), role: 'user', content: prompt })
      actions.appendMessage({
        id: logMessageId,
        role: 'assistant',
        content: '',
        tool: 'log',
        isPlaceholder: true,
        isStreaming: true,
      })
      const assistantMessageId = uuidv4()
      actions.appendMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        isPlaceholder: true,
        isStreaming: true,
      })
      const selectedScene = values.selectedScene
      try {
        const selectedNodesPayload =
          selectedScene && values.selectedNodes.length > 0
            ? values.selectedNodes.map((node: DiagramNode) => ({
                id: node.id,
                type: node.type,
                data: node.data,
                position: node.position,
              }))
            : []
        const selectedEdgesPayload =
          selectedScene && values.selectedEdges.length > 0
            ? values.selectedEdges.map((edge: DiagramEdge) => ({
                id: edge.id,
                type: edge.type,
                source: edge.source,
                target: edge.target,
                sourceHandle: edge.sourceHandle,
                targetHandle: edge.targetHandle,
              }))
            : []
        const response = await apiFetch('/api/ai/scenes/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            frameId: props.frameId,
            sceneId: selectedScene?.id ?? null,
            scene: selectedScene ?? null,
            selectedNodes: selectedNodesPayload.length ? selectedNodesPayload : undefined,
            selectedEdges: selectedEdgesPayload.length ? selectedEdgesPayload : undefined,
            history: values.historyForRequest,
            requestId,
          }),
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to send chat message')
        }
        const payload = await response.json()
        const reply = typeof payload?.reply === 'string' ? payload.reply : 'Done.'
        const tool = typeof payload?.tool === 'string' ? payload.tool : 'reply'

        const chunks = reply.match(/\S+|\s+/g) ?? []
        let current = ''
        for (const chunk of chunks) {
          current += chunk
          actions.updateMessage(assistantMessageId, {
            content: current,
            tool,
            isPlaceholder: false,
            isStreaming: true,
          })
          await new Promise((resolve) => setTimeout(resolve, 12))
        }
        actions.updateMessage(assistantMessageId, { content: current, tool, isStreaming: false, isPlaceholder: false })

        if (tool === 'build_scene') {
          const scenes = Array.isArray(payload?.scenes) ? payload.scenes : []
          if (!scenes.length) {
            throw new Error('No scenes returned from AI')
          }
          const sanitizedScenes = scenes.map((scene: Partial<FrameScene>) => {
            const sanitizedScene = sanitizeScene(scene, values.frameForm)
            return {
              ...sanitizedScene,
              settings: {
                ...sanitizedScene.settings,
                autoArrangeOnLoad: true,
              },
            }
          })
          actions.applyTemplate({ scenes: sanitizedScenes, name: payload?.title || 'AI Generated Scene' })
        }

        if (tool === 'modify_scene') {
          const scenes = Array.isArray(payload?.scenes) ? payload.scenes : []
          const updatedScene = scenes[0]
          const sceneId = updatedScene?.id || selectedScene?.id
          if (!updatedScene || !sceneId) {
            throw new Error('No scene returned from AI to update')
          }
          actions.updateScene(sceneId, updatedScene)
        }
      } catch (error) {
        console.error(error)
        actions.setError(error instanceof Error ? error.message : 'Failed to send chat message')
        actions.updateMessage(assistantMessageId, {
          content: error instanceof Error ? error.message : 'Failed to send chat message',
          tool: 'error',
          isPlaceholder: false,
          isStreaming: false,
        })
      }
      actions.setSubmitting(false)
    },
    [socketLogic.actionTypes.aiSceneLog]: ({ log }) => {
      if (!log.requestId || log.requestId !== values.activeRequestId) {
        return
      }
      const logMessageId = values.activeLogMessageId
      if (!logMessageId) {
        return
      }
      const existing = values.messages.find((message) => message.id === logMessageId)?.content || ''
      const startTimestamp = values.activeLogStartTime || log.timestamp
      if (!values.activeLogStartTime) {
        actions.setActiveLogStartTime(log.timestamp)
      }
      const startTime = new Date(startTimestamp).getTime()
      const logTime = new Date(log.timestamp).getTime()
      const elapsedSeconds = Number.isNaN(startTime) || Number.isNaN(logTime) ? null : Math.max(0, logTime - startTime)
      const elapsedLabel = elapsedSeconds === null ? '' : `${Math.round((elapsedSeconds / 1000) * 10) / 10}s `
      const stageLabel = log.stage ? `[${log.stage}] ` : ''
      const statusLabel = log.status && log.status !== 'info' ? `${log.status.toUpperCase()}: ` : ''
      const line = `${elapsedLabel}${stageLabel}${statusLabel}${log.message}`
      const nextContent = existing ? `${existing}\n${line}` : line
      const isTerminalStatus = log.status === 'success' || log.status === 'error'
      actions.updateMessage(logMessageId, {
        content: nextContent,
        tool: 'log',
        isPlaceholder: false,
        isStreaming: !isTerminalStatus,
      })
    },
  })),
])
