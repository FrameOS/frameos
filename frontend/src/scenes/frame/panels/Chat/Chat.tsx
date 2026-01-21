import { useActions, useValues } from 'kea'
import { chatLogic } from './chatLogic'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { Button } from '../../../../components/Button'
import { TextArea } from '../../../../components/TextArea'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Spinner } from '../../../../components/Spinner'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'

export function Chat() {
  const { frameId } = useValues(frameLogic)
  const { selectedSceneId } = useValues(panelsLogic({ frameId }))
  const { messages, input, isSubmitting, error, chatSceneName } = useValues(
    chatLogic({ frameId, sceneId: selectedSceneId })
  )
  const { setInput, submitMessage, clearChat } = useActions(chatLogic({ frameId, sceneId: selectedSceneId }))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)

  const lastMessage = messages[messages.length - 1]

  useEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    if (shouldAutoScrollRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages.length, lastMessage?.content])
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const shouldStickToBottomRef = useRef(true)

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
  }, [messages.length])

  const handleScroll = () => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    const threshold = 24
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom <= threshold
  }

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

  const renderLogLine = (line: string) => {
    const contextMatch = line.match(/^(.*Selected \d+ context items: )(.+)$/)
    if (contextMatch) {
      const [, label, items] = contextMatch
      const tokens = items
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      return (
        <div className="space-y-2">
          <div className="text-slate-300">{label.trim()}</div>
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pb-2">
        <div className="text-sm text-slate-300">
          {chatSceneName ? `Chat about "${chatSceneName}"` : 'Chat about this frame'}
        </div>
        <Button color="secondary" size="small" onClick={() => clearChat()} disabled={isSubmitting}>
          Clear
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 relative rounded-xl shadow-inner overflow-y-auto space-y-3"
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <div className="text-sm text-slate-400">
            {chatSceneName
              ? 'Ask for a new scene, request edits to the current scene, or ask questions about FrameOS.'
              : 'Ask for a new scene, or ask questions about this frame or FrameOS.'}
          </div>
        ) : (
          <Virtuoso
            className="h-full overflow-y-auto pr-1"
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
            itemContent={(_index, message) => {
              const isLog = message.tool === 'log'
              const isUser = message.role === 'user'
              return (
                <div
                  key={message.id}
                  className={clsx(
                    'rounded-lg border px-3 py-2 text-sm shadow-sm mb-3',
                    isUser
                      ? 'border-blue-900/70 bg-blue-950/60 text-blue-100'
                      : isLog
                      ? 'border-slate-800/80 bg-slate-900/70 text-slate-100'
                      : 'border-slate-800/80 bg-slate-950/70 text-slate-100'
                  )}
                >
                  <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
                    <span className="uppercase tracking-wide">{message.role}</span>
                    {message.tool ? <span className="text-slate-500">tool: {message.tool}</span> : null}
                  </div>
                  {message.isPlaceholder && !message.content ? (
                    <div className="inline-flex items-center gap-2 text-slate-300">
                      <span>Thinking…</span>
                      <Spinner className="h-3 w-3" />
                    </div>
                  ) : (
                    <div>
                      {renderMessageBody(message.content, isLog)}
                      {message.isStreaming ? <span className="ml-1 animate-pulse">▍</span> : null}
                    </div>
                  )}
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
      <div className="pt-3 space-y-2">
        <TextArea
          value={input}
          placeholder="Describe a new scene, request a change, or ask a question..."
          onChange={(value) => setInput(value)}
          onKeyDown={handleKeyDown}
          rows={3}
        />
        <div className="flex justify-end">
          <Button color={sendButtonColor} size="tiny" onClick={handleSubmit} disabled={isSubmitting || !input.trim()}>
            {isSubmitting ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
