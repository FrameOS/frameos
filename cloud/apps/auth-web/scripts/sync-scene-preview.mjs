/* global console */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { strToU8, unzipSync, zipSync } from "fflate";
import postgres from "postgres";

const maxSceneZipBytes = 8 * 1024 * 1024;
const maxVersionsPerScene = 20;

const slug = process.argv[2]?.trim();
if (!slug) {
  throw new Error("Usage: pnpm scene:sync-preview -- <scene-slug>");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  ...(process.env.DATABASE_SSL === "require" ||
  process.env.DATABASE_SSL === "true"
    ? { ssl: "require" }
    : {}),
});

try {
  const result = await sql.begin(async (tx) => {
    const [scene] = await tx`
      select account_id, id, latest_version, name, preview_image
      from store_scenes
      where slug = ${slug}
      for update
    `;
    if (!scene) {
      throw new Error(`Scene not found: ${slug}`);
    }

    const [galleryLead] = await tx`
      select content
      from store_scene_images
      where scene_id = ${scene.id}
      order by position asc, created_at asc
      limit 1
    `;
    const leadImage = scene.preview_image ?? galleryLead?.content;

    const [latest] = await tx`
      select content, frameos_version, risk_flags, version
      from store_scene_versions
      where scene_id = ${scene.id} and yanked_at is null
      order by version desc
      limit 1
    `;
    if (!latest) {
      throw new Error(`No downloadable version found for: ${slug}`);
    }

    const rebuilt = rebuildZipWithPreview(
      Buffer.from(latest.content),
      leadImage ? Buffer.from(leadImage) : undefined,
    );
    if (!rebuilt) {
      throw new Error(`Invalid scene ZIP for: ${slug}`);
    }
    if (!rebuilt.changed) {
      return {
        changed: false,
        sceneId: scene.id,
        version: latest.version,
      };
    }
    if (rebuilt.content.length > maxSceneZipBytes) {
      throw new Error(`Rebuilt scene ZIP exceeds ${maxSceneZipBytes} bytes`);
    }

    const nextVersion = scene.latest_version + 1;
    const sha256 = createHash("sha256").update(rebuilt.content).digest("hex");
    await tx`
      insert into store_scene_versions (
        content,
        content_type,
        frameos_version,
        risk_flags,
        scene_id,
        sha256,
        size_bytes,
        version
      ) values (
        ${rebuilt.content},
        'application/zip',
        ${latest.frameos_version},
        ${latest.risk_flags},
        ${scene.id},
        ${sha256},
        ${rebuilt.content.length},
        ${nextVersion}
      )
    `;
    await tx`
      delete from store_scene_versions
      where scene_id = ${scene.id}
        and version < ${nextVersion - maxVersionsPerScene + 1}
    `;
    await tx`
      update store_scenes
      set latest_version = ${nextVersion}, updated_at = now()
      where id = ${scene.id}
    `;
    await tx`
      insert into audit_events (account_id, actor, event_type, metadata, target)
      values (
        ${scene.account_id},
        ${tx.json({ kind: "maintenance" })},
        'store.scene_preview_synced',
        ${tx.json({ name: scene.name, version: nextVersion })},
        ${tx.json({ sceneId: scene.id })}
      )
    `;

    return { changed: true, sceneId: scene.id, version: nextVersion };
  });
  console.log(JSON.stringify({ slug, ...result }));
} finally {
  await sql.end({ timeout: 5 });
}

function rebuildZipWithPreview(zipBytes, previewImage) {
  try {
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) =>
        /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(file.name),
    });
    const manifestPath = Object.keys(files)
      .filter((name) => /(^|\/)template\.json$/.test(name))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
    const manifestBytes = manifestPath ? files[manifestPath] : undefined;
    if (!manifestPath || !manifestBytes) {
      return undefined;
    }
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return undefined;
    }
    const folder = manifestPath.slice(
      0,
      manifestPath.length - "template.json".length,
    );
    const scenes = files[`${folder}scenes.json`];
    if (!scenes) {
      return undefined;
    }

    const currentImage = files[`${folder}image.jpg`];
    const changed = previewImage
      ? !currentImage ||
        !Buffer.from(currentImage).equals(previewImage) ||
        manifest.image !== "./image.jpg"
      : Boolean(currentImage || manifest.image);
    if (!changed) {
      return { changed: false, content: zipBytes };
    }

    delete manifest.imageHeight;
    delete manifest.imageWidth;
    if (previewImage) {
      manifest.image = "./image.jpg";
    } else {
      delete manifest.image;
    }
    const next = {
      [manifestPath]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}scenes.json`]: scenes,
    };
    if (previewImage) {
      next[`${folder}image.jpg`] = new Uint8Array(previewImage);
    }
    return { changed: true, content: Buffer.from(zipSync(next)) };
  } catch {
    return undefined;
  }
}

function depth(path) {
  return path.split("/").length - 1;
}
