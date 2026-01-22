import { useActions, useValues } from 'kea'
import { chatLogic } from './chatLogic'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { Button } from '../../../../components/Button'
import { TextArea } from '../../../../components/TextArea'
import { Spinner } from '../../../../components/Spinner'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'

export function Chat() {
  const { frameId, scenes } = useValues(frameLogic)
  const { selectedSceneId } = useValues(panelsLogic({ frameId }))
  const {
    messages,
    input,
    isSubmitting,
    error,
    chatSceneName,
    contextItemsExpanded,
    chatView,
    chats,
    activeChatId,
    hasMoreChats,
    isLoadingChats,
    isLoadingMoreChats,
    chatMessagesLoading,
    isCreatingChat,
    contextSelectionSummary,
  } = useValues(chatLogic({ frameId, sceneId: selectedSceneId }))
  const {
    setInput,
    submitMessage,
    clearChat,
    toggleContextItemsExpanded,
    selectChat,
    backToList,
    createChat,
    loadMoreChats,
  } = useActions(chatLogic({ frameId, sceneId: selectedSceneId }))
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const shouldStickToBottomRef = useRef(true)
  const lastMessage = messages[messages.length - 1]
  const pendingAssistantPlaceholder =
    messages.length > 0 &&
    messages[messages.length - 1].isPlaceholder &&
    !messages[messages.length - 1].content &&
    !messages[messages.length - 1].tool
  const pendingThinkingIndex = pendingAssistantPlaceholder ? messages.length - 2 : null

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: messages.length - 1,
          align: 'end',
          behavior: 'auto',
        })
      })
    })
  }, [messages.length, lastMessage?.content, lastMessage?.isStreaming, lastMessage?.tool, lastMessage?.id])

  const handleSubmit = () => {
    submitMessage(input)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (!isSubmitting && input.trim()) {
        handleSubmit()
      }
    }
  }

  const sendButtonColor = input.trim() ? 'primary' : 'secondary'
  const isChatView = chatView === 'chat' && activeChatId
  const activeChatLoading = activeChatId ? chatMessagesLoading[activeChatId] : false

  const formatTimestamp = (timestamp?: string | null) => {
    if (!timestamp) {
      return 'Just now'
    }
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
      return 'Just now'
    }
    return date.toLocaleString()
  }

  const getSceneName = (sceneId?: string | null) => {
    if (!sceneId) {
      return 'Frame chat'
    }
    const scene = scenes?.find((item) => item.id === sceneId)
    return scene?.name ?? 'Frame chat'
  }

  const renderLogLine = (line: string) => {
    const contextMatch = line.match(/^(.*Selected \d+ context items: )(.+)$/)
    if (contextMatch) {
      const [, label, items] = contextMatch
      const tokens = items
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      const contextKey = `context-items:${line}`
      const isExpanded = contextItemsExpanded[contextKey] ?? false
      return (
        <div className="space-y-2">
          <button
            type="button"
            className="text-left text-slate-300 hover:text-slate-100 transition"
            onClick={() => activeChatId && toggleContextItemsExpanded(activeChatId, contextKey)}
          >
            {label.trim()}
            <span className="ml-2 text-xs text-slate-500">{isExpanded ? 'Hide' : 'Show'}</span>
          </button>
          {isExpanded ? (
            <div className="flex flex-wrap gap-2">
              {tokens.map((token) => {
                const typeMatch = token.match(/^\[([^\]]+)\]\s*(.*)$/)
                const typeLabel = typeMatch?.[1]
                const name = typeMatch?.[2] ?? token
                return (
                  <span
                    key={token}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-xs text-slate-200"
                  >
                    {typeLabel ? <span className="text-slate-400">[{typeLabel}]</span> : null}
                    <span className="break-all">{name}</span>
                  </span>
                )
              })}
            </div>
          ) : null}
        </div>
      )
    }

    const structuredMatch = line.match(/^(\d+(?:\.\d+)?s)\s+(\[[^\]]+\])\s+(.*)$/)
    if (structuredMatch) {
      const [, time, stage, message] = structuredMatch
      const statusMatch = message.match(/^(SUCCESS|ERROR):\s+(.*)$/)
      return (
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-slate-500">{time}</span>
          <span className="text-sky-300">{stage}</span>
          {statusMatch ? (
            <>
              <span className={clsx('font-semibold', statusMatch[1] === 'ERROR' ? 'text-red-400' : 'text-emerald-300')}>
                {statusMatch[1]}:
              </span>
              <span className="text-slate-100">{statusMatch[2]}</span>
            </>
          ) : (
            <span className="text-slate-100">{message}</span>
          )}
        </div>
      )
    }

    return <span className="text-slate-100">{line}</span>
  }

  const renderMessageBody = (messageContent: string, isLog: boolean) => {
    if (!messageContent) {
      return null
    }

    if (isLog) {
      const lines = messageContent.split('\n')
      return (
        <div className="space-y-2 font-mono text-xs">
          {lines.map((line, index) => (
            <div key={`${line}-${index}`} className="whitespace-pre-wrap break-words">
              {renderLogLine(line)}
            </div>
          ))}
        </div>
      )
    }

    return <div className="whitespace-pre-wrap break-words">{messageContent}</div>
  }

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-300 flex items-center gap-2">
          {isChatView ? (
            <Button color="secondary" size="small" onClick={() => backToList()}>
              Back
            </Button>
          ) : null}
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          {isChatView ? (chatSceneName ? `Chat about "${chatSceneName}"` : 'Chat about this frame') : 'Chats'}
        </div>
        <div className="flex items-center gap-2">
          <Button color="secondary" size="small" onClick={() => createChat()} disabled={isCreatingChat}>
            {isCreatingChat ? 'Creating…' : 'New chat'}
          </Button>
          {isChatView ? (
            <Button
              color="secondary"
              size="small"
              onClick={() => activeChatId && clearChat(activeChatId)}
              disabled={isSubmitting || !activeChatId}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      {isChatView ? (
        <>
          <div className="flex-1 relative rounded-2xl overflow-hidden">
            {activeChatLoading ? (
              <div className="flex h-full items-center justify-center text-slate-400">
                <Spinner className="text-slate-400" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
                <div className="space-y-2">
                  <div className="text-slate-200 font-medium">Start the conversation</div>
                  <div>
                    {chatSceneName
                      ? 'Ask for a new scene, request edits to the current scene, or ask questions about FrameOS.'
                      : 'Ask for a new scene, or ask questions about this frame or FrameOS.'}
                  </div>
                </div>
              </div>
            ) : (
              <Virtuoso
                className="h-full overflow-y-auto"
                ref={virtuosoRef}
                data={messages}
                followOutput={(isBottom) => (isBottom ? 'auto' : false)}
                atBottomStateChange={(bottom) => {
                  shouldStickToBottomRef.current = bottom
                  setAtBottom(bottom)
                }}
                atBottomThreshold={200}
                increaseViewportBy={{ top: 0, bottom: 300 }}
                initialTopMostItemIndex={messages.length - 1}
                itemContent={(index, message) => {
                  const isLog = message.tool === 'log'
                  const isUser = message.role === 'user'
                  if (message.isPlaceholder && !message.content && !message.tool) {
                    return null
                  }
                  return (
                    <div key={message.id} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
                      <div
                        className={clsx(
                          'rounded-2xl border px-4 py-3 text-sm shadow-sm mb-3 max-w-[90%] sm:max-w-[75%]',
                          isUser
                            ? 'border-blue-900/70 bg-blue-950/70 text-blue-100 shadow-[0_0_12px_rgba(30,64,175,0.25)]'
                            : isLog
                            ? 'border-slate-800/80 bg-slate-900/80 text-slate-100'
                            : 'border-slate-800/80 bg-slate-950/80 text-slate-100'
                        )}
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
                          <span className="uppercase tracking-wide">{message.role}</span>
                          {message.tool ? <span className="text-slate-500">tool: {message.tool}</span> : null}
                        </div>
                        <div>
                          {renderMessageBody(message.content, isLog)}
                          {pendingThinkingIndex === index && isLog && message.isStreaming ? (
                            <div className="inline-flex items-center gap-2 text-slate-300 pt-2">
                              <span>Thinking…</span>
                            </div>
                          ) : null}
                          {message.isStreaming ? <span className="ml-1 animate-pulse">▍</span> : null}
                        </div>
                      </div>
                    </div>
                  )
                }}
              />
            )}
            {!atBottom && messages.length > 0 ? (
              <Button
                onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })}
                color="secondary"
                size="small"
                className="absolute right-4 bottom-4"
              >
                Scroll to latest
              </Button>
            ) : null}
          </div>
          {error ? <div className="text-xs text-red-400 pt-2">{error}</div> : null}
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-2 space-y-2 shadow-inner">
            <TextArea
              value={input}
              placeholder="Describe a new scene, request a change, or ask a question..."
              onChange={(value) => setInput(value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="bg-slate-900/80 border-slate-700/80 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:ring-blue-500"
            />
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{contextSelectionSummary ?? 'Press Ctrl/Cmd + Enter to send'}</span>
              <Button
                color={sendButtonColor}
                size="tiny"
                onClick={handleSubmit}
                disabled={isSubmitting || !input.trim()}
              >
                {isSubmitting ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 rounded-2xl border border-slate-800/80 bg-slate-950/70 p-4 space-y-4 overflow-y-auto">
          {isLoadingChats ? (
            <div className="flex h-full items-center justify-center text-slate-400">
              <Spinner className="text-slate-400" />
            </div>
          ) : chats.length === 0 ? (
            <div className="text-sm text-slate-400">No chats yet. Start a new conversation.</div>
          ) : (
            <div className="space-y-2">
              {chats.map((chat) => {
                const isActive = chat.id === activeChatId
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className={clsx(
                      'w-full text-left rounded-xl border px-4 py-3 transition',
                      isActive
                        ? 'border-blue-800/80 bg-blue-950/60 text-blue-100'
                        : 'border-slate-800/80 bg-slate-900/60 text-slate-200 hover:bg-slate-900/80'
                    )}
                    onClick={() => selectChat(chat.id)}
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{getSceneName(chat.sceneId)}</span>
                      <span className="text-xs text-slate-500">{formatTimestamp(chat.updatedAt)}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">Chat ID: {chat.id}</div>
                  </button>
                )
              })}
            </div>
          )}
          {hasMoreChats ? (
            <div className="flex justify-center pt-2">
              <Button color="secondary" size="small" onClick={() => loadMoreChats()} disabled={isLoadingMoreChats}>
                {isLoadingMoreChats ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
