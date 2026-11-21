"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewFileRequest } from "frameos-wasm";
import { startPlayground, type Playground as PlaygroundHandle, type PlaygroundStatus } from "../lib/playground";

// The playground's one screen: the frame, the size of the window. All of the
// work is src/lib/playground.ts; this only holds the canvas and the status.
export function Playground({ storeUrl }: { storeUrl?: string | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<PlaygroundStatus>({ kind: "loading" });
  // The Files scene's Upload or Download, asked with a button when the tap's
  // gesture ran out before it arrived (frameos-wasm's files.ts).
  const [fileRequest, setFileRequest] = useState<PreviewFileRequest | null>(null);
  const playgroundRef = useRef<PlaygroundHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const playground = startPlayground({
      canvas,
      onFileRequest: setFileRequest,
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
      {fileRequest ? (
        <div className="playground__ask" role="dialog" aria-label="Files from this computer">
          <span>
            {fileRequest.op === "upload"
              ? "The scene asks for files from this computer. They stay in this browser."
              : `The scene asks to save “${fileRequest.name}” to this computer.`}
          </span>
          <button onClick={() => playgroundRef.current?.answerFileRequest()} type="button">
            {fileRequest.op === "upload" ? "Choose files" : "Save"}
          </button>
          <button onClick={() => playgroundRef.current?.cancelFileRequest()} type="button">
            Cancel
          </button>
        </div>
      ) : null}
    </main>
  );
}
