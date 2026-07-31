import { and, desc, eq, sql } from "drizzle-orm";
import { Download } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  accounts,
  createDb,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { CopyUrlField } from "../../../src/components/CopyUrlField";
import { ForkSceneButton } from "../../../src/components/ForkSceneButton";
import { PublicShell } from "../../../src/components/PublicShell";
import { ReportSceneButton } from "../../../src/components/ReportSceneButton";
import { SceneCategoryEditor } from "../../../src/components/SceneCategoryEditor";
import { SceneDescriptionEditor } from "../../../src/components/SceneDescriptionEditor";
import { SceneFrameosVersionEditor } from "../../../src/components/SceneFrameosVersionEditor";
import { SceneEditorModal } from "../../../src/components/SceneEditorModal";
import { SceneImageGallery } from "../../../src/components/SceneImageGallery";
import { SceneLivePreview } from "../../../src/components/SceneLivePreview";
import { SceneMarkdown } from "../../../src/components/SceneMarkdown";
import { SceneTagsEditor } from "../../../src/components/SceneTagsEditor";
import { StoreSceneActions } from "../../../src/components/StoreSceneActions";
import { SceneViewTracker } from "../../../src/components/SceneViewTracker";
import { YankVersionButton } from "../../../src/components/YankVersionButton";
import { getStoreCategory } from "../../../src/lib/categories";
import { getScenesBaseUrl, hasDatabaseUrl } from "../../../src/lib/env";
import {
  formatBytes,
  formatDate,
  formatDateTime,
} from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../src/lib/store-auth";
import { accountIsSuperadmin } from "../../../src/lib/superadmin";

export const dynamic = "force-dynamic";

type ScenePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string; share?: string }>;
};

