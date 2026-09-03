// The frontend sources this bundle imports are written for Vite, where
// `import.meta.env` exists (frontend/src/vite-env.d.ts). esbuild defines no
// such object, which is why every read there is `import.meta.env?.…` — this
// only tells the type checker the same thing.
interface ImportMeta {
  readonly env?: {
    readonly DEV?: boolean
    readonly MODE?: string
  }
}
