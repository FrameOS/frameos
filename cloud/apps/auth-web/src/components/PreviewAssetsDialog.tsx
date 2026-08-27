"use client";

import type { FrameOSPreview, PreviewAssetEntry, PreviewAssetsInfo } from "frameos-wasm";
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";

type PreviewAssetsDialogProps = {
  /** The running preview whose folder is managed; null while it is not
   * running (the dialog then only explains what the folder is). */
  preview: FrameOSPreview | null;
  /** Bumped by the panel whenever the preview reports the folder changed
   * (a scene saved a file): the listing reloads. */
  assetsVersion?: number;
  onClose: () => void;
};

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".qoi"];

export function isImageAssetPath(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The folder part of a relative asset path ("" at the root). */
export function assetParentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function assetBaseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Entries directly inside `folder`, folders first, then files, by name. */
export function entriesInFolder(entries: PreviewAssetEntry[], folder: string): PreviewAssetEntry[] {
  return entries
    .filter((entry) => assetParentFolder(entry.path) === folder)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return assetBaseName(a.path).localeCompare(assetBaseName(b.path), undefined, {
        sensitivity: "base",
      });
    });
}

function imageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

/** A file's bytes as a data URL (the page's CSP allows data: images, not blob: ones). */
function bytesToDataUrl(buffer: ArrayBuffer, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(new Blob([buffer], { type }));
  });
}

