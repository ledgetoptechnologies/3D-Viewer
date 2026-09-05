import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { verifyFixtures } from './scripts/verify-fixtures.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export const DEMO_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export function localRequestAllowed(req) {
  const host = req.headers.host || '';
  const remote = req.socket.remoteAddress;
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
}
function boundary(req, res, next) {
  if (!localRequestAllowed(req)) { res.statusCode = 403; res.end('Local demo only'); return; }
  const decoded = (() => { try { return decodeURIComponent((req.url || '').split('?')[0]); } catch { return ''; } })();
  if (!decoded || /(?:^|\/)(?:\.git|\.env[^/]*|server|workspace|api|session|operations)(?:\/|$)/i.test(decoded)
    || decoded.startsWith('/@fs/')) { res.statusCode = 404; res.end('Not part of this demo'); return; }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', DEMO_CSP);
  next();
}
export default defineConfig({
  plugins: [{ name: 'local-demo-boundary', async buildStart() { await verifyFixtures(); },
    configureServer(server) { server.middlewares.use(boundary); },
    configurePreviewServer(server) { server.middlewares.use(boundary); } }],
  server: { host: '127.0.0.1', port: 8080, strictPort: true, allowedHosts: ['localhost'], fs: { strict: true, allow: [root], deny: ['**/.git/**', '**/.env*'] } },
  preview: { host: '127.0.0.1', port: 8080, strictPort: true, allowedHosts: ['localhost'] },
  build: { target: 'es2022' }
});
