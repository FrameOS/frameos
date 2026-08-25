"use client";

import Link from "next/link";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getStoreCategory } from "../lib/categories";
import { formatBytes, formatDate, formatDateTime } from "../lib/format";
import { CopyUrlField } from "./CopyUrlField";
import { InstallOnFrameBox, type InstallableFrame } from "./InstallOnFrameBox";
import { ReportSceneButton } from "./ReportSceneButton";
import { SceneCategoryEditor } from "./SceneCategoryEditor";
import { SceneDescriptionEditor } from "./SceneDescriptionEditor";
import { SceneFrameosVersionEditor } from "./SceneFrameosVersionEditor";
import { SceneImageGallery } from "./SceneImageGallery";
import { SceneMarkdown } from "./SceneMarkdown";
import { SceneTagsEditor } from "./SceneTagsEditor";
import { StoreSceneActions } from "./StoreSceneActions";
import { YankVersionButton } from "./YankVersionButton";

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
  /** The scene page's absolute URL (share token included), for
   * "Install on a self-hosted FrameOS". */
  pageUrl: string;
  /** The signed-in visitor's cloud frames, or null when "Install on a
   * frame" is not offered (signed out, pulled scene). */
  installableFrames: InstallableFrame[] | null;
  /** The workspace URL for a frame id, minus the id (…/frames/). */
  framesUrl: string;
};

export type SceneInfoPanelProps = SceneInfoData & {
  /** The version the visitor is looking at: the page's pinned version (or
   * the latest), or in the editor the one the Preview panel runs. Null
   * when none is (the preview runs the editor's unsaved scenes). */
  viewingVersion: number | null;
  /** A click on a version row calls this (the Preview panel runs it)
   * instead of navigating the page to `?version=N`. */
  onSelectVersion?: ((version: number) => void) | undefined;
  /** Whether the Preview panel is open beside this column: the gallery then
   * keeps to its thumbnails (the preview shows the scene itself, and the
   * column is narrow); each opens the lightbox. */
  previewOpen?: boolean | undefined;
};

// Everything the scene page says about a scene besides its name: gallery
// first, then metadata, description, notices, install instructions and the
// versions table — with the owner's editors in place of the read-only bits.
// The workspace's Info column.
export function SceneInfoPanel({
  scene,
  versions,
  imageIds,
  isOwner,
  isAdmin,
  signedIn,
  share,
  pageUrl,
  installableFrames,
  framesUrl,
  viewingVersion,
  onSelectVersion,
  previewOpen = false,
}: SceneInfoPanelProps) {
  const isPrivate = scene.visibility !== "public";
  const isActive = scene.status === "active";
  const withShare = (path: string) =>
    share ? `${path}${path.includes("?") ? "&" : "?"}share=${share}` : path;
  // "Install on a frame" pushes the version being looked at when it is not
  // the latest (a pinned page, a version picked in the editor's table).
  const installVersion =
    viewingVersion !== null && viewingVersion !== scene.latestVersion ? viewingVersion : null;

  function versionClick(version: number) {
    return (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onSelectVersion?.(version);
    };
  }

  const showTags = scene.category || scene.tags.length > 0 || isOwner;

  return (
    <div className="scene-info scene-info--panel">
      {/* ph-no-capture travels with the gallery (and the description below):
          autocapture would otherwise ship image URLs as element attributes
          and the scene's own text as click labels. */}
      <SceneImageGallery
        canEdit={isOwner}
        compact={previewOpen}
        hasPreview={scene.hasPreview}
        imageIds={imageIds}
        sceneId={scene.id}
        sceneName={scene.name}
        share={share}
      />
      <div className="scene-info__meta">
        <p className="copy">
          by{" "}
          <Link href={`/publishers/${scene.accountId}`}>{scene.publisher ?? "FrameOS user"}</Link>{" "}
          · {scene.downloadCount} download
          {scene.downloadCount === 1 ? "" : "s"} · updated {formatDate(new Date(scene.updatedAt))}
          {scene.frameosVersion ? ` · requires FrameOS ${scene.frameosVersion} or newer` : ""}
        </p>
      </div>
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
          {installableFrames ? (
            <InstallOnFrameBox
              frames={installableFrames}
              framesUrl={framesUrl}
              sceneId={scene.id}
              sceneName={scene.name}
              sceneVersion={installVersion}
            />
          ) : null}
          <section className="card">
            <h3>{installableFrames ? "Install on a self-hosted FrameOS" : "Install on your FrameOS"}</h3>
            <p>Copy this link into the search box of a frame&apos;s Templates panel:</p>
            <CopyUrlField value={pageUrl} />
            {isPrivate ? (
              <p className="copy">
                The link carries a sharing secret: anyone who has it can view and install this
                private scene.
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {/* One narrow column's worth of table: the version with its status
          pills under it, the date with the zip's details under that, the
          owner's action — everything wraps, nothing scrolls sideways. */}
      <section className="section-block scene-info__versions">
        <h2>Versions</h2>
        <table className="table scene-versions">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              {isOwner ? <th>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td>
                  <Link
                    href={withShare(`/s/${scene.slug}?version=${version.version}`)}
                    {...(onSelectVersion ? { onClick: versionClick(version.version) } : {})}
                    title={
                      onSelectVersion
                        ? `Run v${version.version} in the Preview panel`
                        : `View v${version.version}`
                    }
                  >
                    v{version.version}
                  </Link>
                  <div className="scene-versions__pills">
                    {version.yankedAt ? (
                      <span
                        className="pill pill-warning"
                        title="Skipped by new installs; still downloadable when requested explicitly"
                      >
                        Unpublished
                      </span>
                    ) : version.version === scene.latestVersion ? (
                      <span className="pill pill-ok">Latest</span>
                    ) : (
                      <span className="pill">Published</span>
                    )}
                    {viewingVersion === version.version ? <span className="pill">Previewing</span> : null}
                  </div>
                </td>
                <td>
                  {formatDateTime(new Date(version.createdAt))}
                  <div className="scene-versions__detail">
                    <span title="Minimum FrameOS version">
                      {version.frameosVersion ? `FrameOS ${version.frameosVersion}+` : "any FrameOS"}
                    </span>
                    {" · "}
                    <span>{formatBytes(version.sizeBytes)}</span>
                    {" · "}
                    <code title={`SHA-256 ${version.sha256}`}>{version.sha256.slice(0, 12)}…</code>
                  </div>
                </td>
                {isOwner ? (
                  <td>
                    <YankVersionButton
                      sceneId={scene.id}
                      version={version.version}
                      yanked={Boolean(version.yankedAt)}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
