import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import { useEffect, useRef, useState } from 'react'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Select } from '../../../components/Select'
import { TextInput } from '../../../components/TextInput'
import { urls } from '../../../urls'
import { AccountPageHeader, AccountTable } from './AccountPageHeader'
import { activityLogic, activitySpanOptions, type ActivityHistogram, type ActivityRange } from './activityLogic'
import { formatDateTime } from './format'

const chartHeight = 120
const axisHeight = 18
const barGap = 2
const maxBarWidth = 24

// A bar with 4px rounded top corners and a square foot on the baseline.
export function roundedTopBar(x: number, y: number, width: number, height: number): string {
  if (height <= 0) {
    return ''
  }
  const radius = Math.min(4, width / 2, height)
  const bottom = y + height
  return [
    `M${x},${bottom}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + width - radius}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `V${bottom}`,
    'Z',
  ].join(' ')
}

/** Which buckets a picked range covers, as first/last indexes, or null when none. */
export function selectedBuckets(
  histogram: ActivityHistogram | null,
  range: ActivityRange | null
): { first: number; last: number } | null {
  if (!range || !histogram || histogram.buckets.length === 0) {
    return null
  }
  const from = new Date(range.from).getTime()
  const to = new Date(range.to).getTime()
  let first = -1
  let last = -1
  histogram.buckets.forEach((bucket, index) => {
    const start = new Date(bucket.start).getTime()
    if (start >= from && start < to) {
      if (first === -1) {
        first = index
      }
      last = index
    }
  })
  return first === -1 ? null : { first, last }
}

// One bar per bucket, drawn in pixel space so the rounded data-ends stay
// round at any width. Pointer events on the whole plot: press, drag, release
// picks the buckets under the drag; a plain click picks one bucket. The
// drag and the hover are pointer state of this element, nothing else reads
// them, so they stay here rather than in the logic.
function Histogram({
  histogram,
  onSelect,
  range,
  span,
}: {
  histogram: ActivityHistogram | null
  onSelect: (range: ActivityRange | null) => void
  range: ActivityRange | null
  span: string
}): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<{ end: number; start: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const node = container.current
    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setWidth(Math.floor(entry.contentRect.width))
      }
    })
    observer.observe(node)
    setWidth(Math.floor(node.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [])

  const buckets = histogram?.buckets ?? []
  const count = buckets.length
  const slot = count > 0 && width > 0 ? width / count : 0
  const barWidth = Math.max(1, Math.min(maxBarWidth, slot - barGap))
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count))
  const plotHeight = chartHeight - axisHeight

  const indexAt = (clientX: number): number => {
    const node = container.current
    if (!node || slot === 0) {
      return 0
    }
    const x = clientX - node.getBoundingClientRect().left
    return Math.max(0, Math.min(count - 1, Math.floor(x / slot)))
  }

  const bucketEnd = (index: number): string => {
    const bucket = buckets[index]
    if (!bucket || !histogram) {
      return ''
    }
    return new Date(new Date(bucket.start).getTime() + histogram.step_seconds * 1000).toISOString()
  }

  const selected = selectedBuckets(histogram, range)
  const highlight = drag ? { first: Math.min(drag.start, drag.end), last: Math.max(drag.start, drag.end) } : selected

  const labelFor = (index: number): string => {
    const bucket = buckets[index]
    if (!bucket) {
      return ''
    }
    const date = new Date(bucket.start)
    return span === '24h'
      ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  const tickIndexes =
    count === 0 ? [] : [0, Math.floor(count / 2), count - 1].filter((value, index, all) => all.indexOf(value) === index)

  return (
    <div className="relative w-full select-none" ref={container}>
      {hover !== null && buckets[hover] ? (
        <div
          className="frameos-panel pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs shadow"
          style={{ left: hover * slot + slot / 2 }}
        >
          <strong>{buckets[hover].count}</strong> {buckets[hover].count === 1 ? 'event' : 'events'} · {labelFor(hover)}
        </div>
      ) : null}
      {width > 0 && count > 0 ? (
        <svg
          aria-label="Events over time"
          role="img"
          height={chartHeight}
          width={width}
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            const index = indexAt(event.clientX)
            setDrag({ end: index, start: index })
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const index = indexAt(event.clientX)
            setHover(index)
            if (drag) {
              setDrag({ end: index, start: drag.start })
            }
          }}
          onPointerUp={(event) => {
            if (!drag) {
              return
            }
            const end = indexAt(event.clientX)
            const first = Math.min(drag.start, end)
            const last = Math.max(drag.start, end)
            setDrag(null)
            const startBucket = buckets[first]
            if (startBucket) {
              onSelect({ from: startBucket.start, to: bucketEnd(last) })
            }
          }}
        >
          {highlight ? (
            <rect
              fill="var(--frameos-primary-soft)"
              height={plotHeight}
              width={(highlight.last - highlight.first + 1) * slot}
              x={highlight.first * slot}
              y={0}
            />
          ) : null}
          <line stroke="var(--tool-border)" x1={0} x2={width} y1={plotHeight + 0.5} y2={plotHeight + 0.5} />
          {buckets.map((bucket, index) => {
            const height = bucket.count === 0 ? 0 : Math.max(2, Math.round((bucket.count / max) * (plotHeight - 6)))
            const x = index * slot + (slot - barWidth) / 2
            const dimmed = highlight ? index < highlight.first || index > highlight.last : false
            return (
              <path
                key={bucket.start}
                fill="var(--frameos-primary)"
                opacity={dimmed ? 0.3 : 1}
                d={roundedTopBar(x, plotHeight - height, barWidth, height)}
              />
            )
          })}
          {tickIndexes.map((index) => (
            <text
              key={index}
              fill="var(--frameos-muted-text)"
              fontSize={11}
              textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}
              x={index === 0 ? 0 : index === count - 1 ? width : index * slot + slot / 2}
              y={chartHeight - 4}
            >
              {labelFor(index)}
            </text>
          ))}
        </svg>
      ) : (
        <div style={{ height: chartHeight }} />
      )}
    </div>
  )
}

export function ActivityPage(): JSX.Element {
  const {
    span,
    group,
    groups,
    search,
    range,
    histogram,
    events,
    cursor,
    loading,
    loadingMore,
    failed,
    loadedOnce,
    filtered,
  } = useValues(activityLogic)
  const { setSpan, setGroup, setSearch, applySearch, setRange, clearFilters, loadMore } = useActions(activityLogic)

  return (
    <div className="space-y-4">
      <AccountPageHeader page="activity" />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          applySearch()
        }}
      >
        <div className="w-40">
          <Select
            aria-label="Time span"
            value={span}
            onChange={(value) => setSpan(value)}
            options={activitySpanOptions}
          />
        </div>
        <div className="w-48">
          <Select
            aria-label="Event family"
            value={group}
            onChange={(value) => setGroup(value)}
            options={[{ value: '', label: 'All events' }, ...groups]}
          />
        </div>
        <TextInput
          aria-label="Search activity"
          className="min-w-[14rem] flex-1"
          placeholder="Search events, frames, scenes, IPs…"
          type="search"
          value={search}
          onChange={(value) => setSearch(value)}
        />
        <Button type="submit" size="small" color="secondary">
          Search
        </Button>
        {filtered ? (
          <Button size="small" color="secondary" onClick={clearFilters}>
            Clear
          </Button>
        ) : null}
      </form>

      <Box className="space-y-2 p-4">
        <Histogram histogram={histogram} onSelect={setRange} range={range} span={span} />
        <p className="frameos-muted text-xs">
          {range
            ? `Showing ${formatDateTime(range.from)} to ${formatDateTime(range.to)}.`
            : 'Drag across the chart to pick a time range.'}
          {range ? (
            <>
              {' '}
              <button type="button" className="frameos-link hover:underline" onClick={() => setRange(null)}>
                Show the whole span
              </button>
            </>
          ) : null}
        </p>
      </Box>

      {events.length > 0 ? (
        <Box className={loading ? 'p-4 opacity-60 transition' : 'p-4 transition'}>
          <AccountTable head={['When', 'Event', 'Frame / scene', 'Detail', 'IP']}>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap py-2 pr-3 align-top">{formatDateTime(event.created_at)}</td>
                <td className="py-2 pr-3 align-top">{event.label}</td>
                <td className="py-2 pr-3 align-top">
                  {event.frame_name && event.frame_id ? (
                    <A className="frameos-link hover:underline" href={urls.frame(event.frame_id)}>
                      {event.frame_name}
                    </A>
                  ) : event.scene_name ? (
                    event.scene_name
                  ) : event.frame_id ? (
                    <span className="frameos-muted">deleted frame</span>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="py-2 pr-3 align-top">{event.detail ?? '–'}</td>
                <td className="py-2 align-top font-mono text-xs">{event.ip ?? '–'}</td>
              </tr>
            ))}
          </AccountTable>
          {cursor || failed ? (
            <nav aria-label="Load more activity" className="mt-3 flex items-center gap-3 text-sm">
              <Button size="small" color="secondary" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : failed ? 'Try again' : 'Load more'}
              </Button>
              {failed ? <span className="frameos-muted">Could not load more activity.</span> : null}
            </nav>
          ) : null}
        </Box>
      ) : (
        <Box className="p-4 text-sm">
          {!loadedOnce
            ? 'Loading…'
            : failed
            ? 'Could not load activity. Try again in a moment.'
            : filtered
            ? 'No activity matches these filters.'
            : 'No activity recorded yet.'}
        </Box>
      )}
    </div>
  )
}
