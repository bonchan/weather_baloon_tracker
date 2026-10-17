import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // WebUSB permissions and saved settings are per origin, so keep the port fixed.
    port: 5173,
    strictPort: true,
  },
})
