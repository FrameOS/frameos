import { MakeLogicType, actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { subscriptions } from '../../../../utils/keaSubscriptions'
import { v4 as uuidv4 } from 'uuid'
import { apiFetch } from '../../../../utils/apiFetch'
import { frameLogic, sanitizeScene } from '../../frameLogic'
import { frameEditorsLogic, type FrameEditor } from '../../frameEditorsLogic'
import { scenesLogic } from '../Scenes/scenesLogic'
import { diagramLogic } from '../Diagram/diagramLogic'
import type {
  AppNodeData,
  ChatContextType,
  ChatMessageRecord,
  ChatSummary,
  DiagramEdge,
  DiagramNode,
  FrameType,
  FrameScene,
  FrameId,
} from '../../../../types'
import { editAppLogic } from '../EditApp/editAppLogic'
import { isFrameControlMode } from '../../../../utils/frameControlMode'
import { isCloudMode } from '../../../../utils/cloudMode'
import {
  formatElapsed,
  isCloudAiInstallProposal,
  streamCloudAiChat,
  type CloudAiChatEvent,
  type CloudAiInstallProposal,
} from '../../../../utils/cloudAiChat'
import { installCloudFrameStoreScene } from '../../../../utils/cloudFrameApi'
import { renderSceneCheck } from '../../../../utils/wasmSceneRenderCheck'
import { frameRenderDevice } from '../../../../utils/frameRenderDevice'
import { wasmPreviewDimensions } from '../../../../utils/wasmScenePreview'
import { getCurrentProjectId, projectApiPathForProject } from '../../../../utils/projectApi'
import { urls } from '../../../../urls'
import { router } from 'kea-router'

const MAX_HISTORY = 8
const CHAT_PAGE_SIZE = 20
const APP_CONTEXT_SEPARATOR = '::'
// After the cloud agent delivers a scene, it is rendered once in the wasm
// preview runtime; runtime errors go back to the agent as an automatic
// follow-up message, at most this many rounds per user message.
const MAX_RENDER_CHECK_ROUNDS = 2
const RENDER_CHECK_PREFIX = '[Automatic render check]'

function frameProjectId(frameForm: Partial<FrameType>, frame: FrameType | null | undefined): number | null {
  return frameForm.project_id ?? frame?.project_id ?? null
}

// Whether there is a stored chat list to load: never on a frame's own admin
// pages, and on a backend only once the frame's project is known.
function canListChats(
  props: { frameId: FrameId | null },
  values: { frameForm: Partial<FrameType>; frame: FrameType | null | undefined }
): boolean {
  return (
    !isFrameControlMode() &&
    (isCloudMode() || props.frameId === null || Boolean(frameProjectId(values.frameForm, values.frame)))
  )
}

export interface ChatLogicProps {
  /** null for the chat about no frame in particular: the frames home's AI
   * box. It has no editor, so delivered scenes are not applied anywhere and
   * the assistant saves through its MCP tools instead (docs/ai-chat.md). */
  frameId: FrameId | null
  sceneId?: string | null
}

/** The logic key of the frame-less chat. */
export const HOME_CHAT_KEY = 'home'

// Where a chat route lives: the account's origin on the cloud, the project
// on a backend (the frame's, else the browser's current project).
async function chatApiPath(path: string, projectId: number | null): Promise<string | null> {
  if (isCloudMode()) {
    return path
  }
  const resolved = projectId ?? (await getCurrentProjectId().catch(() => null))
  return resolved ? projectApiPathForProject(resolved, path) : null
}

const frameValue = <T>(fallback: T) => [() => [() => fallback], (value: T) => value] as any

export type ChatInstallProposalStatus =
  | { state: 'pending' }
  | { state: 'approving' }
  | { state: 'installed'; queued: boolean }
  | { state: 'failed'; error: string }
  | { state: 'dismissed' }

/** A frame install the cloud agent proposed (add_scene_to_frame) and the
 * user has yet to approve on the card the chat renders for it. */
export type ChatInstallProposal = {
  proposal: CloudAiInstallProposal
  status: ChatInstallProposalStatus
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  logContent?: string
  tool?: string
  isPlaceholder?: boolean
  isStreaming?: boolean
  createdAt?: string
  proposals?: ChatInstallProposal[]
}

function proposalsFromPayload(payload: unknown): ChatInstallProposal[] | undefined {
  const raw = (payload as { proposals?: unknown } | null | undefined)?.proposals
  if (!Array.isArray(raw)) {
    return undefined
  }
  const proposals = raw
    .filter(isCloudAiInstallProposal)
    .map((proposal) => ({ proposal, status: { state: 'pending' as const } }))
  return proposals.length > 0 ? proposals : undefined
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
  frameId: FrameId | null,
  contextType: ChatContextType,
  contextId?: string | null
): ChatSummary => {
  const timestamp = new Date().toISOString()
  return {
    id: uuidv4(),
    frameId,
    sceneId: contextType === 'scene' ? (contextId ?? null) : null,
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
  const contextId = chat.contextId ?? (contextType === 'scene' ? (chat.sceneId ?? null) : null)
  return {
    ...chat,
    contextType,
    contextId,
    isLocal: false,
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface chatLogicValues {
  selectedEdges: DiagramEdge[] // diagramLogic
  selectedNodes: DiagramNode[] // diagramLogic
  activeEditApp: FrameEditor | null // frameEditorsLogic
  activeSceneEditorId: string | null // frameEditorsLogic
  scenesOpen: boolean // frameEditorsLogic
  frame: FrameType // frameLogic
  frameForm: Partial<FrameType> // frameLogic
  scenes: FrameScene[] // frameLogic
  activeChat: ChatSummary | null
  activeChatId: string | null
  activeEditAppContext: {
    nodeData: AppNodeData | null
    nodeId: string
    sceneId: string
  } | null
  activeLogMessageId: string | null
  activeLogStartTime: string | null
  activeRequestId: string | null
  chatAppContext: {
    nodeData: AppNodeData | undefined
    nodeId: string
    sceneId: string
    sceneName: any
  } | null
  chatContextId: string | null
  chatContextType: ChatContextType
  chatLabelForChat: (chat: ChatSummary) => string
  chatMessagesLoaded: Record<string, boolean>
  chatMessagesLoading: Record<string, boolean>
  chatSceneId: string | null
  chatSceneName: string | null
  chatTitleForChat: (chat: ChatSummary) => string | null
  chatView: ChatView
  chats: ChatSummary[]
  chatsOffset: number
  contextItemsExpanded: Record<string, boolean>
  contextItemsExpandedByChat: Record<string, Record<string, boolean>>
  contextSelectionSummary: string | null
  defaultChatContext: {
    id: string | null
    type: ChatContextType
  }
  error: string | null
  hasMoreChats: boolean
  historyForRequest: {
    content: string
    role: 'assistant' | 'user'
  }[]
  input: string
  isCreatingChat: boolean
  isLoadingChats: boolean
  isLoadingMoreChats: boolean
  isSubmitting: boolean
  logExpanded: Record<string, boolean>
  logExpandedByChat: Record<string, Record<string, boolean>>
  messages: ChatMessage[]
  messagesByChatId: Record<string, ChatMessage[]>
  selectedScene: FrameScene | null
  visibleChats: ChatSummary[]
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface chatLogicActions {
  updateScene: (
    sceneId: string,
    scene: Partial<FrameScene>
  ) => {
    scene: Partial<FrameScene>
    sceneId: string
  } // frameLogic
  appendMessage: (
    chatId: string,
    message: ChatMessage
  ) => {
    chatId: string
    message: ChatMessage
  }
  approveInstallProposal: (
    chatId: string,
    messageId: string,
    proposalId: string
  ) => {
    chatId: string
    messageId: string
    proposalId: string
  }
  backToList: () => {}
  clearChat: (chatId: string) => {
    chatId: string
  }
  createChat: (sceneId?: string | null) => {
    sceneId: string | null | undefined
  }
  createChatFailure: (error: string) => {
    error: string
  }
  createChatSuccess: (chat: ChatSummary) => {
    chat: ChatSummary
  }
  dismissInstallProposal: (
    chatId: string,
    messageId: string,
    proposalId: string
  ) => {
    chatId: string
    messageId: string
    proposalId: string
  }
  ensureChatForApp: (
    sceneId: string,
    nodeId: string
  ) => {
    nodeId: string
    sceneId: string
  }
  ensureChatForScene: (sceneId: string) => {
    sceneId: string
  }
  ensureFrameChat: () => {}
  loadChatMessages: (chatId: string) => {
    chatId: string
  }
  loadChatMessagesFailure: (
    chatId: string,
    error: string
  ) => {
    chatId: string
    error: string
  }
  loadChatMessagesSuccess: (
    chatId: string,
    messages: ChatMessageRecord[]
  ) => {
    chatId: string
    messages: ChatMessageRecord[]
  }
  loadChats: () => {}
  loadChatsFailure: (error: string) => {
    error: string
  }
  loadChatsSuccess: (
    chats: ChatSummary[],
    hasMore: boolean,
    nextOffset: number
  ) => {
    chats: ChatSummary[]
    hasMore: boolean
    nextOffset: number
  }
  loadMoreChats: () => {}
  loadMoreChatsSuccess: (
    chats: ChatSummary[],
    hasMore: boolean,
    nextOffset: number
  ) => {
    chats: ChatSummary[]
    hasMore: boolean
    nextOffset: number
  }
  openChatApp: () => {
    value: true
  }
  openChatScene: (sceneId: string) => {
    sceneId: string
  }
  rekeyChat: (
    fromId: string,
    toId: string
  ) => {
    fromId: string
    toId: string
  }
  selectChat: (chatId: string) => {
    chatId: string
  }
  setActiveChatId: (chatId: string | null) => {
    chatId: string | null
  }
  setActiveLogMessageId: (messageId: string | null) => {
    messageId: string | null
  }
  setActiveLogStartTime: (timestamp: string | null) => {
    timestamp: string | null
  }
  setActiveRequestId: (requestId: string | null) => {
    requestId: string | null
  }
  setError: (error: string | null) => {
    error: string | null
  }
  setInput: (input: string) => {
    input: string
  }
  setProposalStatus: (
    chatId: string,
    messageId: string,
    proposalId: string,
    status: ChatInstallProposalStatus
  ) => {
    chatId: string
    messageId: string
    proposalId: string
    status: ChatInstallProposalStatus
  }
  setSubmitting: (isSubmitting: boolean) => {
    isSubmitting: boolean
  }
  startNewChatWithMessage: (
    content: string,
    sceneId?: string | null
  ) => {
    content: string
    sceneId: string | null | undefined
  }
  submitMessage: (
    content: string,
    chatId?: string | null,
    renderCheckRound?: number
  ) => {
    chatId: string | null | undefined
    content: string
    renderCheckRound: number | undefined
  }
  toggleContextItemsExpanded: (
    chatId: string,
    key: string
  ) => {
    chatId: string
    key: string
  }
  toggleLogExpanded: (
    chatId: string,
    messageId: string
  ) => {
    chatId: string
    messageId: string
  }
  updateMessage: (
    chatId: string,
    id: string,
    updates: Partial<ChatMessage>
  ) => {
    chatId: string
    id: string
    updates: Partial<ChatMessage>
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface chatLogicMeta {
  key: FrameId
  __keaTypeGenInternalSelectorTypes: {
    selectedScene: (scenes: any, activeSceneEditorId: any) => FrameScene | null
    activeEditAppContext: (activeEditApp: any) => {
      nodeData: AppNodeData | null
      nodeId: string
      sceneId: string
    } | null
    activeChat: (chats: any, activeChatId: any) => ChatSummary | null
    chatSceneId: (activeChat: any, activeSceneEditorId: any) => string | null
    chatContextType: (
      activeChat: any,
      activeEditAppContext: any,
      scenesOpen: any,
      selectedScene: any
    ) => ChatContextType
    chatContextId: (
      chatContextType: any,
      activeChat: any,
      activeEditAppContext: any,
      selectedScene: any
    ) => string | null
    chatSceneName: (chatSceneId: any, scenes: any) => string | null
    chatAppContext: (
      chatContextType: any,
      chatContextId: any,
      frameForm: any
    ) => {
      nodeData: AppNodeData | undefined
      nodeId: string
      sceneId: string
      sceneName: any
    } | null
    chatLabelForChat: (scenes: any, frameForm: any) => (chat: ChatSummary) => string
    chatTitleForChat: (messagesByChatId: any) => (chat: ChatSummary) => string | null
    visibleChats: (chats: any, arg: FrameId | null) => ChatSummary[]
    messages: (messagesByChatId: any, activeChatId: any) => ChatMessage[]
    contextItemsExpanded: (contextItemsExpandedByChat: any, activeChatId: any) => Record<string, boolean>
    logExpanded: (logExpandedByChat: any, activeChatId: any) => Record<string, boolean>
    historyForRequest: (messages: ChatMessage[]) => {
      content: string
      role: 'assistant' | 'user'
    }[]
    contextSelectionSummary: (
      chatContextType: ChatContextType,
      chatAppContext: {
        nodeData: AppNodeData | undefined
        nodeId: string
        sceneId: string
        sceneName: any
      } | null,
      selectedScene: FrameScene | null,
      selectedNodes: DiagramNode[],
      selectedEdges: DiagramEdge[]
    ) => string | null
    defaultChatContext: (
      activeEditAppContext: {
        nodeData: AppNodeData | null
        nodeId: string
        sceneId: string
      } | null,
      scenesOpen: boolean,
      selectedScene: FrameScene | null
    ) => {
      id: string | null
      type: ChatContextType
    }
  }
}

export type chatLogicType = MakeLogicType<chatLogicValues, chatLogicActions, ChatLogicProps> & chatLogicMeta

export const chatLogic = kea<chatLogicType>([
  path(['src', 'scenes', 'frame', 'chatLogic']),
  props({} as ChatLogicProps),
  key((props) => props.frameId ?? HOME_CHAT_KEY),
  connect((props: ChatLogicProps) =>
    props.frameId !== null
      ? {
          values: [
            frameLogic({ frameId: props.frameId }),
            ['frame', 'frameForm', 'scenes'],
            frameEditorsLogic({ frameId: props.frameId }),
            ['activeSceneEditorId', 'scenesOpen', 'activeEditApp'],
            diagramLogic({ frameId: props.frameId, sceneId: props.sceneId ?? '' }),
            ['selectedNodes', 'selectedEdges'],
          ],
          actions: [frameLogic({ frameId: props.frameId }), ['updateScene']],
        }
      : {}
  ),
  // The frame-less chat has no frame, editor or diagram to read: the same
  // names, empty, so every selector below reads one shape.
  selectors(({ props }) =>
    props.frameId !== null
      ? {}
      : {
          frame: frameValue(null),
          frameForm: frameValue({}),
          scenes: frameValue([]),
          activeSceneEditorId: frameValue(null),
          scenesOpen: frameValue(false),
          activeEditApp: frameValue(null),
          selectedNodes: frameValue([]),
          selectedEdges: frameValue([]),
        }
  ),
  actions({
    setInput: (input: string) => ({ input }),
    submitMessage: (content: string, chatId?: string | null, renderCheckRound?: number) => ({
      content,
      chatId,
      renderCheckRound,
    }),
    setSubmitting: (isSubmitting: boolean) => ({ isSubmitting }),
    setError: (error: string | null) => ({ error }),
    appendMessage: (chatId: string, message: ChatMessage) => ({ chatId, message }),
    updateMessage: (chatId: string, id: string, updates: Partial<ChatMessage>) => ({ chatId, id, updates }),
    setProposalStatus: (chatId: string, messageId: string, proposalId: string, status: ChatInstallProposalStatus) => ({
      chatId,
      messageId,
      proposalId,
      status,
    }),
    approveInstallProposal: (chatId: string, messageId: string, proposalId: string) => ({
      chatId,
      messageId,
      proposalId,
    }),
    dismissInstallProposal: (chatId: string, messageId: string, proposalId: string) => ({
      chatId,
      messageId,
      proposalId,
    }),
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
    openChatScene: (sceneId: string) => ({ sceneId }),
    openChatApp: true,
    // The server stores a chat under its own id (the backend derives one per
    // project); its first event says which, and the chat moves there.
    rekeyChat: (fromId: string, toId: string) => ({ fromId, toId }),
  }),
  reducers({
    input: [
      '',
      {
        setInput: (_, { input }) => input,
        // Automatic render-check follow-ups must not clear a draft the user
        // may be typing while the check runs.
        submitMessage: (state, { renderCheckRound }) => (renderCheckRound ? state : ''),
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
          // An empty local chat gives way to a stored one about the same
          // thing; one the user already wrote in stays until the server
          // lists it (a list that loaded before the first message was stored).
          const localChats = state.filter(
            (chat: ChatSummary) =>
              !remoteIds.has(chat.id) &&
              (chat.isLocal ? (chat.messageCount ?? 0) > 0 || !remoteContextKeys.has(getChatContextKey(chat)) : false)
          )
          return [...remoteChats, ...localChats]
        },
        rekeyChat: (state, { fromId, toId }) =>
          state.some((chat) => chat.id === toId)
            ? state.filter((chat) => chat.id !== fromId)
            : state.map((chat) => (chat.id === fromId ? { ...chat, id: toId } : chat)),
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
        rekeyChat: (state, { fromId, toId }) => (state === fromId ? toId : state),
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
        rekeyChat: (state, { fromId, toId }) => {
          if (fromId === toId || !(fromId in state)) {
            return state
          }
          const { [fromId]: moved, ...rest } = state
          return { ...rest, [toId]: moved }
        },
        setProposalStatus: (state, { chatId, messageId, proposalId, status }) => ({
          ...state,
          [chatId]: (state[chatId] ?? []).map((message: ChatMessage) =>
            message.id === messageId
              ? {
                  ...message,
                  proposals: (message.proposals ?? []).map((entry) =>
                    entry.proposal.proposal_id === proposalId ? { ...entry, status } : entry
                  ),
                }
              : message
          ),
        }),
        dismissInstallProposal: (state, { chatId, messageId, proposalId }) => ({
          ...state,
          [chatId]: (state[chatId] ?? []).map((message: ChatMessage) =>
            message.id === messageId
              ? {
                  ...message,
                  proposals: (message.proposals ?? []).map((entry) =>
                    entry.proposal.proposal_id === proposalId
                      ? { ...entry, status: { state: 'dismissed' as const } }
                      : entry
                  ),
                }
              : message
          ),
        }),
        loadChatMessagesSuccess: (state, { chatId, messages }) => ({
          ...state,
          [chatId]: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            tool: message.tool ?? undefined,
            createdAt: message.createdAt,
            // Unapproved installs survive a reload: the card comes back
            // pending, and Approve still goes through the frame's own route.
            proposals: proposalsFromPayload(message.payload),
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
        // A chat this browser started holds every message already.
        rekeyChat: (state, { toId }) => ({ ...state, [toId]: true }),
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
      (s: any) => [s.scenes, s.activeSceneEditorId],
      (scenes: FrameScene[], activeSceneEditorId: string | null) =>
        scenes?.find((scene: FrameScene) => scene.id === activeSceneEditorId) ?? null,
    ],
    activeEditAppContext: [
      (s: any) => [s.activeEditApp],
      (activeEditApp: FrameEditor | null) => {
        if (!activeEditApp?.sceneId || !activeEditApp?.nodeId) {
          return null
        }
        return {
          sceneId: activeEditApp.sceneId,
          nodeId: activeEditApp.nodeId,
          nodeData: activeEditApp.nodeData ?? null,
        }
      },
    ],
    activeChat: [
      (s: any) => [s.chats, s.activeChatId],
      (chats: ChatSummary[], activeChatId: string | null) => chats.find((chat) => chat.id === activeChatId) ?? null,
    ],
    chatSceneId: [
      (s: any) => [s.activeChat, s.activeSceneEditorId],
      (activeChat: ChatSummary | null, activeSceneEditorId: string | null): string | null => {
        if (activeChat) {
          const contextType = getChatContextType(activeChat)
          if (contextType === 'scene') {
            return getChatContextId(activeChat) ?? null
          }
          return null
        }
        return activeSceneEditorId ?? null
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
        chatSceneId ? (scenes?.find((scene: FrameScene) => scene.id === chatSceneId)?.name ?? null) : null,
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
            return chat.frameId == null ? 'Chat' : 'Frame chat'
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
    // What the history lists a chat under: its first question. The server
    // names a stored chat by it (deriveChatTitle); one started in this
    // session is named by the question it holds.
    chatTitleForChat: [
      (s: any) => [s.messagesByChatId],
      (messagesByChatId: Record<string, ChatMessage[]>) =>
        (chat: ChatSummary): string | null =>
          chat.title ||
          (messagesByChatId[chat.id] ?? [])
            .find((message) => message.role === 'user' && !message.content.startsWith(RENDER_CHECK_PREFIX))
            ?.content.replace(/\s+/g, ' ')
            .trim() ||
          null,
    ],
    visibleChats: [
      (s: any) => [s.chats, (_: any, props: ChatLogicProps) => props.frameId],
      (chats: ChatSummary[], frameId: FrameId | null) =>
        chats
          .filter(
            (chat) =>
              (chat.messageCount === undefined || chat.messageCount > 0) &&
              // The frames home lists its own chats; a frame's chats are on the frame.
              (frameId !== null || (chat.frameId ?? null) === null)
          )
          // Newest first: a chat from this session sits after the stored
          // ones until the next load.
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    ],
    messages: [
      (s: any) => [s.messagesByChatId, s.activeChatId],
      (messagesByChatId: Record<string, ChatMessage[]>, activeChatId: string | null) =>
        activeChatId ? (messagesByChatId[activeChatId] ?? []) : [],
    ],
    contextItemsExpanded: [
      (s: any) => [s.contextItemsExpandedByChat, s.activeChatId],
      (contextItemsExpandedByChat: Record<string, Record<string, boolean>>, activeChatId: string | null) =>
        activeChatId ? (contextItemsExpandedByChat[activeChatId] ?? {}) : {},
    ],
    logExpanded: [
      (s: any) => [s.logExpandedByChat, s.activeChatId],
      (logExpandedByChat: Record<string, Record<string, boolean>>, activeChatId: string | null) =>
        activeChatId ? (logExpandedByChat[activeChatId] ?? {}) : {},
    ],
    historyForRequest: [
      (s) => [s.messages],
      (messages: ChatMessage[]) =>
        messages
          .filter(
            (message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0
          )
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
    approveInstallProposal: async ({ chatId, messageId, proposalId }) => {
      const message = (values.messagesByChatId[chatId] ?? []).find((entry: ChatMessage) => entry.id === messageId)
      const card = message?.proposals?.find((entry) => entry.proposal.proposal_id === proposalId)
      if (!card || card.status.state === 'approving') {
        return
      }
      const { proposal } = card
      actions.setProposalStatus(chatId, messageId, proposalId, { state: 'approving' })
      try {
        await installCloudFrameStoreScene(
          proposal.frame.id,
          proposal.scene.id,
          proposal.scene.version,
          proposal.declared_settings_groups
        )
        actions.setProposalStatus(chatId, messageId, proposalId, {
          state: 'installed',
          queued: !proposal.frame.connected,
        })
      } catch (error) {
        actions.setProposalStatus(chatId, messageId, proposalId, {
          state: 'failed',
          error: error instanceof Error ? error.message : 'The install was refused',
        })
      }
    },
    loadChats: async () => {
      if (isFrameControlMode()) {
        actions.loadChatsSuccess([], false, 0)
        return
      }
      try {
        // Cloud serves chats at the account origin; self-hosted scopes them
        // under the project. The frame-less chat asks for the frame-less ones,
        // so a page of the history is a page of chats it shows (visibleChats
        // still filters for a server from before `frameless`).
        const frameQuery = props.frameId !== null ? `frameId=${props.frameId}&` : 'frameless=1&'
        const path = await chatApiPath(
          `/api/ai/chats?${frameQuery}limit=${CHAT_PAGE_SIZE}&offset=0`,
          frameProjectId(values.frameForm, values.frame)
        )
        if (!path) {
          actions.loadChatsSuccess([], false, 0)
          return
        }
        const response = await apiFetch(path)
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
      if (isFrameControlMode()) {
        actions.loadMoreChatsSuccess([], false, values.chatsOffset)
        return
      }
      if (!values.hasMoreChats || values.isLoadingMoreChats) {
        return
      }
      try {
        const frameQuery = props.frameId !== null ? `frameId=${props.frameId}&` : 'frameless=1&'
        const path = await chatApiPath(
          `/api/ai/chats?${frameQuery}limit=${CHAT_PAGE_SIZE}&offset=${values.chatsOffset}`,
          frameProjectId(values.frameForm, values.frame)
        )
        if (!path) {
          actions.loadMoreChatsSuccess([], false, values.chatsOffset)
          return
        }
        const response = await apiFetch(path)
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
        (chat) =>
          getChatContextType(chat) === 'frame' &&
          getChatContextId(chat) === null &&
          // The frames home's chat list holds every frame's chats too.
          (props.frameId !== null || (chat.frameId ?? null) === null)
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
    backToList: () => {
      // The history opens on what is stored now: chats made in another tab
      // or by the AI box since the drawer opened.
      if (canListChats(props, values)) {
        actions.loadChats()
      }
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
      if (isFrameControlMode()) {
        actions.loadChatMessagesSuccess(chatId, [])
        return
      }
      try {
        const path = await chatApiPath(`/api/ai/chats/${chatId}`, frameProjectId(values.frameForm, values.frame))
        if (!path) {
          actions.loadChatMessagesSuccess(chatId, [])
          return
        }
        const response = await apiFetch(path)
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
    submitMessage: async ({ content, chatId: chatIdOverride, renderCheckRound }) => {
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
        if (!appContext || props.frameId === null) {
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
      const assistantMessageId = uuidv4()
      actions.setActiveRequestId(requestId)
      actions.setActiveLogMessageId(assistantMessageId)
      actions.setActiveLogStartTime(null)
      actions.appendMessage(chatId, { id: uuidv4(), role: 'user', content: prompt })
      actions.appendMessage(chatId, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        isPlaceholder: true,
        isStreaming: true,
      })
      const selectedScene = values.selectedScene
      // Where the chat lives once the server re-keyed it (rekeyChat).
      let rekeyedChatId: string | null = null
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
        {
          // The AI chat (docs/ai-chat.md): one streaming agentic loop, the
          // same on the cloud and the backend. Text arrives as real token
          // deltas, tool activity feeds the message's log pane, and
          // generated scenes are applied the moment they validate — on the
          // frame this chat is about; a frame-less chat has no editor, and
          // the assistant saves through its MCP tools instead.
          const frameId = props.frameId
          // Re-keyed by the server's `chat` event (rekeyChat).
          let turnChatId: string = chatId
          let streamedContent = ''
          let logContent = ''
          const proposals: ChatInstallProposal[] = []
          let progressLineIndex: number | null = null
          let finalTool: string | undefined
          let streamError: string | null = null
          let deliveredSceneId: string | null = null
          const applyBuildScenes = async (scenes: Record<string, any>[], title?: string): Promise<string | null> => {
            if (!scenes.length || frameId === null) {
              return null
            }
            const frameStore = frameLogic({ frameId })
            const existingSceneIds = new Set(frameStore.values.scenes.map((scene) => scene.id))
            const sanitizedScenes = scenes.map((scene: Partial<FrameScene>) => {
              const sanitizedScene = sanitizeScene(scene, frameStore.values.frameForm)
              return {
                ...sanitizedScene,
                settings: {
                  ...sanitizedScene.settings,
                  autoArrangeOnLoad: true,
                },
              }
            })
            await frameStore.asyncActions.applyTemplate({
              scenes: sanitizedScenes,
              name: title || 'AI Generated Scene',
            })
            await new Promise((resolve) => setTimeout(resolve, 0))
            const updatedScenes = frameStore.values.frameForm?.scenes ?? frameStore.values.scenes
            const newlyAddedScene = updatedScenes.find((scene) => !existingSceneIds.has(scene.id))
            if (newlyAddedScene) {
              scenesLogic({ frameId }).actions.focusScene(newlyAddedScene.id)
            }
            return newlyAddedScene?.id ?? null
          }
          // The assistant's render_scene looks at the scene the way this
          // frame's preview (and the render check below) draws it.
          const previewFrame = frameId !== null ? frameLogic({ frameId }).values : null
          const chatPath = isCloudMode()
            ? '/api/ai/chat'
            : await chatApiPath('/api/ai/chat', frameProjectId(values.frameForm, values.frame))
          if (!chatPath) {
            throw new Error('Could not find the project for this chat.')
          }
          await streamCloudAiChat(
            {
              prompt,
              chatId: turnChatId,
              frameId,
              editor: frameId !== null,
              sceneId: selectedScene?.id ?? null,
              scene: selectedScene ?? null,
              selectedNodes: selectedNodesPayload.length ? selectedNodesPayload : undefined,
              selectedEdges: selectedEdgesPayload.length ? selectedEdgesPayload : undefined,
              history: values.historyForRequest,
              renderSize: previewFrame
                ? wasmPreviewDimensions({
                    width: previewFrame.frameForm?.width ?? previewFrame.frame?.width,
                    height: previewFrame.frameForm?.height ?? previewFrame.frame?.height,
                    rotate: previewFrame.frameForm?.rotate ?? previewFrame.frame?.rotate,
                  })
                : undefined,
              timeZone:
                previewFrame?.frameForm?.timezone ??
                previewFrame?.frame?.timezone ??
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            async (event: CloudAiChatEvent) => {
              switch (event.type) {
                case 'chat':
                  if (event.chatId && event.chatId !== turnChatId) {
                    actions.rekeyChat(turnChatId, event.chatId)
                    turnChatId = event.chatId
                    rekeyedChatId = event.chatId
                  }
                  break
                case 'delta':
                  streamedContent += event.text
                  actions.updateMessage(turnChatId, assistantMessageId, {
                    content: streamedContent,
                    isPlaceholder: false,
                    isStreaming: true,
                  })
                  break
                case 'tool': {
                  const lines = logContent ? logContent.split('\n') : []
                  if (event.status === 'progress') {
                    // The model is still writing this call (e.g. a large
                    // scene): one line per call, its byte count updated.
                    const line = `${event.label} (${event.detail || 'writing…'})…`
                    if (progressLineIndex !== null) {
                      lines[progressLineIndex] = line
                    } else {
                      progressLineIndex = lines.length
                      lines.push(line)
                    }
                  } else if (event.status === 'start') {
                    if (progressLineIndex !== null) {
                      lines[progressLineIndex] = `${event.label}…`
                      progressLineIndex = null
                    } else {
                      lines.push(`${event.label}…`)
                    }
                  } else if (event.status === 'error') {
                    progressLineIndex = null
                    lines.push(`Failed: ${event.detail || event.label}`)
                  } else {
                    break
                  }
                  logContent = lines.join('\n')
                  actions.updateMessage(turnChatId, assistantMessageId, {
                    logContent,
                    isPlaceholder: false,
                  })
                  break
                }
                case 'proposal': {
                  // An Install card, not an install: the agent never deploys
                  // by itself (see add_scene_to_frame in the cloud).
                  if (!isCloudAiInstallProposal(event)) {
                    break
                  }
                  const index = proposals.findIndex((entry) => entry.proposal.proposal_id === event.proposal_id)
                  const entry = { proposal: event, status: { state: 'pending' as const } }
                  if (index === -1) {
                    proposals.push(entry)
                  } else {
                    proposals[index] = entry
                  }
                  actions.updateMessage(turnChatId, assistantMessageId, {
                    proposals: [...proposals],
                    isPlaceholder: false,
                  })
                  break
                }
                case 'scenes':
                  if (event.tool === 'build_scene') {
                    deliveredSceneId = (await applyBuildScenes(event.scenes ?? [], event.title)) ?? deliveredSceneId
                  } else {
                    const updatedScene = event.scenes?.[0]
                    const targetSceneId = updatedScene?.id || selectedScene?.id
                    if (updatedScene && targetSceneId && frameId !== null) {
                      actions.updateScene(targetSceneId, updatedScene)
                      deliveredSceneId = targetSceneId
                    }
                  }
                  break
                case 'done':
                  finalTool = event.tool
                  break
                case 'error':
                  streamError = event.detail
                  break
              }
            },
            {
              path: chatPath,
              onResume: ({ attempt, elapsedMs }) => {
                const lines = logContent ? logContent.split('\n') : []
                lines.push(`Connection dropped after ${formatElapsed(elapsedMs)} — reconnecting (attempt ${attempt})…`)
                logContent = lines.join('\n')
                actions.updateMessage(turnChatId, assistantMessageId, { logContent, isPlaceholder: false })
              },
            }
          )
          if (streamError) {
            throw new Error(streamError)
          }
          actions.updateMessage(turnChatId, assistantMessageId, {
            content: streamedContent || 'Done.',
            tool: finalTool ?? 'reply',
            isStreaming: false,
            isPlaceholder: false,
          })
          if (deliveredSceneId && frameId !== null) {
            // Render the delivered scene once in the wasm preview runtime and
            // hand runtime errors straight back to the agent — a scene that
            // validated as JSON can still fail at render time.
            logContent = `${logContent ? `${logContent}\n` : ''}Checking that the scene renders…`
            actions.updateMessage(turnChatId, assistantMessageId, { logContent })
            try {
              const frameValues = frameLogic({ frameId }).values
              // An ESP32 renders in a few megabytes: check the scene in that
              // much, so one that would run the frame out of memory goes back
              // to the assistant instead of onto the frame.
              const device = frameRenderDevice({ ...frameValues.frame, ...frameValues.frameForm })
              const check = await renderSceneCheck(
                {
                  id: frameId,
                  width: frameValues.frameForm?.width ?? frameValues.frame?.width,
                  height: frameValues.frameForm?.height ?? frameValues.frame?.height,
                  rotate: frameValues.frameForm?.rotate ?? frameValues.frame?.rotate,
                  name: frameValues.frameForm?.name ?? frameValues.frame?.name,
                  timezone: frameValues.frameForm?.timezone ?? frameValues.frame?.timezone,
                  device,
                },
                frameValues.frameForm?.scenes ?? frameValues.scenes,
                deliveredSceneId
              )
              const checkedAs = device ? ` in the frame's memory (${device.label})` : ''
              const uniqueErrors = Array.from(new Set(check.errors))
              if (check.unavailable) {
                // The runtime never started: that says nothing about the
                // scene, so the assistant is not asked to "fix" it.
                logContent = `${logContent}\nRender check skipped: the preview runtime is not available here`
                actions.updateMessage(turnChatId, assistantMessageId, { logContent })
              } else if (uniqueErrors.length === 0 && check.rendered) {
                logContent = `${logContent}\nRender check passed${checkedAs}${
                  check.renderMs !== null ? ` (${(check.renderMs / 1000).toFixed(1)}s)` : ''
                }`
                actions.updateMessage(turnChatId, assistantMessageId, { logContent })
              } else {
                const round = renderCheckRound ?? 0
                logContent = check.outOfMemory
                  ? `${logContent}\nRender check ran out of memory${checkedAs}`
                  : `${logContent}\nRender check found ${uniqueErrors.length || 'render'} problem${
                      uniqueErrors.length === 1 ? '' : 's'
                    }`
                actions.updateMessage(turnChatId, assistantMessageId, { logContent })
                if (round < MAX_RENDER_CHECK_ROUNDS) {
                  const reported = uniqueErrors.slice(0, 8)
                  const feedback =
                    `${RENDER_CHECK_PREFIX} I rendered the delivered scene with the in-browser preview runtime` +
                    `${checkedAs}${check.rendered ? '' : ' and it produced no image'}. It reported these errors:\n` +
                    reported.map((error) => `- ${error}`).join('\n') +
                    (uniqueErrors.length > reported.length
                      ? `\n(and ${uniqueErrors.length - reported.length} more)`
                      : '') +
                    (check.outOfMemory
                      ? '\nOn the frame this aborts the render and restarts the device. Make the scene need less ' +
                        'memory: every image the size of the frame is width x height x 4 bytes, so draw into the ' +
                        "frame's canvas instead of building full-size images, and keep fetched data small. Then " +
                        'deliver the corrected version.'
                      : '\nPlease fix the scene so it renders without errors and deliver the corrected version.')
                  actions.submitMessage(feedback, turnChatId, round + 1)
                  return
                }
              }
            } catch (checkError) {
              // The check is best-effort; never fail the chat over it.
              console.error('Render check failed', checkError)
            }
          }
          actions.setSubmitting(false)
          return
        }
      } catch (error) {
        console.error(error)
        actions.setError(error instanceof Error ? error.message : 'Failed to send chat message')
        actions.updateMessage(rekeyedChatId ?? chatId, assistantMessageId, {
          content: error instanceof Error ? error.message : 'Failed to send chat message',
          tool: 'error',
          isPlaceholder: false,
          isStreaming: false,
        })
      }
      actions.setSubmitting(false)
    },
    openChatScene: ({ sceneId }) => {
      if (props.frameId === null) {
        return
      }
      scenesLogic({ frameId: props.frameId }).actions.focusScene(sceneId)
      router.actions.push(urls.scenes(props.frameId, sceneId))
    },
    openChatApp: () => {
      const context = values.chatAppContext
      if (props.frameId === null || !context?.nodeData) {
        return
      }
      frameEditorsLogic({ frameId: props.frameId }).actions.editApp(context.sceneId, context.nodeId, context.nodeData)
      router.actions.push(urls.apps(props.frameId, context.sceneId, context.nodeId))
    },
  })),
  afterMount(({ actions, values, props }) => {
    if (canListChats(props, values)) {
      actions.loadChats()
    }
    if (values.activeEditAppContext) {
      actions.ensureChatForApp(values.activeEditAppContext.sceneId, values.activeEditAppContext.nodeId)
    } else if (values.scenesOpen) {
      actions.ensureFrameChat()
    }
  }),
  subscriptions(({ actions, values }) => ({
    activeSceneEditorId: (sceneId: string | null) => {
      if (!sceneId) {
        return
      }
      if (values.scenesOpen || values.activeEditAppContext) {
        return
      }
      actions.ensureChatForScene(sceneId)
    },
    activeEditApp: (editor: FrameEditor | null) => {
      if (!editor?.sceneId || !editor?.nodeId) {
        return
      }
      actions.ensureChatForApp(editor.sceneId, editor.nodeId)
    },
    chats: (chats: ChatSummary[]) => {
      if (!values.activeSceneEditorId) {
        return
      }
      if (values.scenesOpen || values.activeEditAppContext) {
        return
      }
      const matchingChat = chats.find(
        (chat) => getChatContextType(chat) === 'scene' && getChatContextId(chat) === values.activeSceneEditorId
      )
      if (matchingChat && matchingChat.id !== values.activeChatId) {
        actions.selectChat(matchingChat.id)
      }
    },
    frame: () => {
      if (
        !isFrameControlMode() &&
        !isCloudMode() &&
        frameProjectId(values.frameForm, values.frame) &&
        values.chats.length === 0
      ) {
        actions.loadChats()
      }
    },
    frameForm: () => {
      if (
        !isFrameControlMode() &&
        !isCloudMode() &&
        frameProjectId(values.frameForm, values.frame) &&
        values.chats.length === 0
      ) {
        actions.loadChats()
      }
    },
    scenesOpen: (scenesOpen: boolean) => {
      if (scenesOpen) {
        actions.ensureFrameChat()
      }
    },
  })),
])
