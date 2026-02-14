import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Button } from '../../../../components/Button'
import { DropdownMenu } from '../../../../components/DropdownMenu'
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
  const { lines, commandInput } = useValues(terminalLogic({ frameId }))
  const { connect, sendCommand, sendKeys, setCommandInput, historyPrev, historyNext } = useActions(terminalLogic({ frameId }))
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const shouldStickToBottomRef = useRef(true)

  useEffect(() => {
    connect()
  }, [])

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: lines.length - 1,
          align: 'end',
          behavior: 'auto',
        })
      })
    })
  }, [lines.length])

  const downloadTerminalLog = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `frame-${frameId}-terminal-log-${timestamp}.log`
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCommand()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      historyPrev()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      historyNext()
    }
  }

  const translateCtrlKeys = (value: string): string =>
    value
      .split('')
      .map((char) => {
        if (!char) {
          return ''
        }
        const upper = char.toUpperCase()
        const code = upper.charCodeAt(0)
        if (code >= 64 && code <= 95) {
          return String.fromCharCode(code - 64)
        }
        return char
      })
      .join('')

  const handleSendKeys = (withCtrl: boolean) => {
    if (!commandInput.trim()) {
      return
    }
    const payload = withCtrl ? translateCtrlKeys(commandInput) : commandInput
    if (payload) {
      sendKeys(payload)
    }
  }

  return (
    <div className="flex flex-col h-full space-y-2 relative">
      <DropdownMenu
        horizontal
        buttonColor="tertiary"
        className="absolute top-4 right-2 z-10"
        items={[
          {
            label: 'Download log',
            onClick: downloadTerminalLog,
          },
        ]}
      />
      <Virtuoso
        className="flex-1 bg-black text-white font-mono text-sm overflow-y-scroll overflow-x-hidden p-2 rounded"
        data={lines}
        ref={virtuosoRef}
        followOutput={(isBottom) => (isBottom ? 'auto' : false)}
        atBottomStateChange={(bottom) => {
          shouldStickToBottomRef.current = bottom
          setAtBottom(bottom)
        }}
        atBottomThreshold={200}
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          className="w-full focus:outline-none p-1 rounded bg-black text-white"
          placeholder="enter command"
        />
        <Button color="secondary" size="small" onClick={() => sendCommand()}>
          Send command
        </Button>
        <Button color="secondary" size="small" onClick={() => handleSendKeys(false)}>
          Send keys
        </Button>
        <Button color="secondary" size="small" onClick={() => handleSendKeys(true)}>
          Send CTRL
        </Button>
      </div>
    </div>
  )
}
