import { and, desc, eq } from "drizzle-orm";
import { Download } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  accounts,
  createDb,
  frames,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { PublicShell } from "../../../src/components/PublicShell";
import { SceneEditorModal } from "../../../src/components/SceneEditorModal";
import type { SceneInfoData } from "../../../src/components/SceneInfoPanel";
import { SceneMarkdown } from "../../../src/components/SceneMarkdown";
import { SceneViewTracker } from "../../../src/components/SceneViewTracker";
import {
  getAccountBaseUrl,
  getCloudBaseUrl,
  getFramesUrl,
  getScenesBaseUrl,
  getStorePath,
  hasDatabaseUrl,
} from "../../../src/lib/env";
import { formatDate, formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../src/lib/store-auth";
import { accountIsSuperadmin } from "../../../src/lib/superadmin";
import { sceneHasPrimaryPreviewSql } from "../../../src/lib/store-preview";

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
      hasPreview: sceneHasPrimaryPreviewSql,
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
      hasPreview: sceneHasPrimaryPreviewSql,
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

  // The signed-in visitor's cloud frames, for "Install on a frame". Only an
  // active, non-pulled scene can be pushed; the box is skipped otherwise.
  const installableFrames =
    session?.accountId && scene.status === "active"
      ? await db
          .select({
            connected: frames.connected,
            id: frames.id,
            name: frames.name,
            status: frames.status,
          })
          .from(frames)
          .where(eq(frames.accountId, session.accountId))
          .orderBy(desc(frames.connected), frames.name)
      : null;
  const framesUrl = new URL("/frames/", getAccountBaseUrl()).toString();

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

  // Everything the workspace's Info panel shows, as plain JSON (the
  // workspace is a client component).
  const info: SceneInfoData = {
    framesUrl,
    imageIds: galleryImages.map((image) => image.id),
    installableFrames,
    isAdmin,
    isOwner,
    pageUrl,
    scene: {
      accountId: scene.accountId,
      category: scene.category,
      description: scene.description,
      downloadCount: scene.downloadCount,
      frameosVersion: scene.frameosVersion,
      hasPreview: scene.hasPreview,
      id: scene.id,
      latestVersion: scene.latestVersion,
      name: scene.name,
      publisher: scene.publisher,
      pulledReason: scene.pulledReason,
      riskFlags: scene.riskFlags,
      slug: scene.slug,
      status: scene.status,
      tags: scene.tags,
      updatedAt: scene.updatedAt.toISOString(),
      visibility: scene.visibility,
    },
    share,
    signedIn: Boolean(session),
    versions: versions.map((version) => ({
      createdAt: version.createdAt.toISOString(),
      frameosVersion: version.frameosVersion,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      version: version.version,
      yankedAt: version.yankedAt ? version.yankedAt.toISOString() : null,
    })),
  };

  return (
    <PublicShell
      isSuperadmin={
        isOwner ? await accountIsSuperadmin(session?.accountId) : isAdmin
      }
      // A public store page is public, and its browse traffic is worth
      // measuring. A private scene reached through its share link is not:
      // its name, description and images are the owner's, shown to whoever
      // holds the link, and none of that should reach analytics.
      noCapture={isPrivate}
      signedIn={Boolean(session)}
    >
      <SceneViewTracker sceneId={scene.id} visibility={scene.visibility} />
      {/* React hoists these into <head>. The frameos backend resolves a
          pasted scene-page URL to its zip through the frameos:zip tag; the
          social/description tags come from generateMetadata. */}
      <meta content={zipUrl} name="frameos:zip" />
      <meta content={scene.name} name="frameos:name" />
      <meta content={String(scene.latestVersion)} name="frameos:version" />
      {/* The page IS the full-screen workspace below (a client component
          that covers everything once mounted). This header is what crawlers
          and browsers without JavaScript get: the name, the publisher line,
          the description and the zip. */}
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
          <SceneMarkdown description={scene.description} />
        </div>
        <div className="button-row">
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
      {/* The diagram is part of what a shared scene IS: everyone gets to
          look behind it. Only the owner can save a new version. */}
      <SceneEditorModal
        backUrl={getStorePath()}
        canFork={Boolean(session?.accountId)}
        canPreview={scene.status !== "pulled"}
        canRemix={scene.status === "active"}
        canSave={isOwner && scene.status === "active"}
        description={scene.description}
        downloadUrl={downloadHref}
        height={scene.previewImageHeight}
        info={info}
        loginUrl={new URL("/login", getCloudBaseUrl()).toString()}
        signupUrl={new URL("/signup", getCloudBaseUrl()).toString()}
        pinnedVersion={pinnedVersion ? pinnedVersion.version : null}
        sceneId={scene.id}
        settingsUrl={`${getFramesUrl()}/settings#settings-openai`}
        share={share}
        signedIn={Boolean(session?.accountId)}
        versions={info.versions}
        width={scene.previewImageWidth}
      />
    </PublicShell>
  );
}
