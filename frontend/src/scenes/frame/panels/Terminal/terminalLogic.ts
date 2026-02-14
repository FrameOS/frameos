import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers } from 'kea'

import type { terminalLogicType } from './terminalLogicType'
import { frameLogic } from '../../frameLogic'
import { getBasePath } from '../../../../utils/getBasePath'
import { apiFetch } from '../../../../utils/apiFetch'

export interface TerminalLogicProps {
  frameId: number
}

const MAX_HISTORY_SIZE = 200

function nextCommandHistory(history: string[], command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) {
    return history
  }
  if (history[history.length - 1] === trimmed) {
    return history
  }
  const next = [...history, trimmed]
  return next.length > MAX_HISTORY_SIZE ? next.slice(next.length - MAX_HISTORY_SIZE) : next
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
    setCommandInput: (commandInput: string) => ({ commandInput }),
    setCommandFromHistory: (commandInput: string) => ({ commandInput }),
    sendCommand: true,
    executeCommand: (command: string) => ({ command }),
    sendKeys: (keys: string) => ({ keys }),
    historyPrev: true,
    historyNext: true,
    initializeHistory: (history: string[]) => ({ history }),
    setHistoryIndex: (historyIndex: number | null) => ({ historyIndex }),
    setNavigationDraft: (navigationDraft: string) => ({ navigationDraft }),
  }),
  reducers({
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
    commandInput: [
      '',
      {
        setCommandInput: (_, { commandInput }) => commandInput,
        setCommandFromHistory: (_, { commandInput }) => commandInput,
        executeCommand: () => '',
      },
    ],
    commandHistory: [
      [] as string[],
      {
        initializeHistory: (_, { history }) => history,
        executeCommand: (state, { command }) => nextCommandHistory(state, command),
      },
    ],
    historyIndex: [
      null as number | null,
      {
        setHistoryIndex: (_, { historyIndex }) => historyIndex,
        setCommandInput: () => null,
        executeCommand: () => null,
      },
    ],
    navigationDraft: [
      '',
      {
        setNavigationDraft: (_, { navigationDraft }) => navigationDraft,
        setCommandInput: (_, { commandInput }) => commandInput,
        executeCommand: () => '',
      },
    ],
  }),
  listeners(({ actions, values, cache, props }) => ({
    connect: () => {
      if (cache.ws) {
        return
      }
      const { frame } = values
      actions.initializeHistory(frame.terminal_history || [])
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
    sendCommand: async () => {
      const command = values.commandInput.trim()
      if (!command) {
        return
      }
      const updatedHistory = nextCommandHistory(values.commandHistory, command)
      actions.executeCommand(command)
      cache.ws?.send(command + '\n')
      await apiFetch(`/api/frames/${props.frameId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal_history: updatedHistory }),
      })
    },
    historyPrev: () => {
      const history = values.commandHistory
      if (!history.length) {
        return
      }
      if (values.historyIndex === null) {
        actions.setNavigationDraft(values.commandInput)
        actions.setHistoryIndex(history.length - 1)
        actions.setCommandFromHistory(history[history.length - 1])
        return
      }
      const nextIndex = Math.max(0, values.historyIndex - 1)
      actions.setHistoryIndex(nextIndex)
      actions.setCommandFromHistory(history[nextIndex])
    },
    historyNext: () => {
      const history = values.commandHistory
      if (!history.length || values.historyIndex === null) {
        return
      }
      if (values.historyIndex >= history.length - 1) {
        actions.setHistoryIndex(null)
        actions.setCommandFromHistory(values.navigationDraft)
        return
      }
      const nextIndex = values.historyIndex + 1
      actions.setHistoryIndex(nextIndex)
      actions.setCommandFromHistory(history[nextIndex])
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
