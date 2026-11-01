'use strict';

/**
 * StremThru Torz as a source.
 *
 * Torz is a Stremio addon that answers the same question every other addon
 * source answers, so it plugs into the existing `toRow` path — the only special
 * part is where the URL comes from.
 *
 * Torz takes its whole configuration as a base64(JSON) path segment, and the
 * zero-config shape is `{indexers:[], stores:[{c:"p2p"}]}`:
 *
 *   - the `p2p` store needs no token, so no debrid account is involved, and
 *     Hydra keeps doing its own cache probe against whatever service the user
 *     configured;
 *   - an empty indexer list is valid because Torz serves from a crowdsourced
 *     pool rather than from indexers it scrapes itself.
 *
 * The upshot is a source that works with nothing configured. Verified live:
 * 524 rows for tt0816692 and 427 for a series episode, in 3-7s.
 *
 * Point `stremthruUrl` at a self-hosted instance to keep the request off the
 * public one. There is no reason to send a debrid key here — Hydra already
 * checks cache itself, and a key in a path segment would land in StremThru's
 * access logs.
 */

const { json } = require('../http');
const cache = require('../cache');
const { toRow } = require('./addon');

/**
 * Two independent public deployments, tried in order. Torz is by far the
 * slowest source we have and its latency is erratic — measured 2.5-3.9s on the
 * author's instance against 4.5-7.0s on the elfhosted mirror, with occasional
 * 8s+ stalls on either. A provider that misses the gather deadline contributes
 * nothing at all, so failover matters more here than anywhere else.
 */
const DEFAULT_BASE = 'https://stremthru.13377001.xyz';
const MIRROR_BASE = 'https://stremthru.elfhosted.com';

/**
 * Torz is the slowest source we have, and its answer is stable for minutes, so
 * results are memoised per title. A warm lambda answers repeats instantly, and
 * concurrent identical lookups collapse into one upstream request.
 *
 * Rejections are never cached, so a timeout retries next time.
 */
const TTL_MS = 10 * 60 * 1000;

/** Per-attempt budget. Two attempts must still fit inside the gather deadline. */
const ATTEMPT_TIMEOUT = 3600;

const BLOB = Buffer.from(
  JSON.stringify({ indexers: [], stores: [{ c: 'p2p' }] }),
  'utf8'
).toString('base64');

const RES_RE = /\b(2160p|1080p|720p|480p|4k|uhd)\b/i;

function hostsFrom(cfg) {
  const raw = cfg && typeof cfg.stremthruUrl === 'string' ? cfg.stremthruUrl.trim() : '';
  if (raw) {
    return [raw.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')];
  }
  return [DEFAULT_BASE, MIRROR_BASE];
}

const stremthru = {
  id: 'stremthru',
  name: 'StremThru Torz',
  kinds: ['movie', 'series'],
  addon: true,

  async search(ctx) {
    if (!ctx.imdbId) return [];

    const type = ctx.kind === 'series' ? 'series' : 'movie';
    const idPart =
      ctx.kind === 'series' && ctx.season != null && ctx.episode != null
        ? `${ctx.imdbId}:${ctx.season}:${ctx.episode}`
        : ctx.imdbId;

    const hosts = hostsFrom(ctx.cfg);
    const key = `torz:${hosts.join(',')}:${type}:${idPart}`;

    const streams = await cache.memo(key, TTL_MS, async () => {
      let lastErr = null;
      for (const host of hosts) {
        const url = `${host}/stremio/torz/${BLOB}/stream/${type}/${idPart}.json`;
        try {
          const data = await json(url, { timeout: ATTEMPT_TIMEOUT });
          return Array.isArray(data && data.streams) ? data.streams : [];
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('torz unreachable');
    });

    const rows = [];
    for (const stream of streams) {
      const row = toRow(stream, 'stremthru', 'StremThru Torz');
      if (!row) continue;

      // Torz splits the metadata: the filename is the release name and `name`
      // carries the resolution. A clean filename like "Breaking Bad S01E01
      // Pilot.mkv" therefore has no quality token at all, which would rank a
      // 4K release as unknown. Fold just the resolution across.
      if (!RES_RE.test(row.title)) {
        const name = typeof stream.name === 'string' ? stream.name : '';
        const m = name.match(RES_RE);
        if (m) row.title = `${row.title} ${m[1]}`.trim();
      }

      rows.push(row);
    }
    return rows;
  },
};

module.exports = stremthru;
module.exports.DEFAULT_BASE = DEFAULT_BASE;
module.exports.MIRROR_BASE = MIRROR_BASE;
module.exports.BLOB = BLOB;
