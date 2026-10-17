import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre's worker is an ES module.
  worker: { format: 'es' },
  // The map chunk is big but lazy-loaded on first use.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    // WebUSB permissions and saved settings are per origin, so keep the port fixed.
    port: 5173,
    strictPort: true,
  },
})
