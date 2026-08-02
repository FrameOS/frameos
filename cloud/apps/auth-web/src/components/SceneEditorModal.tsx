"use client";

import { GitFork, Pencil, Save, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// The FrameOS scene editor as a plain React component in this app's tree
// (react/react-dom are externalized in its bundle — one React). It is
// browser-only (kea, Monaco, wasm), hence the ssr: false dynamic import.
const EmbeddedSceneEditor = dynamic(
  () => import("frameos-editor/react").then((module) => module.EmbeddedSceneEditor),
  { ssr: false },
);

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

// The editor's assets (Monaco workers, wasm preview runtime, stylesheet) are
// copied to /frameos-editor by scripts/copy-editor-assets.mjs; the bundle
// resolves them against this path.
const EDITOR_ASSET_PATH = "/frameos-editor";

if (typeof window !== "undefined") {
  const anyWindow = window as unknown as Record<string, unknown>;
  const config = (anyWindow.FRAMEOS_APP_CONFIG = anyWindow.FRAMEOS_APP_CONFIG || {}) as Record<string, unknown>;
  config.ingress_path = EDITOR_ASSET_PATH;
}

// The editor's stylesheet is global (tailwind preflight included), so it is
// only linked while the full-screen editor is open and removed on close.
function useEditorStylesheet(open: boolean) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${EDITOR_ASSET_PATH}/static/lib.css`;
    document.head.appendChild(link);
    const html = document.documentElement;
    const previousTheme = html.dataset.frameosTheme;
    html.dataset.frameosTheme = html.classList.contains("theme-dark") ? "dark" : "light";
    return () => {
      link.remove();
      if (previousTheme === undefined) {
        delete html.dataset.frameosTheme;
      } else {
        html.dataset.frameosTheme = previousTheme;
      }
    };
  }, [open]);
}

// Owner scene editing via the FrameOS editor rendered as a component in this
// page's React tree. Saving publishes the edited scenes as a new immutable
// version.
export function SceneEditorModal({ sceneId, width, height, description, canSave = false, canFork = false, share }: SceneEditorModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const initialJsonRef = useRef<string>("");
  useEditorStylesheet(open);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTheme(document.documentElement.classList.contains("theme-dark") ? "dark" : "light");
    let cancelled = false;
    void (async () => {
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
        latestScenesRef.current = loaded;
        initialJsonRef.current = JSON.stringify(loaded);
        setScenes(loaded);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sceneId, share]);

  // The editor's Preview panel captured a frame. Owners get it saved to the
  // scene's image gallery; everyone else gets ok:false and the editor falls
  // back to downloading the PNG locally.
  async function saveScreenshot(dataUrl: string) {
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
        // The gallery upload failed for a real reason (quota, moderation,
        // ...): tell the user instead of silently downloading a file they
        // wanted stored.
        fallbackDownload: false,
        error: upload.ok ? undefined : `Saving failed: ${payload.error ?? upload.status}`,
      };
    } catch {
      return { ok: false, fallbackDownload: false, error: "Saving failed" };
    }
  }

  const editorHash = "#scene-editor";
  const openRef = useRef(false);
  openRef.current = open;

  function closeNow() {
    setOpen(false);
    setDirty(false);
    setError(null);
    setScenes(null);
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
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
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
        body: JSON.stringify({ scenes: latest }),
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
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
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
        body: JSON.stringify({ scenes: latest }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(`Saving failed: ${payload.error ?? response.status}`);
        return;
      }
      setDirty(false);
      initialJsonRef.current = JSON.stringify(latest);
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
      <div className="editor-modal__frame">
        {scenes ? (
          <EmbeddedSceneEditor
            scenes={scenes}
            width={width || 800}
            height={height || 480}
            mode="rpios"
            theme={theme}
            // The editor's built-in wasm Preview panel routes CORS-blocked
            // fetches through this endpoint (same one SceneLivePreview uses).
            previewProxyUrl="/api/store/preview-proxy"
            description={description || undefined}
            onScenesChanged={(nextScenes) => {
              latestScenesRef.current = nextScenes as SceneJson[];
              setDirty(JSON.stringify(nextScenes) !== initialJsonRef.current);
            }}
            onSaveScreenshot={saveScreenshot}
          />
        ) : null}
      </div>
    </div>
  );
}
