import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const backendTarget = process.env.FRAMEOS_BACKEND_URL || 'http://localhost:8989'

export default defineConfig({
  plugins: [react()],
  // As in tsconfig.json: the frameos-wasm package from its source.
  resolve: {
    alias: { 'frameos-wasm': fileURLToPath(new URL('../frameos/wasm/src/index.ts', import.meta.url)) },
  },
  server: {
    host: true,
    port: 8616,
    proxy: {
      // The embedded scene editor bundle (frontend/dist-editor, served by
      // the backend): the local scenes page edits in it. Rebuild it with
      // `pnpm --dir frontend run build:esbuild` after changing the editor.
      '/frameos-editor': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: backendTarget,
        // Keep `Host` as the browser dialled it (localhost:8616): the backend
        // refuses a WebSocket handshake whose Origin does not match it
        // (websocket_origin_allowed in backend/app/api/auth.py).
        changeOrigin: false,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 8616,
  },
})
