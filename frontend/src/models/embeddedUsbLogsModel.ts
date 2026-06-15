import { actions, kea, listeners, path, reducers } from 'kea'

import type { LogType } from '../types'
import type { embeddedUsbLogsModelType } from './embeddedUsbLogsModelType'

export type EmbeddedUsbLogStreamStatus = 'idle' | 'selecting' | 'connecting' | 'streaming' | 'stopping' | 'error'

export interface EmbeddedUsbLogStreamState {
  status: EmbeddedUsbLogStreamStatus
  message?: string | null
  error?: string | null
  startedAt?: string | null
  stoppedAt?: string | null
}

const USB_SERIAL_BAUD_RATE = 115200
const USB_LOG_BUFFER_SIZE = 65536
const MAX_USB_LOG_LINES = 50000
const OPEN_RETRY_DELAY_MS = 250
const OPEN_RETRY_ATTEMPTS = 20

let nextUsbLogId = -1

interface UsbLogSession {
  frameId: number
  port: SerialPort
  reader?: ReadableStreamDefaultReader<Uint8Array>
  readLoop?: Promise<void>
  stopRequested: boolean
  pendingLine: string
  failureMessage?: string
}

const sessions = new Map<number, UsbLogSession>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

function isPortSelectionCanceled(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /NotFoundError|No port selected|user cancelled|user canceled/i.test(detail)
}

function serialErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/Failed to open serial port|already open|busy/i.test(detail)) {
    return 'Could not open the serial port. Close other serial monitors and try again.'
  }
  return detail || 'USB serial log stream failed.'
}

function usbLog(line: string, frameId: number, type = 'usb'): LogType {
  return {
    id: nextUsbLogId--,
    frame_id: frameId,
    ip: 'usb',
    line,
    timestamp: new Date().toISOString(),
    type,
  }
}

function appendUsbLine(frameId: number, line: string, type = 'usb'): void {
  if (line.length === 0) {
    return
  }
  embeddedUsbLogsModel.actions.appendUsbLog(usbLog(line, frameId, type))
}

function appendUsbText(session: UsbLogSession, text: string): void {
  session.pendingLine += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = session.pendingLine.split('\n')
  session.pendingLine = lines.pop() ?? ''
  for (const line of lines) {
    appendUsbLine(session.frameId, line)
  }
}

function flushUsbText(session: UsbLogSession): void {
  if (!session.pendingLine) {
    return
  }
  appendUsbLine(session.frameId, session.pendingLine)
  session.pendingLine = ''
}

async function closePort(port: SerialPort): Promise<void> {
  try {
    if (port.readable || port.writable) {
      await port.close()
    }
  } catch (error) {}
}

async function openPort(port: SerialPort): Promise<void> {
  if (port.readable || port.writable) {
    return
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < OPEN_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await port.open({ baudRate: USB_SERIAL_BAUD_RATE, bufferSize: USB_LOG_BUFFER_SIZE })
      return
    } catch (error) {
      lastError = error
      if (attempt < OPEN_RETRY_ATTEMPTS - 1) {
        await sleep(OPEN_RETRY_DELAY_MS)
      }
    }
  }
  throw lastError
}

async function readUsbLogs(session: UsbLogSession): Promise<void> {
  const decoder = new TextDecoder()
  try {
    while (!session.stopRequested && session.port.readable) {
      const reader = session.port.readable.getReader()
      session.reader = reader
      try {
        while (!session.stopRequested) {
          const { value, done } = await reader.read()
          if (done) {
            if (!session.stopRequested) {
              session.failureMessage = 'USB serial log stream ended.'
            }
            return
          }
          if (value) {
            appendUsbText(session, decoder.decode(value, { stream: true }))
          }
        }
      } finally {
        if (session.reader === reader) {
          session.reader = undefined
        }
        reader.releaseLock()
      }
    }
  } catch (error) {
    if (!session.stopRequested) {
      session.failureMessage = serialErrorMessage(error)
    }
  } finally {
    flushUsbText(session)
    if (sessions.get(session.frameId) === session) {
      sessions.delete(session.frameId)
    }
    await closePort(session.port)
    embeddedUsbLogsModel.actions.setUsbLogStreamState(session.frameId, {
      error: session.stopRequested ? null : session.failureMessage || 'USB serial log stream ended.',
      message: session.stopRequested ? 'USB serial log stream stopped.' : null,
      status: session.stopRequested ? 'idle' : 'error',
      stoppedAt: new Date().toISOString(),
    })
  }
}

