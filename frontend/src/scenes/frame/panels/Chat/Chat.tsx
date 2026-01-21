import { useActions, useValues } from 'kea'
import { chatLogic } from './chatLogic'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import { TextArea } from '../../../../components/TextArea'
import { useEffect, useRef } from 'react'
import clsx from 'clsx'

export function Chat() {
  const { frameId } = useValues(frameLogic)
  const { messages, input, isSubmitting, error, selectedSceneName } = useValues(chatLogic({ frameId }))
  const { setInput, submitMessage, clearChat } = useActions(chatLogic({ frameId }))
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!scrollRef.current) {
      return
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length])

  const handleSubmit = () => {
    submitMessage(input)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pb-2">
        <div className="text-sm text-gray-300">
          {selectedSceneName ? `Chat about "${selectedSceneName}"` : 'Chat about this frame'}
        </div>
        <Button color="secondary" size="small" onClick={() => clearChat()} disabled={isSubmitting}>
          Clear
        </Button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 ? (
          <div className="text-sm text-gray-400">
            Ask for a new scene, request edits to the current scene, or ask questions about FrameOS.
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
              <div>{message.content}</div>
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
          rows={3}
        />
        <div className="flex justify-end">
          <Button color="primary" onClick={handleSubmit} disabled={isSubmitting || !input.trim()}>
            {isSubmitting ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
