import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers } from 'kea'

import type { terminalLogicType } from './terminalLogicType'
import { frameLogic } from '../../frameLogic'
import { getBasePath } from '../../../../utils/getBasePath'

export interface TerminalLogicProps {
  frameId: number
}

// Convert a string with ANSI escape codes to HTML with inline styles.
// Supports basic 16-color foreground and background codes and reset (0).
function ansiToHtml(value: string): string {
  // remove unsupported escape sequences like terminal title and bracketed paste mode
  value = value.replace(/\x1b\]0;.*?\x07/g, '').replace(/\x1b\[[?]2004[hl]/g, '')

  const ansiRegex = /\x1b\[([0-9;]*)m/g
  const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
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

export const terminalLogic = kea<terminalLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Terminal', 'terminalLogic']),
  props({} as TerminalLogicProps),
  key((props) => props.frameId),
  connect(() => ({
    values: [frameLogic, ['frame']],
  })),
  actions({
    connect: true,
    disconnect: true,
    appendText: (text: string) => ({ text }),
    setLines: (lines: string[]) => ({ lines }),
    sendCommand: (command: string) => ({ command }),
    sendKeys: (keys: string) => ({ keys }),
  }),
  reducers({
    // ansi encoded lines
    lines: [
      [],
      {
        appendText: (state, { text }) => {
          const parts = text.split(/\r?\n/)
          if (state.length > 0) {
            parts[0] = state[state.length - 1] + parts[0]
            return [...state.slice(0, -1), ...parts]
          }
          return parts
        },
      },
    ],
  }),
  listeners(({ actions, values, cache }) => ({
    connect: () => {
      if (cache.ws) {
        // already connected
        return
      }
      const { frame } = values
      if (frame.agent?.agentEnabled) {
        actions.appendText(
          '*** Terminal access is only available over SSH; agent connections do not provide a shell. ***\n'
        )
      }
      actions.appendText(`***connecting to ${frame.ssh_user}@${frame.frame_host} via SSH***\n`)
      const ws = new WebSocket(`${getBasePath()}/ws/terminal/${frame.id}`)
      ws.onmessage = (event) => actions.appendText(event.data)
      ws.onclose = () => actions.appendText('\n*** connection closed ***\n')
      cache.ws = ws
    },
    disconnect: () => {
      if (cache.ws) {
        cache.ws.close()
        cache.ws = null
      }
    },
    sendCommand: ({ command }) => {
      cache.ws?.send(command + '\n')
    },
    sendKeys: ({ keys }) => {
      cache.ws?.send(keys)
    },
  })),
  afterMount(({ cache }) => {
    cache.ws = null
  }),
  beforeUnmount(({ cache }) => {
    if (cache.ws) {
      cache.ws.close()
      cache.ws = null
    }
  }),
])