export function isEmbeddedUsbLogStreamOpen(streamState?: EmbeddedUsbLogStreamState | null): boolean {
  return !!streamState && ['selecting', 'connecting', 'streaming', 'stopping'].includes(streamState.status)
}

export function embeddedUsbLogStreamSessionPort(frameId: number): SerialPort | null {
  return sessions.get(frameId)?.port ?? null
}

export async function stopEmbeddedUsbLogStream(frameId: number): Promise<SerialPort | null> {
  const session = sessions.get(frameId)
  if (!session) {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: null,
      status: 'idle',
      stoppedAt: new Date().toISOString(),
    })
    return null
  }

  embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
    message: 'Stopping USB serial log stream.',
    status: 'stopping',
  })
  session.stopRequested = true
  try {
    await session.reader?.cancel()
  } catch (error) {}
  try {
    await session.readLoop
  } catch (error) {}
  return session.port
}

export async function startEmbeddedUsbLogStream(frameId: number, port?: SerialPort): Promise<boolean> {
  if (!webSerialSupported()) {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      error: 'Web Serial is not supported in this browser. Use Chrome or Edge to stream USB logs.',
      status: 'error',
      stoppedAt: new Date().toISOString(),
    })
    return false
  }

  await stopEmbeddedUsbLogStream(frameId)

  let selectedPort = port
  try {
    if (!selectedPort) {
      embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
        message: 'Choose the board USB serial port.',
        status: 'selecting',
      })
      selectedPort = await navigator.serial.requestPort()
    }

    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: 'Opening USB serial log stream.',
      status: 'connecting',
    })
    await openPort(selectedPort)

    const session: UsbLogSession = {
      frameId,
      pendingLine: '',
      port: selectedPort,
      stopRequested: false,
    }
    sessions.set(frameId, session)
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: 'Streaming USB serial logs.',
      status: 'streaming',
      startedAt: new Date().toISOString(),
    })
    session.readLoop = readUsbLogs(session)
    return true
  } catch (error) {
    await closePort(selectedPort as SerialPort)
    if (isPortSelectionCanceled(error)) {
      embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
        message: null,
        status: 'idle',
        stoppedAt: new Date().toISOString(),
      })
      return false
    }
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      error: serialErrorMessage(error),
      status: 'error',
      stoppedAt: new Date().toISOString(),
    })
    return false
  }
}

export const embeddedUsbLogsModel = kea<embeddedUsbLogsModelType>([
  path(['src', 'models', 'embeddedUsbLogsModel']),
  actions({
    appendUsbLog: (log: LogType) => ({ log }),
    setUsbLogStreamState: (frameId: number, streamState: EmbeddedUsbLogStreamState) => ({ frameId, streamState }),
    startUsbLogStream: (frameId: number) => ({ frameId }),
    stopUsbLogStream: (frameId: number) => ({ frameId }),
  }),
  reducers({
    usbLogsByFrameId: [
      {} as Record<number, LogType[]>,
      {
        appendUsbLog: (state, { log }) => {
          const logs = state[log.frame_id] ?? []
          return { ...state, [log.frame_id]: [...logs, log].slice(-MAX_USB_LOG_LINES) }
        },
      },
    ],
    usbLogStreamStatesByFrameId: [
      {} as Record<number, EmbeddedUsbLogStreamState>,
      {
        setUsbLogStreamState: (state, { frameId, streamState }) => ({
          ...state,
          [frameId]: {
            ...(state[frameId] ?? { status: 'idle' }),
            ...streamState,
          },
        }),
      },
    ],
  }),
  listeners(() => ({
    startUsbLogStream: async ({ frameId }) => {
      await startEmbeddedUsbLogStream(frameId)
    },
    stopUsbLogStream: async ({ frameId }) => {
      await stopEmbeddedUsbLogStream(frameId)
    },
  })),
])
