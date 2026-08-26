import Link from "next/link";
import type { ReactNode } from "react";
import { getStoreCategory } from "../lib/categories";
import { formatDate } from "../lib/format";

export type SceneCardScene = {
  // Store category slug (categories.ts); shown as a pill when set.
  category?: string | null | undefined;
  description: string | null;
  downloadCount: number;
  frameosVersion?: string | null;
  hasPreview: boolean;
  id: string;
  name: string;
  // Omit (undefined) to leave the publisher out of the meta line — the
  // owner's own listing has no one to credit. null still reads "FrameOS user".
  publisher?: string | null | undefined;
  riskFlags?: string[];
  slug: string;
  // "active" | "pulled"; a pulled scene shows a "Pulled" pill in place of
  // its visibility (the owner's listing).
  status?: string | undefined;
  tags?: string[];
  updatedAt: Date;
  // "private" | "public"; shown as a pill when set (the owner's listing).
  visibility?: string | undefined;
};

export function SceneCard({
  menu,
  scene,
}: {
  // Controls pinned to the card's top-right corner (the owner's "..." menu).
  // The card itself is one link, so anything interactive has to sit beside
  // it rather than inside it.
  menu?: ReactNode | undefined;
  scene: SceneCardScene;
}) {
  const category = scene.category
    ? (getStoreCategory(scene.category)?.title ?? scene.category)
    : null;
  const tags = scene.tags ?? [];
  const card = (
    <Link className="scene-card" href={`/s/${scene.slug}`}>
      {scene.hasPreview ? (
        // Served by our own image route with a fixed content type. Owners
        // see their private scenes' previews through the session cookie.
        <img
          alt=""
          className="scene-card__image"
          loading="lazy"
          src={`/api/store/scenes/${scene.id}/image`}
        />
      ) : (
        <div aria-hidden className="scene-card__placeholder">
          No preview
        </div>
      )}
      <h3>
        {scene.name}
        {scene.riskFlags?.includes("shell") ? (
          <span
            className="risk-badge"
            title="This scene configures apps or code that run shell commands on the frame"
          >
            runs shell commands
          </span>
        ) : null}
      </h3>
      {scene.description ? <p className="copy">{scene.description}</p> : null}
      {scene.visibility || category || tags.length > 0 ? (
        <div className="tag-list">
          {scene.visibility && scene.status === "pulled" ? (
            <span className="pill pill-warning">Pulled</span>
          ) : scene.visibility ? (
            <span
              className={
                scene.visibility === "public" ? "pill pill-ok" : "pill"
              }
            >
              {scene.visibility === "public" ? "Public" : "Private"}
            </span>
          ) : null}
          {category ? (
            <span className="tag-pill tag-pill--category">{category}</span>
          ) : null}
          {tags.slice(0, 4).map((tag) => (
            // The whole card is a link; tags render as plain pills here and
            // are clickable filters on the scene page.
            <span className="tag-pill" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="scene-card__meta">
        {scene.publisher !== undefined ? (
          <>
            <span>{scene.publisher ?? "FrameOS user"}</span>
            <span>·</span>
          </>
        ) : null}
        <span>
          {scene.downloadCount} download{scene.downloadCount === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>{formatDate(scene.updatedAt)}</span>
        {scene.frameosVersion ? (
          <>
            <span>·</span>
            <span title={`Requires FrameOS ${scene.frameosVersion} or newer`}>
              FrameOS {scene.frameosVersion}
            </span>
          </>
        ) : null}
      </div>
    </Link>
  );
  if (!menu) {
    return card;
  }
  return (
    <div className="scene-card-wrap">
      {card}
      <div className="scene-card__menu">{menu}</div>
    </div>
  );
}
