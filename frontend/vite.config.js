import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When the backend dies, Vite's http-proxy gets ECONNRESET but silently keeps
// the browser-side socket open, causing the page to freeze.  This configure
// hook destroys the client socket on any upstream error so the browser
// immediately sees a network error and can react (SSE onerror, img onerror).
function closeOnError(proxy) {
  proxy.on('error', (err, req, res) => {
    try {
      if (res && !res.headersSent) {
        res.writeHead(502);
      }
      if (res?.socket && !res.socket.destroyed) {
        res.socket.destroy();
      } else if (typeof res?.destroy === 'function') {
        res.destroy();
      }
    } catch { /* already closed */ }
  });
}

const BACKEND_HOST = process.env.BACKEND_HOST || 'localhost';
const BACKEND_PORT = process.env.BACKEND_PORT || '3001';

const backendTarget = process.env.PRODUCTION ? `http://${BACKEND_HOST}` : `http://${BACKEND_HOST}:${BACKEND_PORT}`;

const allowedHosts = process.env.VITE_ALLOWED_HOSTS
  ? process.env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim())
  : [];

const VITE_PORT = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts,
    port: VITE_PORT,
    proxy: {
      '/stream':    { target: backendTarget, changeOrigin: true, configure: closeOnError },
      '/events':    { target: backendTarget, changeOrigin: true, configure: closeOnError },
      '/login':     { target: backendTarget, changeOrigin: true },
      '/logout':    { target: backendTarget, changeOrigin: true },
      '/me':        { target: backendTarget, changeOrigin: true },
      '/settings':  { target: backendTarget, changeOrigin: true },
      '/cameras':   { target: backendTarget, changeOrigin: true },
      '/record':    { target: backendTarget, changeOrigin: true },
      '/recordings':{ target: backendTarget, changeOrigin: true },
      '/healthz':   { target: backendTarget, changeOrigin: true },
    },
  },
});
