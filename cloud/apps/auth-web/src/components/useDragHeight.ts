"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

/** How far one arrow key moves the bottom edge. */
const KEY_STEP_PX = 20;

type DragHeightOptions = {
  /** The least height; called when a drag or key starts. */
  least: () => number;
  /** The most height, as a share of the window's. */
  mostOfWindow: number;
};

// A box whose bottom edge a handle drags: the preview's log and its picture.
// `height` is null until the first drag (the CSS's own height); the handle's
// props take the pointer, the arrow keys, and a double click back to null.
export function useDragHeight(boxRef: RefObject<HTMLElement | null>, { least, mostOfWindow }: DragHeightOptions) {
  const [height, setHeight] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const currentHeight = () => boxRef.current?.getBoundingClientRect().height ?? 0;
  const resizeTo = (next: number) => {
    const low = least();
    const high = Math.max(low, window.innerHeight * mostOfWindow);
    setHeight(Math.round(Math.min(high, Math.max(low, next))));
  };
  const handleProps = {
    onDoubleClick: () => setHeight(null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowDown" ? KEY_STEP_PX : event.key === "ArrowUp" ? -KEY_STEP_PX : 0;
      if (step !== 0) {
        event.preventDefault();
        resizeTo(currentHeight() + step);
      }
    },
    onLostPointerCapture: () => {
      dragRef.current = null;
    },
    onPointerCancel: () => {
      dragRef.current = null;
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: currentHeight() };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        resizeTo(drag.startHeight + event.clientY - drag.startY);
      }
    },
    onPointerUp: () => {
      dragRef.current = null;
    },
  };
  return { height, handleProps };
}
