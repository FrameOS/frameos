"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { getStoreCategory } from "../lib/categories";
import { formatDate } from "../lib/format";
import type { InstallableFrame } from "./InstallOnFrameBox";
import { ReportSceneButton } from "./ReportSceneButton";
import { SceneCategoryEditor } from "./SceneCategoryEditor";
import { SceneDescriptionEditor } from "./SceneDescriptionEditor";
import { SceneFrameosVersionEditor } from "./SceneFrameosVersionEditor";
import { SceneImageGallery } from "./SceneImageGallery";
import { SceneMarkdown } from "./SceneMarkdown";
import { SceneTagsEditor } from "./SceneTagsEditor";
import { StoreSceneActions } from "./StoreSceneActions";

/** The listing a version records (and the workspace drafts): plain JSON. */
export type SceneListingData = {
  category: string | null;
  description: string | null;
  frameosVersion: string | null;
  tags: string[];
};

/** The store scene as the Info panel shows it: plain JSON (ISO dates), so
 * the server page can hand it to the client-side editor modal as-is. The
 * listing fields here are the latest version's. */
export type SceneInfoScene = SceneListingData & {
  id: string;
  slug: string;
  name: string;
  accountId: string;
  publisher: string | null;
  downloadCount: number;
  /** ISO timestamp. */
  updatedAt: string;
  visibility: string;
  status: string;
  pulledReason: string | null;
  riskFlags: string[];
  latestVersion: number;
};

export type SceneInfoVersion = {
  version: number;
  /** ISO timestamp. */
  createdAt: string;
  frameosVersion: string | null;
  /** The publisher's one-line "what changed" note, null without one. */
  message: string | null;
  sizeBytes: number;
  sha256: string;
  /** ISO timestamp when unpublished (yanked), null otherwise. */
  yankedAt: string | null;
  /** The listing this version shows (its own, or the latest for versions
   * published before listings were recorded). */
  listing: SceneListingData;
  /** The version's image digests in order; the first is the cover. */
  images: string[];
};

/** Everything the Info panel needs, prepared once by the scene page and
 * shared by the page's own full-width rendering and the editor's column. */
export type SceneInfoData = {
  scene: SceneInfoScene;
  versions: SceneInfoVersion[];
  /** The latest version's image digests in order; the first is the cover. */
  images: string[];
  isOwner: boolean;
  isAdmin: boolean;
  signedIn: boolean;
  /** Share token for private scenes; travels with every link. */
  share?: string | undefined;
  /** The scene page's absolute URL (share token included) — the bar's
   * Install dialog's self-hosted link. */
  pageUrl: string;
  /** The signed-in visitor's cloud frames, or null when "Install on a
   * frame" is not offered (signed out, pulled scene); the Install dialog. */
  installableFrames: InstallableFrame[] | null;
  /** The workspace URL for a frame id, minus the id (…/frames/). */
  framesUrl: string;
};

/** The owner's draft, as the workspace holds it: the listing and images
 * shown are these, and edits go back through the callbacks — published by
 * the bar's Save, like the diagram. */
export type SceneInfoDraft = {
  listing: SceneListingData;
  images: string[];
  onListingChange: (changes: Partial<SceneListingData>) => void;
  onImagesChange: (images: string[]) => void;
};

export type SceneInfoPanelProps = SceneInfoData & {
  /** What heads the column: the workspace's scene name with its rename
   * pencil. */
  heading?: ReactNode;
  /** The listing and images to show instead of the latest version's (a
   * pinned version, or the owner's draft). */
  shown?: { listing: SceneListingData; images: string[] } | undefined;
  /** Owner editing: the draft the editors write into. */
  draft?: SceneInfoDraft | undefined;
};

