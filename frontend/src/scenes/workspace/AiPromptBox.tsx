import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { KeyboardEvent } from 'react'
import { ArrowUpIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { aiPromptBoxLogic } from './aiPromptBoxLogic'
import type { FrameId } from '../../types'

/**
 * The AI box: where the frames home had its search, and above a frame's
 * scenes. Its placeholder cycles through example questions; Enter opens the
 * AI chat drawer with the question (workspaceLogic.startAiChat). The same
 * size and shape as the search box it replaced, a little wider, with a
 * moving gradient outline on hover and focus (`.frameos-ai-box` in index.css).
 */
export function AiPromptBox({ frameId, className }: { frameId: FrameId | null; className?: string }): JSX.Element {
  const logic = aiPromptBoxLogic({ frameId })
  const { input, currentExample, exampleIndex } = useValues(logic)
  const { setInput, submit, acceptExample } = useActions(logic)
  const label = frameId === null ? 'Ask AI about your frames' : 'Ask AI about this frame'

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Tab' && !event.shiftKey && !input) {
      event.preventDefault()
      acceptExample()
    }
  }

  return (
    <form
      role="search"
      aria-label={label}
      data-ai-prompt-box={frameId === null ? 'home' : 'frame'}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className={clsx('frameos-ai-box relative min-w-0 flex-1 rounded-2xl', className)}
    >
      <SparklesIcon
        aria-hidden
        className="frameos-ai-box-icon pointer-events-none absolute left-4 top-1/2 z-[2] h-5 w-5 -translate-y-1/2"
      />
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={label}
        enterKeyHint="send"
        autoComplete="off"
        className="frameos-input frameos-ai-box-input relative z-[1] h-12 w-full rounded-2xl border border-white/90 bg-white/90 pl-12 pr-14 text-base text-slate-900 shadow-lg shadow-slate-300/35 outline-none transition"
      />
      {!input ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-12 right-14 z-[2] flex items-center overflow-hidden"
        >
          {/* Keyed on the index: each new example restarts the slide-in. */}
          <span key={exampleIndex} className="frameos-ai-example truncate text-base text-slate-400">
            {currentExample}
          </span>
        </span>
      ) : null}
      <button
        type="submit"
        title="Ask"
        aria-label="Ask"
        disabled={!input.trim()}
        className={clsx(
          'frameos-ai-box-send absolute right-2 top-1/2 z-[2] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          input.trim() ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        <ArrowUpIcon className="h-4 w-4" />
      </button>
    </form>
  )
}
