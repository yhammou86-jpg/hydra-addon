'use strict';

/**
 * Framework-free request handling.
 *
 * The same functions back both the Vercel functions in /api and the local dev
 * server in /scripts, so there is exactly one implementation of every route.
 */

const { normalize, FALLBACK } = require('./config');
const { encode, decode } = require('./codec');
const { resolveMeta } = require('./metadata');
const { gather, probeAll } = require('./orchestrator');
const { buildStreams } = require('./format');
const { CACHED_BONUS, scoreItem } = require('./rank');
const { ALL } = require('./providers');
const { json } = require('./http');
const debrid = require('./debrid');
const health = require('./health');
const cache = require('./cache');

const VERSION = '2.2.2';
const ADDON_ID = 'community.hydrastream';

function baseUrl(headers) {
  const h = headers || {};
  const proto =
    h['x-forwarded-proto'] || (String(h.host || '').includes('localhost') ? 'http' : 'https');
  const host = h['x-forwarded-host'] || h.host || 'localhost:7000';
  return `${proto}://${host}`;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300, stale-while-revalidate=600',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ manifest */

function buildManifest(cfg, base) {
  const svcName = cfg.key ? debrid.get(cfg.svc).name : null;
  const modeLabel = !cfg.key ? 'P2P' : cfg.mode === 'debrid' ? svcName : `${svcName} + P2P`;

  return {
    id: ADDON_ID,
    version: VERSION,
    name: 'Hydra',
    description:
      `One addon, every source. ${modeLabel}. ` +
      'Aggregates public trackers and Torznab indexers, checks your debrid cache in a single ' +
      'batch call, and falls back to native P2P so there is always something to play. ' +
      'Coded with love by Yassine Aka DesertBoy.',
    logo: `${base}/logo.svg`,
    background: `${base}/logo.svg`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

function handleManifest(query, headers) {
  const cfg = query && query.c ? normalize(decode(query.c)) : FALLBACK;
  return jsonResponse(buildManifest(cfg, baseUrl(headers)), 200, {
    'cache-control': 'public, max-age=3600',
  });
}

/* -------------------------------------------------------------------- stream */

function stripJson(id) {
  return String(id || '').replace(/\.json$/i, '');
}

async function handleStream(query, headers) {
  const type = query.type === 'series' ? 'series' : 'movie';
  const rawId = stripJson(query.id);
  const cfg = normalize(decode(query.c));
  const base = baseUrl(headers);

  if (!rawId || !/^tt\d+/.test(rawId)) return jsonResponse({ streams: [] });

  const meta = await resolveMeta(type, rawId);

  const { items, stats, unreleased } = await gather(cfg, meta, {
    budget: cfg.providers.prowlarr || cfg.providers.torznab ? 8000 : 6500,
  });

  let working = items;
  const svc = debrid.get(cfg.svc);

  // --- debrid batch cache probe (one request for many hashes) -------------
  if (cfg.key && cfg.mode !== 'p2p' && working.length) {
    try {
      const cached = await svc.checkCached(cfg.key, working.map((i) => i.infoHash));

      for (const item of working) {
        if (cached.has(item.infoHash)) item.cached = true;
        else if (cfg.uncached) item.via = 'debrid';
      }

      // Re-score: cached results no longer care about swarm size.
      for (const item of working) {
        item.score = scoreItem(item, cfg) + (item.cached ? CACHED_BONUS : 0);
      }
      working.sort((a, b) => b.score - a.score);

      // Mode semantics, applied only once cache state is known:
      //   debrid     -> the service must be able to serve it
      //   cachedOnly -> strictly what is already on the service's disk
      if (cfg.mode === 'debrid') {
        working = working.filter((i) => i.cached || i.via === 'debrid');
      }
      if (cfg.cachedOnly) working = working.filter((i) => i.cached);
    } catch (err) {
      // Bad key or provider outage: never fail the request, degrade to P2P.
      if (cfg.mode === 'debrid') for (const item of working) item.via = 'debrid';
      stats.debridError = String(err.message || err);
    }
  } else if (cfg.mode === 'p2p' || !cfg.key) {
    working = working.map((i) => ({ ...i, cached: false, via: undefined }));
  }

  const hint =
    meta.kind === 'series' && meta.season != null
      ? `s${String(meta.season).padStart(2, '0')}e${String(meta.episode).padStart(2, '0')}`
      : '';

  let streams = buildStreams(working, cfg, {
    base,
    blob: query.c || encode(cfg),
    hint,
    limit: cfg.max,
    meta,
  });

  // An empty list with no explanation reads as a broken addon. When the reason
  // is simply "this has not come out yet", say it.
  if (unreleased && !streams.length) {
    const label = `${meta.title || 'This title'}${meta.year ? ` (${meta.year})` : ''}`;
    streams = [
      {
        name: 'Hydra',
        title: 'Not released yet',
        description:
          `${label} has not aired or opened yet, so any stream claiming to be it is fake. ` +
          'Turn off "Hide unreleased" in the setup to see unfiltered results anyway.',
        externalUrl: `https://www.imdb.com/title/${meta.imdbId}/`,
      },
    ];
  }

  return jsonResponse({ streams }, 200, {
    'cache-control': 'public, max-age=60, stale-while-revalidate=300',
    'x-hydra-stats': JSON.stringify({
      found: working.length,
      shown: streams.length,
      unreleased: !!unreleased,
      providers: stats.perProvider,
      ms: stats.ms,
    }),
  });
}

/* ------------------------------------------------------------------- resolve */

async function handleResolve(query) {
  const cfg = normalize(decode(query.c));
  const hash = String(query.h || '').toLowerCase();
  const plain = (status, body) => ({ status, headers: { 'content-type': 'text/plain' }, body });

  if (!cfg.key) return plain(400, 'No debrid API key in this configuration.');
  if (!/^[a-f0-9]{40}$/.test(hash)) return plain(400, 'Invalid infohash.');

  const svc = debrid.get(cfg.svc);
  const allowUncached = query.u === '1' || cfg.uncached;

  try {
    const url = await svc.resolve(cfg.key, hash, query.f || '', { allowUncached });
    return { status: 302, headers: { location: url, 'cache-control': 'no-store' }, body: '' };
  } catch (err) {
    const status = err && err.status ? err.status : 502;
    const name = svc.name;
    return plain(status, `${name}: ${err.message || 'unknown error'}`);
  }
}

/* -------------------------------------------------------------------- config */

async function handleConfig({ query, body }) {
  // GET ?c=... -> hydrate the configure page from an existing install URL
  if (query && query.c) {
    const cfg = decode(query.c);
    if (!cfg) return jsonResponse({ ok: false, error: 'Could not decode config' }, 400);
    const safe = { ...normalize(cfg), key: cfg.key ? '***' : '' };
    return jsonResponse({ ok: true, config: safe });
  }

  if (!body || typeof body !== 'object') {
    return jsonResponse({ ok: false, error: 'Expected JSON body' }, 400);
  }

  if (body.action === 'verify') {
    const key = String(body.key || '').trim();
    const svc = debrid.get(body.svc);
    if (!key) return jsonResponse({ ok: false, error: 'Missing API key' }, 400);
    try {
      const info = await svc.userInfo(key);
      return jsonResponse({
        ok: true,
        service: svc.name,
        user: {
          email: info && info.email,
          premium: !!(info && (info.premium_expires_at || info.is_subscribed || info.premium > 0)),
          expires:
            info && (info.premium_expires_at || info.expiration || info.expires_at || null),
          points: info && info.points,
        },
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message || 'Invalid key' }, 200);
    }
  }

  if (body.action === 'probe') {
    const cfg = normalize(body.config);
    const sources = await probeAll(cfg);
    return jsonResponse({ ok: true, sources });
  }

  if (body.action === 'encode') {
    const cfg = normalize(body.config);
    return jsonResponse({ ok: true, blob: encode(cfg) });
  }

  /**
   * Preflight a user-supplied addon URL.
   *
   * Some addons (StremThru Torz, MediaFusion) answer 200 with an empty stream
   * list when they are not configured — indistinguishable from "this film has
   * no results". Their manifest says so plainly, though: an empty `types` array
   * or `configurationRequired: true` means the URL is a stub, not a source.
   * Checking here turns a silent empty list into an explanation.
   */
  if (body.action === 'check-addon') {
    const raw = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return jsonResponse({ ok: false, error: 'Needs to be an http(s) URL' }, 200);
    }

    const base = raw.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '');
    try {
      const manifest = await json(`${base}/manifest.json`, { timeout: 8000 });
      const types = Array.isArray(manifest && manifest.types) ? manifest.types : [];
      const needsConfig = !!(manifest && manifest.behaviorHints && manifest.behaviorHints.configurationRequired);
      const configured = types.length > 0 && !needsConfig;

      return jsonResponse({
        ok: true,
        name: manifest && manifest.name ? String(manifest.name) : base,
        types,
        configured,
        note: configured
          ? `Ready — serves ${types.join(', ')}`
          : 'This URL is not configured yet. Open the addon\'s own configure page and paste the URL it gives you, not its bare address.',
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.hint || err.message || 'Could not reach that addon' }, 200);
    }
  }

  return jsonResponse({ ok: false, error: 'Unknown action' }, 400);
}

/* -------------------------------------------------------------------- health */

function handleHealth() {
  return jsonResponse({
    ok: true,
    name: 'Hydra',
    version: VERSION,
    providers: ALL.map((p) => ({ id: p.id, name: p.name, kinds: p.kinds })),
    debrid: debrid.list(),
    health: health.snapshot(),
    cacheEntries: cache.size(),
    encryptedConfig: !!process.env.CONFIG_SECRET,
    uptime: Math.round(process.uptime()),
  });
}

module.exports = {
  VERSION,
  ADDON_ID,
  baseUrl,
  jsonResponse,
  handleManifest,
  handleStream,
  handleResolve,
  handleConfig,
  handleHealth,
  buildManifest,
};
