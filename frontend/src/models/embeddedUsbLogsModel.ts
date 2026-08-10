import { actions, kea, listeners, path, reducers } from 'kea'

import type { LogType, FrameId } from '../types'
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
const USB_PAYLOAD_READY_TIMEOUT_MS = 30000
const USB_PAYLOAD_CHUNK_SIZE = 4096
const OPEN_RETRY_DELAY_MS = 250
const OPEN_RETRY_ATTEMPTS = 20
// Reboot-acking commands (restart / factory-reset / wifi) flush their OK
// marker and reset ~250ms later: wait for the device to actually fall off
// the bus before probing for its replacement port, then poll until the
// USB API answers again.
const USB_REBOOT_PORT_DROP_WAIT_MS = 1500
const USB_REBOOT_RECONNECT_TIMEOUT_MS = 60000
const USB_REBOOT_RECONNECT_POLL_MS = 750
const USB_REBOOT_PROBE_TIMEOUT_MS = 4000

let nextUsbLogId = -1

interface UsbLogSession {
  frameId: FrameId
  port: SerialPort
  reader?: ReadableStreamDefaultReader<Uint8Array>
  readLoop?: Promise<void>
  stopRequested: boolean
  pendingLine: string
  logFilter: (line: string) => string | null
  failureMessage?: string
}

const sessions = new Map<FrameId, UsbLogSession>()
const lastPorts = new Map<FrameId, SerialPort>()
const usbApiCommandLocks = new Map<FrameId, Promise<void>>()
const serialPortReconnectEligible = new WeakMap<SerialPort, boolean>()

interface EmbeddedUsbApiCommandOptions {
  payload?: string | Uint8Array
  timeoutMs?: number
  promptIfNeeded?: boolean
  port?: SerialPort
  mirrorOutput?: boolean
  // Keep the port open after the command instead of close/reopen per call.
  // Open/close churn toggles DTR/RTS, which can spuriously reset
  // USB-Serial/JTAG boards — use this when polling (e.g. waiting for the
  // board to boot after flashing).
  keepOpen?: boolean
  // The command acks OK and then reboots the board (~250ms later), dropping
  // and re-enumerating the USB device. Resolve on the OK marker, then run
  // the flasher's reconnect flow (resolveLiveSerialPort) instead of
  // surfacing the dead port as a read error.
  expectReboot?: boolean
  // A liveness probe repeated until the board answers (e.g. while it boots
  // after a flash). Its attempts are not events a person needs to see, and
  // its failures are the expected case, so keep them out of the log — the
  // caller reports the progress and the final error itself.
  probe?: boolean
}

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

function usbLog(line: string, frameId: FrameId, type = 'usb', timestamp?: string): LogType {
  return {
    id: nextUsbLogId--,
    frame_id: frameId,
    ip: 'usb',
    line,
    timestamp: timestamp ?? new Date().toISOString(),
    type,
  }
}

function appendUsbLine(frameId: FrameId, line: string, type = 'usb', timestamp?: string): void {
  if (line.length === 0) {
    return
  }
  embeddedUsbLogsModel.actions.appendUsbLog(usbLog(line, frameId, type, timestamp))
}

/**
 * Append a line to a frame's USB log view. `timestamp` overrides "now", which
 * matters for replayed history: the device's log ring carries the epoch each
 * line was written at, and stamping those with the fetch time would file
 * yesterday's boot under this minute.
 */
export function appendEmbeddedUsbLogLine(frameId: FrameId, line: string, type = 'usb', timestamp?: string): void {
  appendUsbLine(frameId, line, type, timestamp)
}

/** Append a line that came off the device's console, minus the wire protocol. */
function appendFilteredUsbLine(frameId: FrameId, filter: (line: string) => string | null, line: string): void {
  const visible = filter(line)
  if (visible !== null) {
    appendUsbLine(frameId, visible)
  }
}

function appendUsbText(session: UsbLogSession, text: string): void {
  session.pendingLine += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = session.pendingLine.split('\n')
  session.pendingLine = lines.pop() ?? ''
  for (const line of lines) {
    appendFilteredUsbLine(session.frameId, session.logFilter, line)
  }
}

function flushUsbText(session: UsbLogSession): void {
  if (!session.pendingLine) {
    return
  }
  appendFilteredUsbLine(session.frameId, session.logFilter, session.pendingLine)
  session.pendingLine = ''
}

async function closePort(port: SerialPort): Promise<void> {
  try {
    if (port.readable || port.writable) {
      await port.close()
    }
  } catch (error) {}
}

