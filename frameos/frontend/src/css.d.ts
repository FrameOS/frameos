// esbuild bundles the stylesheets these files import for their side effects.
// TypeScript 7 checks that a side-effect import resolves, so declare them.
declare module '*.css'