// A thumbnail read out of the worker's folder on demand, as a data URL —
// the store's CSP allows data: images, not blob: ones (see ImageLightbox).
function AssetThumbnail({ preview, entry }: { preview: FrameOSPreview; entry: PreviewAssetEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    preview
      .readAsset(entry.path)
      .then((buffer) => bytesToDataUrl(buffer, imageMimeType(entry.path)))
      .then((dataUrl) => {
        if (!cancelled) {
          setUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preview, entry.path, entry.mtime, entry.size]);
  return url ? (
    <img alt="" className="assets-dialog__thumb" src={url} />
  ) : (
    <div className="assets-dialog__thumb assets-dialog__thumb--blank">
      <FileIcon aria-hidden size={18} />
    </div>
  );
}

// Manage the preview's browser asset folder: the files the running scene
// sees at /srv/assets. The folder lives in this browser only (the wasm
// worker's IndexedDB-backed filesystem), never on a frame or in the cloud.
// Overlay on <body>, like ImageLightbox: the editor frame's transform would
// otherwise keep a fixed element inside a column.
export function PreviewAssetsDialog({ preview, assetsVersion = 0, onClose }: PreviewAssetsDialogProps) {
  const [entries, setEntries] = useState<PreviewAssetEntry[]>([]);
  const [info, setInfo] = useState<PreviewAssetsInfo | null>(preview?.assetsInfo ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const reload = useCallback(async () => {
    if (!preview) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEntries(await preview.listAssets());
      setInfo(preview.assetsInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [preview]);

  useEffect(() => {
    void reload();
  }, [reload, assetsVersion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (folder && !entries.some((entry) => entry.isDir && entry.path === folder)) {
      setFolder("");
    }
  }, [folder, entries]);

  const run = async (task: () => Promise<void>) => {
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await reload();
  };

  const addFiles = (files: FileList | File[] | null) => {
    if (!preview) {
      return;
    }
    const list = files ? Array.from(files) : [];
    if (list.length === 0) {
      return;
    }
    void run(async () => {
      for (const file of list) {
        await preview.writeAsset(folder ? `${folder}/${file.name}` : file.name, file);
      }
    });
  };

  const submitNewFolder = () => {
    const name = (newFolderName ?? "").trim().replace(/\//g, "");
    setNewFolderName(null);
    if (!preview || !name || name === "." || name === "..") {
      return;
    }
    void run(() => preview.createAssetFolder(folder ? `${folder}/${name}` : name));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer?.files ?? null);
  };

  const visible = entriesInFolder(entries, folder);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const fileCount = entries.filter((entry) => !entry.isDir).length;
  const crumbs = folder ? folder.split("/") : [];

  return createPortal(
    <div
      aria-label="Browser assets"
      aria-modal
      className="dialog"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="dialog__panel dialog__panel--wide assets-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2>Browser assets</h2>
          <button aria-label="Close" className="dialog__close" onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </div>
        <p className="notice assets-dialog__intro">
          This is a temporary asset folder that exists <strong>only in this browser</strong> — it is
          never sent to a frame or to the cloud. The preview runs scenes with it mounted at{" "}
          <code>/srv/assets</code>, the path a real frame keeps its assets at, so image scenes have
          something to show and apps that save files have somewhere to put them.{" "}
          {info?.persistent === false
            ? "This browser blocks persistent storage, so the folder lives in memory and is gone when the preview restarts."
            : "It is kept in this browser between previews and shared by every preview you open here."}{" "}
          A fresh folder starts with a few generated sample photos; add your own images to test
          slideshows and local-image scenes.
        </p>
        {!preview ? (
          <p className="notice" role="status">
            Start the preview to manage its folder.
          </p>
        ) : null}
        <div className="button-row assets-dialog__toolbar">
          <button
            className="button button--subtle button--small"
            disabled={!preview}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <Upload aria-hidden size={14} />
            Add files
          </button>
          <input
            aria-label="Add files"
            className="assets-dialog__file-input"
            multiple
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="button button--subtle button--small"
            disabled={!preview || newFolderName !== null}
            onClick={() => setNewFolderName("")}
            type="button"
          >
            <FolderPlus aria-hidden size={14} />
            New folder
          </button>
          <button
            aria-label="Refresh"
            className="button button--subtle button--small"
            disabled={!preview || loading}
            onClick={() => void reload()}
            title="Reload the folder listing"
            type="button"
          >
            <RefreshCw aria-hidden size={14} />
          </button>
          <span className="assets-dialog__spacer" />
          {confirmReset ? (
            <>
              <span className="assets-dialog__confirm">Delete everything and regenerate the samples?</span>
              <button
                className="button button-danger button--small"
                onClick={() => {
                  setConfirmReset(false);
                  if (preview) {
                    void run(() => preview.resetAssets());
                  }
                }}
                type="button"
              >
                Reset folder
              </button>
              <button
                className="button button--subtle button--small"
                onClick={() => setConfirmReset(false)}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="button button--subtle button--small"
              disabled={!preview}
              onClick={() => setConfirmReset(true)}
              title="Delete everything in the folder and regenerate the sample photos"
              type="button"
            >
              Reset to samples
            </button>
          )}
        </div>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="assets-dialog__crumbs">
          <button
            className={`assets-dialog__crumb${folder ? "" : " assets-dialog__crumb--current"}`}
            onClick={() => setFolder("")}
            type="button"
          >
            /srv/assets
          </button>
          {crumbs.map((crumb, index) => {
            const path = crumbs.slice(0, index + 1).join("/");
            const current = index === crumbs.length - 1;
            return (
              <span className="assets-dialog__crumb-wrap" key={path}>
                <ChevronRight aria-hidden size={12} />
                <button
                  className={`assets-dialog__crumb${current ? " assets-dialog__crumb--current" : ""}`}
                  onClick={() => setFolder(path)}
                  type="button"
                >
                  {crumb}
                </button>
              </span>
            );
          })}
        </div>
        <div
          className={`assets-dialog__list${dragging ? " assets-dialog__list--dragging" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDrop={onDrop}
        >
          {newFolderName !== null ? (
            <div className="assets-dialog__row">
              <Folder aria-hidden size={18} />
              <input
                aria-label="Folder name"
                autoFocus
                className="input assets-dialog__name-input"
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submitNewFolder();
                  } else if (event.key === "Escape") {
                    setNewFolderName(null);
                  }
                }}
                placeholder="Folder name"
                value={newFolderName}
              />
              <button className="button button-primary button--small" onClick={submitNewFolder} type="button">
                Create
              </button>
              <button
                className="button button--subtle button--small"
                onClick={() => setNewFolderName(null)}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : null}
          {preview && loading && entries.length === 0 ? (
            <p className="assets-dialog__empty">Reading the browser folder…</p>
          ) : visible.length === 0 && newFolderName === null ? (
            <p className="assets-dialog__empty">
              {preview ? "This folder is empty. Drop files here, or use “Add files”." : ""}
            </p>
          ) : (
            visible.map((entry) => {
              const name = assetBaseName(entry.path);
              const confirming = confirmDeletePath === entry.path;
              return (
                <div className="assets-dialog__row" key={entry.path}>
                  {entry.isDir ? (
                    <div className="assets-dialog__thumb assets-dialog__thumb--blank">
                      <Folder aria-hidden size={20} />
                    </div>
                  ) : preview && isImageAssetPath(entry.path) ? (
                    <AssetThumbnail entry={entry} preview={preview} />
                  ) : (
                    <div className="assets-dialog__thumb assets-dialog__thumb--blank">
                      <FileIcon aria-hidden size={18} />
                    </div>
                  )}
                  <div className="assets-dialog__meta">
                    {entry.isDir ? (
                      <button
                        className="assets-dialog__name assets-dialog__name--folder"
                        onClick={() => setFolder(entry.path)}
                        type="button"
                      >
                        {name}/
                      </button>
                    ) : (
                      <span className="assets-dialog__name" title={entry.path}>
                        {name}
                      </span>
                    )}
                    <span className="assets-dialog__details">
                      {entry.isDir ? "Folder" : formatAssetSize(entry.size)}
                      {entry.mtime ? ` · ${new Date(entry.mtime).toLocaleString()}` : ""}
                    </span>
                  </div>
                  {confirming ? (
                    <span className="button-row">
                      <button
                        className="button button-danger button--small"
                        onClick={() => {
                          setConfirmDeletePath(null);
                          if (preview) {
                            void run(() => preview.deleteAsset(entry.path));
                          }
                        }}
                        type="button"
                      >
                        Delete{entry.isDir ? " folder" : ""}
                      </button>
                      <button
                        className="button button--subtle button--small"
                        onClick={() => setConfirmDeletePath(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      aria-label={`Delete ${name}`}
                      className="button button--subtle button--small"
                      disabled={!preview}
                      onClick={() => setConfirmDeletePath(entry.path)}
                      title={entry.isDir ? "Delete this folder and everything in it" : "Delete this file"}
                      type="button"
                    >
                      <Trash2 aria-hidden size={14} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="assets-dialog__footer">
          <span>
            {fileCount} file{fileCount === 1 ? "" : "s"}, {formatAssetSize(totalBytes)}
            {info?.maxBytes ? ` of ${formatAssetSize(info.maxBytes)}` : ""}
          </span>
          <span>Stored in this browser only</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
