import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { subscriptions } from 'kea-subscriptions'
import { v4 as uuidv4 } from 'uuid'
import { apiFetch } from '../../../../utils/apiFetch'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { scenesLogic } from '../Scenes/scenesLogic'
import { diagramLogic } from '../Diagram/diagramLogic'
import type {
  ChatMessageRecord,
  ChatSummary,
  DiagramEdge,
  DiagramNode,
  FrameScene,
  PanelWithMetadata,
} from '../../../../types'
import { Area, Panel } from '../../../../types'
import { socketLogic } from '../../../socketLogic'

import type { chatLogicType } from './chatLogicType'

const MAX_HISTORY = 8
const CHAT_PAGE_SIZE = 20

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
  createdAt?: string
}

export type ChatView = 'list' | 'chat'

const buildLocalChat = (frameId: number, sceneId?: string | null): ChatSummary => {
  const timestamp = new Date().toISOString()
  return {
    id: uuidv4(),
    frameId,
    sceneId: sceneId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    messageCount: 0,
    isLocal: true,
  }
}

const normalizeRemoteChat = (chat: ChatSummary): ChatSummary => ({
  ...chat,
  isLocal: false,
})

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
    submitMessage: (content: string, chatId?: string | null) => ({ content, chatId }),
    setSubmitting: (isSubmitting: boolean) => ({ isSubmitting }),
    setError: (error: string | null) => ({ error }),
    appendMessage: (chatId: string, message: ChatMessage) => ({ chatId, message }),
    updateMessage: (chatId: string, id: string, updates: Partial<ChatMessage>) => ({ chatId, id, updates }),
    clearChat: (chatId: string) => ({ chatId }),
    setActiveRequestId: (requestId: string | null) => ({ requestId }),
    setActiveLogMessageId: (messageId: string | null) => ({ messageId }),
    setActiveLogStartTime: (timestamp: string | null) => ({ timestamp }),
    toggleContextItemsExpanded: (chatId: string, key: string) => ({ chatId, key }),
    loadChats: () => ({}),
    loadChatsSuccess: (chats: ChatSummary[], hasMore: boolean, nextOffset: number) => ({
      chats,
      hasMore,
      nextOffset,
    }),
    loadChatsFailure: (error: string) => ({ error }),
    loadMoreChats: () => ({}),
    loadMoreChatsSuccess: (chats: ChatSummary[], hasMore: boolean, nextOffset: number) => ({
      chats,
      hasMore,
      nextOffset,
    }),
    createChat: (sceneId?: string | null) => ({ sceneId }),
    startNewChatWithMessage: (content: string, sceneId?: string | null) => ({ content, sceneId }),
    createChatSuccess: (chat: ChatSummary) => ({ chat }),
    createChatFailure: (error: string) => ({ error }),
    ensureChatForScene: (sceneId: string) => ({ sceneId }),
    ensureFrameChat: () => ({}),
    selectChat: (chatId: string) => ({ chatId }),
    setActiveChatId: (chatId: string | null) => ({ chatId }),
    backToList: () => ({}),
    loadChatMessages: (chatId: string) => ({ chatId }),
    loadChatMessagesSuccess: (chatId: string, messages: ChatMessageRecord[]) => ({ chatId, messages }),
    loadChatMessagesFailure: (chatId: string, error: string) => ({ chatId, error }),
  }),
  reducers({
    input: [
      '',
      {
        setInput: (_, { input }) => input,
        submitMessage: () => '',
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
        loadChatsFailure: (_, { error }) => error,
        loadChatMessagesFailure: (_, { error }) => error,
        createChatFailure: (_, { error }) => error,
      },
    ],
    chats: [
      [] as ChatSummary[],
      {
        loadChatsSuccess: (state, { chats }) => {
          const remoteChats = chats.map(normalizeRemoteChat)
          const remoteIds = new Set(remoteChats.map((chat) => chat.id))
          const remoteSceneIds = new Set(remoteChats.map((chat) => chat.sceneId ?? null))
          const localChats = state.filter(
            (chat: ChatSummary) => chat.isLocal && !remoteIds.has(chat.id) && !remoteSceneIds.has(chat.sceneId ?? null)
          )
          return [...remoteChats, ...localChats]
        },
        loadMoreChatsSuccess: (state, { chats }) => {
          const merged = new Map<string, ChatSummary>(state.map((chat) => [chat.id, chat]))
          for (const chat of chats.map(normalizeRemoteChat)) {
            merged.set(chat.id, chat)
          }
          return Array.from(merged.values())
        },
        createChatSuccess: (state, { chat }) => {
          const next = [chat, ...state.filter((item: ChatSummary) => item.id !== chat.id)]
          return next
        },
        appendMessage: (state, { chatId, message }) => {
          const now = new Date().toISOString()
          return state.map((chat) => {
            if (chat.id !== chatId) {
              return chat
            }
            const messageCount = (chat.messageCount ?? 0) + 1
            return {
              ...chat,
              updatedAt: now,
              messageCount,
              isLocal: false,
              sceneId: chat.sceneId ?? null,
            }
          })
        },
      },
    ],
    hasMoreChats: [
      true,
      {
        loadChatsSuccess: (_, { hasMore }) => hasMore,
        loadMoreChatsSuccess: (_, { hasMore }) => hasMore,
      },
    ],
    chatsOffset: [
      0,
      {
        loadChatsSuccess: (_, { nextOffset }) => nextOffset,
        loadMoreChatsSuccess: (_, { nextOffset }) => nextOffset,
      },
    ],
    isLoadingChats: [
      false,
      {
        loadChats: () => true,
        loadChatsSuccess: () => false,
        loadChatsFailure: () => false,
      },
    ],
    isLoadingMoreChats: [
      false,
      {
        loadMoreChats: () => true,
        loadMoreChatsSuccess: () => false,
        loadChatsFailure: () => false,
      },
    ],
    isCreatingChat: [
      false,
      {
        createChat: () => true,
        createChatSuccess: () => false,
        createChatFailure: () => false,
      },
    ],
    activeChatId: [
      null as string | null,
      {
        selectChat: (_, { chatId }) => chatId,
        setActiveChatId: (_, { chatId }) => chatId,
      },
    ],
    chatView: [
      'list' as ChatView,
      {
        selectChat: () => 'chat',
        backToList: () => 'list',
      },
    ],
    messagesByChatId: [
      {} as Record<string, ChatMessage[]>,
      {
        appendMessage: (state, { chatId, message }) => {
          if (!chatId) {
            return state
          }
          return {
            ...state,
            [chatId]: [...(state[chatId] ?? []), message],
          }
        },
        updateMessage: (state, { chatId, id, updates }) => {
          if (!chatId) {
            return state
          }
          return {
            ...state,
            [chatId]: (state[chatId] ?? []).map((message: ChatMessage) =>
              message.id === id ? { ...message, ...updates } : message
            ),
          }
        },
        clearChat: (state, { chatId }) => ({
          ...state,
          [chatId]: [],
        }),
        loadChatMessagesSuccess: (state, { chatId, messages }) => ({
          ...state,
          [chatId]: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            tool: message.tool ?? undefined,
            createdAt: message.createdAt,
          })),
        }),
      },
    ],
    chatMessagesLoading: [
      {} as Record<string, boolean>,
      {
        loadChatMessages: (state, { chatId }) => ({
          ...state,
          [chatId]: true,
        }),
        loadChatMessagesSuccess: (state, { chatId }) => ({
          ...state,
          [chatId]: false,
        }),
        loadChatMessagesFailure: (state, { chatId }) => ({
          ...state,
          [chatId]: false,
        }),
      },
    ],
    chatMessagesLoaded: [
      {} as Record<string, boolean>,
      {
        loadChatMessagesSuccess: (state, { chatId }) => ({
          ...state,
          [chatId]: true,
        }),
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
    contextItemsExpandedByChat: [
      {} as Record<string, Record<string, boolean>>,
      {
        toggleContextItemsExpanded: (state, { chatId, key }) => ({
          ...state,
          [chatId]: {
            ...(state[chatId] ?? {}),
            [key]: !(state[chatId] ?? {})[key],
          },
        }),
        clearChat: (state, { chatId }) => ({
          ...state,
          [chatId]: {},
        }),
      },
    ],
  }),
  selectors({
    selectedScene: [
      (s: any) => [s.scenes, s.selectedSceneId, s.panels],
      (scenes: FrameScene[], selectedSceneId: string | null, panels: Record<Area, PanelWithMetadata[]>) => {
        const activeTopLeftPanel = panels?.[Area.TopLeft]?.find((panel) => panel.active)?.panel
        if (activeTopLeftPanel === Panel.Scenes) {
          return null
        }
        return scenes?.find((scene: FrameScene) => scene.id === selectedSceneId) ?? null
      },
    ],
    activeChat: [
      (s: any) => [s.chats, s.activeChatId],
      (chats: ChatSummary[], activeChatId: string | null) => chats.find((chat) => chat.id === activeChatId) ?? null,
    ],
    chatSceneId: [
      (s: any) => [s.activeChat, s.selectedSceneId],
      (activeChat: ChatSummary | null, selectedSceneId: string | null): string | null =>
        activeChat ? activeChat.sceneId ?? null : selectedSceneId ?? null,
    ],
    chatSceneName: [
      (s: any) => [s.chatSceneId, s.scenes],
      (chatSceneId: string | null, scenes: FrameScene[]): string | null =>
        chatSceneId ? scenes?.find((scene: FrameScene) => scene.id === chatSceneId)?.name ?? null : null,
    ],
    visibleChats: [
      (s: any) => [s.chats],
      (chats: ChatSummary[]) => chats.filter((chat) => chat.messageCount === undefined || chat.messageCount > 0),
    ],
    messages: [
      (s: any) => [s.messagesByChatId, s.activeChatId],
      (messagesByChatId: Record<string, ChatMessage[]>, activeChatId: string | null) =>
        activeChatId ? messagesByChatId[activeChatId] ?? [] : [],
    ],
    contextItemsExpanded: [
      (s: any) => [s.contextItemsExpandedByChat, s.activeChatId],
      (contextItemsExpandedByChat: Record<string, Record<string, boolean>>, activeChatId: string | null) =>
        activeChatId ? contextItemsExpandedByChat[activeChatId] ?? {} : {},
    ],
    historyForRequest: [
      (s) => [s.messages],
      (messages: ChatMessage[]) =>
        messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-MAX_HISTORY)
          .map((message) => ({ role: message.role, content: message.content })),
    ],
    contextSelectionSummary: [
      (s) => [s.selectedScene, s.selectedNodes, s.selectedEdges],
      (selectedScene: FrameScene | null, selectedNodes: DiagramNode[], selectedEdges: DiagramEdge[]): string | null => {
        if (!selectedScene) {
          return null
        }
        const nodeCount = selectedNodes.length
        const edgeCount = selectedEdges.length
        if (nodeCount + edgeCount === 0) {
          return null
        }
        const parts: string[] = []
        if (nodeCount > 0) {
          parts.push(`${nodeCount} node${nodeCount === 1 ? '' : 's'}`)
        }
        if (edgeCount > 0) {
          parts.push(`${edgeCount} edge${edgeCount === 1 ? '' : 's'}`)
        }
        return `${parts.join(' and ')} added to context`
      },
    ],
    isScenesPanelActive: [
      (s: any) => [s.panels],
      (panels: Record<Area, PanelWithMetadata[]>): boolean => {
        const activeTopLeftPanel = panels?.[Area.TopLeft]?.find((panel) => panel.active)?.panel
        return activeTopLeftPanel === Panel.Scenes
      },
    ],
  }),
  listeners(({ actions, values, props }) => ({
    loadChats: async () => {
      try {
        const response = await apiFetch(`/api/ai/chats?frameId=${props.frameId}&limit=${CHAT_PAGE_SIZE}&offset=0`)
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to load chats')
        }
        const payload = await response.json()
        const chats = Array.isArray(payload?.chats) ? payload.chats : []
        const hasMore = Boolean(payload?.hasMore)
        const nextOffset = typeof payload?.nextOffset === 'number' ? payload.nextOffset : chats.length
        actions.loadChatsSuccess(chats, hasMore, nextOffset)
      } catch (error) {
        actions.loadChatsFailure(error instanceof Error ? error.message : 'Failed to load chats')
      }
    },
    loadMoreChats: async () => {
      if (!values.hasMoreChats || values.isLoadingMoreChats) {
        return
      }
      try {
        const response = await apiFetch(
          `/api/ai/chats?frameId=${props.frameId}&limit=${CHAT_PAGE_SIZE}&offset=${values.chatsOffset}`
        )
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to load more chats')
        }
        const payload = await response.json()
        const chats = Array.isArray(payload?.chats) ? payload.chats : []
        const hasMore = Boolean(payload?.hasMore)
        const nextOffset =
          typeof payload?.nextOffset === 'number' ? payload.nextOffset : values.chatsOffset + chats.length
        actions.loadMoreChatsSuccess(chats, hasMore, nextOffset)
      } catch (error) {
        actions.loadChatsFailure(error instanceof Error ? error.message : 'Failed to load more chats')
      }
    },
    createChat: async ({ sceneId }) => {
      const targetSceneId = sceneId !== undefined ? sceneId : values.selectedScene?.id ?? null
      const chat = buildLocalChat(props.frameId, targetSceneId)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    startNewChatWithMessage: async ({ content, sceneId }) => {
      const targetSceneId = sceneId !== undefined ? sceneId : values.selectedScene?.id ?? null
      const chat = buildLocalChat(props.frameId, targetSceneId)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
      actions.submitMessage(content, chat.id)
    },
    ensureChatForScene: ({ sceneId }) => {
      const matchingChat = values.chats.find((chat) => chat.sceneId === sceneId)
      if (matchingChat) {
        if (matchingChat.id !== values.activeChatId) {
          actions.selectChat(matchingChat.id)
        }
        return
      }
      const chat = buildLocalChat(props.frameId, sceneId)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    ensureFrameChat: () => {
      const matchingChat = values.chats.find((chat) => chat.sceneId === null)
      if (matchingChat) {
        if (matchingChat.id !== values.activeChatId) {
          actions.selectChat(matchingChat.id)
        }
        return
      }
      const chat = buildLocalChat(props.frameId, null)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    selectChat: ({ chatId }) => {
      const chat = values.chats.find((item) => item.id === chatId)
      if (chat?.isLocal && (chat.messageCount ?? 0) === 0) {
        return
      }
      if (!values.chatMessagesLoaded[chatId] && !values.chatMessagesLoading[chatId]) {
        actions.loadChatMessages(chatId)
      }
    },
    loadChatMessages: async ({ chatId }) => {
      try {
        const response = await apiFetch(`/api/ai/chats/${chatId}`)
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.detail || 'Failed to load chat history')
        }
        const payload = await response.json()
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        actions.loadChatMessagesSuccess(chatId, messages)
      } catch (error) {
        actions.loadChatMessagesFailure(chatId, error instanceof Error ? error.message : 'Failed to load chat history')
      }
    },
    submitMessage: async ({ content, chatId: chatIdOverride }) => {
      const prompt = content.trim()
      if (!prompt) {
        actions.setSubmitting(false)
        actions.setError('Add a message to send.')
        return
      }
      let chatId = chatIdOverride ?? values.activeChatId
      if (!chatId) {
        const targetSceneId = values.selectedScene?.id ?? null
        const chat = buildLocalChat(props.frameId, targetSceneId)
        actions.createChatSuccess(chat)
        actions.selectChat(chat.id)
        chatId = chat.id
      }
      if (!chatId) {
        actions.setSubmitting(false)
        return
      }
      const requestId = uuidv4()
      const logMessageId = uuidv4()
      actions.setActiveRequestId(requestId)
      actions.setActiveLogMessageId(logMessageId)
      actions.setActiveLogStartTime(null)
      actions.appendMessage(chatId, { id: uuidv4(), role: 'user', content: prompt })
      actions.appendMessage(chatId, {
        id: logMessageId,
        role: 'assistant',
        content: '',
        tool: 'log',
        isPlaceholder: true,
        isStreaming: true,
      })
      const assistantMessageId = uuidv4()
      actions.appendMessage(chatId, {
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
            chatId,
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
          actions.updateMessage(chatId, assistantMessageId, {
            content: current,
            tool,
            isPlaceholder: false,
            isStreaming: true,
          })
          await new Promise((resolve) => setTimeout(resolve, 12))
        }
        actions.updateMessage(chatId, assistantMessageId, {
          content: current,
          tool,
          isStreaming: false,
          isPlaceholder: false,
        })

        if (tool === 'build_scene') {
          const scenes = Array.isArray(payload?.scenes) ? payload.scenes : []
          if (!scenes.length) {
            throw new Error('No scenes returned from AI')
          }
          const existingSceneIds = new Set(values.scenes.map((scene) => scene.id))
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
          await new Promise((resolve) => setTimeout(resolve, 0))
          const updatedScenes = values.frameForm?.scenes ?? values.scenes
          const newlyAddedScene = updatedScenes.find((scene) => !existingSceneIds.has(scene.id))
          if (newlyAddedScene) {
            scenesLogic({ frameId: props.frameId }).actions.focusScene(newlyAddedScene.id)
          }
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
        actions.updateMessage(chatId, assistantMessageId, {
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
      const chatId = values.activeChatId
      if (!logMessageId || !chatId) {
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
      actions.updateMessage(chatId, logMessageId, {
        content: nextContent,
        tool: 'log',
        isPlaceholder: false,
        isStreaming: !isTerminalStatus,
      })
    },
  })),
  afterMount(({ actions }) => {
    actions.loadChats()
  }),
  subscriptions(({ actions, values }) => ({
    selectedSceneId: (sceneId: string | null) => {
      if (!sceneId) {
        return
      }
      if (values.isScenesPanelActive) {
        return
      }
      actions.ensureChatForScene(sceneId)
    },
    chats: (chats: ChatSummary[]) => {
      if (!values.selectedSceneId) {
        return
      }
      if (values.isScenesPanelActive) {
        return
      }
      const matchingChat = chats.find((chat) => chat.sceneId === values.selectedSceneId)
      if (matchingChat && matchingChat.id !== values.activeChatId) {
        actions.selectChat(matchingChat.id)
      }
    },
    isScenesPanelActive: (isScenesPanelActive: boolean) => {
      if (isScenesPanelActive) {
        actions.ensureFrameChat()
      }
    },
  })),
])
