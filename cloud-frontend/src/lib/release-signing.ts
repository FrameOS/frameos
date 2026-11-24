// The release verifier lives in the shared frontend now
// (frontend/src/utils/releaseSigning.ts): the browser flashers of both planes
// and flash.frameos.net check every firmware image with it too, not just the
// SD image builder.
export * from '../../../frontend/src/utils/releaseSigning'
