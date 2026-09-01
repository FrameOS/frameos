import { and, desc, eq } from "drizzle-orm";
import { Download } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  accounts,
  createDb,
  frames,
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
  getAccountUrl,
  getCloudBaseUrl,
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
import {
  defaultSceneDescription,
  socialDescription,
} from "../../../src/lib/social-description";
import { listingForVersion } from "../../../src/lib/store-listing";
import { imageSetForVersion, imageSetForVersionId } from "../../../src/lib/store-images";

export const dynamic = "force-dynamic";

type ScenePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string; share?: string }>;
};

// Discord paints a link embed's left edge in the page's theme-color; the
// FrameOS green (--primary in globals.css) makes a shared scene card read as
// ours at a glance. Declared here rather than in the root layout so the
// account pages keep the browser's default chrome tint.
export function generateViewport() {
  return { themeColor: "#1c7c66" };
}

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
      id: storeScenes.id,
      name: storeScenes.name,
      publisher: accounts.displayName,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
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
  // Markdown flattened to the one plain paragraph a link card can show.
  const description = socialDescription(
    scene.description,
    defaultSceneDescription(scene.publisher),
  );
  const [cover] = await imageSetForVersion(db, scene.id, null);
  const images = cover
    ? [
        {
          url: new URL(
            `/api/store/scenes/${scene.id}/image${shareSuffix}`,
            getScenesBaseUrl(),
          ).toString(),
          width: cover.width ?? undefined,
          height: cover.height ?? undefined,
          alt: scene.name,
        },
      ]
    : undefined;
  const imageUrl = images?.[0]?.url;
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
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
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
  // The AI switch (Account → AI usage). Read here so the panel can say AI is
  // off BEFORE accepting a prompt: the gate would refuse the turn anyway, but
  // discovering that after typing and waiting is a bad way to learn it.
  let aiDisabled = false;
  if (session?.accountId) {
    const [row] = await db
      .select({
        aiDisabledAt: accounts.aiDisabledAt,
        isSuperadmin: accounts.isSuperadmin,
      })
      .from(accounts)
      .where(eq(accounts.id, session.accountId))
      .limit(1);
    aiDisabled = Boolean(row?.aiDisabledAt);
    isAdmin = isOwner ? false : (row?.isSuperadmin ?? false);
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
      category: storeSceneVersions.category,
      createdAt: storeSceneVersions.createdAt,
      description: storeSceneVersions.description,
      frameosVersion: storeSceneVersions.frameosVersion,
      id: storeSceneVersions.id,
      listingRecorded: storeSceneVersions.listingRecorded,
      message: storeSceneVersions.message,
      sha256: storeSceneVersions.sha256,
      sizeBytes: storeSceneVersions.sizeBytes,
      tags: storeSceneVersions.tags,
      version: storeSceneVersions.version,
      yankedAt: storeSceneVersions.yankedAt,
    })
    .from(storeSceneVersions)
    .where(eq(storeSceneVersions.sceneId, scene.id))
    .orderBy(desc(storeSceneVersions.version));

  // Each version's image set (versions from before sets were recorded show
  // the latest's), and the latest's, which is the page's own.
  const latestImages = await imageSetForVersion(db, scene.id, null);
  const versionImages = new Map<number, string[]>();
  for (const version of versions) {
    versionImages.set(
      version.version,
      version.listingRecorded
        ? (await imageSetForVersionId(db, version.id)).map((image) => image.sha256)
        : latestImages.map((image) => image.sha256),
    );
  }

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
  const shownListing = pinnedVersion ? listingForVersion(pinnedVersion, scene) : scene;
  const zipUrl = new URL(
    withShare(`/api/store/scenes/${scene.id}/download`),
    getScenesBaseUrl(),
  ).toString();

  // Everything the workspace's Info panel shows, as plain JSON (the
  // workspace is a client component).
  const info: SceneInfoData = {
    framesUrl,
    images: latestImages.map((image) => image.sha256),
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
    versions: versions.map((version) => {
      const listing = listingForVersion(version, scene);
      return {
        createdAt: version.createdAt.toISOString(),
        frameosVersion: listing.frameosVersion,
        images: versionImages.get(version.version) ?? [],
        listing,
        message: version.message,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
        version: version.version,
        yankedAt: version.yankedAt ? version.yankedAt.toISOString() : null,
      };
    }),
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
            {shownListing.frameosVersion
              ? ` · requires FrameOS ${shownListing.frameosVersion} or newer`
              : ""}
          </p>
          <SceneMarkdown description={shownListing.description} />
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
        aiDisabled={aiDisabled}
        aiSettingsUrl={getAccountUrl("/account/ai")}
        backUrl={getStorePath()}
        canFork={Boolean(session?.accountId)}
        canPreview={scene.status !== "pulled"}
        canRemix={scene.status === "active"}
        canSave={isOwner && scene.status === "active"}
        description={shownListing.description}
        downloadUrl={downloadHref}
        height={latestImages[0]?.height ?? null}
        info={info}
        loginUrl={new URL("/login", getCloudBaseUrl()).toString()}
        signupUrl={new URL("/signup", getCloudBaseUrl()).toString()}
        pinnedVersion={pinnedVersion ? pinnedVersion.version : null}
        sceneId={scene.id}
        settingsUrl={`${getAccountUrl("/account/settings")}#settings-openai`}
        share={share}
        signedIn={Boolean(session?.accountId)}
        versions={info.versions}
        width={latestImages[0]?.width ?? null}
      />
    </PublicShell>
  );
}
