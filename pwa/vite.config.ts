import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // `npm run dev` serves the UI; the bridge (`npm start`) serves the socket.
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
});
