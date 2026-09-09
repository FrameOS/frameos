/**
 * The message an owner sees when the store refuses an action on their scene.
 * Every route answers `{error: <code>}` (plus details); collapsing that into
 * "Failed" hid the two refusals owners actually hit — the private-scene
 * quota and the pulled state — behind a word that suggested a bug.
 */
export function ownerActionErrorMessage(
  detail: Record<string, unknown>,
  status: number,
): string {
  switch (detail.error) {
    case "content_rejected": {
      const categories = Array.isArray(detail.categories)
        ? ` (${detail.categories.join(", ")})`
        : "";
      return `Rejected by content moderation${categories}`;
    }
    case "moderation_unavailable":
      return "Moderation service unavailable — try again later";
    case "storage_quota_exceeded":
      return "Over your private scene storage quota — delete a private scene or free up space first";
    case "scene_pulled":
      return "This scene was pulled by moderation and cannot be changed";
    case "rate_limited":
      return "Too many changes in a row — wait a moment and try again";
    case "login_required":
      return "Signed out — sign in again";
    default:
      return typeof detail.error === "string" && detail.error
        ? `Failed (${detail.error})`
        : `Failed (${status})`;
  }
}
