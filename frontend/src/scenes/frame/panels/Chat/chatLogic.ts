import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { subscriptions } from 'kea-subscriptions'
import { v4 as uuidv4 } from 'uuid'
import { apiFetch } from '../../../../utils/apiFetch'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { scenesLogic } from '../Scenes/scenesLogic'
import { diagramLogic } from '../Diagram/diagramLogic'
import type {
  AppNodeData,
  ChatContextType,
  ChatMessageRecord,
  ChatSummary,
  DiagramEdge,
  DiagramNode,
  FrameScene,
  PanelWithMetadata,
} from '../../../../types'
import { Area, Panel } from '../../../../types'
import { socketLogic } from '../../../socketLogic'
import { editAppLogic } from '../EditApp/editAppLogic'

import type { chatLogicType } from './chatLogicType'

const MAX_HISTORY = 8
const CHAT_PAGE_SIZE = 20
const APP_CONTEXT_SEPARATOR = '::'

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

const buildAppContextId = (sceneId: string, nodeId: string) => `${sceneId}${APP_CONTEXT_SEPARATOR}${nodeId}`

const parseAppContextId = (contextId?: string | null) => {
  if (!contextId) {
    return null
  }
  const parts = contextId.split(APP_CONTEXT_SEPARATOR)
  if (parts.length < 2) {
    return null
  }
  const [sceneId, ...rest] = parts
  const nodeId = rest.join(APP_CONTEXT_SEPARATOR)
  if (!sceneId || !nodeId) {
    return null
  }
  return { sceneId, nodeId }
}

const getChatContextType = (chat: ChatSummary | null): ChatContextType =>
  (chat?.contextType as ChatContextType | undefined) ?? (chat?.sceneId ? 'scene' : 'frame')

const getChatContextId = (chat: ChatSummary | null): string | null => {
  if (!chat) {
    return null
  }
  if (chat.contextId) {
    return chat.contextId
  }
  const contextType = getChatContextType(chat)
  if (contextType === 'scene') {
    return chat.sceneId ?? null
  }
  return null
}

const getChatContextKey = (chat: ChatSummary) => `${getChatContextType(chat)}:${getChatContextId(chat) ?? ''}`

const buildLocalChat = (
  frameId: number,
  contextType: ChatContextType,
  contextId?: string | null
): ChatSummary => {
  const timestamp = new Date().toISOString()
  return {
    id: uuidv4(),
    frameId,
    sceneId: contextType === 'scene' ? contextId ?? null : null,
    contextType,
    contextId: contextId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    messageCount: 0,
    isLocal: true,
  }
}

