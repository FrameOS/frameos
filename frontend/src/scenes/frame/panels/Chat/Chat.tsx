import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import { chatLogic } from './chatLogic'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { scenesLogic } from '../Scenes/scenesLogic'
import { settingsLogic } from '../../../settings/settingsLogic'
import { Button } from '../../../../components/Button'
import { TextArea } from '../../../../components/TextArea'
import { Spinner } from '../../../../components/Spinner'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Area, Panel } from '../../../../types'
import { ChevronLeftIcon } from '@heroicons/react/24/solid'
import { urls } from '../../../../urls'

export function Chat() {
  const { frameId, scenes } = useValues(frameLogic)
  const { selectedSceneId, panels } = useValues(panelsLogic({ frameId }))
  const { savedSettings } = useValues(settingsLogic)
  const {
    messages,
    input,
    isSubmitting,
    error,
    chatSceneName,
    chatSceneId,
    chatContextType,
    chatAppContext,
    contextItemsExpanded,
    chatView,
    visibleChats,
    activeChatId,
    hasMoreChats,
    isLoadingChats,
    isLoadingMoreChats,
    chatMessagesLoading,
    isCreatingChat,
    contextSelectionSummary,
    logExpanded,
    chatLabelForChat,
  } = useValues(chatLogic({ frameId, sceneId: selectedSceneId }))
  const {
    setInput,
    submitMessage,
    clearChat,
    toggleContextItemsExpanded,
    toggleLogExpanded,
    selectChat,
    backToList,
    createChat,
    loadMoreChats,
  } = useActions(chatLogic({ frameId, sceneId: selectedSceneId }))
  const { setPanel, editApp } = useActions(panelsLogic({ frameId }))
  const { focusScene } = useActions(scenesLogic({ frameId }))
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerElementRef = useRef<HTMLElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const lastMessage = messages[messages.length - 1]
  const isChatView = chatView === 'chat' && activeChatId
  const hasBackendApiKey = Boolean(savedSettings?.openAI?.backendApiKey?.trim())
  const missingBackendApiKey = !hasBackendApiKey

  const focusSceneById = (sceneId: string) => {
    const scenesPanel = panels?.[Area.TopLeft]?.find((panel) => panel.panel === Panel.Scenes)
    if (scenesPanel) {
      setPanel(Area.TopLeft, scenesPanel)
    }
    focusScene(sceneId)
    router.actions.push(urls.scenes(frameId, sceneId))
  }

  const appLabel =
    chatAppContext?.nodeData?.name || chatAppContext?.nodeData?.keyword || chatAppContext?.nodeId || 'this app'

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

  useEffect(() => {
    const scroller = scrollerElementRef.current
    if (!scroller) {
      return
    }

    const disableFollowIfNeeded = () => {
      if (!shouldStickToBottomRef.current) {
        return
      }
      shouldStickToBottomRef.current = false
      setAtBottom(false)
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        disableFollowIfNeeded()
      }
    }

    const handleTouchMove = () => {
      disableFollowIfNeeded()
    }

    scroller.addEventListener('wheel', handleWheel, { passive: true })
    scroller.addEventListener('touchmove', handleTouchMove, { passive: true })

    return () => {
      scroller.removeEventListener('wheel', handleWheel)
      scroller.removeEventListener('touchmove', handleTouchMove)
    }
  }, [isChatView])

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
  const activeChatLoading = activeChatId ? chatMessagesLoading[activeChatId] : false

  const handleSceneLinkClick = (event: React.MouseEvent<HTMLAnchorElement>, sceneId?: string | null) => {
    if (!sceneId) {
      return
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return
    }
    event.preventDefault()
    focusSceneById(sceneId)
  }

  const handleOpenScene = (event: React.MouseEvent<HTMLAnchorElement>) => {
    handleSceneLinkClick(event, chatSceneId)
  }

  const handleOpenApp = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (!chatAppContext?.nodeData) {
      return
    }
    editApp(chatAppContext.sceneId, chatAppContext.nodeId, chatAppContext.nodeData)
    router.actions.push(urls.apps(frameId, chatAppContext.sceneId, chatAppContext.nodeId))
  }

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

  const normalizeGeneratedSceneName = (sceneName: string) =>
    sceneName
      .replace(/\.$/, '')
      .replace(/^["']|["']$/g, '')
      .trim()

  const extractGeneratedSceneName = (message: string) => {
    const match = message.match(/(?:Scene generated|Generated a new scene):\s*(.+)$/)
    if (!match) {
      return null
    }
    return normalizeGeneratedSceneName(match[1])
  }

  const renderGeneratedSceneMessage = (sceneName: string) => {
    const targetScene = scenes?.find((scene) => scene.name === sceneName)
    const label = sceneName || 'Untitled scene'
    return (
      <>
        <span>Scene generated: </span>
        {targetScene ? (
          <a
            href={urls.scenes(frameId, targetScene.id)}
            onClick={(event) => handleSceneLinkClick(event, targetScene.id)}
            className="text-sky-300 hover:text-sky-200 underline underline-offset-2 decoration-sky-300/70"
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
      </>
    )
  }

  const stripBracketSegments = (value: string) =>
    value
      .replace(/\s*\[[^\]]+\]\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  const stripReviewIssues = (value: string) => {
    const match = value.match(/^(WARNING: Scene review issues:)\s*(\[.*\])$/)
    return match ? match[1] : value
  }

  const renderLogLine = (
    line: string,
    options: { showStage?: boolean; showDetails?: boolean } = { showStage: true, showDetails: true }
  ) => {
    const { showStage = true, showDetails = true } = options
    const lineWithReview = showDetails ? line : stripReviewIssues(line)

    const contextMatch = line.match(/^(.*Selected \d+ context items: )(.+)$/)
    if (contextMatch) {
      const [, label, items] = contextMatch
      if (!showDetails) {
        return <span>{label.trim()}</span>
      }
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
            className="frameos-link text-left transition"
            onClick={() => activeChatId && toggleContextItemsExpanded(activeChatId, contextKey)}
          >
            {label.trim()}
            <span className="frame-tool-muted ml-2 text-xs">{isExpanded ? 'Hide' : 'Show'}</span>
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
                    className="frameos-tag inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                  >
                    {typeLabel ? <span className="frame-tool-muted">[{typeLabel}]</span> : null}
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
      const statusMessage = statusMatch ? statusMatch[2] : message
      const filteredStatusMessage = showDetails ? statusMessage : stripReviewIssues(statusMessage)
      const generatedSceneName = extractGeneratedSceneName(statusMessage)
      return (
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          <span className="frame-tool-muted">{time}</span>
          {showStage ? <span className="frameos-link">{stage}</span> : null}
          {statusMatch ? (
            <span className={clsx('font-semibold', statusMatch[1] === 'ERROR' ? 'text-red-400' : 'text-emerald-300')}>
              {statusMatch[1]}:
            </span>
          ) : null}
          {generatedSceneName ? (
            <span>{renderGeneratedSceneMessage(generatedSceneName)}</span>
          ) : statusMatch ? (
            <span>{filteredStatusMessage}</span>
          ) : (
            <span>
              {showStage
                ? filteredStatusMessage
                : stripBracketSegments(showDetails ? message : stripReviewIssues(message))}
            </span>
          )}
        </div>
      )
    }

    const sanitizedLine = showStage ? lineWithReview : stripBracketSegments(lineWithReview)
    const generatedSceneName = extractGeneratedSceneName(lineWithReview)
    if (generatedSceneName) {
      return <span>{renderGeneratedSceneMessage(generatedSceneName)}</span>
    }

    return <span>{sanitizedLine}</span>
  }

  const renderLogMessage = (messageContent: string, messageId: string, isStreaming?: boolean) => {
    const lines = messageContent ? messageContent.split('\n') : []
    const displayLines = lines.length > 0 ? lines : ['Thinking…']
    const lastLine = displayLines[displayLines.length - 1] ?? ''
    const isExpanded = logExpanded[messageId] ?? false
    const canExpand = displayLines.length > 1

    if (!isExpanded) {
      return (
        <button
          type="button"
          className={clsx('flex w-full items-start text-left', canExpand ? 'cursor-pointer' : 'cursor-default')}
          onClick={() => activeChatId && canExpand && toggleLogExpanded(activeChatId, messageId)}
          disabled={!canExpand}
        >
          {isStreaming ? <Spinner className="h-4 w-4 mr-2" /> : <span className="h-4 w-4" />}
          <span className={clsx('flex-1 text-sm', isStreaming ? 'opacity-70' : '')}>
            {renderLogLine(lastLine, { showStage: false, showDetails: false })}
          </span>
          {isStreaming ? (
            <div className="w-2">
              <span className="ai-scene-ellipsis frame-tool-muted" />
            </div>
          ) : null}
        </button>
      )
    }

    return (
      <div className="space-y-2 text-sm">
        {displayLines.map((line, index) => (
          <div key={`${line}-${index}`} className="whitespace-pre-wrap break-words">
            {renderLogLine(line)}
          </div>
        ))}
        <button
          type="button"
          className="frameos-link text-xs transition"
          onClick={() => activeChatId && toggleLogExpanded(activeChatId, messageId)}
        >
          Hide log steps
        </button>
      </div>
    )
  }

  const renderMessageBody = (messageContent: string, isLog: boolean, messageId: string, isStreaming?: boolean) => {
    if (isLog) {
      return renderLogMessage(messageContent, messageId, isStreaming)
    }

    if (!messageContent) {
      if (isStreaming) {
        return (
          <div className="frame-tool-muted flex items-center gap-2">
            <Spinner className="h-4 w-4" />
            <span className="text-sm">Thinking…</span>
          </div>
        )
      }
      return null
    }

    const generatedSceneName = extractGeneratedSceneName(messageContent.trim())
    if (generatedSceneName) {
      return <div className="whitespace-pre-wrap break-words">{renderGeneratedSceneMessage(generatedSceneName)}</div>
    }

    return <div className="whitespace-pre-wrap break-words">{messageContent}</div>
  }

  return (
    <div className="flex h-full flex-col gap-3 @container">
      {missingBackendApiKey ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700">
          <div className="font-semibold">OpenAI backend API key not configured.</div>
          <div className="mt-1 opacity-80">Add the backend API key in Settings to enable chat responses.</div>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="frame-tool-muted text-sm flex items-center gap-2">
          {isChatView ? (
            <Button color="secondary" size="small" onClick={() => backToList()}>
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
          ) : null}
          {isChatView ? (
            chatSceneName ? (
              <span>
                Chat about{' '}
                <a
                  href={chatSceneId ? urls.scenes(frameId, chatSceneId) : '#'}
                  onClick={handleOpenScene}
                  className="frameos-link underline underline-offset-2 inline"
                >
                  &quot;{chatSceneName}&quot;
                </a>
              </span>
            ) : chatContextType === 'app' ? (
              <span>
                Chat about{' '}
                {chatAppContext?.nodeData ? (
                  <a href="#" onClick={handleOpenApp} className="frameos-link underline underline-offset-2 inline">
                    &quot;{appLabel}&quot;
                  </a>
                ) : (
                  `"${appLabel}"`
                )}
              </span>
            ) : (
              'Chat about this frame'
            )
          ) : (
            'Chats'
          )}
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
              <div className="frame-tool-muted flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : messages.length === 0 ? (
              <div className="frame-tool-muted flex h-full items-center justify-center px-6 text-center text-sm">
                <div className="space-y-2">
                  <div className="frameos-strong font-medium">Start the conversation</div>
                  <div>
                    {chatContextType === 'app'
                      ? 'Ask for edits to this app, or ask questions about how it works.'
                      : chatSceneName
                      ? 'Ask for a new scene, request edits to the current scene, or ask questions about FrameOS.'
                      : 'Ask for a new scene, or ask questions about this frame or FrameOS.'}
                  </div>
                </div>
              </div>
            ) : (
              <Virtuoso
                className="h-full overflow-y-auto"
                ref={virtuosoRef}
                scrollerRef={(node) => {
                  if (node && node instanceof HTMLElement) {
                    scrollerElementRef.current = node
                  }
                }}
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
                    if (!message.isStreaming) {
                      return null
                    }
                    return (
                      <div key={message.id} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
                        <div
                          className={clsx(
                            'mb-3 max-w-[90%] rounded-2xl border px-4 py-3 text-sm shadow-sm @md:max-w-[75%]',
                            isUser ? 'frameos-chat-bubble-user' : 'frameos-chat-bubble'
                          )}
                        >
                          <div className="frame-tool-muted flex items-center justify-between text-[11px] mb-2">
                            <span className="uppercase tracking-wide">{message.role}</span>
                          </div>
                          <div className="frame-tool-muted flex items-center gap-2 text-sm">
                            <Spinner className="h-4 w-4" />
                            <span>Thinking…</span>
                          </div>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={message.id} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
                      <div
                        className={clsx(
                          'mb-3 max-w-[90%] rounded-2xl border px-4 py-3 text-sm shadow-sm @md:max-w-[75%]',
                          isUser
                            ? 'frameos-chat-bubble-user'
                            : isLog
                            ? 'frameos-chat-bubble-log'
                            : 'frameos-chat-bubble'
                        )}
                      >
                        <div className="frame-tool-muted flex items-center justify-between text-[11px] mb-2">
                          <span className="uppercase tracking-wide">{message.role}</span>
                          {message.tool ? <span>tool: {message.tool}</span> : null}
                        </div>
                        <div>{renderMessageBody(message.content, isLog, message.id, message.isStreaming)}</div>
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
          <div className="frameos-inset rounded-2xl border p-2 space-y-2 shadow-inner">
            <TextArea
              value={input}
              placeholder={
                chatContextType === 'app'
                  ? 'Describe a change to this app, or ask about it...'
                  : 'Describe a new scene, request a change, or ask a question...'
              }
              onChange={(value) => setInput(value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="min-h-24"
            />
            <div className="frame-tool-muted flex items-center justify-between text-xs">
              <span>{contextSelectionSummary ?? 'Press Ctrl/Cmd + Enter to send'}</span>
              <Button
                color={sendButtonColor}
                size="tiny"
                onClick={handleSubmit}
                disabled={isSubmitting || !input.trim() || missingBackendApiKey}
              >
                {isSubmitting ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="frameos-inset flex-1 rounded-2xl border p-4 space-y-4 overflow-y-auto">
          {isLoadingChats ? (
            <div className="frame-tool-muted flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : visibleChats.length === 0 ? (
            <div className="frame-tool-muted text-sm">No chats yet. Start a new conversation.</div>
          ) : (
            <div className="space-y-2">
              {visibleChats.map((chat) => {
                const isActive = chat.id === activeChatId
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className={clsx(
                      'w-full text-left rounded-xl border px-4 py-3 transition',
                      isActive
                        ? 'frameos-primary-soft-active frameos-primary-border-strong'
                        : 'frameos-chat-bubble hover:bg-white/70'
                    )}
                    onClick={() => selectChat(chat.id)}
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{chatLabelForChat(chat)}</span>
                      <span className="frame-tool-muted text-xs">{formatTimestamp(chat.updatedAt)}</span>
                    </div>
                    <div className="frame-tool-muted text-xs mt-1">Chat ID: {chat.id}</div>
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
