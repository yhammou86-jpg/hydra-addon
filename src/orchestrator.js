'use strict';

/**
 * The orchestrator: fan out, enforce a deadline, normalise, dedupe, rank.
 *
 * Design rule: this function must never reject. A stream request that returns
 * six good results from three working scrapers is a success; a 500 because one
 * tracker timed out is a bug. Everything is allSettled + per-provider timeout.
 */

const { ALL } = require('./providers');
const { fromUrls } = require('./providers/addon');
const { parseRelease, matchesEpisode } = require('./parse');
const { isUnreleased } = require('./metadata');
const { scoreItem, passesFilters, sortItems } = require('./rank');
const { withTimeout } = require('./http');
const health = require('./health');

/**
 * Every provider that should run for this request.
 *
 * Built-ins are toggled by id; user-pasted addon URLs are instantiated on the
 * fly. Both paths produce the same provider shape, so nothing downstream needs
 * to know the difference.
 */
function activeProviders(cfg, kind) {
  const builtin = ALL.filter((p) => cfg.providers[p.id] && p.kinds.includes(kind));
  const custom = fromUrls(cfg.addons).filter((p) => p.kinds.includes(kind));
  return builtin.concat(custom);
}

/**
 * Overall budget for scraping. Vercel Hobby allows 60s and the function is
 * capped at 30s, but the client gives up long before that: Stremio and Nuvio
 * both abandon a stream request that drags. 8.5s leaves room for the metadata
 * lookup and ranking while still finishing inside the client's patience, and
 * it is loose enough that a slow-but-working source is not cut off and reported
 * as an empty result.
 */
const DEFAULT_BUDGET_MS = 8500;

function normalizeOne(raw, ctx) {
  if (!raw || !raw.infoHash) return null;
  const hash = String(raw.infoHash).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;

  const parsed = parseRelease(raw.title || '');

  // Episode hygiene: drop season packs and wrong episodes for series requests.
  if (ctx.kind === 'series' && ctx.season != null && ctx.episode != null) {
    if (!matchesEpisode(parsed, ctx.season, ctx.episode)) return null;
  }

  return {
    infoHash: hash,
    title: raw.title || '',
    size: Number(raw.size) || 0,
    seeders: Number(raw.seeders) || 0,
    provider: raw.provider || 'unknown',
    providerName: raw.providerName || raw.provider || 'unknown',
    parsed,
    cached: false,
    score: 0,
  };
}

/* ---------------------------------------------------------- duplicate releases */

const EXT_RE = /\.(mkv|mp4|avi|m4v|ts|torrent)$/i;
const RES_TOKEN = /\b(2160p|1080p|720p|480p|360p|4k|uhd)\b/;

/**
 * Hash dedupe only catches the *same torrent*. The same *release* gets
 * re-uploaded constantly, so the identical file turns up under several
 * infohashes and fills the list with what looks like choice.
 *
 * A signature of normalised title + size in whole GB collapses those. Both
 * halves are needed: a bare title groups unrelated encodes ("Interstellar"
 * appears 28 times across qualities), and size alone groups unrelated films.
 *
 * Parenthesised text is deliberately preserved — "…(1080p BluRay x265 10bit
 * Tigole)" and "…(1080p BluRay x265 HEVC 10bit AAC 5.1 Q22 Joy)" are different
 * releases that happen to weigh the same, and stripping the brackets merged
 * them.
 */
function releaseSignature(item) {
  const title = String(item.title || '')
    .toLowerCase()
    .replace(EXT_RE, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Without a resolution or a size there is nothing safe to compare, so the row
  // is left alone rather than guessed at.
  if (!title || !RES_TOKEN.test(title) || !item.size) return '';

  return `${title}|${Math.round(item.size / 1e9)}`;
}

function collapseDuplicates(items) {
  const seen = new Map();
  const out = [];

  for (const item of items) {
    const sig = releaseSignature(item);
    if (!sig) {
      out.push(item);
      continue;
    }

    const kept = seen.get(sig);
    if (!kept) {
      seen.set(sig, item);
      out.push(item);
      continue;
    }

    // Survivor keeps the better swarm count and inherits every source it was
    // seen on, so the merged row still credits all of them.
    if (item.seeders > kept.seeders) kept.seeders = item.seeders;
    if (!kept.size && item.size) kept.size = item.size;
    if (!kept.providerName.split(', ').includes(item.providerName)) {
      kept.providerName += `, ${item.providerName}`;
    }
  }

  return out;
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const existing = map.get(item.infoHash);
    if (!existing) {
      map.set(item.infoHash, item);
      continue;
    }
    // Same infohash across trackers: keep the richer record.
    if (item.seeders > existing.seeders) existing.seeders = item.seeders;
    if (!existing.size && item.size) existing.size = item.size;
    if (item.title.length > existing.title.length) existing.title = item.title;
    if (!existing.providerName.split(', ').includes(item.providerName)) {
      existing.providerName += `, ${item.providerName}`;
    }
  }
  return [...map.values()];
}

