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

export interface EmbeddedUsbApiCommandResult {
  command: string
  text?: string
  bytes?: Uint8Array
  metadata?: string
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
const lastPorts = new Map<number, SerialPort>()

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

function appendSelectedUsbPort(frameId: number, port: SerialPort): void {
  lastPorts.set(frameId, port)
}

export function embeddedUsbApiCanUse(frameId: number): boolean {
  return webSerialSupported() && (sessions.has(frameId) || lastPorts.has(frameId))
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function usbApiResponseCommand(command: string): string {
  return command.trim().split(/\s+/, 1)[0] || command
}

function parseUsbCommandResult(command: string, text: string): EmbeddedUsbApiCommandResult | null {
  const expectedCommand = usbApiResponseCommand(command)
  const errorMatch = text.match(/__FRAMEOS_USB_ERROR__\s+(\S+)\s+(\S+)\s*([^\r\n]*)/)
  if (errorMatch) {
    if (errorMatch[1] !== expectedCommand) {
      return null
    }
    throw new Error(`${errorMatch[2]} ${errorMatch[3] || ''}`.trim())
  }

  const okMatch = text.match(/__FRAMEOS_USB_OK__\s+(\S+)/)
  if (okMatch) {
    if (okMatch[1] !== expectedCommand) {
      return null
    }
    return { command: okMatch[1] }
  }

  const beginMatch = text.match(/__FRAMEOS_USB_BEGIN__\s+(\S+)\s+(\d+)\s+(\S+)([^\r\n]*)\r?\n/)
  if (!beginMatch) {
    return null
  }
  const responseCommand = beginMatch[1]
  if (responseCommand !== expectedCommand) {
    return null
  }
  const beginEnd = beginMatch.index! + beginMatch[0].length
  const endMarker = `__FRAMEOS_USB_END__ ${responseCommand}`
  const endIndex = text.indexOf(endMarker, beginEnd)
  if (endIndex < 0) {
    return null
  }
  const payload = text.slice(beginEnd, endIndex).replace(/\r?\n$/, '')
  const encoding = beginMatch[3]
  const metadata = beginMatch[4]?.trim() || undefined
  if (encoding === 'base64') {
    return {
      command: responseCommand,
      bytes: base64ToBytes(payload.replace(/\s+/g, '')),
      metadata,
    }
  }
  return { command: responseCommand, text: payload, metadata }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  let timeoutHandle: ReturnType<typeof window.setTimeout> | null = null
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timeoutHandle = window.setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle)
    }
  }
}

async function runUsbApiCommandOnPort(
  port: SerialPort,
  command: string,
  payload?: Uint8Array,
  timeoutMs = 30000
): Promise<EmbeddedUsbApiCommandResult> {
  await openPort(port)
  if (!port.readable || !port.writable) {
    throw new Error('USB serial port is not open')
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = port.readable.getReader()
  const writer = port.writable.getWriter()
  let received = ''
  let timedOut = false
  try {
    await writer.write(encoder.encode(`usb_api ${command}${payload ? ` ${payload.byteLength}` : ''}\n`))
    if (payload) {
      await writer.write(payload)
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const chunk = await readWithTimeout(reader, remaining)
      if (chunk === null) {
        timedOut = true
        break
      }
      if (chunk.done) {
        throw new Error('USB serial command stream ended')
      }
      if (chunk.value) {
        received += decoder.decode(chunk.value, { stream: true })
        const result = parseUsbCommandResult(command, received)
        if (result) {
          return result
        }
      }
    }
    throw new Error(`Timed out waiting for USB command response: ${command}`)
  } finally {
    try {
      writer.releaseLock()
    } catch (error) {}
    if (timedOut) {
      try {
        await reader.cancel()
      } catch (error) {}
    }
    try {
      reader.releaseLock()
    } catch (error) {}
  }
}

export async function runEmbeddedUsbApiCommand(
  frameId: number,
  command: string,
  options?: { payload?: string | Uint8Array; timeoutMs?: number; promptIfNeeded?: boolean }
): Promise<EmbeddedUsbApiCommandResult> {
  if (!webSerialSupported()) {
    throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge.')
  }
  const hadLogStream = sessions.has(frameId)
  const stoppedPort = hadLogStream ? await stopEmbeddedUsbLogStream(frameId) : null
  let port = stoppedPort || lastPorts.get(frameId) || null
  if (!port && options?.promptIfNeeded) {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: 'Choose the board USB serial port.',
      status: 'selecting',
    })
    port = await navigator.serial.requestPort()
  }
  if (!port) {
    throw new Error('No USB serial port selected for this frame')
  }
  appendSelectedUsbPort(frameId, port)
  const payload =
    typeof options?.payload === 'string'
      ? new TextEncoder().encode(options.payload)
      : options?.payload
  try {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: `Sending USB command: ${command}`,
      status: 'connecting',
    })
    return await runUsbApiCommandOnPort(port, command, payload, options?.timeoutMs)
  } finally {
    if (hadLogStream) {
      await startEmbeddedUsbLogStream(frameId, port)
    } else {
      await closePort(port)
      embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
        message: null,
        status: 'idle',
        stoppedAt: new Date().toISOString(),
      })
    }
  }
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
    appendSelectedUsbPort(frameId, selectedPort)

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
