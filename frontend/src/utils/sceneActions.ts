/**
 * The scene action split-button's vocabulary. Two actions only: the preview
 * drawer's "Deploy to frame" (which picks activate-by-id or send-the-whole-
 * scene on its own, see scenePreviewDeploy.ts) and the in-browser preview.
 *
 * Pure module: the shared-spa tests import it directly, so it must not pull
 * kea, React or the DOM in.
 */

/** Which action the scene split-button performs when clicked. */
export type SceneActionKey = 'deploy' | 'preview-browser'

/**
 * The persisted preference, read back safely. Earlier builds stored
 * 'activate' and 'preview-frame' under the same key; both (and anything else
 * unrecognised) now mean "Deploy to frame".
 */
export function normalizeSceneActionKey(value: unknown): SceneActionKey {
  return value === 'preview-browser' ? 'preview-browser' : 'deploy'
}