// Full social-card metadata (OpenGraph + Twitter) for scenes anyone may see:
// public ones, and private ones opened through their ?share= token. Other
// private/pulled scenes keep the default title so names cannot be probed.
export async function generateMetadata({
  params,
  searchParams,
}: ScenePageProps) {
  const { slug } = await params;
  const { share } = await searchParams;
  if (!hasDatabaseUrl()) {
    return {};
  }
  const db = createDb();
  const [scene] = await db
    .select({
      description: storeScenes.description,
      hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
      id: storeScenes.id,
      name: storeScenes.name,
      previewImageHeight: storeScenes.previewImageHeight,
      previewImageWidth: storeScenes.previewImageWidth,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(and(eq(storeScenes.slug, slug), eq(storeScenes.status, "active")))
    .limit(1);
  if (!scene) {
    return {};
  }
  const isPublic = scene.visibility === "public";
  if (!isPublic && !shareTokenGrantsAccess(scene.shareToken, share)) {
    return {};
  }

  const shareSuffix = isPublic ? "" : `?share=${scene.shareToken}`;
  const pageUrl = new URL(
    `/s/${slug}${shareSuffix}`,
    getScenesBaseUrl(),
  ).toString();
  const description =
    scene.description ?? "A scene for FrameOS smart displays.";
  const [galleryImage] = scene.hasPreview
    ? []
    : await db
        .select({ id: storeSceneImages.id })
        .from(storeSceneImages)
        .where(eq(storeSceneImages.sceneId, scene.id))
        .orderBy(storeSceneImages.position, storeSceneImages.createdAt)
        .limit(1);
  const imagePath = scene.hasPreview
    ? `/api/store/scenes/${scene.id}/image`
    : galleryImage
      ? `/api/store/scenes/${scene.id}/images/${galleryImage.id}`
      : undefined;
  const imageUrl = imagePath
    ? new URL(`${imagePath}${shareSuffix}`, getScenesBaseUrl()).toString()
    : undefined;
  const images = imageUrl
    ? [
        {
          url: imageUrl,
          width: scene.previewImageWidth ?? undefined,
          height: scene.previewImageHeight ?? undefined,
          alt: scene.name,
        },
      ]
    : undefined;
  return {
    title: scene.name,
    description,
    openGraph: {
      title: scene.name,
      description,
      url: pageUrl,
      siteName: "FrameOS Scenes",
      type: "website",
      images,
    },
    twitter: {
      card: imageUrl ? "summary_large_image" : "summary",
      title: scene.name,
      description,
      images: imageUrl ? [imageUrl] : undefined,
    },
  };
}

export default async function ScenePage({
  params,
  searchParams,
}: ScenePageProps) {
  const { slug } = await params;
  const { version: versionParam, share: shareParam } = await searchParams;
  if (!hasDatabaseUrl()) {
    redirect("/");
  }

  const db = createDb();
  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      category: storeScenes.category,
      createdAt: storeScenes.createdAt,
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      previewImageHeight: storeScenes.previewImageHeight,
      previewImageWidth: storeScenes.previewImageWidth,
      publisher: accounts.displayName,
      pulledReason: storeScenes.pulledReason,
      riskFlags: storeScenes.riskFlags,
      shareToken: storeScenes.shareToken,
      slug: storeScenes.slug,
      status: storeScenes.status,
      tags: storeScenes.tags,
      updatedAt: storeScenes.updatedAt,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(eq(storeScenes.slug, slug))
    .limit(1);

  if (!scene) {
    notFound();
  }

  const session = await readSession();
  const isOwner = Boolean(
    session?.accountId && session.accountId === scene.accountId,
  );
  let isAdmin = false;
  if (session?.accountId && !isOwner) {
    const [row] = await db
      .select({ isSuperadmin: accounts.isSuperadmin })
      .from(accounts)
      .where(eq(accounts.id, session.accountId))
      .limit(1);
    isAdmin = row?.isSuperadmin ?? false;
  }

  // Private and pulled scenes exist only for their owner and moderators;
  // everyone else sees the same 404 a nonexistent slug would produce. The
  // owner's linked frameos backend also counts (bearer token): it fetches
  // this page to resolve the frameos:zip meta tag when the owner pastes a
  // private scene's URL into the Templates panel. A valid ?share= token
  // grants read access to a private (but never pulled) scene.
  const sharedAccess =
    scene.status === "active" &&
    shareTokenGrantsAccess(scene.shareToken, shareParam);
  let privileged = isOwner || isAdmin;
  if (
    !privileged &&
    !sharedAccess &&
    (scene.visibility !== "public" || scene.status !== "active")
  ) {
    const authorization = (await headers()).get("authorization");
    privileged = await canAccessPrivateScene(
      db,
      authorization,
      scene.accountId,
    );
  }
  if (
    (scene.visibility !== "public" || scene.status !== "active") &&
    !privileged &&
    !sharedAccess
  ) {
    notFound();
  }

  const versions = await db
    .select({
      createdAt: storeSceneVersions.createdAt,
      frameosVersion: storeSceneVersions.frameosVersion,
      sha256: storeSceneVersions.sha256,
      sizeBytes: storeSceneVersions.sizeBytes,
      version: storeSceneVersions.version,
      yankedAt: storeSceneVersions.yankedAt,
    })
    .from(storeSceneVersions)
    .where(eq(storeSceneVersions.sceneId, scene.id))
    .orderBy(desc(storeSceneVersions.version));

  // Owner-uploaded gallery images shown next to the zip's preview image.
  const galleryImages = await db
    .select({ id: storeSceneImages.id })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, scene.id))
    .orderBy(storeSceneImages.position, storeSceneImages.createdAt);

  // ?version=N pins the page to that published version. The latest version
  // counts as "viewing" by default; only pinning an OLDER version changes
  // anything (banner + versioned download).
  const requestedVersion = /^[0-9]{1,9}$/.test(versionParam ?? "")
    ? Number(versionParam)
    : null;
  const requestedVersionRow = requestedVersion
    ? (versions.find((candidate) => candidate.version === requestedVersion) ??
      null)
    : null;
  const pinnedVersion =
    requestedVersionRow && requestedVersionRow.version !== scene.latestVersion
      ? requestedVersionRow
      : null;
  const viewingVersionNumber = pinnedVersion?.version ?? scene.latestVersion;

  // Private scenes carry their ?share= token in every URL that leaves this
  // page (install link, zip meta tag, download/version links), so the links
  // keep working for people — and frames — without the owner's session.
  const isPrivate = scene.visibility !== "public";
  const share = isPrivate ? scene.shareToken : undefined;
  const withShare = (path: string) =>
    share ? `${path}${path.includes("?") ? "&" : "?"}share=${share}` : path;
  const downloadHref = withShare(
    pinnedVersion
      ? `/api/store/scenes/${scene.id}/download?version=${pinnedVersion.version}`
      : `/api/store/scenes/${scene.id}/download`,
  );

  const pageUrl = new URL(
    withShare(`/s/${scene.slug}`),
    getScenesBaseUrl(),
  ).toString();
  const zipUrl = new URL(
    withShare(`/api/store/scenes/${scene.id}/download`),
    getScenesBaseUrl(),
  ).toString();

  return (
    <PublicShell
      isSuperadmin={
        isOwner ? await accountIsSuperadmin(session?.accountId) : isAdmin
      }
      signedIn={Boolean(session)}
      title="FrameOS Scenes"
    >
      <SceneViewTracker sceneId={scene.id} visibility={scene.visibility} />
      {/* React hoists these into <head>. The frameos backend resolves a
          pasted scene-page URL to its zip through the frameos:zip tag; the
          social/description tags come from generateMetadata. */}
      <meta content={zipUrl} name="frameos:zip" />
      <meta content={scene.name} name="frameos:name" />
      <meta content={String(scene.latestVersion)} name="frameos:version" />
      <div className="content-header">
        <div>
          <h1>{scene.name}</h1>
          <p className="copy">
            by{" "}
            <Link href={`/publishers/${scene.accountId}`}>
              {scene.publisher ?? "FrameOS user"}
            </Link>{" "}
            · {scene.downloadCount} download
            {scene.downloadCount === 1 ? "" : "s"} · updated{" "}
            {formatDate(scene.updatedAt)}
            {scene.frameosVersion
              ? ` · requires FrameOS ${scene.frameosVersion} or newer`
              : ""}
          </p>
          {isOwner ? (
            <SceneFrameosVersionEditor
              frameosVersion={scene.frameosVersion}
              sceneId={scene.id}
            />
          ) : null}
          {scene.category || scene.tags.length > 0 || isOwner ? (
            <div className="tag-list">
              {scene.category ? (
                <Link
                  className="tag-pill tag-pill--category"
                  href={`/?category=${encodeURIComponent(scene.category)}`}
                >
                  {getStoreCategory(scene.category)?.title ?? scene.category}
                </Link>
              ) : null}
              {isOwner ? (
                <SceneCategoryEditor
                  category={scene.category}
                  sceneId={scene.id}
                />
              ) : null}
              {scene.tags.map((tag) => (
                <Link
                  className="tag-pill"
                  href={`/?tag=${encodeURIComponent(tag)}`}
                  key={tag}
                >
                  {tag}
                </Link>
              ))}
              {isOwner ? (
                <SceneTagsEditor sceneId={scene.id} tags={scene.tags} />
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="button-row">
          {scene.visibility === "public" && scene.status === "active" ? (
            <ReportSceneButton sceneId={scene.id} signedIn={Boolean(session)} />
          ) : null}
          {scene.status === "active" &&
          (scene.visibility === "public" || isOwner) ? (
            <ForkSceneButton sceneId={scene.id} signedIn={Boolean(session)} />
          ) : null}
          <a className="button" href={downloadHref}>
            <Download aria-hidden size={18} />
            {pinnedVersion
              ? `Download v${pinnedVersion.version}`
              : "Download zip"}
          </a>
        </div>
      </div>

      {pinnedVersion ? (
        <div className="notice">
          Viewing version {pinnedVersion.version}, published{" "}
          {formatDateTime(pinnedVersion.createdAt)}
          {pinnedVersion.yankedAt ? " (unpublished)" : ""} — the latest is v
          {scene.latestVersion}.{" "}
          <Link href={withShare(`/s/${scene.slug}`)}>Back to latest</Link>
        </div>
      ) : null}

      {scene.status === "pulled" ? (
        <p className="notice-error" role="alert">
          This scene was pulled by moderation and is hidden from the store
          {scene.pulledReason ? `: ${scene.pulledReason}` : "."}
        </p>
      ) : null}
      {scene.visibility !== "public" && scene.status === "active" ? (
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
          This scene configures apps or custom code that run shell commands on
          the frame. Only install it if you trust the publisher — review the
          scene after installing, before deploying it.
        </p>
      ) : null}

      <div className="scene-detail section-block">
        <SceneImageGallery
          canEdit={isOwner}
          hasPreview={scene.hasPreview}
          imageIds={galleryImages.map((image) => image.id)}
          sceneId={scene.id}
          sceneName={scene.name}
          share={share}
        />
        <div className="stack">
          {isOwner ? (
            <SceneDescriptionEditor
              description={scene.description}
              sceneId={scene.id}
            />
          ) : (
            <SceneMarkdown description={scene.description} />
          )}
          {/* The diagram is part of what a shared scene IS: everyone gets to
              look behind it. Only the owner can save a new version. */}
          <div className="button-row">
            <SceneEditorModal
              canFork={Boolean(session?.accountId)}
              canSave={isOwner && scene.status === "active"}
              description={scene.description}
              height={scene.previewImageHeight}
              sceneId={scene.id}
              share={share}
              width={scene.previewImageWidth}
            />
            <SceneLivePreview
              canSaveToGallery={isOwner}
              frameosVersion={scene.frameosVersion}
              height={scene.previewImageHeight}
              sceneId={scene.id}
              share={share}
              width={scene.previewImageWidth}
            />
          </div>
          <section className="card">
            <h3>Install on your FrameOS</h3>
            <p>
              Copy this link into the search box of a frame&apos;s Templates
              panel:
            </p>
            <CopyUrlField value={pageUrl} />
            {isPrivate ? (
              <p className="copy">
                The link carries a sharing secret: anyone who has it can view
                and install this private scene.
              </p>
            ) : null}
          </section>
        </div>
      </div>

      <section className="section-block">
        <h2>Versions</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>FrameOS</th>
              <th>Size</th>
              <th>SHA-256</th>
              <th>Status</th>
              {isOwner ? <th>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td>
                  <Link
                    href={withShare(
                      `/s/${scene.slug}?version=${version.version}`,
                    )}
                  >
                    v{version.version}
                  </Link>
                  {viewingVersionNumber === version.version ? (
                    <>
                      {" "}
                      <span className="pill">Viewing</span>
                    </>
                  ) : null}
                </td>
                <td>{formatDateTime(version.createdAt)}</td>
                <td>{version.frameosVersion ?? "—"}</td>
                <td>{formatBytes(version.sizeBytes)}</td>
                <td>
                  <code>{version.sha256.slice(0, 16)}…</code>
                </td>
                <td>
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
    </PublicShell>
  );
}
