"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// Scene-page image gallery: the zip's preview image plus any owner-uploaded
// gallery images, with a thumbnail strip when there is more than one. Owners
// add images (moderated server-side) and remove both the primary preview and
// uploaded gallery images.
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

  const shareSuffix = share ? `?share=${encodeURIComponent(share)}` : "";
  const previewUrl = `/api/store/scenes/${sceneId}/image${shareSuffix}`;
  const urls: { id: string | null; url: string }[] = [
    ...(hasPreview ? [{ id: null, url: previewUrl }] : []),
    ...imageIds.map((id) => ({
      id,
      url: `/api/store/scenes/${sceneId}/images/${id}${shareSuffix}`,
    })),
  ];
  const [selected, setSelected] = useState(0);
  const current = urls[Math.min(selected, urls.length - 1)];

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
      setSelected(0);
      router.refresh();
    } else {
      const payload = await response.json().catch(() => ({}));
      setError(`Removing failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    // ph-no-capture travels with the gallery rather than being left to each
    // page that mounts it: the scene's own images and name are never
    // analytics material, wherever it is rendered.
    <div className="scene-gallery ph-no-capture">
      {current ? (
        <div className="scene-gallery__main">
          <img
            alt={`${sceneName} preview`}
            className="scene-card__image"
            src={current.url}
          />
          {canEdit ? (
            <button
              className="scene-gallery__remove"
              disabled={busy}
              onClick={() => void remove(current.id)}
              title="Remove this image"
              type="button"
            >
              <Trash2 aria-hidden size={14} />
              Remove
            </button>
          ) : null}
        </div>
      ) : (
        <div aria-hidden className="scene-card__placeholder">
          No preview
        </div>
      )}
      {urls.length > 1 || canEdit ? (
        <div className="scene-gallery__thumbs">
          {urls.map((image, index) => (
            <button
              className={
                index === Math.min(selected, urls.length - 1)
                  ? "scene-gallery__thumb scene-gallery__thumb--active"
                  : "scene-gallery__thumb"
              }
              key={image.id ?? "preview"}
              onClick={() => setSelected(index)}
              type="button"
            >
              <img alt="" src={image.url} />
            </button>
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
      ) : null}
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
