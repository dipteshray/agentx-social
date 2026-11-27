import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes straight into the Worker-served public/ directory.
// emptyOutDir is false on purpose: public/ also holds ece.js (legacy static
// copy, unused by the React bundle) and llms.txt, which must survive builds.
// The build script removes public/assets first so stale hashed chunks never
// accumulate. The Worker serves public/ as Static Assets; the generated
// index.html is the SPA shell (boot spinner painted before React mounts).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: false,
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
