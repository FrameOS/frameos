import { desc, eq, inArray } from "drizzle-orm";
import {
  accountIdentities,
  accounts,
  accountSettings,
  aiChatMessages,
  aiChats,
  auditEvents,
  clientBackups,
  createDb,
  frames,
  linkedClients,
  sessions,
  storeSceneImages,
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";

// GDPR art. 20 (portability) and art. 15 (access) in one file the user can
// download themselves, without asking us and without waiting a month.
//
// What is deliberately NOT in it:
//
//   * Password hashes, session tokens, share tokens, encrypted linked-client
//     credentials, device enrollment token hashes. These are credentials, not
//     personal data the user is entitled to a copy of, and putting them in a
//     file that then lives in a Downloads folder is a way to turn "I exported
//     my data" into "I leaked my account".
//   * Binary blobs — scene zips, gallery images, uploaded frame assets,
//     backup contents. They are described (name, size, sha256, type, download
//     URL) rather than embedded: a base64 JSON blob of a few hundred MB is not
//     a portable format, and every one of them already has a download link in
//     the UI. Portability requires a "structured, commonly used and
//     machine-readable format", not that everything be in one file.
//
// Everything else about the account is here, including the audit trail, which
// is the part an art. 15 request is usually actually after.

export type AccountExport = Awaited<ReturnType<typeof buildAccountExport>>;

function blobRef(input: {
  contentType: string | null;
  downloadPath?: string | undefined;
  sha256?: string | undefined;
  sizeBytes: number | undefined;
}) {
  return {
    contentType: input.contentType,
    downloadPath: input.downloadPath,
    note: "Binary content is not embedded in this export; download it from the path above while your account exists.",
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  };
}

export async function buildAccountExport(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const [account] = await db
    .select({
      createdAt: accounts.createdAt,
      displayName: accounts.displayName,
      id: accounts.id,
      isSuperadmin: accounts.isSuperadmin,
      primaryEmail: accounts.primaryEmail,
      storeBannedAt: accounts.storeBannedAt,
      storeBanReason: accounts.storeBanReason,
      updatedAt: accounts.updatedAt,
      verifiedPublisherAt: accounts.verifiedPublisherAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) {
    return undefined;
  }

  const [
    identities,
    settings,
    clients,
    accountSessions,
    accountFrames,
    scenes,
    backups,
    chats,
    events,
  ] = await Promise.all([
    db
      .select({
        createdAt: accountIdentities.createdAt,
        emailSnapshot: accountIdentities.emailSnapshot,
        emailVerified: accountIdentities.emailVerified,
        providerIssuer: accountIdentities.providerIssuer,
        providerKey: accountIdentities.providerKey,
        // The subject is the user's own email (password) or their Google
        // subject id — their data either way.
        providerSubject: accountIdentities.providerSubject,
      })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId)),
    db
      .select({
        createdAt: accountSettings.createdAt,
        key: accountSettings.key,
        updatedAt: accountSettings.updatedAt,
        value: accountSettings.value,
      })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId)),
    db
      .select({
        clientKind: linkedClients.clientKind,
        createdAt: linkedClients.createdAt,
        lastSeenAt: linkedClients.lastSeenAt,
        localOrigin: linkedClients.localOrigin,
        publicDisplayName: linkedClients.publicDisplayName,
        revokedAt: linkedClients.revokedAt,
      })
      .from(linkedClients)
      .where(eq(linkedClients.accountId, accountId)),
    db
      .select({
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.accountId, accountId)),
    db
      .select({
        assignedChecksum: frames.assignedChecksum,
        createdAt: frames.createdAt,
        frameosVersion: frames.frameosVersion,
        hardware: frames.hardware,
        id: frames.id,
        lastSeenAt: frames.lastSeenAt,
        name: frames.name,
        // The device's PUBLIC key only; we never hold the private half.
        publicKey: frames.publicKey,
        schedule: frames.schedule,
        settings: frames.settings,
        status: frames.status,
      })
      .from(frames)
      .where(eq(frames.accountId, accountId)),
    db
      .select({
        category: storeScenes.category,
        createdAt: storeScenes.createdAt,
        description: storeScenes.description,
        downloadCount: storeScenes.downloadCount,
        frameosVersion: storeScenes.frameosVersion,
        id: storeScenes.id,
        latestVersion: storeScenes.latestVersion,
        name: storeScenes.name,
        slug: storeScenes.slug,
        status: storeScenes.status,
        tags: storeScenes.tags,
        updatedAt: storeScenes.updatedAt,
        visibility: storeScenes.visibility,
      })
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId)),
    db
      .select({
        contentType: clientBackups.contentType,
        createdAt: clientBackups.createdAt,
        id: clientBackups.id,
        itemKey: clientBackups.itemKey,
        kind: clientBackups.kind,
        name: clientBackups.name,
        sha256: clientBackups.sha256,
        sizeBytes: clientBackups.sizeBytes,
      })
      .from(clientBackups)
      .where(eq(clientBackups.accountId, accountId)),
    db
      .select({
        contextId: aiChats.contextId,
        contextType: aiChats.contextType,
        createdAt: aiChats.createdAt,
        id: aiChats.id,
        title: aiChats.title,
        updatedAt: aiChats.updatedAt,
      })
      .from(aiChats)
      .where(eq(aiChats.accountId, accountId))
      .orderBy(desc(aiChats.updatedAt)),
    db
      .select({
        createdAt: auditEvents.createdAt,
        eventType: auditEvents.eventType,
        metadata: auditEvents.metadata,
        target: auditEvents.target,
      })
      // `actor` is deliberately not selected: on rows an operator produced
      // (a superadmin resolving a report on your scene) it identifies THEM,
      // and your access request is not a lookup tool for staff identities.
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountId))
      .orderBy(desc(auditEvents.createdAt)),
  ]);

  // Scene versions, gallery images and chat messages hang off the rows above,
  // so they need a second round — and `inArray` with an empty list is invalid
  // SQL, hence the guards.
  const sceneIds = scenes.map((scene) => scene.id);
  const chatIds = chats.map((chat) => chat.id);

  const [versions, images, messages] = await Promise.all([
    sceneIds.length
      ? db
          .select({
            createdAt: storeSceneVersions.createdAt,
            contentType: storeSceneVersions.contentType,
            frameosVersion: storeSceneVersions.frameosVersion,
            riskFlags: storeSceneVersions.riskFlags,
            sceneId: storeSceneVersions.sceneId,
            sha256: storeSceneVersions.sha256,
            sizeBytes: storeSceneVersions.sizeBytes,
            version: storeSceneVersions.version,
            yankedAt: storeSceneVersions.yankedAt,
          })
          .from(storeSceneVersions)
          .where(inArray(storeSceneVersions.sceneId, sceneIds))
      : [],
    sceneIds.length
      ? db
          .select({
            contentType: storeSceneImages.contentType,
            createdAt: storeSceneImages.createdAt,
            id: storeSceneImages.id,
            position: storeSceneImages.position,
            sceneId: storeSceneImages.sceneId,
          })
          .from(storeSceneImages)
          .where(inArray(storeSceneImages.sceneId, sceneIds))
      : [],
    chatIds.length
      ? db
          .select({
            chatId: aiChatMessages.chatId,
            content: aiChatMessages.content,
            createdAt: aiChatMessages.createdAt,
            payload: aiChatMessages.payload,
            role: aiChatMessages.role,
            tool: aiChatMessages.tool,
          })
          .from(aiChatMessages)
          .where(inArray(aiChatMessages.chatId, chatIds))
          .orderBy(aiChatMessages.id)
      : [],
  ]);

  return {
    account,
    aiChats: chats.map((chat) => ({
      ...chat,
      messages: messages.filter((message) => message.chatId === chat.id),
    })),
    auditEvents: events,
    backups: backups.map((backup) => ({
      ...backup,
      content: blobRef({
        contentType: backup.contentType,
        downloadPath: `/api/account/backups/${backup.id}`,
        sha256: backup.sha256,
        sizeBytes: backup.sizeBytes,
      }),
    })),
    frames: accountFrames,
    identities,
    linkedClients: clients,
    exportedAt: new Date().toISOString(),
    // A pointer to what this file leaves out, so the omissions are a stated
    // decision rather than something the reader has to notice.
    readme: {
      excluded:
        "Credentials (password hash, session/share/enrollment tokens, encrypted backend credentials) and binary file contents. Binary items are listed with their size, checksum and download path.",
      format: "JSON, UTF-8. Timestamps are ISO 8601 UTC.",
      questions:
        "For anything this does not cover, see /legal/privacy for how to make a full access request.",
    },
    scenes: scenes.map((scene) => ({
      ...scene,
      images: images
        .filter((image) => image.sceneId === scene.id)
        .map((image) => ({
          createdAt: image.createdAt,
          content: blobRef({
            contentType: image.contentType,
            downloadPath: `/api/store/scenes/${scene.id}/images/${image.id}`,
            sizeBytes: undefined,
          }),
          position: image.position,
        })),
      versions: versions
        .filter((version) => version.sceneId === scene.id)
        .map((version) => ({
          createdAt: version.createdAt,
          content: blobRef({
            contentType: version.contentType,
            downloadPath: `/api/store/scenes/${scene.id}/download?version=${version.version}`,
            sha256: version.sha256,
            sizeBytes: version.sizeBytes,
          }),
          frameosVersion: version.frameosVersion,
          riskFlags: version.riskFlags,
          version: version.version,
          yankedAt: version.yankedAt,
        })),
    })),
    sessions: accountSessions,
    settings,
  };
}
