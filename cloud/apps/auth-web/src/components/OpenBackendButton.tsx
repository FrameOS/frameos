"use client";

import { ExternalLink, MonitorSmartphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Opens a linked FrameOS backend inside the cloud UI: a full-viewport
// overlay (same chrome as the scene editor modal) with a header saying what
// is shown and where it came from, and the backend in an iframe below. The
// backend is a separate app with its own login; we only frame it.
//
// The URL hash is the source of truth (same pattern as SceneEditorModal):
// opening pushes #backend-<id>, so the browser Back button closes the
// overlay instead of leaving the page, and a direct link reopens it.
export function OpenBackendButton({
  id,
  name,
  origin,
}: {
  id: string;
  name: string;
  origin: string;
}) {
  const [open, setOpen] = useState(false);
  const viewerHash = `#backend-${id}`;
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    const sync = () => {
      const shouldOpen = window.location.hash === viewerHash;
      if (shouldOpen !== openRef.current) {
        setOpen(shouldOpen);
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [viewerHash]);

  function openViewer() {
    window.history.pushState({ frameosBackendViewer: true }, "", viewerHash);
    setOpen(true);
  }

  function close() {
    // Clear the hash in place instead of history.back(): the framed backend
    // is a separate app whose internal navigation shares the session
    // history, so "back" from here could step through it rather than pop
    // our hash entry.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    setOpen(false);
  }

  if (!open) {
    return (
      // A real link so right-click → "open in new tab" works (the hash
      // reopens the viewer there); left click keeps the in-page flow.
      <a
        className="button button--small"
        href={viewerHash}
        onClick={(event) => {
          event.preventDefault();
          openViewer();
        }}
        title={`Open ${origin} without leaving FrameOS Cloud`}
      >
        <MonitorSmartphone aria-hidden size={16} />
        Open
      </a>
    );
  }

  return (
    <div aria-modal className="editor-modal" role="dialog">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          FrameOS backend: {name}
          <span className="pill" title={origin}>
            {origin}
          </span>
          <span className="copy backend-modal-context">
            viewed from FrameOS Cloud
          </span>
        </div>
        <div className="button-row">
          <a
            className="button button--subtle button--small"
            href={origin}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ExternalLink aria-hidden size={16} />
            Open in new tab
          </a>
          <button className="button button--small" onClick={close} type="button">
            <X aria-hidden size={16} />
            Close
          </button>
        </div>
      </div>
      <iframe
        className="editor-modal__frame"
        src={origin}
        title={`FrameOS backend at ${origin}`}
      />
    </div>
  );
}
