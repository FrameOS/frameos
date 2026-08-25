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

//
// The gallery subquery names its tables explicitly instead of interpolating
// the columns: in a single-table select (my-scenes) drizzle strips the table
// qualifier from every column inside a `sql` field, so `${storeScenes.id}`
// became a bare "id" that the subquery resolved against store_scene_images —
// and the fallback was never true. The joined listings (store, publishers,
// repository indexes) happened to keep their qualifiers, which hid it.
export const sceneHasAnyImageSql = sql<boolean>`(${storeScenes.previewImage} is not null or ${storeScenes.previewObjectKey} is not null or exists (select 1 from ${storeSceneImages} where ${storeSceneImages}.scene_id = ${storeScenes}.id))`;