async function openPort(port: SerialPort, options?: { resetBaud?: boolean }): Promise<void> {
  if (options?.resetBaud && (port.readable || port.writable) && !port.readable?.locked && !port.writable?.locked) {
    await closePort(port)
  }
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

function appendSelectedUsbPort(frameId: FrameId, port: SerialPort): void {
  lastPorts.set(frameId, port)
}

function serialPortIsConnected(port: SerialPort): boolean {
  // SerialPort.connected is Chrome 117+; treat missing support as connected.
  return (port as { connected?: boolean }).connected !== false
}

function matchingSerialPorts(original: SerialPort, ports: SerialPort[]): SerialPort[] {
  const info = original.getInfo()
  return ports.filter((port) => {
    const portInfo = port.getInfo()
    return portInfo.usbVendorId === info.usbVendorId && portInfo.usbProductId === info.usbProductId
  })
}

/** Snapshot whether this is the only granted board with its VID/PID before an
 * operation that may make it re-enumerate. Object identity is the only stable
 * distinction Web Serial exposes for otherwise identical boards. */
export async function prepareSerialPortReconnect(original: SerialPort): Promise<void> {
  try {
    const granted = matchingSerialPorts(original, await navigator.serial.getPorts())
    serialPortReconnectEligible.set(original, granted.length === 1 && granted[0] === original)
  } catch (error) {
    // If the granted-port inventory cannot be inspected, fail closed and
    // require an explicit selection instead of risking another board.
    serialPortReconnectEligible.set(original, false)
  }
}

export function serialPortReconnectRequiresReselection(original: SerialPort): boolean {
  return serialPortReconnectEligible.get(original) === false
}

// When the board reboots (e.g. after flashing), its USB device re-enumerates
// and the SerialPort object we hold goes permanently stale — every open()
// fails with NetworkError. The replacement object is already granted, so it
// shows up in getPorts(); match it by USB vendor/product id.
export function isSerialPortGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /failed to open serial port|device has been lost|port is closed/i.test(message)
}

export async function resolveLiveSerialPort(original: SerialPort): Promise<SerialPort | null> {
  let ports: SerialPort[] = []
  try {
    ports = await navigator.serial.getPorts()
  } catch (error) {
    return null
  }
  const connected = matchingSerialPorts(original, ports).filter(serialPortIsConnected)
  // Prefer the original object so a second board with the same vendor/product
  // id is never picked while the original is still alive
  if (connected.includes(original)) {
    return original
  }
  if (serialPortReconnectEligible.get(original) !== true) {
    return null
  }
  if (connected.length !== 1) {
    if (connected.length > 1) {
      serialPortReconnectEligible.set(original, false)
    }
    return null
  }
  const replacement = connected[0]
  serialPortReconnectEligible.set(replacement, true)
  return replacement
}

async function withUsbApiCommandLock<T>(frameId: FrameId, operation: () => Promise<T>): Promise<T> {
  const previousLock = usbApiCommandLocks.get(frameId)
  if (previousLock) {
    appendUsbLine(frameId, '[USB API] waiting for previous USB command to finish')
  }
  const previousDone = previousLock?.catch(() => {}) ?? Promise.resolve()
  let releaseLock: () => void = () => {}
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const queuedLock = previousDone.then(() => currentLock)
  usbApiCommandLocks.set(frameId, queuedLock)

  await previousDone
  try {
    return await operation()
  } finally {
    releaseLock()
    if (usbApiCommandLocks.get(frameId) === queuedLock) {
      usbApiCommandLocks.delete(frameId)
    }
  }
}

export function embeddedUsbApiCanUse(frameId: FrameId): boolean {
  // Only claim USB is usable when the remembered port is still connected —
  // a port granted earlier in the session goes stale once the board is
  // unplugged, and callers that prefer USB over HTTP must fall through to
  // the network path instead of timing out against a dead port.
  if (!webSerialSupported()) {
    return false
  }
  const sessionPort = sessions.get(frameId)?.port
  if (sessionPort && serialPortIsConnected(sessionPort)) {
    return true
  }
  const lastPort = lastPorts.get(frameId)
  return lastPort !== undefined && serialPortIsConnected(lastPort)
}

export function embeddedUsbApiCanPrompt(): boolean {
  return webSerialSupported()
}

