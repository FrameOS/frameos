"use client";

import { GitFork, Pencil, Save, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type SceneEditorModalProps = {
  sceneId: string;
  width?: number | null;
  height?: number | null;
  /** Store listing description, shown in the editor's Scene settings panel
   * (scenes.json itself doesn't carry one). */
  description?: string | null;
  /** Owner-only: offer "Save as new version". Everyone else gets the diagram
   * as an explorable playground — edits stay in the browser. */
  canSave?: boolean;
  /** Signed-in users can fork: save the (edited) scenes as a new private
   * scene under their own account. */
  canFork?: boolean;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
};

type SceneJson = { id: string } & Record<string, unknown>;

// Owner scene editing via the embedded FrameOS editor: the editor bundle
// (copied to /frameos-editor by scripts/copy-editor-assets.mjs) runs in an
// iframe — isolating its global stylesheet and React 18 runtime from this
// app — and this modal talks to it over its documented postMessage protocol
// (see the frameos-editor package README). Saving publishes the edited
// scenes as a new immutable version.
export function SceneEditorModal({ sceneId, width, height, description, canSave = false, canFork = false, share }: SceneEditorModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const initialJsonRef = useRef<string>("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    let scenes: SceneJson[] | null = null;

    const post = (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(message, window.location.origin);
    };

    const initMessage = (initScenes: SceneJson[]) => ({
      type: "frameos-editor:init",
      scenes: initScenes,
      width: width || 800,
      height: height || 480,
      mode: "rpios",
      // Match the page's theme (see ThemeToggle).
      theme: document.documentElement.classList.contains("theme-dark")
        ? "dark"
        : "light",
      // The editor's built-in wasm Preview panel routes CORS-blocked fetches
      // through this endpoint (same one SceneLivePreview uses).
      previewProxyUrl: "/api/store/preview-proxy",
      description: description || undefined,
    });

    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== iframeRef.current?.contentWindow
      ) {
        return;
      }
      const message = event.data;
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "frameos-editor:ready" && scenes) {
        post(initMessage(scenes));
      } else if (message.type === "frameos-editor:scenes" && Array.isArray(message.scenes)) {
        latestScenesRef.current = message.scenes as SceneJson[];
        setDirty(JSON.stringify(message.scenes) !== initialJsonRef.current);
      } else if (
        message.type === "frameos-editor:save-screenshot" &&
        typeof message.dataUrl === "string" &&
        message.dataUrl.startsWith("data:image/png;base64,")
      ) {
        // The editor's Preview panel captured a frame. Owners get it saved
        // to the scene's image gallery; everyone else gets ok:false and the
        // editor falls back to downloading the PNG locally.
        void (async () => {
          if (!canSave) {
            post({
              type: "frameos-editor:screenshot-saved",
              ok: false,
              error: "Only the scene owner can save to its images",
            });
            return;
          }
          try {
            const response = await fetch(`/api/account/scenes/${sceneId}/images`, {
              body: JSON.stringify({
                content_base64: message.dataUrl.slice("data:image/png;base64,".length),
              }),
              headers: { "content-type": "application/json" },
              method: "POST",
            });
            const payload = await response.json().catch(() => ({}));
            post({
              type: "frameos-editor:screenshot-saved",
              ok: response.ok,
              // The gallery upload failed for a real reason (quota,
              // moderation, ...): tell the user instead of silently
              // downloading a file they wanted stored.
              fallbackDownload: false,
              error: response.ok
                ? undefined
                : `Saving failed: ${payload.error ?? response.status}`,
            });
            if (response.ok) {
              router.refresh();
            }
          } catch {
            post({
              type: "frameos-editor:screenshot-saved",
              ok: false,
              fallbackDownload: false,
              error: "Saving failed",
            });
          }
        })();
      }
    };
    window.addEventListener("message", onMessage);

    (async () => {
      try {
        const response = await fetch(
          `/api/store/scenes/${sceneId}/scenes.json${share ? `?share=${encodeURIComponent(share)}` : ""}`,
        );
        if (!response.ok) {
          throw new Error(`Could not load the scene (${response.status})`);
        }
        const loaded = (await response.json()) as SceneJson[];
        if (cancelled) {
          return;
        }
        scenes = loaded;
        latestScenesRef.current = loaded;
        initialJsonRef.current = JSON.stringify(loaded);
        // The iframe may have signalled ready before the fetch finished;
        // send init now that we have the scenes.
        post(initMessage(scenes));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [open, sceneId, width, height, description]);

  const editorHash = "#scene-editor";
  const openRef = useRef(false);
  openRef.current = open;

  function closeNow() {
    setOpen(false);
    setDirty(false);
    setError(null);
    latestScenesRef.current = null;
  }

  // The URL hash is the source of truth: back/forward (and loading a
  // #scene-editor link directly) open and close the modal. Closing simply
  // discards unsaved edits — no confirmation dialog.
  useEffect(() => {
    const sync = () => {
      const shouldOpen = window.location.hash === editorHash;
      if (shouldOpen === openRef.current) {
        return;
      }
      if (shouldOpen) {
        setOpen(true);
      } else {
        closeNow();
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  function openEditor() {
    window.history.pushState({ frameosSceneEditor: true }, "", editorHash);
    setOpen(true);
  }

  function close() {
    if (window.history.state?.frameosSceneEditor) {
      // Delegates to the hash-sync handler above.
      window.history.back();
      return;
    }
    // Opened via a direct #scene-editor link: clear the hash in place.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    closeNow();
  }

  async function forkAndSave() {
    const scenes = latestScenesRef.current;
    if (!scenes || scenes.length === 0) {
      setError("Nothing to fork yet.");
      return;
    }
    if (
      !window.confirm(
        "Save these scenes (including your edits) as a new private scene in your account?",
      )
    ) {
      return;
    }
    setForking(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}/fork`, {
        body: JSON.stringify({ scenes }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload.error === "login_required"
            ? "Sign in to fork this scene."
            : `Forking failed: ${payload.error ?? response.status}`,
        );
        return;
      }
      // Jump to the fresh copy; its editor opens on unsaved-free state.
      window.location.href = `/s/${payload.scene.slug}`;
    } finally {
      setForking(false);
    }
  }

  async function save() {
    const scenes = latestScenesRef.current;
    if (!scenes || scenes.length === 0) {
      setError("Nothing to save yet.");
      return;
    }
    if (
      !window.confirm(
        "Publish the edited scenes as a new version? Everyone installing or updating this scene will get it.",
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}/content`, {
        body: JSON.stringify({ scenes }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(`Saving failed: ${payload.error ?? response.status}`);
        return;
      }
      setDirty(false);
      initialJsonRef.current = JSON.stringify(scenes);
      close();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      // A real link so right-click → "open in new tab" works (the hash
      // reopens the editor there); left click keeps the in-page flow.
      <a
        className="button button--subtle"
        href={editorHash}
        onClick={(event) => {
          event.preventDefault();
          openEditor();
        }}
      >
        <Pencil aria-hidden size={18} />
        {canSave ? "Edit scene" : "View diagram"}
      </a>
    );
  }

  return (
    <div aria-modal className="editor-modal" role="dialog">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          Scene editor
          {canSave && dirty ? (
            <span className="pill pill-warning">Unsaved changes</span>
          ) : null}
          {!canSave ? (
            <span className="pill" title="Explore and tweak freely; nothing you change here is saved anywhere">
              Playground — changes are not saved
            </span>
          ) : null}
          {error ? <span className="pill pill-warning">{error}</span> : null}
        </div>
        <div className="button-row">
          {canSave ? (
            <button
              className="button button--small"
              disabled={saving || !dirty}
              onClick={() => void save()}
              type="button"
            >
              <Save aria-hidden size={16} />
              {saving ? "Saving…" : "Save as new version"}
            </button>
          ) : null}
          {canFork ? (
            <button
              className="button button--small"
              disabled={forking}
              onClick={() => void forkAndSave()}
              title="Save these scenes (including your edits) as a new private scene in your account"
              type="button"
            >
              <GitFork aria-hidden size={16} />
              {forking ? "Forking…" : "Fork & save copy"}
            </button>
          ) : null}
          <button className="button button--small" onClick={close} type="button">
            <X aria-hidden size={16} />
            Close
          </button>
        </div>
      </div>
      <iframe
        className="editor-modal__frame"
        ref={iframeRef}
        src="/frameos-editor/index.html"
        title="FrameOS scene editor"
      />
    </div>
  );
}
