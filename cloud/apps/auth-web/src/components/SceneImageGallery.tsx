"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ImageLightbox } from "./ImageLightbox";

// The scene's images (the Info panel): the zip's preview plus any
// owner-uploaded gallery images, as one grid of equal thumbnails — each
// opens the lightbox full size. Owners add images (moderated server-side),
// remove any of them, the primary preview included, and drag the gallery
// images into the order the page should show them (the zip's own preview
// always leads and stays put).
export function SceneImageGallery({
  canEdit,
  hasPreview,
  imageIds,
  sceneId,
  sceneName,
  share,
}: {
  canEdit: boolean;
  hasPreview: boolean;
  imageIds: string[];
  sceneId: string;
  sceneName: string;
  /** Share token for private scenes, so images load for shared visitors. */
  share?: string | undefined;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The order shown while a reorder is in flight (and until the server
  // re-renders with it). Keyed by the server's list so a refresh that brings
  // a different set of images wins over a stale override.
  const [reordered, setReordered] = useState<{ base: string; order: string[] } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const serverKey = imageIds.join(",");
  const order = reordered && reordered.base === serverKey ? reordered.order : imageIds;

  const shareSuffix = share ? `?share=${encodeURIComponent(share)}` : "";
  const previewUrl = `/api/store/scenes/${sceneId}/image${shareSuffix}`;
  const urls: { id: string | null; url: string }[] = [
    ...(hasPreview ? [{ id: null, url: previewUrl }] : []),
    ...order.map((id) => ({
      id,
      url: `/api/store/scenes/${sceneId}/images/${id}${shareSuffix}`,
    })),
  ];
  const [zoomed, setZoomed] = useState<string | null>(null);

  async function upload(file: File) {
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
    if (response.ok) {
      router.refresh();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (payload.error === "content_rejected") {
      setError("Rejected by content moderation");
    } else if (payload.error === "image_too_large") {
      setError("Image too large (max 4 MB)");
    } else if (payload.error === "unsupported_image") {
      setError("Not a supported image (JPEG, PNG, WebP or GIF)");
    } else if (payload.error === "image_quota_exceeded") {
      setError("Image limit reached for this scene");
    } else {
      setError(`Upload failed: ${payload.error ?? response.status}`);
    }
  }

  async function remove(imageId: string | null) {
    if (!window.confirm("Remove this image from the scene page?")) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch(
      imageId
        ? `/api/account/scenes/${sceneId}/images/${imageId}`
        : `/api/account/scenes/${sceneId}/image`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (response.ok) {
      router.refresh();
    } else {
      const payload = await response.json().catch(() => ({}));
      setError(`Removing failed: ${payload.error ?? response.status}`);
    }
  }

  async function moveImage(fromId: string, toId: string) {
    if (fromId === toId) {
      return;
    }
    const next = order.filter((id) => id !== fromId);
    const at = next.indexOf(toId);
    if (at < 0) {
      return;
    }
    // Dropping on a later image lands after it, on an earlier one before it:
    // the dragged thumbnail takes the slot it was dropped on.
    next.splice(order.indexOf(fromId) < order.indexOf(toId) ? at + 1 : at, 0, fromId);
    setReordered({ base: serverKey, order: next });
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/account/scenes/${sceneId}/images`, {
      body: JSON.stringify({ order: next }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    setBusy(false);
    if (response.ok) {
      router.refresh();
    } else {
      setReordered(null);
      const payload = await response.json().catch(() => ({}));
      setError(`Reordering failed: ${payload.error ?? response.status}`);
    }
  }

  const canDrag = canEdit && order.length > 1;

  return (
    // ph-no-capture travels with the gallery rather than being left to each
    // page that mounts it: the scene's own images and name are never
    // analytics material, wherever it is rendered.
    <div className="scene-gallery ph-no-capture">
      {urls.length > 0 || canEdit ? (
        <div className="scene-gallery__thumbs">
          {urls.map((image, index) => (
            <div
              className={[
                "scene-gallery__thumb-wrap",
                canDrag && image.id ? "scene-gallery__thumb-wrap--draggable" : "",
                dragging && dragging === image.id ? "scene-gallery__thumb-wrap--dragging" : "",
                dropTarget && dropTarget === image.id && dragging !== image.id
                  ? "scene-gallery__thumb-wrap--drop-target"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-image-id={image.id ?? undefined}
              draggable={canDrag && image.id ? true : undefined}
              key={image.id ?? "preview"}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (dragging && image.id) {
                  event.preventDefault();
                  if (dropTarget !== image.id) {
                    setDropTarget(image.id);
                  }
                }
              }}
              onDragStart={(event) => {
                if (!canDrag || !image.id) {
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", image.id);
                setDragging(image.id);
              }}
              onDrop={(event) => {
                if (!dragging || !image.id) {
                  return;
                }
                event.preventDefault();
                const from = dragging;
                setDragging(null);
                setDropTarget(null);
                void moveImage(from, image.id);
              }}
            >
              <button
                aria-label={`View image ${index + 1} full size`}
                className="scene-gallery__thumb"
                onClick={() => setZoomed(image.url)}
                title={canDrag && image.id ? "View full size · drag to reorder" : "View full size"}
                type="button"
              >
                <img alt="" src={image.url} />
              </button>
              {canEdit ? (
                <button
                  aria-label={`Remove image ${index + 1}`}
                  className="scene-gallery__thumb-remove"
                  disabled={busy}
                  onClick={() => void remove(image.id)}
                  title="Remove this image from the scene page"
                  type="button"
                >
                  <Trash2 aria-hidden size={12} />
                </button>
              ) : null}
            </div>
          ))}
          {canEdit ? (
            <>
              <button
                className="scene-gallery__thumb scene-gallery__add"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                title="Add an image to this scene's page"
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
