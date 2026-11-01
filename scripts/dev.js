'use strict';

/**
 * Local dev server — mirrors the exact Vercel routing table so what you test
 * here behaves identically once deployed. No dependencies, no build step.
 *
 *   npm run dev   ->  http://localhost:7000
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  handleManifest,
  handleStream,
  handleResolve,
  handleConfig,
  handleHealth,
} = require('../src/app');

const PORT = Number(process.env.PORT || 7000);
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(data);
  });
}

function emit(res, result) {
  res.writeHead(result.status || 200, result.headers || {});
  res.end(result.body === undefined ? '' : result.body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const query = Object.fromEntries(url.searchParams.entries());
  const headers = req.headers;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': '*',
      });
      return res.end();
    }

    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC, 'index.html'));
    }
    if (pathname === '/configure' || pathname === '/configure.html') {
      return serveStatic(res, path.join(PUBLIC, 'configure.html'));
    }
    if (pathname === '/health') return emit(res, handleHealth());

    if (pathname === '/api/config') {
      const body = req.method === 'POST' ? await readBody(req) : null;
      return emit(res, await handleConfig({ query, body }));
    }

    if (pathname === '/manifest.json') return emit(res, handleManifest(query, headers));

    const resolveMatch = pathname.match(/^\/r\/([a-f0-9]{40})$/i);
    if (resolveMatch) return emit(res, await handleResolve({ ...query, h: resolveMatch[1] }));

    const manifestMatch = pathname.match(/^\/([^/]+)\/manifest\.json$/);
    if (manifestMatch) return emit(res, handleManifest({ c: manifestMatch[1] }, headers));

    const streamMatch = pathname.match(/^\/([^/]+)\/stream\/(movie|series)\/(.+?)(?:\.json)?$/);
    if (streamMatch) {
      return emit(
        res,
        await handleStream({ c: streamMatch[1], type: streamMatch[2], id: streamMatch[3] }, headers)
      );
    }

    // Un-prefixed install: Stremio will happily install the bare manifest.json,
    // so the matching stream route has to exist or every playback request 404s.
    const bareStreamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+?)(?:\.json)?$/);
    if (bareStreamMatch) {
      return emit(
        res,
        await handleStream({ type: bareStreamMatch[1], id: bareStreamMatch[2] }, headers)
      );
    }

    // Static assets
    const safe = path.normalize(path.join(PUBLIC, pathname)).replace(/^(\.\.[/\\])+/, '');
    if (safe.startsWith(PUBLIC) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
      return serveStatic(res, safe);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('[hydra]', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err && err.message) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Hydra dev server`);
  console.log(`  ├─ landing    http://localhost:${PORT}/`);
  console.log(`  ├─ configure  http://localhost:${PORT}/configure`);
  console.log(`  ├─ manifest   http://localhost:${PORT}/manifest.json`);
  console.log(`  └─ health     http://localhost:${PORT}/health\n`);
});
