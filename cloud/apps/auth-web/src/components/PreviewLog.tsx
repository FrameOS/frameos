"use client";

import { Fragment, useMemo, useRef, type ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  formatLogTimestamp,
  parsePreviewLogLine,
  type PreviewLogEntry,
  type PreviewLogLine,
} from "../lib/preview-log";

type PreviewLogProps = {
  lines: readonly PreviewLogLine[];
};

/** How close to the end (px) still counts as "at the bottom". */
const STICK_THRESHOLD_PX = 80;

// The scene preview's log list: one virtualised row per runtime line, the
// same shape as the frame Logs panel in the shared SPA — a timestamp
// column, the event name as a tag, then key=value pairs. Sticks to the
// bottom while the reader is there and stays put once they scroll up.
export function PreviewLog({ lines }: PreviewLogProps) {
  const entries = useMemo(
    () => lines.map((item) => parsePreviewLogLine(item.line, item.id, item.receivedAt)),
    [lines],
  );
  // Sticks to the bottom on the scroller itself rather than through
  // Virtuoso's followOutput alone: that scrolls when a line is appended, before
  // the new row is measured, and the runtime's lines wrap unevenly (two
  // arriving back to back left the list a row or two short of the end). So
  // once the rows are measured and the list height changes, jump to the end —
  // unless the reader has scrolled up, which the scroll handler notices.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const stickToBottom = () => {
    const scroller = scrollerRef.current;
    if (scroller && stickRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };
  return (
    <div className="preview-log" data-testid="preview-log">
      <Virtuoso
        atBottomThreshold={STICK_THRESHOLD_PX}
        className="preview-log__list"
        components={{
          EmptyPlaceholder: () => <div className="preview-log__empty">No logs yet</div>,
        }}
        computeItemKey={(_index, entry) => entry.id}
        data={entries}
        // Instant, not smooth: a smooth scroll still in flight when the next
        // line lands reads as "not at the bottom" and the list stops following.
        followOutput={(isAtBottom) => isAtBottom}
        increaseViewportBy={{ bottom: 300, top: 0 }}
        itemContent={(_index, entry) => <PreviewLogRow entry={entry} />}
        onScroll={(event) => {
          const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
          stickRef.current = scrollHeight - scrollTop - clientHeight <= STICK_THRESHOLD_PX;
        }}
        scrollerRef={(element) => {
          scrollerRef.current = element instanceof HTMLElement ? element : null;
        }}
        totalListHeightChanged={stickToBottom}
      />
    </div>
  );
}

function PreviewLogRow({ entry }: { entry: PreviewLogEntry }) {
  const time = formatLogTimestamp(entry.timestamp);
  return (
    <div className={`preview-log__row preview-log__row--${entry.level}`}>
      <span className="preview-log__time">{time}</span>
      <span className="preview-log__body">
        {entry.event !== undefined ? (
          <span className="preview-log__event">{entry.event}</span>
        ) : null}
        {entry.event === undefined && entry.fields.length === 0
          ? insertBreaks(entry.raw)
          : entry.fields.map(([key, value]) => (
              <span className="preview-log__field" key={key}>
                <span className="preview-log__key">{key}=</span>
                <span className="preview-log__value">{insertBreaks(value)}</span>
              </span>
            ))}
      </span>
    </div>
  );
}

// Word-break opportunities after ":" "," "/" so long JSON values and URLs
// wrap at their seams instead of mid-token (frontend/src/utils/insertBreaks).
function insertBreaks(text: string): ReactNode {
  const segments = text.split(/([:,/])/);
  return segments.map((segment, index) =>
    segment === ":" || segment === "," || segment === "/" ? (
      <Fragment key={index}>
        {segment}
        <wbr />
      </Fragment>
    ) : (
      <Fragment key={index}>{segment}</Fragment>
    ),
  );
}
