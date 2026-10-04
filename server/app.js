import { createReadStream, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SSE_HEARTBEAT_MS = 25000;
const COOKIE = 'dash_key';

/**
 * HTTP handler: static files, the snapshot API, a Server-Sent Events
 * stream for live updates, and scene activation (the only write).
 */
export function createApp({ config, store }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        return send(res, 200, { ok: true, connected: store.connected, mock: config.mock });
      }
      if (!authorized(req, url, res, config)) return;

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        return send(res, 200, store.snapshot());
      }
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        return stream(req, res, store);
      }
      const cam = url.pathname.match(/^\/api\/cameras\/(camera\.[a-z0-9_]+)\/snapshot$/);
      if (cam && req.method === 'GET') {
        const width = Math.min(3840, Math.max(160, Number.parseInt(url.searchParams.get('w'), 10) || 1280));
        const img = await store.cameraSnapshot(cam[1], width);
        res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'no-store' });
        res.end(img.body);
        return;
      }
      const scene = url.pathname.match(/^\/api\/scenes\/(scene\.[a-z0-9_]+)$/);
      if (scene && req.method === 'POST') {
        await store.activateScene(scene[1]);
        res.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        return send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(url.pathname, res);
      }
      send(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) console.error(`${req.method} ${url.pathname}:`, err.message);
      if (!res.headersSent) send(res, status, { error: err.message });
    }
  };
}

/**
 * Optional shared key (ACCESS_KEY). Open the dashboard once with ?key=...
 * and it's remembered in a long-lived cookie; Fully Kiosk keeps cookies.
 */
function authorized(req, url, res, config) {
  if (!config.accessKey) return true;
  const fromQuery = url.searchParams.get('key');
  if (fromQuery && safeEqual(fromQuery, config.accessKey)) {
    const secure = config.tlsCert || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    url.searchParams.delete('key');
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(config.accessKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`,
      Location: url.pathname + (url.search || ''),
    }).end();
    return false;
  }
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  if (cookie && safeEqual(cookie, config.accessKey)) return true;
  send(res, 401, { error: 'Unauthorized — open the dashboard with ?key=<ACCESS_KEY> once' });
  return false;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function stream(req, res, store) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx (Synology reverse proxy) must not buffer SSE
  });
  const write = (snap) => res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
  write(store.snapshot());
  const unsubscribe = store.subscribe(write);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'Bad path' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(publicDir, '.' + rel);
  if (!file.startsWith(publicDir + sep)) return send(res, 404, { error: 'Not found' });

  let stat;
  try {
    stat = statSync(file);
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  if (!stat.isFile()) return send(res, 404, { error: 'Not found' });

  const ext = extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // Fonts never change; everything else revalidates so a redeploy shows up on reload.
    'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}
