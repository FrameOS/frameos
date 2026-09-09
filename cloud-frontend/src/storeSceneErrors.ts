// The store's error-code wording, for the cloud's Next.js components. The
// table itself lives with the SPA (frontend/src/utils/storeSceneErrors.ts),
// where the editor's cloud save path reads it; this is the window-free
// re-export auth-web imports as `@frameos/cloud-frontend/src/storeSceneErrors`
// so the owner buttons, the upload forms and the editor say the same thing
// for the same refusal.
export {
  storeSceneErrorCode,
  storeSceneErrorMessage,
  type StoreErrorDetail,
} from '../../frontend/src/utils/storeSceneErrors'