// Everything the scene page says about a scene: its name (the heading)
// with the publisher line under it, the images, tags, notices and the
// description — with the owner's editors in place of the read-only bits.
// Installing lives in the bar's Install dialog, the versions in the bar's
// version dropdown and its "Manage versions…" dialog. The workspace's Info
// column.
export function SceneInfoPanel({
  scene,
  images: latestImages,
  isOwner,
  isAdmin,
  signedIn,
  share,
  heading,
  shown,
  draft,
}: SceneInfoPanelProps) {
  const isPrivate = scene.visibility !== "public";
  const isActive = scene.status === "active";
  const editing = draft !== undefined && isOwner && isActive;
  const listing: SceneListingData = draft?.listing ?? shown?.listing ?? scene;
  const images = draft?.images ?? shown?.images ?? latestImages;

  const showTags = listing.category || listing.tags.length > 0 || editing;

  return (
    <div className="scene-info scene-info--panel">
      <header className="scene-info__header">
        {heading ? <h1 className="scene-info__heading">{heading}</h1> : null}
        <p className="copy scene-info__byline">
          by{" "}
          <Link href={`/publishers/${scene.accountId}`}>{scene.publisher ?? "FrameOS user"}</Link>{" "}
          · {scene.downloadCount} download
          {scene.downloadCount === 1 ? "" : "s"} · updated {formatDate(new Date(scene.updatedAt))}
          {listing.frameosVersion ? ` · requires FrameOS ${listing.frameosVersion} or newer` : ""}
        </p>
      </header>
      {/* The description reads right under the title; ph-no-capture keeps
          the scene's own text (and the gallery's image URLs below) out of
          autocapture labels and attributes. */}
      <div className="section-block ph-no-capture">
        <div className="stack">
          {editing ? (
            <SceneDescriptionEditor
              description={listing.description}
              key={listing.description ?? ""}
              onChange={(description) => draft.onListingChange({ description })}
            />
          ) : (
            <SceneMarkdown description={listing.description} />
          )}
        </div>
      </div>
      {/* ph-no-capture travels with the gallery too. A pulled scene is
          frozen server-side, so the owner gets no add/remove controls on
          it rather than failing ones. */}
      <SceneImageGallery
        canEdit={editing}
        images={images}
        onChange={editing ? draft.onImagesChange : undefined}
        sceneId={scene.id}
        sceneName={scene.name}
        share={share}
      />
      {editing ? (
        <SceneFrameosVersionEditor
          frameosVersion={listing.frameosVersion}
          key={listing.frameosVersion ?? ""}
          onChange={(frameosVersion) => draft.onListingChange({ frameosVersion })}
        />
      ) : null}
      {showTags ? (
        <div className="tag-list">
          {listing.category ? (
            <Link
              className="tag-pill tag-pill--category"
              href={`/?category=${encodeURIComponent(listing.category)}`}
            >
              {getStoreCategory(listing.category)?.title ?? listing.category}
            </Link>
          ) : null}
          {editing ? (
            <SceneCategoryEditor
              category={listing.category}
              key={listing.category ?? ""}
              onChange={(category) => draft.onListingChange({ category })}
            />
          ) : null}
          {listing.tags.map((tag) => (
            <Link className="tag-pill" href={`/?tag=${encodeURIComponent(tag)}`} key={tag}>
              {tag}
            </Link>
          ))}
          {editing ? (
            <SceneTagsEditor
              key={listing.tags.join(",")}
              onChange={(tags) => draft.onListingChange({ tags })}
              tags={listing.tags}
            />
          ) : null}
        </div>
      ) : null}
      {scene.visibility === "public" && isActive ? (
        <div className="button-row">
          <ReportSceneButton sceneId={scene.id} signedIn={signedIn} />
        </div>
      ) : null}

      {scene.status === "pulled" ? (
        <div className="notice notice-error" role="alert">
          <span className="pill pill-warning">Pulled</span> This scene was pulled by moderation
          and is hidden from the store
          {scene.pulledReason ? `: ${scene.pulledReason}` : "."}
          {isOwner || isAdmin
            ? " Only you and moderators can open this page; the scene cannot be edited, installed or made visible while it is pulled."
            : ""}
          {isOwner ? (
            <div className="notice__actions">
              <StoreSceneActions
                name={scene.name}
                sceneId={scene.id}
                status={scene.status}
                visibility={scene.visibility}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {isPrivate && isActive ? (
        <div className="notice">
          {isOwner || isAdmin
            ? "This scene is private — it is only visible to you and to anyone you give the sharing link below."
            : "This scene is private — you are viewing it through a sharing link."}
          {isOwner ? (
            <div className="notice__actions">
              <StoreSceneActions
                name={scene.name}
                sceneId={scene.id}
                status={scene.status}
                visibility={scene.visibility}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {scene.riskFlags.includes("shell") ? (
        <p className="notice-error" role="alert">
          This scene configures apps or custom code that run shell commands on the frame. Only
          install it if you trust the publisher — review the scene after installing, before
          deploying it.
        </p>
      ) : null}

    </div>
  );
}
