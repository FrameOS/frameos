import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Button } from '../../../../components/Button'
import { terminalLogic } from './terminalLogic'

// Convert a string with ANSI escape codes to HTML with inline styles.
// Supports basic 16-color foreground and background codes and reset (0).
function ansiToHtml(value: string): string {
  // remove unsupported escape sequences like terminal title and bracketed paste mode
  value = value.replace(/\x1b\]0;.*?\x07/g, '').replace(/\x1b\[[?]2004[hl]/g, '')

  const ansiRegex = /\x1b\[([0-9;]*)m/g
  const colors = [
    '#2e3440', // black
    '#bf616a', // red
    '#a3be8c', // green
    '#ebcb8b', // yellow
    '#81a1c1', // blue
    '#b48ead', // magenta
    '#88c0d0', // cyan
    '#e5e9f0', // white
  ] as const
  const escapeHtml = (str: string): string =>
    str.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
  let result = ''
  let lastIndex = 0
  const stack: string[] = []
  let match: RegExpExecArray | null
  while ((match = ansiRegex.exec(value)) !== null) {
    result += escapeHtml(value.slice(lastIndex, match.index))
    lastIndex = ansiRegex.lastIndex
    const codes = match[1].split(';').filter(Boolean).map(Number)
    for (const code of codes) {
      if (code === 0) {
        while (stack.length) {
          result += stack.pop()
        }
      } else if (code === 1) {
        result += '<span style="font-weight:bold">'
        stack.push('</span>')
      } else if (code >= 30 && code <= 37) {
        result += `<span style="color:${colors[code - 30]}">`
        stack.push('</span>')
      } else if (code >= 90 && code <= 97) {
        result += `<span style="color:${colors[code - 90]}">`
        stack.push('</span>')
      } else if (code >= 40 && code <= 47) {
        result += `<span style="background-color:${colors[code - 40]}">`
        stack.push('</span>')
      } else if (code >= 100 && code <= 107) {
        result += `<span style="background-color:${colors[code - 100]}">`
        stack.push('</span>')
      }
    }
  }
  result += escapeHtml(value.slice(lastIndex))
  while (stack.length) {
    result += stack.pop()
  }
  return result
}

export function Terminal() {
  const { frameId } = useValues(frameLogic)
  const { lines } = useValues(terminalLogic({ frameId }))
  const { connect, sendCommand } = useActions(terminalLogic({ frameId }))
  const [cmd, setCmd] = useState('')
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    connect()
  }, [])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCommand(cmd)
      setCmd('')
    }
  }

  return (
    <div className="flex flex-col h-full space-y-2 relative">
      <Virtuoso
        className="flex-1 bg-black text-white font-mono text-sm overflow-y-scroll overflow-x-hidden p-2 rounded"
        data={lines}
        ref={virtuosoRef}
        followOutput={(isBottom) => (isBottom ? 'smooth' : false)}
        atBottomStateChange={(bottom) => setAtBottom(bottom)}
        increaseViewportBy={{ top: 0, bottom: 600 }}
        initialTopMostItemIndex={lines.length - 1}
        itemContent={(_index, line) => (
          <div
            className="whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(line) || '&nbsp;' }}
          />
        )}
      />
      {!atBottom && (
        <Button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: lines.length - 1, behavior: 'smooth' })}
          color="secondary"
          size="small"
          className="absolute right-6 bottom-14"
        >
          Scroll to latest
        </Button>
      )}
      <div>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          className="w-full focus:outline-none p-1 rounded bg-black text-white"
          placeholder="enter command"
        />
      </div>
    </div>
  )
}
