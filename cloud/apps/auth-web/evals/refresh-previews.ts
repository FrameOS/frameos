// Re-render every AI-built store scene's CURRENT version and replace its
// storefront preview image with the result, skipping scenes that do not
// render cleanly. The builder used to store whatever the last attempt drew,
// error screens included, so cards could show a failure the scene no longer
// has.
//
//   pnpm --filter @frameos-cloud/auth-web ai:refresh-previews [--slug a,b] [--all-ai-built] [--dry-run]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { arrayContains, eq } from "drizzle-orm";
import { createDb, storeScenes } from "@frameos-cloud/db";
import { blobNamespaces, storeBlob } from "../src/lib/blobs";
import { DEFAULT_CLOUD_URL, HeadlessRenderer } from "../src/lib/ai/eval/render-check";
import { loadStoreSceneBySlug } from "./lib/store";

function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), "../../.env.local")]) {
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.call(process, candidate);
      } catch {
        // tolerate a malformed line
      }
      break;
    }
  }
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const slugArg = argv[argv.indexOf("--slug") + 1];
  const slugs = argv.includes("--slug") && slugArg ? slugArg.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const db = createDb(process.env.DATABASE_URL ?? "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud");
  const rows =
    slugs.length > 0
      ? await Promise.all(slugs.map(async (slug) => (await db.select({ slug: storeScenes.slug }).from(storeScenes).where(eq(storeScenes.slug, slug)))[0]))
      : await db.select({ slug: storeScenes.slug }).from(storeScenes).where(arrayContains(storeScenes.tags, ["ai-built"]));
  const renderer = await HeadlessRenderer.launch({ cloudUrl: process.env.CLOUD_URL ?? DEFAULT_CLOUD_URL });
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row) {
      continue;
    }
    const scene = await loadStoreSceneBySlug(db, row.slug);
    const first = scene.scenes[0] as { id?: string } | undefined;
    const rendered = await renderer.render({ height: 600, scenes: scene.scenes, ...(first?.id ? { sceneId: first.id } : {}), width: 800 });
    if (!rendered.rendered || !rendered.png || rendered.errors.length > 0) {
      skipped += 1;
      console.log(`- ${row.slug}: skipped (${rendered.errors[0]?.slice(0, 120) ?? "no frame"})`);
      continue;
    }
    if (dryRun) {
      console.log(`- ${row.slug}: would update preview (${rendered.png.length} bytes)`);
      updated += 1;
      continue;
    }
    const stored = await storeBlob(blobNamespaces.scenePreview, rendered.png, "image/png");
    await db
      .update(storeScenes)
      .set({
        previewImage: null,
        previewImageHeight: rendered.height,
        previewImageSizeBytes: stored.sizeBytes,
        previewImageType: "image/png",
        previewImageWidth: rendered.width,
        previewObjectKey: stored.objectKey,
        updatedAt: new Date(),
      })
      .where(eq(storeScenes.id, scene.id));
    updated += 1;
    console.log(`- ${row.slug}: preview updated`);
  }
  await renderer.close();
  console.log(`done: ${updated} updated, ${skipped} skipped`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