export async function ensureEmbeddedUsbApiPort(frameId: FrameId): Promise<boolean> {
  if (!webSerialSupported()) {
    appendUsbLine(frameId, '[USB API] USB port selection failed: Web Serial is not supported in this browser.')
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      error: 'Web Serial is not supported in this browser. Use Chrome or Edge.',
      status: 'error',
      stoppedAt: new Date().toISOString(),
    })
    return false
  }

  if (embeddedUsbApiCanUse(frameId)) {
    return true
  }

  try {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: 'Choose the board USB serial port.',
      status: 'selecting',
    })
    const port = await navigator.serial.requestPort()
    appendSelectedUsbPort(frameId, port)
    appendUsbLine(frameId, '[USB API] USB port selected for this frame')
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: null,
      status: 'idle',
      stoppedAt: new Date().toISOString(),
    })
    return true
  } catch (error) {
    if (isPortSelectionCanceled(error)) {
      embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
        message: null,
        status: 'idle',
        stoppedAt: new Date().toISOString(),
      })
      return false
    }
    appendUsbLine(frameId, `[USB API] USB port selection failed: ${serialErrorMessage(error)}`)
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      error: serialErrorMessage(error),
      status: 'error',
      stoppedAt: new Date().toISOString(),
    })
    throw error
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// The device's console is a shared stdout: other tasks (render printfs,
// ESP_LOG lines, the cloud client) can interleave lines into the middle of
// a multi-second base64 payload dump. A corrupted transfer is therefore an
// expected transient, not a programming error — callers retry it.
export class UsbPayloadCorruptedError extends Error {
  constructor(detail: string) {
    super(`USB payload corrupted (${detail}) — likely a log line interleaved with the transfer`)
    this.name = 'UsbPayloadCorruptedError'
  }
}

// Decode the BEGIN…END payload region defensively: whole lines that are not
// pure base64 are interleaved log output and get dropped; the declared byte
// length then verifies nothing else went missing (a print that glued itself
// onto a chunk line takes that chunk's bytes down with it).
function decodeUsbBase64Payload(payload: string, declaredBytes: number): Uint8Array {
  const kept = payload
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z0-9+/=]*$/.test(line))
    .join('')
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(kept)
  } catch (error) {
    throw new UsbPayloadCorruptedError('not valid base64')
  }
  if (declaredBytes > 0 && bytes.byteLength !== declaredBytes) {
    throw new UsbPayloadCorruptedError(`expected ${declaredBytes} bytes, decoded ${bytes.byteLength}`)
  }
  return bytes
}

function usbApiResponseCommand(command: string): string {
  return command.trim().split(/\s+/, 1)[0] || command
}

function parseUsbCommandReady(command: string, text: string): boolean {
  const expectedCommand = usbApiResponseCommand(command)
  const readyMatch = text.match(/__FRAMEOS_USB_READY__\s+(\S+)/)
  return readyMatch?.[1] === expectedCommand
}

function parseUsbCommandResult(command: string, text: string): EmbeddedUsbApiCommandResult | null {
  const expectedCommand = usbApiResponseCommand(command)
  // Require the trailing newline so a chunk boundary mid-line can't
  // truncate the error to its first characters ("image failed: E")
  const errorMatch = text.match(/__FRAMEOS_USB_ERROR__\s+(\S+)\s+(\S+)[ \t]*([^\r\n]*)\r?\n/)
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
      bytes: decodeUsbBase64Payload(payload, Number(beginMatch[2]) || 0),
      metadata,
    }
  }
  return { command: responseCommand, text: payload, metadata }
}

// A ~1 MB image payload arrives in hundreds of serial chunks; running the
// full parser (three regexes plus an indexOf over the whole accumulated
// buffer) on every chunk was O(n²) and froze the tab for seconds. The
// parser only has a chance of succeeding once one of these markers has
// arrived, so the read loops gate on seeing one in the freshly received
// tail first. BEGIN is deliberately not in the list — it arrives at the
// START of a payload, and parsing from then on would restore the O(n²).
const usbResponseTerminators = [
  '__FRAMEOS_USB_OK__',
  '__FRAMEOS_USB_ERROR__',
  '__FRAMEOS_USB_END__',
  '__FRAMEOS_USB_READY__',
] as const

function tailHasUsbTerminator(received: string, freshLength: number): boolean {
  // Overlap window: a marker can straddle the chunk boundary.
  const tail = received.slice(-(freshLength + 64))
  return usbResponseTerminators.some((marker) => tail.includes(marker))
}

/** One-line digest of the device's status JSON, for people reading the log. */
export function summarizeUsbStatusJson(text: string): string | null {
  let status: EmbeddedUsbStatus
  try {
    status = JSON.parse(text) as EmbeddedUsbStatus
  } catch (error) {
    return null
  }
  const parts: string[] = []
  if (status.version) {
    parts.push(`version=${status.version}`)
  }
  if (status.config?.panel) {
    parts.push(`panel=${status.config.panel}`)
  }
  if (status.scenes) {
    parts.push(`scenes=${status.scenes.loaded ?? 0}/${status.scenes.available ?? 0}`)
  }
  const wifi = [status.config?.wifiSsid, status.wifi?.ip].filter(Boolean).join(' ')
  parts.push(`wifi=${wifi || 'not connected'}`)
  return parts.join(' ')
}

// Slack over the declared payload size: base64 line breaks and the trailing
// newline are not counted in it.
const USB_PAYLOAD_SUPPRESSION_SLACK = 1024
const USB_PAYLOAD_SUMMARY_CHARS = 16384

