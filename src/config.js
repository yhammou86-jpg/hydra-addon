'use strict';

/**
 * Configuration schema + normalisation.
 *
 * Short keys because the whole object is compressed into the addon URL. Every
 * value is clamped so a hand-edited URL can never crash the addon.
 */

const { SUPPORTED_LANGS } = require('./parse');

const PROVIDER_IDS = [
  'knaben',
  'yts',
  'eztv',
  'bitsearch',
  'nyaa',
  'apibay',
  'animetosho',
  'therarbg',
  'torrentio',
  'comet',
  'stremthru',
  'torrentsdb',
  'mediafusion',
  'torrentgalaxy',
  'prowlarr',
  'torznab',
];

const RESOLUTIONS = ['4k', '1080p', '720p', '480p', '360p'];
const SERVICES = ['torbox', 'realdebrid'];
const STYLES = ['rich', 'compact'];

const DEFAULTS = {
  v: 2,
  svc: 'torbox',
  key: '',
  mode: 'hybrid',
  style: 'rich',
  providers: {
    knaben: true,
    yts: true,
    eztv: true,
    bitsearch: true,
    nyaa: true,
    apibay: true,
    animetosho: true,
    therarbg: false,
    // Addon sources: they already aggregated dozens of indexers, so they are
    // the highest value-per-request sources in the list.
    torrentio: true,
    comet: true,
    // Torz needs nothing configured: `p2p` store, no indexers, crowdsourced
    // pool. It is the single highest-yield source we have, so it is on.
    stremthru: true,
    torrentsdb: true,
    mediafusion: true,
    // TGX has no live mirror and hangs, so it is opt-in.
    torrentgalaxy: false,
    prowlarr: false,
    torznab: false,
  },
  res: ['4k', '1080p', '720p', '480p'],
  max: 40,
  maxGB: 40,
  langs: [],
  addons: [],
  minSeed: 0,
  noCam: true,
  strictMatch: true,
  hideUnreleased: true,
  sort: 'quality',
  cachedOnly: false,
  uncached: false,
  preferEfficient: true,
  lang: '',
  proxy: '',
  prowlarr: { url: '', key: '' },
  torznab: { url: '', key: '' },
  // Empty means the public instance. Set it to keep Torz requests on your own
  // StremThru deployment.
  stremthruUrl: '',
};

function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // `tb` was the original single-service key name; accept it as an alias.
  const key = typeof src.key === 'string' ? src.key : typeof src.tb === 'string' ? src.tb : '';

  const cfg = {
    v: 2,
    svc: SERVICES.includes(src.svc) ? src.svc : DEFAULTS.svc,
    key: key.trim(),
    mode: ['hybrid', 'debrid', 'p2p'].includes(src.mode) ? src.mode : DEFAULTS.mode,
    style: STYLES.includes(src.style) ? src.style : DEFAULTS.style,
    providers: {},
    res: [],
    max: clampInt(src.max, 5, 100, DEFAULTS.max),
    // 0 means "no cap". 500 GB is a ceiling, not a recommendation.
    maxGB: clampInt(src.maxGB, 0, 500, DEFAULTS.maxGB),
    langs: [],
    addons: [],
    minSeed: clampInt(src.minSeed, 0, 500, DEFAULTS.minSeed),
    noCam: bool(src.noCam, DEFAULTS.noCam),
    strictMatch: bool(src.strictMatch, DEFAULTS.strictMatch),
    hideUnreleased: bool(src.hideUnreleased, DEFAULTS.hideUnreleased),
    sort: ['quality', 'seeders', 'size'].includes(src.sort) ? src.sort : DEFAULTS.sort,
    cachedOnly: bool(src.cachedOnly, DEFAULTS.cachedOnly),
    uncached: bool(src.uncached, DEFAULTS.uncached),
    preferEfficient: bool(src.preferEfficient, DEFAULTS.preferEfficient),
    lang: typeof src.lang === 'string' ? src.lang.slice(0, 12) : '',
    proxy: typeof src.proxy === 'string' ? src.proxy.trim().slice(0, 300) : '',
    prowlarr: { url: '', key: '' },
    torznab: { url: '', key: '' },
    stremthruUrl: '',
  };

  // `solid` was the original SolidTorrents provider id. It became BitSearch, so
  // an old encoded URL still carries `providers.solid` — honour it.
  const solidAlias =
    src.providers && typeof src.providers === 'object' ? src.providers.solid : undefined;

  for (const id of PROVIDER_IDS) {
    const explicit = src.providers && src.providers[id];
    const v = explicit !== undefined ? explicit : id === 'bitsearch' ? solidAlias : undefined;
    cfg.providers[id] = bool(v, DEFAULTS.providers[id]);
  }

  const wanted = Array.isArray(src.res) ? src.res : DEFAULTS.res;
  cfg.res = RESOLUTIONS.filter((r) => wanted.includes(r));
  if (!cfg.res.length) cfg.res = DEFAULTS.res.slice();

  // Empty means "any". That is the safe default: an English release usually
  // carries no language tag at all, so a filter that required a positive match
  // would empty the list for most films.
  if (Array.isArray(src.langs)) {
    cfg.langs = [...new Set(src.langs.filter((l) => SUPPORTED_LANGS.includes(l)))];
  }

  // Extra addon base URLs — StremThru Torz, Sootio, Zilean, or anything else.
  // These addons hand you a personal manifest URL containing your settings,
  // so pasting it is the supported integration rather than a workaround.
  if (Array.isArray(src.addons)) {
    cfg.addons = src.addons
      .filter((u) => typeof u === 'string')
      .map((u) => u.trim().slice(0, 300))
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 6);
  }

  if (src.prowlarr && typeof src.prowlarr === 'object') {
    cfg.prowlarr.url = String(src.prowlarr.url || '').replace(/\/+$/, '').slice(0, 200);
    cfg.prowlarr.key = String(src.prowlarr.key || '').slice(0, 200);
  }
  if (!cfg.prowlarr.url || !cfg.prowlarr.key) cfg.providers.prowlarr = false;

  if (src.torznab && typeof src.torznab === 'object') {
    cfg.torznab.url = String(src.torznab.url || '').replace(/\/+$/, '').slice(0, 300);
    cfg.torznab.key = String(src.torznab.key || '').slice(0, 200);
  }
  if (!cfg.torznab.url) cfg.providers.torznab = false;

  // Optional: point Torz at a self-hosted instance. A bare host is accepted and
  // upgraded to https, and a pasted manifest URL is stripped back to its root.
  if (typeof src.stremthruUrl === 'string' && src.stremthruUrl.trim()) {
    let u = src.stremthruUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    u = u.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
    cfg.stremthruUrl = /^https?:\/\/[^\s/]+/i.test(u) ? u.slice(0, 300) : '';
  }

  if (!cfg.key) {
    if (cfg.mode === 'debrid') cfg.mode = 'hybrid';
    cfg.cachedOnly = false;
    cfg.uncached = false;
  }

  return cfg;
}

/** Config used when someone hits the bare /manifest.json */
const FALLBACK = normalize({});

module.exports = { DEFAULTS, PROVIDER_IDS, RESOLUTIONS, SERVICES, normalize, FALLBACK };
