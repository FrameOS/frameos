/**
 * One wording for every refusal the cloud scene store answers with.
 *
 * Every store and account-scene route replies `{error: <code>}` plus a few
 * details. Three different places used to turn that into text — the owner
 * buttons collapsed everything into "Failed", the upload and new-scene forms
 * each kept their own partial table, and the editor's Save showed the raw
 * code — so the two refusals owners actually hit (the private-scene quota
 * and the pulled state) read as a bug in one place and as `storage_quota_exceeded`
 * in another. This is the table; every reader goes through it.
 *
 * Window-free and dependency-free on purpose: the cloud's Next.js components
 * import it through `@frameos/cloud-frontend/src/storeSceneErrors`, the SPA
 * through this path, and the shared-spa suite pins the wording.
 */

export type StoreErrorDetail = {
  error?: unknown
  /** Free-text explanation some routes add next to the code. */
  detail?: unknown
  /** content_rejected: the moderation categories that fired. */
  categories?: unknown
  /** scene_name_taken: the name that clashed. */
  name?: unknown
  [key: string]: unknown
}

export function storeSceneErrorCode(detail: StoreErrorDetail | null | undefined): string | undefined {
  const code = detail?.error
  return typeof code === 'string' && code ? code : undefined
}

/**
 * The message a person sees for a store refusal. `fallback` names the action
 * that failed ("Saving failed") and prefixes the unknown-code and no-code
 * forms, so a new server code still tells the reader what did not happen.
 */
export function storeSceneErrorMessage(
  detail: StoreErrorDetail | null | undefined,
  status: number,
  fallback = 'Failed'
): string {
  const code = storeSceneErrorCode(detail)
  switch (code) {
    // Moderation
    case 'content_rejected': {
      const categories = Array.isArray(detail?.categories) ? ` (${detail.categories.join(', ')})` : ''
      return `Rejected by content moderation${categories}`
    }
    case 'moderation_unavailable':
      return 'Moderation service unavailable — try again later'
    case 'scene_pulled':
      return 'This scene was pulled by moderation and cannot be changed'
    case 'store_banned':
      return 'This account cannot publish scenes'

    // Quotas and limits
    case 'storage_quota_exceeded':
      return 'Over your private scene storage quota — delete a private scene or free up space first'
    case 'scene_quota_exceeded':
      return 'Scene limit reached'
    case 'daily_scene_limit_exceeded':
      return 'Daily new-scene limit reached — try again tomorrow'
    case 'rate_limited':
      return 'Too many changes in a row — wait a moment and try again'

    // Who you are
    case 'login_required':
      return 'Signed out — sign in again'
    case 'insufficient_scope':
      return 'This link or token is not allowed to do that'
    case 'read_only_token':
      return 'This API token is read-only'

    // The scene
    case 'scene_not_found':
      return 'This scene no longer exists'
    case 'version_not_found':
      return 'This version no longer exists'
    case 'cannot_yank_last_version':
      return 'A scene must keep at least one published version'
    case 'scene_name_taken':
      return `You already have another scene called “${
        typeof detail?.name === 'string' && detail.name ? detail.name : 'that'
      }” — rename this one to something else`
    case 'invalid_tags':
      return 'Up to 5 tags; lowercase letters, digits, dashes, max 24 characters each'
    case 'invalid_frameos_version':
      return 'The minimum FrameOS version should look like 2026.7.5'
    case 'invalid_scenes':
      return 'The scene is empty'
    case 'scene_too_large':
      return 'The scene is too large (max 8 MB)'
    case 'scene_requires_compilation':
      return 'This is a legacy compiled scene (Nim code nodes or Nim apps). Convert it to an interpreted scene at /nim-converter first.'

    // Zip uploads
    case 'invalid_name':
      return "The ZIP's template.json needs a scene name"
    case 'invalid_template_json':
      return 'template.json is not valid'
    case 'invalid_upload':
      return 'Choose a FrameOS scene ZIP'
    case 'invalid_zip':
      return 'That file is not a valid ZIP'
    case 'missing_scenes':
      return 'The ZIP has no scenes'
    case 'missing_template_json':
      return 'The ZIP has no template.json'

    // Images
    case 'image_too_large':
      return 'Image too large (max 4 MB)'
    case 'unsupported_image':
      return 'Not a supported image (JPEG, PNG, WebP or GIF)'
    case 'image_not_found':
      return "An image in this scene's set no longer exists — remove it and save again"

    default:
      if (typeof detail?.detail === 'string' && detail.detail) {
        return detail.detail
      }
      return `${fallback} (${code ?? status})`
  }
}
