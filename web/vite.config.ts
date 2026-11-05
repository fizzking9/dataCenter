import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser application builds next to the compiled application, so the
 * modular server can serve it as the initial Release artifact.
 */
export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // The catalog renders a visible marker for a missing entry in development; a
  // release build keeps the governed ASCII value instead of inventing copy.
  define: { __DEV__: JSON.stringify(command === 'serve') },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
}));
