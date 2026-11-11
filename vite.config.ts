import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Lets the Cloudflare quick-tunnel's random hostname through — Vite's
    // dev server rejects unrecognized Host headers by default.
    allowedHosts: true,
    // Same-origin proxy for the backend WS connection (see src/data/kalshi.ts)
    // — the tunnel only needs to expose this one dev server port, so a
    // fresh tunnel hostname never needs to be re-shared or re-configured.
    proxy: {
      "/ws": {
        target: "ws://localhost:4001",
        ws: true,
      },
    },
  },
})
