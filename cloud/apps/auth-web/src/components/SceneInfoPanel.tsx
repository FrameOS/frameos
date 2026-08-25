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

/** The store scene as the Info panel shows it: plain JSON (ISO dates), so
 * the server page can hand it to the client-side editor modal as-is. */
export type SceneInfoScene = {
  id: string;
  slug: string;
  name: string;
  accountId: string;
  publisher: string | null;
  downloadCount: number;
  /** ISO timestamp. */
  updatedAt: string;
  frameosVersion: string | null;
  category: string | null;
  tags: string[];
  description: string | null;
  visibility: string;
  status: string;
  pulledReason: string | null;
  riskFlags: string[];
  latestVersion: number;
  hasPreview: boolean;
};

export type SceneInfoVersion = {
  version: number;
  /** ISO timestamp. */
  createdAt: string;
  frameosVersion: string | null;
  sizeBytes: number;
  sha256: string;
  /** ISO timestamp when unpublished (yanked), null otherwise. */
  yankedAt: string | null;
};

/** Everything the Info panel needs, prepared once by the scene page and
 * shared by the page's own full-width rendering and the editor's column. */
export type SceneInfoData = {
  scene: SceneInfoScene;
  versions: SceneInfoVersion[];
  /** Owner-uploaded gallery image ids (the zip's preview is `hasPreview`). */
  imageIds: string[];
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

export type SceneInfoPanelProps = SceneInfoData & {
  /** What heads the column: the workspace's scene name with its rename
   * pencil. */
  heading?: ReactNode;
};

// Everything the scene page says about a scene: its name (the heading)
// with the publisher line under it, the images, tags, notices and the
// description — with the owner's editors in place of the read-only bits.
// Installing lives in the bar's Install dialog, the versions in the bar's
// version dropdown and its "Manage versions…" dialog. The workspace's Info
// column.
export function SceneInfoPanel({
  scene,
  imageIds,
  isOwner,
  isAdmin,
  signedIn,
  share,
  heading,
}: SceneInfoPanelProps) {
  const isPrivate = scene.visibility !== "public";
  const isActive = scene.status === "active";

  const showTags = scene.category || scene.tags.length > 0 || isOwner;

  return (
    <div className="scene-info scene-info--panel">
      <header className="scene-info__header">
        {heading ? <h1 className="scene-info__heading">{heading}</h1> : null}
        <p className="copy scene-info__byline">
          by{" "}
          <Link href={`/publishers/${scene.accountId}`}>{scene.publisher ?? "FrameOS user"}</Link>{" "}
          · {scene.downloadCount} download
          {scene.downloadCount === 1 ? "" : "s"} · updated {formatDate(new Date(scene.updatedAt))}
          {scene.frameosVersion ? ` · requires FrameOS ${scene.frameosVersion} or newer` : ""}
        </p>
      </header>
      {/* ph-no-capture travels with the gallery (and the description below):
          autocapture would otherwise ship image URLs as element attributes
          and the scene's own text as click labels. */}
      <SceneImageGallery
        canEdit={isOwner}
        hasPreview={scene.hasPreview}
        imageIds={imageIds}
        sceneId={scene.id}
        sceneName={scene.name}
        share={share}
      />
      {isOwner ? (
        <SceneFrameosVersionEditor frameosVersion={scene.frameosVersion} sceneId={scene.id} />
      ) : null}
      {showTags ? (
        <div className="tag-list">
          {scene.category ? (
            <Link
              className="tag-pill tag-pill--category"
              href={`/?category=${encodeURIComponent(scene.category)}`}
            >
              {getStoreCategory(scene.category)?.title ?? scene.category}
            </Link>
          ) : null}
          {isOwner ? <SceneCategoryEditor category={scene.category} sceneId={scene.id} /> : null}
          {scene.tags.map((tag) => (
            <Link className="tag-pill" href={`/?tag=${encodeURIComponent(tag)}`} key={tag}>
              {tag}
            </Link>
          ))}
          {isOwner ? <SceneTagsEditor sceneId={scene.id} tags={scene.tags} /> : null}
        </div>
      ) : null}
      {scene.visibility === "public" && isActive ? (
        <div className="button-row">
          <ReportSceneButton sceneId={scene.id} signedIn={signedIn} />
        </div>
      ) : null}

      {scene.status === "pulled" ? (
        <p className="notice-error" role="alert">
          This scene was pulled by moderation and is hidden from the store
          {scene.pulledReason ? `: ${scene.pulledReason}` : "."}
        </p>
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

      <div className="section-block ph-no-capture">
        <div className="stack">
          {isOwner ? (
            <SceneDescriptionEditor description={scene.description} sceneId={scene.id} />
          ) : (
            <SceneMarkdown description={scene.description} />
          )}
        </div>
      </div>

    </div>
  );
}
