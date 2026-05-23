import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import clsx from 'clsx'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { terminalLogic } from './terminalLogic'
import { workspaceLogic, type WorkspaceTheme } from '../../../workspace/workspaceLogic'

const terminalPalettes: Record<WorkspaceTheme, { foreground: readonly string[]; background: readonly string[] }> = {
  light: {
    foreground: [
      '#111827', // black
      '#b91c1c', // red
      '#15803d', // green
      '#a16207', // yellow
      '#1d4ed8', // blue
      '#7e22ce', // magenta
      '#0e7490', // cyan
      '#475569', // white
    ],
    background: [
      'rgba(15, 23, 42, 0.1)',
      'rgba(248, 113, 113, 0.22)',
      'rgba(74, 222, 128, 0.22)',
      'rgba(251, 191, 36, 0.24)',
      'rgba(96, 165, 250, 0.2)',
      'rgba(192, 132, 252, 0.2)',
      'rgba(45, 212, 191, 0.2)',
      'rgba(226, 232, 240, 0.82)',
    ],
  },
  dark: {
    foreground: [
      '#2e3440', // black
      '#bf616a', // red
      '#a3be8c', // green
      '#ebcb8b', // yellow
      '#81a1c1', // blue
      '#b48ead', // magenta
      '#88c0d0', // cyan
      '#e5e9f0', // white
    ],
    background: ['#2e3440', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
  },
}

// Convert a string with ANSI escape codes to HTML with inline styles.
// Supports basic 16-color foreground and background codes and reset (0).
function ansiToHtml(value: string, theme: WorkspaceTheme): string {
  // remove unsupported escape sequences like terminal title and bracketed paste mode
  value = value.replace(/\x1b\]0;.*?\x07/g, '').replace(/\x1b\[[?]2004[hl]/g, '')

  const ansiRegex = /\x1b\[([0-9;]*)m/g
  const colors = terminalPalettes[theme]
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
        result += `<span style="color:${colors.foreground[code - 30]}">`
        stack.push('</span>')
      } else if (code >= 90 && code <= 97) {
        result += `<span style="color:${colors.foreground[code - 90]}">`
        stack.push('</span>')
      } else if (code >= 40 && code <= 47) {
        result += `<span style="background-color:${colors.background[code - 40]}">`
        stack.push('</span>')
      } else if (code >= 100 && code <= 107) {
        result += `<span style="background-color:${colors.background[code - 100]}">`
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
  const { theme } = useValues(workspaceLogic)
  const { lines, commandInput, connectionState } = useValues(terminalLogic({ frameId }))
  const { connect, sendCommand, sendKeys, setCommandInput, historyPrev, historyNext } = useActions(
    terminalLogic({ frameId })
  )
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const commandBarRef = useRef<HTMLDivElement>(null)
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
        scrollToLatest('auto')
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

  const scrollToLatest = (behavior: 'auto' | 'smooth' = 'smooth') => {
    if (lines.length === 0) {
      return
    }
    virtuosoRef.current?.scrollToIndex({ index: lines.length - 1, align: 'end', behavior })
    requestAnimationFrame(() => {
      const offset = (commandBarRef.current?.offsetHeight ?? 112) + 24
      window.scrollBy({ top: offset, behavior })
    })
  }

  const connectionLabel =
    connectionState === 'connected' ? 'Connected' : connectionState === 'connecting' ? 'Connecting' : 'Closed'
  const connectionClassName =
    connectionState === 'connected'
      ? theme === 'dark'
        ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20'
        : 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20'
      : connectionState === 'connecting'
      ? theme === 'dark'
        ? 'bg-amber-400/10 text-amber-300 ring-amber-400/20'
        : 'bg-amber-500/10 text-amber-700 ring-amber-500/20'
      : theme === 'dark'
      ? 'bg-slate-100/10 text-slate-300 ring-white/10'
      : 'bg-slate-500/10 text-slate-600 ring-slate-500/20'

  const controlButtonClassName =
    'frameos-secondary-button h-10 shrink-0 rounded-full px-4 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

  return (
    <div
      className={clsx(
        'frame-tool-panel @container relative min-h-[calc(100vh-3rem)] w-full pb-44 @4xl:pb-28',
        theme === 'dark' ? 'text-slate-100' : 'text-slate-950'
      )}
    >
      <Virtuoso
        useWindowScroll
        className="min-h-[calc(100vh-13rem)] overflow-x-hidden font-mono text-sm leading-6"
        data={lines}
        ref={virtuosoRef}
        followOutput={(isBottom) => (isBottom ? 'auto' : false)}
        atBottomStateChange={(bottom) => {
          shouldStickToBottomRef.current = bottom
          setAtBottom(bottom)
        }}
        atBottomThreshold={200}
        increaseViewportBy={{ top: 0, bottom: 600 }}
        initialTopMostItemIndex={Math.max(lines.length - 1, 0)}
        itemContent={(_index, line) => (
          <div
            className="whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(line, theme) || '&nbsp;' }}
          />
        )}
      />
      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToLatest()}
          className="terminal-scroll-latest-button frameos-secondary-button rounded-full px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          Scroll to latest
        </button>
      )}
      <div
        ref={commandBarRef}
        className={clsx(
          'terminal-command-bar frameos-divider z-20 flex flex-col gap-3 rounded-[22px] border px-4 py-3 shadow-2xl shadow-slate-500/20 backdrop-blur-xl',
          theme === 'dark' ? 'border-white/10 bg-[#1b1c22]/90' : 'border-white/80 bg-white/90'
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="frameos-strong text-sm font-semibold text-slate-900">Terminal</div>
            <div
              className={clsx('rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset', connectionClassName)}
            >
              {connectionLabel}
            </div>
          </div>
          <DropdownMenu
            horizontal
            buttonColor="none"
            className="frameos-secondary-button flex h-10 w-10 items-center justify-center rounded-full !px-0 !py-0"
            items={[
              {
                label: 'Download log',
                onClick: downloadTerminalLog,
              },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2 @4xl:flex-row @4xl:items-center">
          <input
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="h-10 min-w-0 flex-1 rounded-full px-4 font-mono text-sm shadow-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400"
            placeholder="Enter command"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => sendCommand()} className={controlButtonClassName}>
              Send command
            </button>
            <button type="button" onClick={() => handleSendKeys(false)} className={controlButtonClassName}>
              Send keys
            </button>
            <button type="button" onClick={() => handleSendKeys(true)} className={controlButtonClassName}>
              Send CTRL
            </button>
            {connectionState === 'closed' && (
              <button type="button" onClick={() => connect()} className={controlButtonClassName}>
                Reconnect
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
