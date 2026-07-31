"use client";

import { Camera, KeyRound, Play, RotateCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  requiredSettingsForScenes,
  type PreviewSettingsGroup,
} from "../lib/preview-settings";

type SceneLivePreviewProps = {
  sceneId: string;
  width?: number | null;
  height?: number | null;
  frameosVersion?: string | null;
  /** Owner-only: "Save screenshot" uploads to the scene's image gallery
   * instead of downloading the PNG. */
  canSaveToGallery?: boolean;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
};

type SceneJson = { id: string } & Record<string, unknown>;

// Runs the scene in the browser through the frameos-wasm runtime: canvas,
// showIf-aware state fields, event buttons, and logs — no frame needed. The
// runtime assets are copied into /frameos-wasm by scripts/copy-wasm-assets.mjs.
export function SceneLivePreview({
  sceneId,
  width,
  height,
  frameosVersion,
  canSaveToGallery = false,
  share,
}: SceneLivePreviewProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingShot, setSavingShot] = useState(false);
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);

  // The viewport applied to the running preview, and the form values being
  // typed (applied on "Resize").
  const [viewport, setViewport] = useState({
    height: height || 480,
    width: width || 800,
  });
  const [viewportForm, setViewportForm] = useState(viewport);

  // Bumped by the Restart button; remounts the whole wasm runtime.
  const [restartCount, setRestartCount] = useState(0);

  // App settings (API keys etc.) some scenes need to render. Typed values are
  // kept per flat "group.field" key; "Apply" nests them into the settings
  // object the runtime expects and remounts the preview.
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});
  const [appliedSettings, setAppliedSettings] = useState<
    Record<string, Record<string, string>>
  >({});
  const requiredSettings = useMemo<PreviewSettingsGroup[]>(
    () => (scenes ? requiredSettingsForScenes(scenes) : []),
    [scenes],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  // The URL hash is the source of truth (same pattern as SceneEditorModal):
  // opening pushes #live-preview so the browser Back button closes the
  // preview instead of leaving the page, and a direct link reopens it.
  const previewHash = "#live-preview";
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    const sync = () => {
      const shouldOpen = window.location.hash === previewHash;
      if (shouldOpen !== openRef.current) {
        setOpen(shouldOpen);
        if (!shouldOpen) {
          setError(null);
        }
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

  function openPreview() {
    window.history.pushState({ frameosLivePreview: true }, "", previewHash);
    setOpen(true);
  }

  function closePreview() {
    setError(null);
    if (window.history.state?.frameosLivePreview) {
      // Pops our own entry; the hash-sync handler closes the modal.
      window.history.back();
      return;
    }
    // Opened via a direct #live-preview link: clear the hash in place.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    setOpen(false);
  }

  useEffect(() => {
    if (!open || scenes !== null) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/store/scenes/${sceneId}/scenes.json${share ? `?share=${encodeURIComponent(share)}` : ""}`,
        );
        if (!response.ok) {
          throw new Error(`Could not load the scene (${response.status})`);
        }
        const loaded = (await response.json()) as SceneJson[];
        if (!cancelled) {
          setScenes(loaded);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scenes, sceneId]);

  useEffect(() => {
    if (!open || !scenes || !containerRef.current) {
      return;
    }
    let cancelled = false;
    let handle: { destroy: () => void } | null = null;
    (async () => {
      try {
        const { mountFrameOSManager } = await import("frameos-wasm");
        if (cancelled || !containerRef.current) {
          return;
        }
        handle = mountFrameOSManager(containerRef.current, {
          workerUrl: "/frameos-wasm/preview-worker.js",
          width: viewport.width,
          height: viewport.height,
          scenes,
          settings: appliedSettings,
          // Fallback only: the runtime fetches URLs client-side first and
          // routes just CORS-blocked hosts through this endpoint.
          proxyUrl: "/api/store/preview-proxy",
          onError: (message) => setError(message),
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
  }, [open, scenes, viewport, appliedSettings, restartCount]);

  function applySettings() {
    const nested: Record<string, Record<string, string>> = {};
    for (const group of requiredSettings) {
      for (const field of group.fields) {
        const value = settingsForm[field.path.join(".")]?.trim();
        if (value) {
          nested[field.path[0]] = {
            ...nested[field.path[0]],
            [field.path[1]]: value,
          };
        }
      }
    }
    setAppliedSettings(nested);
  }

  async function saveScreenshot() {
    const canvas = containerRef.current?.querySelector("canvas");
    if (!canvas) {
      setError("No rendered frame to capture yet.");
      return;
    }
    setSavingShot(true);
    setError(null);
    setNotice(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) {
        setError("Could not capture the canvas.");
        return;
      }
      if (!canSaveToGallery) {
        // Not the owner: hand the PNG to the browser instead.
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${sceneId}-preview.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setNotice("Screenshot downloaded.");
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const response = await fetch(`/api/account/scenes/${sceneId}/images`, {
        body: JSON.stringify({ content_base64: btoa(binary) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) {
        setNotice("Screenshot saved to the scene's images.");
        // The gallery behind this modal shows it as soon as we close.
        router.refresh();
      } else {
        const payload = await response.json().catch(() => ({}));
        setError(`Saving screenshot failed: ${payload.error ?? response.status}`);
      }
    } finally {
      setSavingShot(false);
    }
  }

  if (!open) {
    return (
      // A real link so right-click → "open in new tab" works (the hash
      // reopens the preview there); left click keeps the in-page flow.
      <a
        className="button button--subtle"
        href={previewHash}
        onClick={(event) => {
          event.preventDefault();
          openPreview();
        }}
      >
        <Play aria-hidden size={18} />
        Live preview
        {frameosVersion ? ` (requires ${frameosVersion}+)` : ""}
      </a>
    );
  }

  return (
    // The open preview takes over the whole viewport, like the scene editor
    // modal — the page underneath stays put for when it closes.
    <div aria-modal className="editor-modal" role="dialog">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          Live preview
          {frameosVersion ? ` — requires FrameOS ${frameosVersion} or newer` : ""}
        </div>
        <div className="button-row">
          <button
            className="button button--subtle button--small"
            disabled={savingShot}
            onClick={() => void saveScreenshot()}
            title={
              canSaveToGallery
                ? "Save the current frame to this scene's images"
                : "Download the current frame as a PNG"
            }
            type="button"
          >
            <Camera aria-hidden size={16} />
            {savingShot ? "Saving…" : "Save screenshot"}
          </button>
          <button
            className="button button--subtle button--small"
            onClick={() => {
              setError(null);
              setRestartCount((count) => count + 1);
            }}
            title="Reload the wasm FrameOS runtime from scratch"
            type="button"
          >
            <RotateCw aria-hidden size={18} />
            Restart
          </button>
          <button className="button button--small" onClick={closePreview} type="button">
            <X aria-hidden size={16} />
            Close
          </button>
        </div>
      </div>
      <div className="editor-modal__body stack">
        <div className="viewport-controls">
          <label className="viewport-controls__label" htmlFor="preview-width">
            Viewport
          </label>
          <input
            className="viewport-controls__input"
            id="preview-width"
            min={64}
            max={4096}
            onChange={(event) =>
              setViewportForm((form) => ({
                ...form,
                width: Number(event.target.value),
              }))
            }
            type="number"
            value={viewportForm.width}
          />
          ×
          <input
            aria-label="Viewport height"
            className="viewport-controls__input"
            min={64}
            max={4096}
            onChange={(event) =>
              setViewportForm((form) => ({
                ...form,
                height: Number(event.target.value),
              }))
            }
            type="number"
            value={viewportForm.height}
          />
          <button
            className="button button--subtle button--small"
            disabled={
              !Number.isFinite(viewportForm.width) ||
              !Number.isFinite(viewportForm.height) ||
              viewportForm.width < 64 ||
              viewportForm.height < 64 ||
              viewportForm.width > 4096 ||
              viewportForm.height > 4096 ||
              (viewportForm.width === viewport.width &&
                viewportForm.height === viewport.height)
            }
            onClick={() => setViewport(viewportForm)}
            type="button"
          >
            Resize
          </button>
        </div>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {requiredSettings.length > 0 ? (
        <div className="card preview-settings">
          <h4 className="preview-settings__title">
            <KeyRound aria-hidden size={16} />
            This scene uses services that need credentials
          </h4>
          <p className="copy preview-settings__hint">
            Keys stay in this browser tab and are used only by the preview —
            they are not stored on FrameOS Cloud.
          </p>
          {requiredSettings.map((group) => (
            <div className="preview-settings__group" key={group.key}>
              <span className="preview-settings__group-title">{group.title}</span>
              {group.fields.map((field) => {
                const formKey = field.path.join(".");
                return (
                  <label className="preview-settings__field" key={formKey}>
                    <span>{field.label}</span>
                    <input
                      autoComplete="off"
                      className="preview-settings__input"
                      onChange={(event) =>
                        setSettingsForm((form) => ({
                          ...form,
                          [formKey]: event.target.value,
                        }))
                      }
                      type={field.secret ? "password" : "text"}
                      value={settingsForm[formKey] ?? ""}
                    />
                  </label>
                );
              })}
            </div>
          ))}
          <button
            className="button button--small"
            onClick={applySettings}
            type="button"
          >
            Apply &amp; reload preview
          </button>
        </div>
      ) : null}
      <div ref={containerRef} />
      <p className="copy" style={{ fontSize: "0.8rem", opacity: 0.7 }}>
        Runs in your browser via WebAssembly. Scenes that fetch external data or use device-only
        apps may render incompletely.
      </p>
      </div>
    </div>
  );
}
