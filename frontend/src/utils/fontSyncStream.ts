/**
 * Reader for the cloud's font-sync progress stream.
 *
 * A cloud frame gets its fonts one at a time — each is a command the device
 * acks only after writing it to an SD card — so the route reports progress as
 * NDJSON rather than answering once at the end (minutes later, through a proxy
 * that would have timed the request out long before). This turns those lines
 * into progress callbacks and a closing summary.
 *
 * A self-hosted backend copies fonts over SSH and answers with plain JSON, so
 * callers only use this when the response says it is a stream.
 */

export interface FontSyncProgress {
  done: number
  total: number
  detail: string
}

export interface FontSyncSummary {
  ok: boolean
  detail: string
  uploaded: number
  skipped: number
  failed: number
}

interface FontSyncEvent {
  type?: string
  total?: number
  totalBytes?: number
  alreadyPresent?: number
  file?: string
  index?: number
  status?: string
  reason?: string
  uploaded?: number
  skipped?: number
  failed?: number
  stopped?: string
  error?: string
}

export function isFontSyncStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('ndjson')
}

function summarize(event: FontSyncEvent): FontSyncSummary {
  const uploaded = event.uploaded ?? 0
  const skipped = event.skipped ?? 0
  const failed = event.failed ?? 0
  const parts: string[] = []
  parts.push(`${uploaded} font${uploaded === 1 ? '' : 's'} copied`)
  if (skipped > 0) {
    parts.push(`${skipped} skipped`)
  }
  if (failed > 0) {
    parts.push(`${failed} failed`)
  }
  let detail = parts.join(', ')
  if (event.stopped) {
    detail = `${detail} — stopped early: ${event.stopped}`
  }
  return { ok: failed === 0 && !event.stopped, detail, uploaded, skipped, failed }
}

/**
 * Read the stream to its end, calling `onProgress` per font. Resolves with the
 * run's summary; throws only if the stream carried an explicit error event or
 * ended without one, which the caller reports as a failed sync.
 */
export async function consumeFontSyncStream(
  response: Response,
  onProgress: (progress: FontSyncProgress) => void
): Promise<FontSyncSummary> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('The font sync returned no progress stream')
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let done = 0
  let summary: FontSyncSummary | null = null
  let streamError: string | null = null

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    let event: FontSyncEvent
    try {
      event = JSON.parse(trimmed) as FontSyncEvent
    } catch {
      // A half-written line at the very end of a truncated stream is not
      // worth failing the whole sync over; the missing `done` event is.
      return
    }
    if (event.type === 'start') {
      total = event.total ?? 0
      onProgress({ done: 0, total, detail: `Copying ${total} fonts to the frame` })
    } else if (event.type === 'font') {
      done += 1
      const status = event.status === 'uploaded' ? 'Copied' : event.status === 'skipped' ? 'Skipped' : 'Failed'
      const reason = event.reason ? ` (${event.reason})` : ''
      onProgress({ done, total, detail: `${status} ${event.file ?? ''}${reason}`.trim() })
    } else if (event.type === 'done') {
      summary = summarize(event)
    } else if (event.type === 'error') {
      streamError = event.error ?? 'The font sync failed'
    }
  }

  for (;;) {
    const { done: finished, value } = await reader.read()
    if (finished) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  handleLine(buffer)

  if (streamError) {
    throw new Error(streamError)
  }
  if (!summary) {
    // The connection dropped mid-run. Commands already queued still land on
    // the device, but claiming the sync finished would be a lie.
    throw new Error('The font sync stopped before it finished')
  }
  return summary
}