const normalizeRemoteChat = (chat: ChatSummary): ChatSummary => {
  const contextType = (chat.contextType as ChatContextType | undefined) ?? (chat.sceneId ? 'scene' : 'frame')
  const contextId = chat.contextId ?? (contextType === 'scene' ? chat.sceneId ?? null : null)
  return {
    ...chat,
    contextType,
    contextId,
    isLocal: false,
  }
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
      ['selectedScenePanelId', 'panels', 'scenesOpen', 'activeEditAppPanel'],
      diagramLogic({ frameId: props.frameId, sceneId: props.sceneId ?? '' }),
      ['selectedNodes', 'selectedEdges'],
    ],
    actions: [frameLogic(props), ['applyTemplate', 'updateScene'], panelsLogic(props), ['openChat']],
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
    toggleLogExpanded: (chatId: string, messageId: string) => ({ chatId, messageId }),
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
    ensureChatForApp: (sceneId: string, nodeId: string) => ({ sceneId, nodeId }),
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
          const remoteContextKeys = new Set(remoteChats.map((chat) => getChatContextKey(chat)))
          const localChats = state.filter(
            (chat: ChatSummary) =>
              chat.isLocal && !remoteIds.has(chat.id) && !remoteContextKeys.has(getChatContextKey(chat))
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
    logExpandedByChat: [
      {} as Record<string, Record<string, boolean>>,
      {
        toggleLogExpanded: (state, { chatId, messageId }) => ({
          ...state,
          [chatId]: {
            ...(state[chatId] ?? {}),
            [messageId]: !(state[chatId] ?? {})[messageId],
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
      (s: any) => [s.scenes, s.selectedScenePanelId, s.panels],
      (scenes: FrameScene[], selectedScenePanelId: string | null, panels: Record<Area, PanelWithMetadata[]>) => {
        const activeTopLeftPanel = panels?.[Area.TopLeft]?.find((panel) => panel.active)?.panel
        if (activeTopLeftPanel === Panel.Scenes) {
          return null
        }
        return scenes?.find((scene: FrameScene) => scene.id === selectedScenePanelId) ?? null
      },
    ],
    activeEditAppContext: [
      (s: any) => [s.activeEditAppPanel],
      (activeEditAppPanel: PanelWithMetadata | null) => {
        if (!activeEditAppPanel?.metadata) {
          return null
        }
        const metadata = activeEditAppPanel.metadata as { sceneId?: string; nodeId?: string; nodeData?: AppNodeData }
        if (!metadata.sceneId || !metadata.nodeId) {
          return null
        }
        return {
          sceneId: metadata.sceneId,
          nodeId: metadata.nodeId,
          nodeData: metadata.nodeData ?? null,
        }
      },
    ],
    activeChat: [
      (s: any) => [s.chats, s.activeChatId],
      (chats: ChatSummary[], activeChatId: string | null) => chats.find((chat) => chat.id === activeChatId) ?? null,
    ],
    chatSceneId: [
      (s: any) => [s.activeChat, s.selectedScenePanelId],
      (activeChat: ChatSummary | null, selectedScenePanelId: string | null): string | null => {
        if (activeChat) {
          const contextType = getChatContextType(activeChat)
          if (contextType === 'scene') {
            return getChatContextId(activeChat) ?? null
          }
          return null
        }
        return selectedScenePanelId ?? null
      },
    ],
    chatContextType: [
      (s: any) => [s.activeChat, s.activeEditAppContext, s.scenesOpen, s.selectedScene],
      (
        activeChat: ChatSummary | null,
        activeEditAppContext: { sceneId: string; nodeId: string } | null,
        scenesOpen: boolean,
        selectedScene: FrameScene | null
      ): ChatContextType => {
        if (activeChat) {
          return getChatContextType(activeChat)
        }
        if (activeEditAppContext) {
          return 'app'
        }
        if (scenesOpen) {
          return 'frame'
        }
        if (selectedScene) {
          return 'scene'
        }
        return 'frame'
      },
    ],
    chatContextId: [
      (s: any) => [s.chatContextType, s.activeChat, s.activeEditAppContext, s.selectedScene],
      (
        chatContextType: ChatContextType,
        activeChat: ChatSummary | null,
        activeEditAppContext: { sceneId: string; nodeId: string } | null,
        selectedScene: FrameScene | null
      ): string | null => {
        if (activeChat) {
          return getChatContextId(activeChat)
        }
        if (chatContextType === 'app' && activeEditAppContext) {
          return buildAppContextId(activeEditAppContext.sceneId, activeEditAppContext.nodeId)
        }
        if (chatContextType === 'scene') {
          return selectedScene?.id ?? null
        }
        return null
      },
    ],
    chatSceneName: [
      (s: any) => [s.chatSceneId, s.scenes],
      (chatSceneId: string | null, scenes: FrameScene[]): string | null =>
        chatSceneId ? scenes?.find((scene: FrameScene) => scene.id === chatSceneId)?.name ?? null : null,
    ],
    chatAppContext: [
      (s: any) => [s.chatContextType, s.chatContextId, s.frameForm],
      (chatContextType: ChatContextType, chatContextId: string | null, frameForm) => {
        if (chatContextType !== 'app' || !chatContextId) {
          return null
        }
        const parsed = parseAppContextId(chatContextId)
        if (!parsed) {
          return null
        }
        const scene = frameForm?.scenes?.find((item: FrameScene) => item.id === parsed.sceneId)
        const node = scene?.nodes?.find((item: any) => item.id === parsed.nodeId)
        return {
          sceneId: parsed.sceneId,
          nodeId: parsed.nodeId,
          sceneName: scene?.name ?? parsed.sceneId,
          nodeData: node?.data as AppNodeData | undefined,
        }
      },
    ],
    chatLabelForChat: [
      (s: any) => [s.scenes, s.frameForm],
      (scenes: FrameScene[], frameForm) => {
        return (chat: ChatSummary) => {
          const contextType = getChatContextType(chat)
          if (contextType === 'frame') {
            return 'Frame chat'
          }
          if (contextType === 'scene') {
            return scenes?.find((scene: FrameScene) => scene.id === chat.sceneId)?.name ?? 'Frame chat'
          }
          const contextId = getChatContextId(chat)
          const parsed = parseAppContextId(contextId)
          if (!parsed) {
            return 'App chat'
          }
          const scene = frameForm?.scenes?.find((item: FrameScene) => item.id === parsed.sceneId)
          const node = scene?.nodes?.find((item: any) => item.id === parsed.nodeId)
          const nodeData = node?.data as AppNodeData | undefined
          const appLabel = nodeData?.name || nodeData?.keyword || parsed.nodeId
          const sceneLabel = scene?.name ?? parsed.sceneId
          return `${sceneLabel} / ${appLabel}`
        }
      },
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
    logExpanded: [
      (s: any) => [s.logExpandedByChat, s.activeChatId],
      (logExpandedByChat: Record<string, Record<string, boolean>>, activeChatId: string | null) =>
        activeChatId ? logExpandedByChat[activeChatId] ?? {} : {},
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
      (s) => [s.chatContextType, s.chatAppContext, s.selectedScene, s.selectedNodes, s.selectedEdges],
      (
        chatContextType: ChatContextType,
        chatAppContext: { nodeData?: AppNodeData } | null,
        selectedScene: FrameScene | null,
        selectedNodes: DiagramNode[],
        selectedEdges: DiagramEdge[]
      ): string | null => {
        if (chatContextType === 'app') {
          const appLabel = chatAppContext?.nodeData?.name || chatAppContext?.nodeData?.keyword
          return appLabel ? `Editing app "${appLabel}"` : 'Editing this app'
        }
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
    defaultChatContext: [
      (s) => [s.activeEditAppContext, s.scenesOpen, s.selectedScene],
      (
        activeEditAppContext: { sceneId: string; nodeId: string } | null,
        scenesOpen: boolean,
        selectedScene: FrameScene | null
      ): { type: ChatContextType; id: string | null } => {
        if (activeEditAppContext) {
          return { type: 'app', id: buildAppContextId(activeEditAppContext.sceneId, activeEditAppContext.nodeId) }
        }
        if (scenesOpen) {
          return { type: 'frame', id: null }
        }
        if (selectedScene) {
          return { type: 'scene', id: selectedScene.id }
        }
        return { type: 'frame', id: null }
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
      if (sceneId !== undefined) {
        const chat = buildLocalChat(props.frameId, 'scene', sceneId ?? null)
        actions.createChatSuccess(chat)
        actions.selectChat(chat.id)
        return
      }
      const { type, id } = values.defaultChatContext
      const chat = buildLocalChat(props.frameId, type, id)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    startNewChatWithMessage: async ({ content, sceneId }) => {
      actions.openChat()
      if (sceneId !== undefined) {
        const chat = buildLocalChat(props.frameId, 'scene', sceneId ?? null)
        actions.createChatSuccess(chat)
        actions.selectChat(chat.id)
        actions.submitMessage(content, chat.id)
        return
      }
      const { type, id } = values.defaultChatContext
      const chat = buildLocalChat(props.frameId, type, id)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
      actions.submitMessage(content, chat.id)
    },
    ensureChatForScene: ({ sceneId }) => {
      const matchingChat = values.chats.find(
        (chat) => getChatContextType(chat) === 'scene' && getChatContextId(chat) === sceneId
      )
      if (matchingChat) {
        if (matchingChat.id !== values.activeChatId) {
          actions.selectChat(matchingChat.id)
        }
        return
      }
      const chat = buildLocalChat(props.frameId, 'scene', sceneId)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    ensureChatForApp: ({ sceneId, nodeId }) => {
      const contextId = buildAppContextId(sceneId, nodeId)
      const matchingChat = values.chats.find(
        (chat) => getChatContextType(chat) === 'app' && getChatContextId(chat) === contextId
      )
      if (matchingChat) {
        if (matchingChat.id !== values.activeChatId) {
          actions.selectChat(matchingChat.id)
        }
        return
      }
      const chat = buildLocalChat(props.frameId, 'app', contextId)
      actions.createChatSuccess(chat)
      actions.selectChat(chat.id)
    },
    ensureFrameChat: () => {
      const matchingChat = values.chats.find(
        (chat) => getChatContextType(chat) === 'frame' && getChatContextId(chat) === null
      )
      if (matchingChat) {
        if (matchingChat.id !== values.activeChatId) {
          actions.selectChat(matchingChat.id)
        }
        return
      }
      const chat = buildLocalChat(props.frameId, 'frame', null)
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
      let chatContextType = values.chatContextType
      let chatContextId = values.chatContextId
      if (!chatId) {
        const { type, id } = values.defaultChatContext
        chatContextType = type
        chatContextId = id
        const chat = buildLocalChat(props.frameId, type, id)
        actions.createChatSuccess(chat)
        actions.selectChat(chat.id)
        chatId = chat.id
      } else if (values.activeChat) {
        chatContextType = getChatContextType(values.activeChat)
        chatContextId = getChatContextId(values.activeChat)
      }
      if (!chatId) {
        actions.setSubmitting(false)
        return
      }
      if (chatContextType === 'app') {
        const appContext = values.activeEditAppContext
        if (!appContext) {
          actions.setSubmitting(false)
          actions.setError('Open the app editor to chat about this app.')
          return
        }
        const appLogic = editAppLogic({
          frameId: props.frameId,
          sceneId: appContext.sceneId,
          nodeId: appContext.nodeId,
        })
        const { sources, sourcesLoading, configJson, savedKeyword, title } = appLogic.values
        if (sourcesLoading || !sources || Object.keys(sources).length === 0) {
          actions.setSubmitting(false)
          actions.setError('Wait for the app sources to load before chatting.')
          return
        }
        const appKeyword = savedKeyword || appContext.nodeData?.keyword || null
        const appName = configJson?.name || title || appContext.nodeData?.name || appContext.nodeId
        const requestId = uuidv4()
        actions.setActiveRequestId(requestId)
        actions.appendMessage(chatId, { id: uuidv4(), role: 'user', content: prompt })
        const assistantMessageId = uuidv4()
        actions.appendMessage(chatId, {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          isPlaceholder: true,
          isStreaming: true,
        })
        try {
          const response = await apiFetch('/api/ai/apps/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              chatId,
              frameId: props.frameId,
              sceneId: appContext.sceneId,
              nodeId: appContext.nodeId,
              appName,
              appKeyword,
              sources,
              history: values.historyForRequest,
              requestId,
            }),
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload?.detail || 'Failed to send app chat message')
          }
          const payload = await response.json()
          const reply = typeof payload?.reply === 'string' ? payload.reply : 'Done.'
          const tool = typeof payload?.tool === 'string' ? payload.tool : 'reply'
          const chunks = reply.match(/\\S+|\\s+/g) ?? []
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
          if (tool === 'edit_app' && payload?.files && typeof payload.files === 'object') {
            const files = payload.files as Record<string, string>
            let firstFile: string | null = null
            for (const [file, source] of Object.entries(files)) {
              if (typeof source === 'string') {
                appLogic.actions.updateFile(file, source)
                firstFile = firstFile ?? file
              }
            }
            if (firstFile) {
              appLogic.actions.setActiveFile(firstFile)
            }
          }
        } catch (error) {
          console.error(error)
          actions.setError(error instanceof Error ? error.message : 'Failed to send app chat message')
          actions.updateMessage(chatId, assistantMessageId, {
            content: error instanceof Error ? error.message : 'Failed to send app chat message',
            tool: 'error',
            isPlaceholder: false,
            isStreaming: false,
          })
        }
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
  afterMount(({ actions, values }) => {
    actions.loadChats()
    if (values.activeEditAppContext) {
      actions.ensureChatForApp(values.activeEditAppContext.sceneId, values.activeEditAppContext.nodeId)
    } else if (values.scenesOpen) {
      actions.ensureFrameChat()
    }
  }),
  subscriptions(({ actions, values }) => ({
    selectedScenePanelId: (sceneId: string | null) => {
      if (!sceneId) {
        return
      }
      if (values.scenesOpen || values.activeEditAppContext) {
        return
      }
      actions.ensureChatForScene(sceneId)
    },
    activeEditAppPanel: (panel: PanelWithMetadata | null) => {
      if (!panel?.metadata) {
        return
      }
      const metadata = panel.metadata as { sceneId?: string; nodeId?: string }
      if (!metadata.sceneId || !metadata.nodeId) {
        return
      }
      actions.ensureChatForApp(metadata.sceneId, metadata.nodeId)
    },
    chats: (chats: ChatSummary[]) => {
      if (!values.selectedScenePanelId) {
        return
      }
      if (values.scenesOpen || values.activeEditAppContext) {
        return
      }
      const matchingChat = chats.find(
        (chat) =>
          getChatContextType(chat) === 'scene' && getChatContextId(chat) === values.selectedScenePanelId
      )
      if (matchingChat && matchingChat.id !== values.activeChatId) {
        actions.selectChat(matchingChat.id)
      }
    },
    scenesOpen: (scenesOpen: boolean) => {
      if (scenesOpen) {
        actions.ensureFrameChat()
      }
    },
  })),
])
