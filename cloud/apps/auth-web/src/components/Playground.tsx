"use client";

import { useEffect, useRef, useState } from "react";
import { startPlayground, type PlaygroundStatus } from "../lib/playground";

// The playground's one screen: the frame, the size of the window. All of the
// work is src/lib/playground.ts; this only holds the canvas and the status.
export function Playground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<PlaygroundStatus>({ kind: "loading" });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const playground = startPlayground({
      canvas,
      onStatus: setStatus,
      viewport: () => ({ height: window.innerHeight, width: window.innerWidth }),
    });
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
    };
  }, []);

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
    </main>
  );
}
