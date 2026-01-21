import { useActions, useValues } from 'kea'
import { chatLogic } from './chatLogic'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { Button } from '../../../../components/Button'
import { TextArea } from '../../../../components/TextArea'
import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Spinner } from '../../../../components/Spinner'

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pb-2">
        <div className="text-sm text-gray-300">
          {chatSceneName ? `Chat about "${chatSceneName}"` : 'Chat about this frame'}
        </div>
        <Button color="secondary" size="small" onClick={() => clearChat()} disabled={isSubmitting}>
          Clear
        </Button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1" onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="text-sm text-gray-400">
            {chatSceneName
              ? 'Ask for a new scene, request edits to the current scene, or ask questions about FrameOS.'
              : 'Ask for a new scene, or ask questions about this frame or FrameOS.'}
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={clsx(
                'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                message.role === 'user'
                  ? 'bg-blue-950 text-blue-100 border border-blue-900'
                  : 'bg-gray-900 text-gray-100 border border-gray-800'
              )}
            >
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                <span className="uppercase tracking-wide">{message.role}</span>
                {message.tool ? <span>tool: {message.tool}</span> : null}
              </div>
              {message.isPlaceholder && !message.content ? (
                <div className="flex items-center gap-2 text-gray-300">
                  <Spinner className="shrink-0" />
                  <span>Thinking…</span>
                </div>
              ) : (
                <div>
                  {message.content}
                  {message.isStreaming ? <span className="ml-1 animate-pulse">▍</span> : null}
                </div>
              )}
            </div>
          ))
        )}
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