/**
 * The device console is a shared stdout: the usb_api wire protocol (BEGIN/END
 * markers, base64 or JSON payload bodies) lands in the same stream a person
 * reads in the logs panel. Strip the framing, drop payload bodies, and turn a
 * status dump into a single summary line. Stateful across lines, so each sink
 * (log stream, command mirror) needs its own instance.
 */
export function createUsbProtocolLogFilter(): (line: string) => string | null {
  let payloadCommand: string | null = null
  let payloadEncoding = ''
  let payloadBudget = 0
  let payloadText = ''

  const endPayload = (): void => {
    payloadCommand = null
    payloadText = ''
  }

  return (line: string): string | null => {
    if (payloadCommand !== null) {
      if (line.startsWith(`__FRAMEOS_USB_END__ ${payloadCommand}`)) {
        const summary = payloadCommand === 'status' ? summarizeUsbStatusJson(payloadText) : null
        const command = payloadCommand
        endPayload()
        return summary ? `${command}: ${summary}` : null
      }
      if (payloadEncoding === 'text' && payloadText.length < USB_PAYLOAD_SUMMARY_CHARS) {
        payloadText += line
      }
      payloadBudget -= line.length + 1
      // A payload whose END never arrives (board reset mid-transfer) must not
      // swallow every log line that follows it.
      if (payloadBudget < 0) {
        endPayload()
      }
      return null
    }

    const begin = line.match(/^__FRAMEOS_USB_BEGIN__\s+(\S+)\s+(\d+)\s+(\S+)/)
    if (begin) {
      payloadCommand = begin[1]
      payloadBudget = Number(begin[2]) + USB_PAYLOAD_SUPPRESSION_SLACK
      payloadEncoding = begin[3]
      payloadText = ''
      return null
    }
    const error = line.match(/^__FRAMEOS_USB_ERROR__\s+(\S+)\s+(.*)$/)
    if (error) {
      return `${error[1]} failed: ${error[2].trim()}`
    }
    if (/^__FRAMEOS_USB_(OK|READY|END)__\b/.test(line)) {
      return null
    }
    return line
  }
}

async function writeUsbPayload(writer: WritableStreamDefaultWriter<Uint8Array>, payload: Uint8Array): Promise<void> {
  for (let offset = 0; offset < payload.byteLength; offset += USB_PAYLOAD_CHUNK_SIZE) {
    await writer.write(payload.slice(offset, Math.min(payload.byteLength, offset + USB_PAYLOAD_CHUNK_SIZE)))
  }
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
  timeoutMs = 30000,
  onText?: (text: string) => void,
  keepOpen = false
): Promise<EmbeddedUsbApiCommandResult> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let received = ''
  let timedOut = false
  // Sticky across chunks: a terminator may arrive without its trailing
  // newline (the ERROR regex requires one), so once seen, keep parsing
  // until the parser produces a result.
  let parseArmed = false
  const appendReceived = (value: Uint8Array): boolean => {
    const decoded = decoder.decode(value, { stream: true })
    received += decoded
    onText?.(decoded)
    if (!parseArmed && tailHasUsbTerminator(received, decoded.length)) {
      parseArmed = true
    }
    return parseArmed
  }
  try {
    await openPort(port, { resetBaud: !keepOpen })
    if (!port.readable || !port.writable) {
      throw new Error('USB serial port is not open')
    }
    if (port.readable.locked || port.writable.locked) {
      throw new Error('USB serial port is already in use by another command or log stream')
    }
    reader = port.readable.getReader()
    writer = port.writable.getWriter()
    await writer.write(encoder.encode(`usb_api ${command}${payload ? ` ${payload.byteLength}` : ''}\n`))
    if (payload) {
      const readyDeadline = Date.now() + Math.min(timeoutMs, USB_PAYLOAD_READY_TIMEOUT_MS)
      let payloadReady = false
      while (Date.now() < readyDeadline) {
        const remaining = Math.max(1, readyDeadline - Date.now())
        const chunk = await readWithTimeout(reader, remaining)
        if (chunk === null) {
          break
        }
        if (chunk.done) {
          throw new Error('USB serial command stream ended')
        }
        if (chunk.value) {
          if (!appendReceived(chunk.value)) {
            continue
          }
          const result = parseUsbCommandResult(command, received)
          if (result) {
            return result
          }
          if (parseUsbCommandReady(command, received)) {
            payloadReady = true
            // Re-arm for the actual response phase, or every post-READY
            // chunk of a large payload would run the full parser again.
            parseArmed = false
            break
          }
        }
      }
      if (!payloadReady) {
        throw new Error(`Timed out waiting for USB command ready: ${command}`)
      }
      await writeUsbPayload(writer, payload)
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
        if (!appendReceived(chunk.value)) {
          continue
        }
        const result = parseUsbCommandResult(command, received)
        if (result) {
          return result
        }
      }
    }
    throw new Error(`Timed out waiting for USB command response: ${command}`)
  } finally {
    if (writer) {
      try {
        writer.releaseLock()
      } catch (error) {}
    }
    if (reader) {
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
}

// After an expected reboot the SerialPort we hold dies and the device
// re-enumerates. Reuse the flasher's reconnect handling: poll getPorts()
// for the (single) matching board, then probe `status` until the USB API
// answers again. Runs inside the command lock, so queued commands wait for
// the board to come back instead of racing its boot.
async function reconnectAfterExpectedUsbReboot(
  frameId: FrameId,
  port: SerialPort,
  resumeLogStream: boolean
): Promise<void> {
  await closePort(port)
  appendUsbLine(frameId, '[USB API] device is rebooting; waiting for the USB port to come back')
  embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
    message: 'Device is rebooting. Waiting for the USB port to come back.',
    status: 'connecting',
  })
  await sleep(USB_REBOOT_PORT_DROP_WAIT_MS)
  const deadline = Date.now() + USB_REBOOT_RECONNECT_TIMEOUT_MS
  let livePort: SerialPort | null = null
  while (Date.now() < deadline) {
    const candidate = await resolveLiveSerialPort(port)
    if (!candidate) {
      if (serialPortReconnectRequiresReselection(port)) {
        break
      }
      await sleep(USB_REBOOT_RECONNECT_POLL_MS)
      continue
    }
    try {
      // keepOpen: open/close churn toggles DTR/RTS, which can spuriously
      // reset USB-Serial/JTAG boards mid-boot.
      await runUsbApiCommandOnPort(candidate, 'status', undefined, USB_REBOOT_PROBE_TIMEOUT_MS, undefined, true)
      livePort = candidate
      break
    } catch (error) {
      await sleep(USB_REBOOT_RECONNECT_POLL_MS)
    }
  }
  if (!livePort) {
    if (lastPorts.get(frameId) === port) {
      lastPorts.delete(frameId)
    }
    appendUsbLine(frameId, '[USB API] USB port did not come back after the reboot; select the port again to reconnect')
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: null,
      status: 'idle',
      stoppedAt: new Date().toISOString(),
    })
    return
  }
  appendUsbLine(
    frameId,
    livePort === port
      ? '[USB API] USB port is back after the reboot'
      : '[USB API] USB device re-enumerated after the reboot; reconnected to the new port'
  )
  appendSelectedUsbPort(frameId, livePort)
  if (resumeLogStream) {
    await startEmbeddedUsbLogStream(frameId, livePort)
  } else {
    await closePort(livePort)
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: null,
      status: 'idle',
      stoppedAt: new Date().toISOString(),
    })
  }
}

