import { sql } from "drizzle-orm";
import { storeSceneImages, storeScenes } from "@frameos-cloud/db";

// "Has a preview" comes in two strengths. The primary preview is the image
// extracted from the published ZIP (store_scenes.preview_*). A scene whose
// owner deleted that and later added gallery screenshots still has something
// to show: listings, tiles and repository indexes use `sceneHasAnyImageSql`,
// and /api/store/scenes/:id/image falls back to the first gallery image. The
// scene page's own gallery uses the primary-only form so the lead image is
// not listed twice.
export const sceneHasPrimaryPreviewSql = sql<boolean>`(${storeScenes.previewImage} is not null or ${storeScenes.previewObjectKey} is not null)`;

export const sceneHasAnyImageSql = sql<boolean>`(${storeScenes.previewImage} is not null or ${storeScenes.previewObjectKey} is not null or exists (select 1 from ${storeSceneImages} where ${storeSceneImages.sceneId} = ${storeScenes.id}))`;
