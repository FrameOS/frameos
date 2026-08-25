// Database helpers for the evals: the eval account and store scenes as the
// editor would load them. Runs against the local cloud database that
// scripts/import-store-scenes.mjs filled.
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  accountIdentities,
  createDb,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { readBlob } from "../../src/lib/blobs";
import { extractScenesFromZip } from "../../src/lib/scene-title";

export type Db = ReturnType<typeof createDb>;

export async function evalAccountId(db: Db, email: string): Promise<string> {
  const [identity] = await db
    .select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.emailSnapshot, email), eq(accountIdentities.providerKey, "password")))
    .limit(1);
  if (!identity) {
    throw new Error(
      `No account with email ${email} in the database. Run scripts/import-store-scenes.mjs first, or set EVAL_ACCOUNT_EMAIL.`,
    );
  }
  return identity.accountId;
}

export type LoadedStoreScene = {
  id: string;
  slug: string;
  name: string;
  scenes: unknown[];
};

export async function loadStoreSceneBySlug(db: Db, slug: string): Promise<LoadedStoreScene> {
  const [scene] = await db
    .select({ id: storeScenes.id, name: storeScenes.name, slug: storeScenes.slug })
    .from(storeScenes)
    .where(eq(storeScenes.slug, slug))
    .limit(1);
  if (!scene) {
    throw new Error(`No store scene with slug "${slug}"`);
  }
  const [version] = await db
    .select()
    .from(storeSceneVersions)
    .where(and(eq(storeSceneVersions.sceneId, scene.id), isNull(storeSceneVersions.yankedAt)))
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  const content = await readBlob(version);
  const scenes = content ? extractScenesFromZip(content) : undefined;
  if (!scenes || scenes.length === 0) {
    throw new Error(`Store scene "${slug}" has no readable scenes.json`);
  }
  return { id: scene.id, name: scene.name, scenes, slug: scene.slug };
}