/**
 * Run one provider, timing it and recording the outcome for diagnostics.
 */
async function runProvider(provider, ctx, deadline) {
  const started = Date.now();
  const remaining = Math.max(1200, deadline - started);
  try {
    const rows = await withTimeout(provider.search(ctx), remaining, provider.id);
    const list = Array.isArray(rows) ? rows : [];
    health.record(provider.id, { ok: true, ms: Date.now() - started, count: list.length });
    return { id: provider.id, rows: list };
  } catch (err) {
    health.record(provider.id, {
      ok: false,
      ms: Date.now() - started,
      error: err.message,
      reason: err.reason,
    });
    return { id: provider.id, rows: [], reason: err.reason, hint: err.hint, error: err.message };
  }
}

/**
 * @param {object} cfg normalised config
 * @param {object} meta output of resolveMeta
 * @param {{budget?:number}} [opts]
 */
async function gather(cfg, meta, opts = {}) {
  const budget = opts.budget || DEFAULT_BUDGET_MS;
  const started = Date.now();
  const deadline = started + budget;

  // Nothing exists yet, so every result would be fake. Skip the scrape entirely
  // rather than paying 7 seconds to collect CAMs and mislabelled rips.
  if (cfg.hideUnreleased !== false && isUnreleased(meta)) {
    return {
      items: [],
      unreleased: true,
      stats: { providers: 0, raw: 0, unique: 0, perProvider: {}, ms: Date.now() - started },
    };
  }

  const active = activeProviders(cfg, meta.kind);
  if (!active.length || !meta.title) return { items: [], stats: { providers: 0, raw: 0, ms: 0 } };

  const ctx = { ...meta, cfg };
  const settled = await Promise.allSettled(active.map((p) => runProvider(p, ctx, deadline)));

  const raw = [];
  const perProvider = {};

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { id, rows } = result.value;
    perProvider[id] = rows.length;
    for (const row of rows) {
      const item = normalizeOne(row, ctx);
      if (item) raw.push(item);
    }
  }

  let items = dedupe(raw);
  if (cfg.dedupe !== false) items = collapseDuplicates(items);
  items = items.filter((item) => passesFilters(item, cfg, meta));

  for (const item of items) item.score = scoreItem(item, cfg);
  items = sortItems(items, cfg);

  return {
    items,
    stats: {
      providers: active.length,
      raw: raw.length,
      unique: items.length,
      perProvider,
      ms: Date.now() - started,
    },
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Diagnostics must not fire twenty requests at once. A burst saturates the
 * connection pool, every source times out, and the panel reports a wall of
 * false negatives — which is worse than no diagnostic at all.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Generous per-source budget: this is a diagnostic, not a stream request. */
const PROBE_TIMEOUT_MS = 7000;
const PROBE_CONCURRENCY = 5;

/** Whole-probe wall clock. Must stay under the 30s serverless limit. */
const PROBE_BUDGET_MS = 26000;

/**
 * Diagnostics: run every enabled provider against a fixed, well-seeded title and
 * report what each one returned. Powers the "Test sources" panel.
 *
 * Each source gets its own timeout, but every timeout is also clamped to the
 * time left in the overall budget. A slow source late in the run is reported as
 * `timeout` rather than silently blowing through the function limit.
 */
async function probe(cfg, meta, opts = {}) {
  const active = activeProviders(cfg, meta.kind);
  const ctx = { ...meta, cfg };
  const timeout = opts.timeout || PROBE_TIMEOUT_MS;
  const limit = opts.concurrency || PROBE_CONCURRENCY;
  const deadline = opts.deadline || Date.now() + PROBE_BUDGET_MS;

  const results = await mapLimit(active, limit, async (provider) => {
    const started = Date.now();
    const left = deadline - started;

    if (left < 1200) {
      return {
        provider,
        rows: [],
        reason: 'skipped',
        hint: 'Ran out of time budget before this source was tested. Try again.',
        ms: 0,
      };
    }

    try {
      const rows = await withTimeout(provider.search(ctx), Math.min(timeout, left), provider.id);
      const list = Array.isArray(rows) ? rows : [];
      health.record(provider.id, { ok: true, ms: Date.now() - started, count: list.length });
      return { provider, rows: list, ms: Date.now() - started };
    } catch (err) {
      health.record(provider.id, {
        ok: false,
        ms: Date.now() - started,
        error: err.message,
        reason: err.reason,
      });
      return {
        provider,
        rows: [],
        reason: err.reason,
        hint: err.hint,
        ms: Date.now() - started,
      };
    }
  });

  return results.map((r) => {
    const reason = r.reason || (r.rows.length ? 'ok' : 'empty');
    return {
      id: r.provider.id,
      name: r.provider.name,
      count: r.rows.length,
      ok: r.rows.length > 0,
      reason,
      hint: r.hint || '',
      avgMs: r.ms,
    };
  }).sort((a, b) => b.count - a.count);
}

/**
 * Diagnostics across both media kinds.
 *
 * A provider may only support movies or only series, so a single query would
 * leave half the list untested. But testing every source twice doubles the load
 * for nothing, so the series pass only re-tests sources that found nothing as a
 * movie. A source that already answered does not need a second opinion.
 */
async function probeAll(cfg, opts = {}) {
  // Deliberately a title that is actually present on the public trackers. The
  // old probe used Inception, which has been taken down from TPB — so a
  // perfectly healthy source reported `empty` and looked broken.
  const movie = {
    kind: 'movie',
    imdbId: 'tt0816692',
    title: 'Interstellar',
    year: 2014,
    season: null,
    episode: null,
    episodeTitle: '',
    genres: ['Adventure'],
  };
  const series = {
    kind: 'series',
    imdbId: 'tt0903747',
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: 'Pilot',
    genres: ['Crime'],
  };

  const deadline = opts.deadline || Date.now() + (opts.budget || PROBE_BUDGET_MS);
  const passOpts = { ...opts, deadline };

  const movieRows = await probe(cfg, movie, passOpts);
  const seen = new Set(movieRows.map((r) => r.id));

  // Re-test with a series when the movie pass found nothing — and always test
  // providers that are series-only, since they never appear in the movie pass
  // at all and would otherwise vanish from the report.
  const retry = new Set(movieRows.filter((r) => r.count === 0).map((r) => r.id));
  for (const provider of ALL.concat(fromUrls(cfg.addons))) {
    if (!cfg.providers[provider.id] && provider.addon !== true) continue;
    if (provider.kinds.includes('series') && !seen.has(provider.id)) retry.add(provider.id);
  }

  let seriesRows = [];
  // Only spend the remaining budget on a second pass if there is budget left.
  if (retry.size && deadline - Date.now() > 2000) {
    seriesRows = (await probe(cfg, series, passOpts)).filter((r) => retry.has(r.id));
  }

  const merged = new Map(movieRows.map((r) => [r.id, { ...r }]));

  for (const row of seriesRows) {
    const cur = merged.get(row.id);
    if (!cur) {
      merged.set(row.id, { ...row });
      continue;
    }
    cur.count += row.count;
    cur.ok = cur.count > 0;
    cur.avgMs = Math.max(cur.avgMs, row.avgMs);
    // A source that found nothing as a movie but answered for a series works.
    if (row.count > 0) {
      cur.reason = 'ok';
      cur.hint = '';
    } else if (!cur.hint && row.hint) {
      cur.reason = row.reason;
      cur.hint = row.hint;
    }
  }

  return [...merged.values()].sort((x, y) => y.count - x.count);
}

module.exports = { gather, probe, probeAll, DEFAULT_BUDGET_MS, releaseSignature, collapseDuplicates };
