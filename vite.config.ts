import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation enables SharedArrayBuffer, which lets the model run
// multi-threaded (several times faster). Keep in sync with public/_headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // onnxruntime-web ships its own wasm loader; pre-bundling breaks its relative imports.
  optimizeDeps: { exclude: ['@imgly/background-removal'] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
})
