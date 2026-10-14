"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudFrameUrl } from "@frameos/cloud-frontend/src/routes";
import { formatDateTime } from "../lib/format";

// The account activity page (app/account/activity): a histogram of events
// over a chosen span that you drag across to pick a time range, a filter
// row (span, event family, search), and the matching events newest first
// with a keyset cursor behind "Load more". Everything comes from
// /api/account/activity and its /histogram; the two share one filter
// parser, so the bars and the rows always describe the same slice.

interface ActivityEvent {
  created_at: string;
  detail: string | null;
  event_type: string;
  frame_id: string | null;
  frame_name: string | null;
  id: string;
  ip: string | null;
  label: string;
  scene_name: string | null;
}

interface Bucket {
  count: number;
  start: string;
}

interface Histogram {
  buckets: Bucket[];
  from: string;
  step_seconds: number;
  to: string;
}

interface Cursor {
  before: string;
  before_id: string;
}

interface Range {
  from: string;
  to: string;
}

const spanOptions: { label: string; value: string }[] = [
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "All time", value: "all" },
];

const chartHeight = 120;
const axisHeight = 18;
const barGap = 2;
const maxBarWidth = 24;

export function ActivityFeed({ groups }: { groups: { label: string; value: string }[] }) {
  const [span, setSpan] = useState("30d");
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<Range | null>(null);

  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Every fetch carries the generation it was started under: a reply from a
  // filter the reader has already moved away from is dropped, not rendered.
  const generation = useRef(0);

  const listParams = useCallback(() => {
    const params = new URLSearchParams();
    if (query) {
      params.set("q", query);
    }
    if (group) {
      params.set("group", group);
    }
    if (range) {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    return params;
  }, [group, query, range]);

  // The histogram follows the span, the search and the family, never the
  // drag: it is the thing you drag on, so it keeps showing the whole span.
  useEffect(() => {
    const token = ++generation.current;
    const params = new URLSearchParams({ span });
    if (query) {
      params.set("q", query);
    }
    if (group) {
      params.set("group", group);
    }
    void fetch(`/api/account/activity/histogram?${params}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as Histogram) : null))
      .then((body) => {
        if (token === generation.current && body) {
          setHistogram(body);
        }
      })
      .catch(() => undefined);
  }, [group, query, span]);

  useEffect(() => {
    const token = ++generation.current;
    setLoading(true);
    setFailed(false);
    void fetch(`/api/account/activity?${listParams()}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        return (await response.json()) as {
          events: ActivityEvent[];
          next_cursor: Cursor | null;
        };
      })
      .then((body) => {
        if (token !== generation.current) {
          return;
        }
        setEvents(body.events);
        setCursor(body.next_cursor);
        setLoading(false);
        setLoadedOnce(true);
      })
      .catch(() => {
        if (token === generation.current) {
          setFailed(true);
          setLoading(false);
          setLoadedOnce(true);
        }
      });
  }, [listParams]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) {
      return;
    }
    const token = generation.current;
    setLoadingMore(true);
    const params = listParams();
    params.set("before", cursor.before);
    params.set("before_id", cursor.before_id);
    try {
      const response = await fetch(`/api/account/activity?${params}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const body = (await response.json()) as {
        events: ActivityEvent[];
        next_cursor: Cursor | null;
      };
      if (token !== generation.current) {
        return;
      }
      setEvents((current) => [...current, ...body.events]);
      setCursor(body.next_cursor);
    } catch {
      if (token === generation.current) {
        setFailed(true);
      }
    } finally {
      if (token === generation.current) {
        setLoadingMore(false);
      }
    }
  }, [cursor, listParams, loadingMore]);

  // The span changes what the chart covers, so a range picked on the old
  // chart no longer means anything on the new one.
  function changeSpan(value: string) {
    setSpan(value);
    setRange(null);
  }

  const filtered = Boolean(query || group || range);

  return (
    <>
      <form
        className="filter-bar activity-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <select
          aria-label="Time span"
          className="input filter-bar__select"
          onChange={(event) => changeSpan(event.target.value)}
          value={span}
        >
          {spanOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Event family"
          className="input filter-bar__select"
          onChange={(event) => setGroup(event.target.value)}
          value={group}
        >
          <option value="">All events</option>
          {groups.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Search activity"
          className="input filter-bar__search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search events, frames, scenes, IPs…"
          type="search"
          value={search}
        />
        <button className="button button--small" type="submit">
          Search
        </button>
        {filtered ? (
          <button
            className="button button--small button--subtle"
            onClick={() => {
              setSearch("");
              setQuery("");
              setGroup("");
              setRange(null);
            }}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </form>

      <section className="card activity-chart-card">
        <ActivityHistogram
          histogram={histogram}
          onSelect={setRange}
          range={range}
          span={span}
        />
        <p className="copy activity-chart__hint">
          {range
            ? `Showing ${formatDateTime(new Date(range.from))} to ${formatDateTime(new Date(range.to))}.`
            : "Drag across the chart to pick a time range."}
          {range ? (
            <>
              {" "}
              <button className="link-button" onClick={() => setRange(null)} type="button">
                Show the whole span
              </button>
            </>
          ) : null}
        </p>
      </section>

      {events.length > 0 ? (
        <div className={loading ? "activity-list activity-list--stale" : "activity-list"}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Frame / scene</th>
                <th>Detail</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDateTime(new Date(event.created_at))}</td>
                  <td>{event.label}</td>
                  <td>
                    {event.frame_name && event.frame_id ? (
                      <Link href={cloudFrameUrl(event.frame_id)}>{event.frame_name}</Link>
                    ) : event.scene_name ? (
                      event.scene_name
                    ) : event.frame_id ? (
                      <span style={{ opacity: 0.6 }}>deleted frame</span>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td>{event.detail ?? "–"}</td>
                  <td>{event.ip ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor || failed ? (
            <nav aria-label="Load more activity" className="store-pager">
              <button
                className="button button--subtle"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                type="button"
              >
                {loadingMore ? "Loading…" : failed ? "Try again" : "Load more"}
              </button>
              {failed ? <span>Could not load more activity.</span> : null}
            </nav>
          ) : null}
        </div>
      ) : (
        <section className="card">
          <p>
            {!loadedOnce
              ? "Loading…"
              : failed
                ? "Could not load activity. Try again in a moment."
                : filtered
                  ? "No activity matches these filters."
                  : "No activity recorded yet."}
          </p>
        </section>
      )}
    </>
  );
}

// One bar per bucket, drawn in pixel space so the rounded data-ends stay
// round at any width. Pointer events on the whole plot: press, drag,
// release picks the buckets under the drag; a plain click picks one bucket.
function ActivityHistogram({
  histogram,
  onSelect,
  range,
  span,
}: {
  histogram: Histogram | null;
  onSelect: (range: Range | null) => void;
  range: Range | null;
  span: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ end: number; start: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(node);
    setWidth(Math.floor(node.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  const buckets = histogram?.buckets ?? [];
  const count = buckets.length;
  const slot = count > 0 && width > 0 ? width / count : 0;
  const barWidth = Math.max(1, Math.min(maxBarWidth, slot - barGap));
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const plotHeight = chartHeight - axisHeight;

  const indexAt = (clientX: number) => {
    const node = container.current;
    if (!node || slot === 0) {
      return 0;
    }
    const x = clientX - node.getBoundingClientRect().left;
    return Math.max(0, Math.min(count - 1, Math.floor(x / slot)));
  };

  const bucketEnd = (index: number) => {
    const bucket = buckets[index];
    if (!bucket || !histogram) {
      return "";
    }
    return new Date(new Date(bucket.start).getTime() + histogram.step_seconds * 1000).toISOString();
  };

  // Where the current selection sits, in bucket indexes, for the overlay.
  const selected = (() => {
    if (!range || !histogram || count === 0) {
      return null;
    }
    const from = new Date(range.from).getTime();
    const to = new Date(range.to).getTime();
    let first = -1;
    let last = -1;
    buckets.forEach((bucket, index) => {
      const start = new Date(bucket.start).getTime();
      if (start >= from && start < to) {
        if (first === -1) {
          first = index;
        }
        last = index;
      }
    });
    return first === -1 ? null : { first, last };
  })();
  const highlight = drag
    ? { first: Math.min(drag.start, drag.end), last: Math.max(drag.start, drag.end) }
    : selected;

  const labelFor = (index: number) => {
    const bucket = buckets[index];
    if (!bucket) {
      return "";
    }
    const date = new Date(bucket.start);
    return span === "24h"
      ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const tickIndexes =
    count === 0 ? [] : [0, Math.floor(count / 2), count - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div
      className={histogram ? "activity-chart" : "activity-chart activity-chart--empty"}
      ref={container}
    >
      {hover !== null && buckets[hover] ? (
        <div className="activity-chart__tooltip" style={{ left: hover * slot + slot / 2 }}>
          <strong>{buckets[hover].count}</strong>{" "}
          {buckets[hover].count === 1 ? "event" : "events"} · {labelFor(hover)}
        </div>
      ) : null}
      {width > 0 && count > 0 ? (
        <svg
          aria-label="Events over time"
          height={chartHeight}
          onPointerDown={(event) => {
            const index = indexAt(event.clientX);
            setDrag({ end: index, start: index });
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const index = indexAt(event.clientX);
            setHover(index);
            if (drag) {
              setDrag({ end: index, start: drag.start });
            }
          }}
          onPointerUp={(event) => {
            if (!drag) {
              return;
            }
            const end = indexAt(event.clientX);
            const first = Math.min(drag.start, end);
            const last = Math.max(drag.start, end);
            setDrag(null);
            const startBucket = buckets[first];
            if (startBucket) {
              onSelect({ from: startBucket.start, to: bucketEnd(last) });
            }
          }}
          role="img"
          style={{ touchAction: "none" }}
          width={width}
        >
          {highlight ? (
            <rect
              className="activity-chart__selection"
              height={plotHeight}
              width={(highlight.last - highlight.first + 1) * slot}
              x={highlight.first * slot}
              y={0}
            />
          ) : null}
          <line
            className="activity-chart__baseline"
            x1={0}
            x2={width}
            y1={plotHeight + 0.5}
            y2={plotHeight + 0.5}
          />
          {buckets.map((bucket, index) => {
            const height =
              bucket.count === 0 ? 0 : Math.max(2, Math.round((bucket.count / max) * (plotHeight - 6)));
            const x = index * slot + (slot - barWidth) / 2;
            const dimmed = highlight ? index < highlight.first || index > highlight.last : false;
            return (
              <path
                className={dimmed ? "activity-chart__bar activity-chart__bar--dim" : "activity-chart__bar"}
                d={roundedTopBar(x, plotHeight - height, barWidth, height)}
                key={bucket.start}
              />
            );
          })}
          {tickIndexes.map((index) => (
            <text
              className="activity-chart__tick"
              key={index}
              textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
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
  );
}

// A bar with 4px rounded top corners and a square foot on the baseline.
function roundedTopBar(x: number, y: number, width: number, height: number) {
  if (height <= 0) {
    return "";
  }
  const radius = Math.min(4, width / 2, height);
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + width - radius}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `V${bottom}`,
    "Z",
  ].join(" ");
}
