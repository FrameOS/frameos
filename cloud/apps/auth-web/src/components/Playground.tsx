"use client";

import { useEffect, useRef, useState } from "react";
import { startPlayground, type Playground as PlaygroundHandle, type PlaygroundKeyboard, type PlaygroundStatus } from "../lib/playground";

// The playground's one screen: the frame, the size of the window. All of the
// work is src/lib/playground.ts; this only holds the canvas, the status and
// the offer of the whole keyboard.
export function Playground({ storeUrl }: { storeUrl?: string | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playgroundRef = useRef<PlaygroundHandle | null>(null);
  const [status, setStatus] = useState<PlaygroundStatus>({ kind: "loading" });
  const [keyboard, setKeyboard] = useState<PlaygroundKeyboard>("page");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const playground = startPlayground({
      canvas,
      onKeyboard: setKeyboard,
      onStatus: setStatus,
      storeUrl,
      viewport: () => ({ height: window.innerHeight, width: window.innerWidth }),
    });
    playgroundRef.current = playground;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => playground.resize(), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      playground.destroy();
      playgroundRef.current = null;
    };
  }, [storeUrl]);

  return (
    <main className="playground">
      <canvas
        aria-label="FrameOS running in your browser"
        className="playground__frame"
        ref={canvasRef}
        tabIndex={0}
      />
      {status.kind !== "running" ? (
        <div className="playground__status" role="status">
          {status.kind === "loading" ? "Starting FrameOS…" : status.message}
        </div>
      ) : null}
      {keyboard === "offered" ? (
        <div className="playground__keyboard" role="dialog" aria-label="The keyboard">
          <span>
            Your browser keeps some Super key shortcuts for itself. In full screen the frame gets the whole keyboard.
            Hold Esc to leave.
          </span>
          <button type="button" className="playground__keyboard-yes" onClick={() => void playgroundRef.current?.captureKeyboard()}>
            Full screen
          </button>
          <button type="button" onClick={() => playgroundRef.current?.declineKeyboard()}>
            Not now
          </button>
        </div>
      ) : null}
    </main>
  );
}
