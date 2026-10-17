"use client";

import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
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
/** How far one arrow key moves the bottom edge: about a line. */
const KEY_STEP_PX = 20;

// The scene preview's log list: one virtualised row per runtime line, the
// same shape as the frame Logs panel in the shared SPA — a timestamp
// column, the event name as a tag, then key=value pairs. Sticks to the
// bottom while the reader is there and stays put once they scroll up.
// Three lines tall to start with (the CSS); the whole bottom row is a handle
// that drags the box taller, and a double click on it brings it back.
export function PreviewLog({ lines }: PreviewLogProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // null: the three-line height from the CSS, which is also the least.
  const [height, setHeight] = useState<number | null>(null);
  const minHeightRef = useRef<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const currentHeight = () => {
    const box = boxRef.current;
    const measured = box ? box.getBoundingClientRect().height : 0;
    if (height === null && minHeightRef.current === null) {
      minHeightRef.current = measured;
    }
    return measured;
  };
  const resizeTo = (next: number) => {
    const least = minHeightRef.current ?? 0;
    const most = Math.max(least, window.innerHeight * 0.8);
    setHeight(Math.round(Math.min(most, Math.max(least, next))));
  };
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: currentHeight() };
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      resizeTo(drag.startHeight + event.clientY - drag.startY);
    }
  };
  const onResizeEnd = () => {
    dragRef.current = null;
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? KEY_STEP_PX : event.key === "ArrowUp" ? -KEY_STEP_PX : 0;
    if (step !== 0) {
      event.preventDefault();
      resizeTo(currentHeight() + step);
    }
  };
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
    <div
      className="preview-log"
      data-testid="preview-log"
      ref={boxRef}
      style={height === null ? undefined : { height }}
    >
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
      <div
        aria-label="Resize the log"
        aria-orientation="horizontal"
        className="preview-log__resize"
        onDoubleClick={() => setHeight(null)}
        onKeyDown={onResizeKey}
        onLostPointerCapture={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        role="separator"
        tabIndex={0}
        title="Drag down for a taller log, double-click for three lines"
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
