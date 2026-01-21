import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'
import { apiFetch } from '../../../../utils/apiFetch'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import type { FrameScene } from '../../../../types'

const MAX_HISTORY = 8

export interface ChatLogicProps {
  frameId: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  tool?: string
}

export const chatLogic = kea([
  path(['src', 'scenes', 'frame', 'chatLogic']),
  props({} as ChatLogicProps),
  key((props) => props.frameId),
  connect((props: ChatLogicProps) => ({
    values: [
      frameLogic(props),
      ['frameForm', 'scenes'],
      panelsLogic(props),
      ['selectedSceneId', 'selectedSceneName'],
    ],
    actions: [frameLogic(props), ['applyTemplate', 'updateScene']],
  })),
  actions({
    setInput: (input: string) => ({ input }),
    submitMessage: (content: string) => ({ content }),
    setSubmitting: (isSubmitting: boolean) => ({ isSubmitting }),
    setError: (error: string | null) => ({ error }),
    appendMessage: (message: ChatMessage) => ({ message }),
    clearChat: true,
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
        clearChat: () => [],
      },
    ],
  }),
  selectors({
    selectedScene: [
      (s) => [s.scenes, s.selectedSceneId],
      (scenes, selectedSceneId) => scenes?.find((scene: FrameScene) => scene.id === selectedSceneId) ?? null,
    ],
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
      actions.appendMessage({ id: uuidv4(), role: 'user', content: prompt })
      const selectedScene = values.selectedScene
      try {
        const response = await apiFetch('/api/ai/scenes/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            frameId: props.frameId,
            sceneId: selectedScene?.id ?? null,
            scene: selectedScene ?? null,
            history: values.historyForRequest,
          }),
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to send chat message')
        }
        const payload = await response.json()
        const reply = typeof payload?.reply === 'string' ? payload.reply : 'Done.'
        const tool = typeof payload?.tool === 'string' ? payload.tool : 'reply'
        actions.appendMessage({ id: uuidv4(), role: 'assistant', content: reply, tool })

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
        actions.appendMessage({
          id: uuidv4(),
          role: 'assistant',
          content: error instanceof Error ? error.message : 'Failed to send chat message',
          tool: 'error',
        })
      }
      actions.setSubmitting(false)
    },
  })),
])