export async function runEmbeddedUsbApiCommand(
  frameId: FrameId,
  command: string,
  options?: EmbeddedUsbApiCommandOptions
): Promise<EmbeddedUsbApiCommandResult> {
  return await withUsbApiCommandLock(frameId, () => runEmbeddedUsbApiCommandLocked(frameId, command, options))
}

async function runEmbeddedUsbApiCommandLocked(
  frameId: FrameId,
  command: string,
  options?: EmbeddedUsbApiCommandOptions
): Promise<EmbeddedUsbApiCommandResult> {
  if (!webSerialSupported()) {
    appendUsbLine(frameId, `[USB API] ${command} failed: Web Serial is not supported in this browser.`)
    throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge.')
  }
  const hadLogStream = sessions.has(frameId)
  const stoppedPort = hadLogStream ? await stopEmbeddedUsbLogStream(frameId) : null
  let port = options?.port || stoppedPort || lastPorts.get(frameId) || null
  if (!port && options?.promptIfNeeded) {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: 'Choose the board USB serial port.',
      status: 'selecting',
    })
    port = await navigator.serial.requestPort()
  }
  if (!port) {
    appendUsbLine(frameId, `[USB API] ${command} failed: No USB serial port selected for this frame`)
    throw new Error('No USB serial port selected for this frame')
  }
  appendSelectedUsbPort(frameId, port)
  if (!serialPortReconnectEligible.has(port)) {
    await prepareSerialPortReconnect(port)
  }
  const payload = typeof options?.payload === 'string' ? new TextEncoder().encode(options.payload) : options?.payload
  if (!options?.probe) {
    appendUsbLine(frameId, `[USB API] ${command}${payload ? ` (${payload.byteLength} bytes)` : ''}`)
    if (payload) {
      appendUsbLine(frameId, `[USB API] waiting for ${command} ready marker`)
    }
  }
  const mirrorSerialText = options?.mirrorOutput !== false && usbApiResponseCommand(command) !== 'image'
  const commandLogFilter = createUsbProtocolLogFilter()
  let pendingCommandLogLine = ''
  const appendCommandLogText = mirrorSerialText
    ? (text: string): void => {
        pendingCommandLogLine += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const lines = pendingCommandLogLine.split('\n')
        pendingCommandLogLine = lines.pop() ?? ''
        for (const line of lines) {
          appendFilteredUsbLine(frameId, commandLogFilter, line)
        }
      }
    : undefined
  const flushCommandLogText = (): void => {
    if (pendingCommandLogLine) {
      appendFilteredUsbLine(frameId, commandLogFilter, pendingCommandLogLine)
      pendingCommandLogLine = ''
    }
  }
  let rebootAcknowledged = false
  try {
    embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, {
      message: `Sending USB command: ${command}`,
      status: 'connecting',
    })
    let result: EmbeddedUsbApiCommandResult
    try {
      result = await runUsbApiCommandOnPort(
        port,
        command,
        payload,
        options?.timeoutMs,
        appendCommandLogText,
        options?.keepOpen
      )
    } catch (error) {
      const replacement = isSerialPortGoneError(error) ? await resolveLiveSerialPort(port) : null
      if (!replacement || replacement === port) {
        if (isSerialPortGoneError(error) && serialPortReconnectRequiresReselection(port)) {
          if (lastPorts.get(frameId) === port) {
            lastPorts.delete(frameId)
          }
          throw new Error(
            'Multiple identical USB devices are available. Select the target board again before sending data.'
          )
        }
        throw error
      }
      appendUsbLine(frameId, `[USB API] USB device re-enumerated; retrying ${command} on the new port`)
      port = replacement
      appendSelectedUsbPort(frameId, port)
      result = await runUsbApiCommandOnPort(
        port,
        command,
        payload,
        options?.timeoutMs,
        appendCommandLogText,
        options?.keepOpen
      )
    }
    flushCommandLogText()
    if (!options?.probe) {
      appendUsbLine(frameId, `[USB API] ${command} complete`)
    }
    rebootAcknowledged = options?.expectReboot === true
    return result
  } catch (error) {
    flushCommandLogText()
    if (!options?.probe) {
      appendUsbLine(frameId, `[USB API] ${command} failed: ${serialErrorMessage(error)}`)
    }
    throw error
  } finally {
    if (rebootAcknowledged) {
      await reconnectAfterExpectedUsbReboot(frameId, port, hadLogStream)
    } else if (hadLogStream) {
      await startEmbeddedUsbLogStream(frameId, port)
    } else {
      if (!options?.keepOpen) {
        await closePort(port)
      }
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

export function embeddedUsbLogStreamSessionPort(frameId: FrameId): SerialPort | null {
  return sessions.get(frameId)?.port ?? null
}

/**
 * Type a line into the board's console REPL over the live log stream.
 *
 * This piggybacks on the streaming session on purpose. Web Serial grants a
 * port exclusively, so a second opener would fail with "port already open"
 * — but a port's readable and writable are locked independently, so the log
 * reader can keep running while we take the writer, push a line and hand it
 * back. The reply arrives through the same reader as ordinary log output,
 * which is exactly what makes this useful: you see the answer in context.
 *
 * The command is echoed into the log view locally. The firmware's line
 * editor does not echo input that arrives programmatically, so without this
 * the transcript would show answers with no questions.
 *
 * Whatever is typed is sent verbatim — this is the same REPL the USB cable
 * exposes (`status`, `scenes`, `set …`, `restart`, `factory-reset`), and it
 * is reachable by anyone holding the board anyway. No allow-list here; the
 * device validates its own commands.
 */
export async function sendEmbeddedUsbConsoleCommand(frameId: FrameId, command: string): Promise<void> {
  const line = command.trim()
  if (!line) {
    return
  }
  const session = sessions.get(frameId)
  if (!session || session.stopRequested) {
    throw new Error('Connect the USB log stream first — commands go over that same connection.')
  }
  const writable = session.port.writable
  if (!writable) {
    throw new Error('The USB serial port is not writable. Reconnect the log stream and try again.')
  }
  if (writable.locked) {
    // Another write is mid-flight; serializing here would hide a bug rather
    // than fix one, and console commands are hand-typed, not batched.
    throw new Error('The USB serial port is busy. Try again in a moment.')
  }
  const writer = writable.getWriter()
  try {
    await writer.write(new TextEncoder().encode(line + '\n'))
  } catch (error) {
    throw new Error(serialErrorMessage(error))
  } finally {
    writer.releaseLock()
  }
  appendEmbeddedUsbLogLine(frameId, `> ${line}`)
}

export async function stopEmbeddedUsbLogStream(frameId: FrameId): Promise<SerialPort | null> {
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

export async function startEmbeddedUsbLogStream(frameId: FrameId, port?: SerialPort): Promise<boolean> {
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
    await openPort(selectedPort, { resetBaud: true })
    appendSelectedUsbPort(frameId, selectedPort)

    const session: UsbLogSession = {
      frameId,
      logFilter: createUsbProtocolLogFilter(),
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
    setUsbLogStreamState: (frameId: FrameId, streamState: EmbeddedUsbLogStreamState) => ({ frameId, streamState }),
    startUsbLogStream: (frameId: FrameId) => ({ frameId }),
    stopUsbLogStream: (frameId: FrameId) => ({ frameId }),
  }),
  reducers({
    usbLogsByFrameId: [
      {} as Record<FrameId, LogType[]>,
      {
        appendUsbLog: (state, { log }) => {
          const logs = state[log.frame_id] ?? []
          return { ...state, [log.frame_id]: [...logs, log].slice(-MAX_USB_LOG_LINES) }
        },
      },
    ],
    usbLogStreamStatesByFrameId: [
      {} as Record<FrameId, EmbeddedUsbLogStreamState>,
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

// ----- Typed helpers over the firmware's usb_api subcommands -----

/** Keys accepted by `usb_api set <key> <value...>` (fos_console.c cmd_set). */
export type EmbeddedUsbConfigKey =
  | 'wifi_ssid'
  | 'wifi_pass'
  | 'backend'
  | 'api_key'
  | 'cloud_url'
  | 'claim_token'
  | 'frame_id'
  | 'hardware'
  | 'panel'
  | 'render_mode'
  | 'interval'
  | 'server_send_logs'
  | 'assets_path'
  | 'assets_sd'
  | 'deep_sleep'
  | 'wake_schedule'
  | 'pins'
  | 'gpio_buttons'

export interface EmbeddedUsbWifiNetwork {
  ssid: string
  rssi: number
  channel: number
  auth: string
}

export interface EmbeddedUsbWifiScanResult {
  networks: EmbeddedUsbWifiNetwork[]
  total: number
}

/** Subset of fos_http_status_json() the UI cares about; the device sends more. */
export interface EmbeddedUsbStatus {
  app?: string
  version?: string
  uptimeSec?: number
  wifi?: { state?: number; ip?: string; rssi?: number; timeSynced?: boolean }
  cloud?: { state?: string; url?: string; frameId?: string; wsConnected?: boolean; error?: string }
  config?: {
    frameId?: number
    panel?: string
    renderMode?: string
    intervalSec?: number
    backendUrl?: string
    wifiSsid?: string
  }
  scenes?: { loaded?: number; available?: number; hasScene?: boolean }
  render?: { count?: number; lastMs?: number }
  [key: string]: unknown
}

export interface EmbeddedUsbLogEntry {
  /** Unix epoch seconds, or null when the device had no synced clock. */
  epoch: number | null
  line: string
}

const USB_STATUS_TIMEOUT_MS = 10000
const USB_SET_TIMEOUT_MS = 15000
// The scan itself takes ~3-6s and briefly drops the device's Wi-Fi.
const USB_WIFI_SCAN_TIMEOUT_MS = 30000
const USB_LOGS_TIMEOUT_MS = 15000
const USB_REBOOT_COMMAND_TIMEOUT_MS = 10000

/** `usb_api status` — parsed device status JSON. */
export async function usbStatus(frameId: FrameId): Promise<EmbeddedUsbStatus> {
  const result = await runEmbeddedUsbApiCommand(frameId, 'status', {
    timeoutMs: USB_STATUS_TIMEOUT_MS,
    mirrorOutput: false,
  })
  try {
    return JSON.parse(result.text ?? '') as EmbeddedUsbStatus
  } catch (error) {
    throw new Error('USB status command returned invalid JSON')
  }
}

/**
 * `usb_api set <key> <value...>` — persist one config value. Values may
 * contain spaces (the console re-joins the arguments), but runs of
 * whitespace collapse to single spaces and empty values are rejected by
 * the console's argument parser.
 */
export async function usbSet(frameId: FrameId, key: EmbeddedUsbConfigKey, value: string): Promise<void> {
  if (!value.trim()) {
    throw new Error(`The USB console cannot store an empty value for ${key}`)
  }
  await runEmbeddedUsbApiCommand(frameId, `set ${key} ${value}`, { timeoutMs: USB_SET_TIMEOUT_MS })
}

/** `usb_api wifi-scan` — list visible networks (strongest first). */
export async function usbWifiScan(frameId: FrameId): Promise<EmbeddedUsbWifiScanResult> {
  const result = await runEmbeddedUsbApiCommand(frameId, 'wifi-scan', {
    timeoutMs: USB_WIFI_SCAN_TIMEOUT_MS,
    mirrorOutput: false,
  })
  let parsed: { networks?: unknown; total?: unknown }
  try {
    parsed = JSON.parse(result.text ?? '')
  } catch (error) {
    throw new Error('USB wifi-scan command returned invalid JSON')
  }
  const networks = (Array.isArray(parsed.networks) ? parsed.networks : [])
    .map((network: Record<string, unknown>) => ({
      ssid: typeof network?.ssid === 'string' ? network.ssid : '',
      rssi: Number(network?.rssi ?? -100),
      channel: Number(network?.channel ?? 0),
      auth: typeof network?.auth === 'string' ? network.auth : 'unknown',
    }))
    .sort((a, b) => b.rssi - a.rssi)
  return { networks, total: Number(parsed.total ?? networks.length) }
}

/** `usb_api restart` — acks OK, reboots, then reconnects the serial session. */
export async function usbRestart(frameId: FrameId): Promise<void> {
  await runEmbeddedUsbApiCommand(frameId, 'restart', {
    timeoutMs: USB_REBOOT_COMMAND_TIMEOUT_MS,
    expectReboot: true,
  })
}

/** `usb_api factory-reset` — erases the device config, reboots, reconnects. */
export async function usbFactoryReset(frameId: FrameId): Promise<void> {
  await runEmbeddedUsbApiCommand(frameId, 'factory-reset', {
    timeoutMs: USB_REBOOT_COMMAND_TIMEOUT_MS,
    expectReboot: true,
  })
}

/** `usb_api logs` — the device's recent in-memory log ring. */
export async function usbLogsTail(frameId: FrameId): Promise<EmbeddedUsbLogEntry[]> {
  const result = await runEmbeddedUsbApiCommand(frameId, 'logs', {
    timeoutMs: USB_LOGS_TIMEOUT_MS,
    mirrorOutput: false,
  })
  const text = result.text ?? ''
  if (!text) {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+|-) (.*)$/)
      if (!match) {
        return { epoch: null, line }
      }
      return { epoch: match[1] === '-' ? null : Number(match[1]), line: match[2] }
    })
}

/**
 * Fetch the device's own log ring and replay it into this frame's USB log view.
 *
 * The serial stream only carries what the board printed while a browser was
 * attached, which is never the interesting part: by the time anyone opens the
 * logs, whatever went wrong has already scrolled past — or happened before the
 * cable was plugged in. The firmware keeps the last FOS_NIM_LOG_RING_CAP lines
 * regardless of who is listening, and `usb_api logs` is the only way to read
 * them. It needs an explicit request because it is a point-in-time snapshot,
 * not a stream.
 *
 * Lines are stamped with the epoch the DEVICE recorded, so replayed history
 * files itself under when it happened. Entries from before the board had a
 * synced clock come back with no epoch; those keep the fetch time, which is
 * wrong but monotonic, and the marker lines around the batch say so.
 */
export async function loadEmbeddedUsbLogHistory(frameId: FrameId): Promise<number> {
  appendUsbLine(frameId, '[USB API] reading the device log ring')
  let entries: EmbeddedUsbLogEntry[]
  try {
    entries = await usbLogsTail(frameId)
  } catch (error) {
    appendUsbLine(frameId, `[USB API] could not read the device log ring: ${serialErrorMessage(error)}`)
    throw error
  }
  if (entries.length === 0) {
    appendUsbLine(frameId, '[USB API] the device log ring is empty')
    return 0
  }
  let undated = 0
  for (const entry of entries) {
    const timestamp = entry.epoch === null ? undefined : new Date(entry.epoch * 1000).toISOString()
    if (entry.epoch === null) {
      undated += 1
    }
    appendUsbLine(frameId, entry.line, 'usb-history', timestamp)
  }
  appendUsbLine(
    frameId,
    undated > 0
      ? `[USB API] replayed ${entries.length} line(s) from the device log ring; ${undated} predate its clock sync and show the time they were read`
      : `[USB API] replayed ${entries.length} line(s) from the device log ring`
  )
  return entries.length
}

/**
 * Provision Wi-Fi credentials and reboot into them. Uses `set wifi_ssid` +
 * `set wifi_pass` + `restart` (NOT the positional `wifi <ssid> <pass>`),
 * so SSIDs and passwords containing spaces survive the console's argument
 * splitting. Open networks fall back to `wifi <ssid>` because `set` cannot
 * store an empty wifi_pass — that path only works for SSIDs without spaces.
 */
export async function usbProvisionWifi(frameId: FrameId, ssid: string, password: string): Promise<void> {
  if (!ssid.trim()) {
    throw new Error('Wi-Fi network name is required')
  }
  if (!password) {
    if (/\s/.test(ssid)) {
      throw new Error(
        'The device console cannot join an open network whose name contains spaces. Set a password, or rename the network.'
      )
    }
    await runEmbeddedUsbApiCommand(frameId, `wifi ${ssid}`, {
      timeoutMs: USB_REBOOT_COMMAND_TIMEOUT_MS,
      expectReboot: true,
    })
    return
  }
  await usbSet(frameId, 'wifi_ssid', ssid)
  await usbSet(frameId, 'wifi_pass', password)
  await usbRestart(frameId)
}
