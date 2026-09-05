import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard is served from app.mailkong.net in production and talks
    // to the control plane on the same origin, so dev proxies rather than
    // introducing a CORS path that only exists locally.
    proxy: { '/_app': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
})
