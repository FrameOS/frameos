"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { ImageLightbox } from "./ImageLightbox";

// The scene's images (the Info panel): the version's ordered image set as
// one grid of equal thumbnails — the first is the cover — each opening the
// lightbox full size. For an owner in the workspace the grid is the draft:
// adding registers the bytes with the server (moderated there) and hands
// back a digest, removing and dragging just reorder the list, and nothing
// is published until Save — an image set is part of a version.
export function SceneImageGallery({
  canEdit,
  images,
  onChange,
  sceneId,
  sceneName,
  share,
}: {
  canEdit: boolean;
  /** The image digests, in order; the first is the cover. */
  images: string[];
  /** The draft's image list changed (owner editing only). */
  onChange?: ((images: string[]) => void) | undefined;
  sceneId: string;
  sceneName: string;
  /** Share token for private scenes, so images load for shared visitors. */
  share?: string | undefined;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const editable = canEdit && onChange !== undefined;

  const shareSuffix = share ? `?share=${encodeURIComponent(share)}` : "";
  const urlFor = (sha: string) => `/api/store/scenes/${sceneId}/images/${sha}${shareSuffix}`;

  async function upload(file: File) {
    if (!onChange) {
      return;
    }
    setBusy(true);
    setError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const response = await fetch(`/api/account/scenes/${sceneId}/images`, {
      body: JSON.stringify({ content_base64: btoa(binary) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    setBusy(false);
    const payload = await response.json().catch(() => ({}));
    if (response.ok && typeof payload.image?.sha256 === "string") {
      const sha = payload.image.sha256 as string;
      onChange(images.includes(sha) ? images : [...images, sha]);
      return;
    }
    if (payload.error === "content_rejected") {
      setError("Rejected by content moderation");
    } else if (payload.error === "image_too_large") {
      setError("Image too large (max 4 MB)");
    } else if (payload.error === "unsupported_image") {
      setError("Not a supported image (JPEG, PNG, WebP or GIF)");
    } else if (payload.error === "storage_quota_exceeded") {
      setError("Storage quota reached for private scenes");
    } else {
      setError(`Upload failed: ${payload.error ?? response.status}`);
    }
  }

  function remove(sha: string) {
    onChange?.(images.filter((image) => image !== sha));
  }

  function moveImage(from: string, to: string) {
    if (from === to || !onChange) {
      return;
    }
    const next = images.filter((sha) => sha !== from);
    const at = next.indexOf(to);
    if (at < 0) {
      return;
    }
    // Dropping on a later image lands after it, on an earlier one before it:
    // the dragged thumbnail takes the slot it was dropped on.
    next.splice(images.indexOf(from) < images.indexOf(to) ? at + 1 : at, 0, from);
    onChange(next);
  }

  const canDrag = editable && images.length > 1;
  const maxImages = 10;

  return (
    // ph-no-capture travels with the gallery rather than being left to each
    // page that mounts it: the scene's own images and name are never
    // analytics material, wherever it is rendered.
    <div className="scene-gallery ph-no-capture">
      {images.length > 0 || editable ? (
        <div className="scene-gallery__thumbs">
          {images.map((sha, index) => (
            <div
              className={[
                "scene-gallery__thumb-wrap",
                canDrag ? "scene-gallery__thumb-wrap--draggable" : "",
                dragging === sha ? "scene-gallery__thumb-wrap--dragging" : "",
                dropTarget === sha && dragging !== sha ? "scene-gallery__thumb-wrap--drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-image-id={sha}
              draggable={canDrag ? true : undefined}
              key={sha}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (dragging) {
                  event.preventDefault();
                  if (dropTarget !== sha) {
                    setDropTarget(sha);
                  }
                }
              }}
              onDragStart={(event) => {
                if (!canDrag) {
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", sha);
                setDragging(sha);
              }}
              onDrop={(event) => {
                if (!dragging) {
                  return;
                }
                event.preventDefault();
                const from = dragging;
                setDragging(null);
                setDropTarget(null);
                moveImage(from, sha);
              }}
            >
              <button
                aria-label={`View image ${index + 1} full size`}
                className="scene-gallery__thumb"
                onClick={() => setZoomed(urlFor(sha))}
                title={
                  canDrag
                    ? index === 0
                      ? "The cover · view full size · drag to reorder"
                      : "View full size · drag to reorder"
                    : "View full size"
                }
                type="button"
              >
                <img alt="" src={urlFor(sha)} />
              </button>
              {editable ? (
                <button
                  aria-label={`Remove image ${index + 1}`}
                  className="scene-gallery__thumb-remove"
                  disabled={busy}
                  onClick={() => remove(sha)}
                  title="Remove this image from the scene (published by Save)"
                  type="button"
                >
                  <Trash2 aria-hidden size={12} />
                </button>
              ) : null}
            </div>
          ))}
          {editable && images.length < maxImages ? (
            <>
              <button
                className="scene-gallery__thumb scene-gallery__add"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                title="Add an image to this scene (published by Save)"
                type="button"
              >
                <ImagePlus aria-hidden size={18} />
              </button>
              <input
                accept="image/jpeg,image/png,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void upload(file);
                  }
                }}
                ref={fileInputRef}
                type="file"
              />
            </>
          ) : null}
        </div>
      ) : (
        <div aria-hidden className="scene-card__placeholder">
          No preview
        </div>
      )}
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {zoomed ? (
        <ImageLightbox
          alt={`${sceneName} preview`}
          label="Scene image"
          onClose={() => setZoomed(null)}
          url={zoomed}
        />
      ) : null}
    </div>
  );
}
