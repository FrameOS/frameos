import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backendTarget = process.env.FRAMEOS_BACKEND_URL || 'http://localhost:8989'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 8616,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 8616,
  },
})
