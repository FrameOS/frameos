import {
  storeSceneErrorMessage,
  type StoreErrorDetail,
} from "@frameos/cloud-frontend/src/storeSceneErrors";

/**
 * The message an owner sees when the store refuses an action on their scene.
 * Every route answers `{error: <code>}` (plus details); collapsing that into
 * "Failed" hid the two refusals owners actually hit — the private-scene
 * quota and the pulled state — behind a word that suggested a bug. The
 * wording is the shared store table (frontend/src/utils/storeSceneErrors.ts),
 * so the editor's Save, the upload forms and these buttons agree.
 */
export function ownerActionErrorMessage(
  detail: StoreErrorDetail,
  status: number,
  fallback = "Failed",
): string {
  return storeSceneErrorMessage(detail, status, fallback);
}
