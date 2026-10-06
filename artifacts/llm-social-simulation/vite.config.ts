import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// PORT and BASE_PATH are injected by the dev/preview host. A production build
// (`vite build`) runs in a clean image without them, so both fall back to the
// standard Vite defaults instead of throwing — otherwise `vite build` can only
// ever run inside the preview sandbox.
const port = Number(process.env.PORT ?? 5173);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  // The game reads its model credentials straight from the environment so the
  // key never has to be written to a file. `BERGET_API_KEY` and
  // `POLLINATIONS_API_KEY` are the deployment variables; `VITE_LLM_*` and
  // `VITE_POLLINATIONS_*` let you override endpoint/model per developer.
  envPrefix: ["VITE_", "BERGET_", "POLLINATIONS_"],
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    // The deployable package root is the repo root, and static hosting serves
    // the built site straight from dist/ there.
    outDir: path.resolve(import.meta.dirname, '..', '..', 'dist'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
