import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers } from 'kea'

import type { terminalLogicType } from './terminalLogicType'
import { frameLogic } from '../../frameLogic'
import { getBasePath } from '../../../../utils/getBasePath'
import { apiFetch } from '../../../../utils/apiFetch'
import { FrameType } from '../../../../types'

export interface TerminalLogicProps {
  frameId: number
}

export type TerminalConnectionState = 'connecting' | 'connected' | 'closed'

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

function hasActiveAgentConnection(frame: FrameType): boolean {
  return (frame.active_connections ?? 0) > 0
}

function hasDirectSshConfig(frame: FrameType): boolean {
  return Boolean(frame.frame_host?.trim() && frame.ssh_user?.trim() && Number(frame.ssh_port || 0) > 0)
}

function terminalSshTarget(frame: FrameType): string {
  const user = frame.ssh_user?.trim()
  const host = frame.frame_host?.trim()

  if (user && host) {
    return `${user}@${host}`
  }

  return host || 'frame'
}

const AGENT_TERMINAL_LIMIT_MESSAGE =
  '*** Terminal access is only available over SSH; agent connections do not provide a shell. ***\n'

export const terminalLogic = kea<terminalLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Terminal', 'terminalLogic']),
  props({} as TerminalLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: TerminalLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame']],
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
    setConnectionState: (connectionState: TerminalConnectionState) => ({ connectionState }),
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
    connectionState: [
      'closed' as TerminalConnectionState,
      {
        setConnectionState: (_, { connectionState }) => connectionState,
      },
    ],
  }),
  listeners(({ actions, values, cache, props }) => ({
    connect: () => {
      if (cache.ws?.readyState === WebSocket.OPEN || cache.ws?.readyState === WebSocket.CONNECTING) {
        return
      }
      cache.ws = null
      const { frame } = values
      if (!frame) {
        return
      }
      const hasAgentConnection = hasActiveAgentConnection(frame)
      const hasSshConfig = hasDirectSshConfig(frame)
      cache.manualDisconnect = false
      cache.receivedTerminalOutput = false
      actions.setConnectionState('connecting')
      actions.initializeHistory(frame.terminal_history || [])
      if (hasAgentConnection && !hasSshConfig) {
        actions.appendText(AGENT_TERMINAL_LIMIT_MESSAGE)
      }
      actions.appendText(`***connecting to ${terminalSshTarget(frame)} via SSH***\n`)
      const ws = new WebSocket(`${getBasePath()}/ws/terminal/${frame.id}`)
      ws.onopen = () => actions.setConnectionState('connected')
      ws.onmessage = (event) => {
        cache.receivedTerminalOutput = true
        actions.appendText(event.data)
      }
      ws.onclose = () => {
        actions.setConnectionState('closed')
        if (hasAgentConnection && hasSshConfig && !cache.manualDisconnect && !cache.receivedTerminalOutput) {
          actions.appendText(`\n${AGENT_TERMINAL_LIMIT_MESSAGE}`)
        }
        actions.appendText('\n*** connection closed ***\n')
        cache.ws = null
      }
      cache.ws = ws
    },
    disconnect: () => {
      if (cache.ws) {
        cache.manualDisconnect = true
        cache.ws.close()
        cache.ws = null
      }
      actions.setConnectionState('closed')
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
