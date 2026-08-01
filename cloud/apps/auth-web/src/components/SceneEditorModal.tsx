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

type EditorHandle = {
  getScenesSync: () => SceneJson[];
  setScenes: (scenes: SceneJson[], sceneId?: string) => void;
  destroy: () => void;
};

// The mount module bundles its own React and resolves chunk/worker/stylesheet
// URLs against its own location, so it must be loaded at runtime from the
// copied assets in public/ — not resolved (and rebundled) by the app bundler.
// The Function wrapper keeps webpack/turbopack from touching the import.
const importEditorMount = new Function(
  "url",
  "return import(url)",
) as (url: string) => Promise<{
  mountFrameOSEditor: (
    container: HTMLElement,
    options: Record<string, unknown>,
  ) => EditorHandle;
}>;

// Owner scene editing via the FrameOS editor mounted directly into this page
// (frameos-editor/mount, copied to /frameos-editor by
// scripts/copy-editor-assets.mjs) — no iframe. The mount module injects the
// editor's global stylesheet while open and removes it on close; the modal
// container's `transform` makes it the containing block for the editor's
// fixed-position drawers (see .editor-modal__frame in globals.css). Saving
// publishes the edited scenes as a new immutable version.
export function SceneEditorModal({ sceneId, width, height, description, canSave = false, canFork = false, share }: SceneEditorModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const initialJsonRef = useRef<string>("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    let handle: EditorHandle | null = null;

    void (async () => {
      try {
        const response = await fetch(
          `/api/store/scenes/${sceneId}/scenes.json${share ? `?share=${encodeURIComponent(share)}` : ""}`,
        );
        if (!response.ok) {
          throw new Error(`Could not load the scene (${response.status})`);
        }
        const scenes = (await response.json()) as SceneJson[];
        const { mountFrameOSEditor } = await importEditorMount("/frameos-editor/static/mount.js");
        if (cancelled || !containerRef.current) {
          return;
        }
        latestScenesRef.current = scenes;
        initialJsonRef.current = JSON.stringify(scenes);
        handle = mountFrameOSEditor(containerRef.current, {
          scenes,
          width: width || 800,
          height: height || 480,
          mode: "rpios",
          // Match the page's theme (see ThemeToggle).
          theme: document.documentElement.classList.contains("theme-dark")
            ? "dark"
            : "light",
          // The editor's built-in wasm Preview panel routes CORS-blocked
          // fetches through this endpoint (same one SceneLivePreview uses).
          previewProxyUrl: "/api/store/preview-proxy",
          description: description || undefined,
          onScenesChanged: (nextScenes: SceneJson[]) => {
            latestScenesRef.current = nextScenes;
            setDirty(JSON.stringify(nextScenes) !== initialJsonRef.current);
          },
          // The editor's Preview panel captured a frame. Owners get it saved
          // to the scene's image gallery; everyone else gets ok:false and the
          // editor falls back to downloading the PNG locally.
          onSaveScreenshot: async (dataUrl: string) => {
            if (!canSave) {
              return { ok: false, error: "Only the scene owner can save to its images" };
            }
            if (!dataUrl.startsWith("data:image/png;base64,")) {
              return { ok: false, fallbackDownload: false, error: "Unexpected screenshot format" };
            }
            try {
              const upload = await fetch(`/api/account/scenes/${sceneId}/images`, {
                body: JSON.stringify({
                  content_base64: dataUrl.slice("data:image/png;base64,".length),
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
              });
              const payload = await upload.json().catch(() => ({}));
              if (upload.ok) {
                router.refresh();
              }
              return {
                ok: upload.ok,
                // The gallery upload failed for a real reason (quota,
                // moderation, ...): tell the user instead of silently
                // downloading a file they wanted stored.
                fallbackDownload: false,
                error: upload.ok ? undefined : `Saving failed: ${payload.error ?? upload.status}`,
              };
            } catch {
              return { ok: false, fallbackDownload: false, error: "Saving failed" };
            }
          },
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
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
      <div className="editor-modal__frame" ref={containerRef} />
    </div>
  );
}
