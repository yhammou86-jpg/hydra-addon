'use strict';

/**
 * Self-test — `npm test`. No framework, no dependencies.
 *
 * Covers the pure logic (codec, config, parser, ranking) plus a live smoke test
 * of the HTTP handlers. Exits non-zero on failure so it can gate a deploy.
 */

const assert = require('node:assert');

const { encode, decode } = require('../src/codec');
const { normalize } = require('../src/config');
const { parseRelease, matchesEpisode, detectLanguages, parseSizeText } = require('../src/parse');
const { scoreItem, passesFilters } = require('../src/rank');
const { toRow } = require('../src/providers/addon');
const stremthru = require('../src/providers/stremthru');
const { ALL } = require('../src/providers');
const { handleManifest, handleHealth, handleConfig } = require('../src/app');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}\n`);
  }
}

/**
 * Async tests are collected rather than awaited in place, so the report at the
 * bottom can wait for them. Without this the summary printed before the network
 * tests resolved — and the process exited 0 even when they failed, which made
 * the whole suite useless as a deploy gate.
 */
const pending = [];

function testAsync(name, fn) {
  const run = (async () => {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
    } catch (err) {
      failures.push({ name, err });
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}\n`);
    }
  })();
  pending.push(run);
  return run;
}

/* ---------------------------------------------------------------- codec */
console.log('\ncodec');

test('round-trips a config', () => {
  const cfg = normalize({ key: 'abc123', mode: 'hybrid', max: 55 });
  const blob = encode(cfg);
  assert.ok(blob.startsWith('d1'), 'expected d1 prefix');
  // The blob carries only the delta, so it is normalised back into a full config.
  assert.deepStrictEqual(normalize(decode(blob)), cfg);
});

test('keeps a default config tiny', () => {
  const blob = encode(normalize({}));
  assert.ok(blob.length < 40, `blob was ${blob.length} chars`);
});

test('stays short enough for a URL', () => {
  const blob = encode(normalize({ key: 'x'.repeat(40) }));
  assert.ok(blob.length < 400, `blob was ${blob.length} chars`);
});

test('rejects garbage instead of throwing', () => {
  assert.strictEqual(decode('not-a-real-blob'), null);
  assert.strictEqual(decode(''), null);
  assert.strictEqual(decode(null), null);
});

test('encrypts when CONFIG_SECRET is set', () => {
  process.env.CONFIG_SECRET = 'test-secret-value';
  const cfg = normalize({ key: 'super-secret-key' });
  const blob = encode(cfg);
  assert.ok(blob.startsWith('e1'), 'expected e1 prefix');
  assert.ok(!blob.includes('super-secret'), 'key must not appear in plaintext');
  assert.deepStrictEqual(normalize(decode(blob)), cfg);
  delete process.env.CONFIG_SECRET;
});

/* --------------------------------------------------------------- config */
console.log('\nconfig');

test('clamps out-of-range values', () => {
  const cfg = normalize({ max: 9999, minSeed: -40 });
  assert.strictEqual(cfg.max, 100);
  assert.strictEqual(cfg.minSeed, 0);
});

test('drops unknown providers and resolutions', () => {
  const cfg = normalize({ providers: { bogus: true }, res: ['8k'] });
  assert.strictEqual(cfg.providers.bogus, undefined);
  assert.deepStrictEqual(cfg.res, ['4k', '1080p', '720p', '480p']);
});

test('maps a legacy solid flag onto bitsearch', () => {
  assert.strictEqual(normalize({ providers: { solid: false } }).providers.bitsearch, false);
  assert.strictEqual(normalize({ providers: { bitsearch: true, solid: false } }).providers.bitsearch, true);
});

test('carries a proxy through normalisation', () => {
  assert.strictEqual(normalize({}).proxy, '');
  assert.strictEqual(normalize({ proxy: '  https://p.test/?url=  ' }).proxy, 'https://p.test/?url=');
  assert.strictEqual(normalize({ proxy: 123 }).proxy, '');
});

test('disables debrid-only mode without a key', () => {
  const cfg = normalize({ mode: 'debrid', key: '' });
  assert.strictEqual(cfg.mode, 'hybrid');
});

/* ---------------------------------------------------------------- parse */
console.log('\nrelease parser');

test('detects 4K REMUX', () => {
  const p = parseRelease('Inception.2010.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.7.1-FGT');
  assert.strictEqual(p.resolution, '4k');
  assert.strictEqual(p.source, 'REMUX');
  assert.strictEqual(p.codec, 'x265');
  assert.strictEqual(p.hdr, true);
  assert.strictEqual(p.group, 'FGT');
});

test('detects season and episode', () => {
  const p = parseRelease('Breaking.Bad.S01E01.1080p.WEB.h264-EDITH');
  assert.strictEqual(p.season, 1);
  assert.strictEqual(p.episode, 1);
  assert.strictEqual(p.source, 'WEB');
});

test('flags CAM rips', () => {
  assert.strictEqual(parseRelease('Movie.2024.CAM.1080p.x264').isCam, true);
  assert.strictEqual(parseRelease('Movie.2024.HDCAM.x264').isCam, true);
});

test('matches episodes correctly', () => {
  const ep = parseRelease('Show.S02E05.720p.HDTV.x264-GROUP');
  assert.strictEqual(matchesEpisode(ep, 2, 5), true);
  assert.strictEqual(matchesEpisode(ep, 2, 6), false);
  assert.strictEqual(matchesEpisode(ep, 3, 5), false);
});

/* ---------------------------------------------------------------- rank */
console.log('\nranking');

const cfg = normalize({ mode: 'p2p' });

function item(name, seeders, size = 2e9) {
  const parsed = parseRelease(name);
  return { infoHash: 'a'.repeat(40), title: name, size, seeders, parsed, cached: false, score: 0 };
}

test('4K outranks 1080p at similar seed counts', () => {
  const a = item('Movie.2024.2160p.WEB-DL.x265', 50);
  const b = item('Movie.2024.1080p.WEB-DL.x265', 50);
  assert.ok(scoreItem(a, cfg) > scoreItem(b, cfg));
});

test('a 1-seeder 4K does not beat a healthy 1080p', () => {
  const a = item('Movie.2024.2160p.WEB-DL.x265', 1);
  const b = item('Movie.2024.1080p.WEB-DL.x264', 90);
  assert.ok(scoreItem(b, cfg) > scoreItem(a, cfg), 'liveness penalty failed');
});

test('cached beats everything', () => {
  const a = item('Movie.2024.720p.HDTV.x264', 0);
  a.cached = true;
  const b = item('Movie.2024.2160p.REMUX.x265', 500);
  assert.ok(scoreItem(a, cfg) > scoreItem(b, cfg));
});

test('filters CAM when asked', () => {
  const cam = item('Movie.2024.CAM.1080p.x264', 900);
  assert.strictEqual(passesFilters(cam, normalize({ noCam: true })), false);
  assert.strictEqual(passesFilters(cam, normalize({ noCam: false })), true);
});

test('filters by resolution', () => {
  const r720 = item('Movie.2024.720p.WEB-DL.x264', 50);
  assert.strictEqual(passesFilters(r720, normalize({ res: ['1080p'] })), false);
});

/* ------------------------------------------------------------ handlers */
console.log('\nhandlers');

const headers = { host: 'hydra.test', 'x-forwarded-proto': 'https' };

test('manifest is valid Stremio JSON', () => {
  const res = handleManifest({}, headers);
  assert.strictEqual(res.status, 200);
  const m = JSON.parse(res.body);
  assert.strictEqual(m.id, 'community.hydrastream');
  assert.deepStrictEqual(m.resources, ['stream']);
  assert.deepStrictEqual(m.types, ['movie', 'series']);
  assert.deepStrictEqual(m.idPrefixes, ['tt']);
  assert.ok(m.logo.startsWith('https://hydra.test'));
});

test('health lists every provider', () => {
  const body = JSON.parse(handleHealth().body);
  assert.strictEqual(body.ok, true);
  assert.ok(body.providers.length >= 10);
});

test('config endpoint encodes a blob', async () => {
  const res = await handleConfig({ body: { action: 'encode', config: { mode: 'p2p' } } });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.ok(decode(body.blob));
});

testAsync('check-addon rejects a non-http url', async () => {
  const res = await handleConfig({ body: { action: 'check-addon', url: 'javascript:alert(1)' } });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
});

testAsync('check-addon flags an unconfigured addon as not configured', async () => {
  // StremThru Torz serves a manifest with an empty `types` array until it has
  // been configured — the exact silent-empty failure this check exists to catch.
  const res = await handleConfig({
    body: { action: 'check-addon', url: 'https://stremthru.elfhosted.com/stremio/torz' },
  });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true, 'manifest should be reachable');
  assert.strictEqual(body.configured, false, 'should be flagged as unconfigured');
});

testAsync('check-addon passes a working addon', async () => {
  const res = await handleConfig({
    body: { action: 'check-addon', url: 'https://torrentio.strem.fun' },
  });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.configured, true);
  assert.ok(body.types.includes('movie'));
});

/* ------------------------------------------------------ release identity */
console.log('\nrelease identity');

const { releaseTitle, releaseYear, titleMatches } = require('../src/parse');

test('extracts the title out of a release name', () => {
  assert.strictEqual(releaseTitle('Inception.2010.2160p.UHD.BluRay.REMUX'), 'Inception');
  assert.strictEqual(releaseTitle('Dune.Part.Two.2024.1080p.WEB-DL.x265'), 'Dune Part Two');
  assert.strictEqual(releaseTitle('[SubsPlease] Jujutsu Kaisen - 24 (1080p)'), 'Jujutsu Kaisen');
});

test('a number in the title is not mistaken for the year', () => {
  // The trap: naive year stripping eats the "2049" and the film then looks wrong.
  assert.strictEqual(releaseTitle('Blade.Runner.2049.2017.1080p.BluRay'), 'Blade Runner 2049');
  assert.strictEqual(releaseYear('Blade.Runner.2049.2017.1080p.BluRay'), 2017);
  assert.strictEqual(releaseTitle('1917.2019.1080p.BluRay'), '1917');
  assert.strictEqual(releaseYear('1917.2019.1080p.BluRay'), 2019);
});

test('rejects a sequel when the first film was asked for', () => {
  assert.strictEqual(titleMatches('Dune', 'Dune'), true);
  assert.strictEqual(titleMatches('Dune', 'Dune Part Two'), false);
  assert.strictEqual(titleMatches('Oppenheimer', 'Barbie'), false);
  // Edition words are not a mismatch.
  assert.strictEqual(titleMatches('Interstellar', 'Interstellar IMAX'), true);
  assert.strictEqual(titleMatches('The Matrix', 'Matrix'), true);
});

test('drops a release whose year belongs to a different film', () => {
  const meta = { kind: 'movie', title: 'Dune', year: 2021 };
  const wrong = item('Dune.1984.2160p.BluRay.x265', 500, 8e9);
  const right = item('Dune.2021.2160p.BluRay.x265', 500, 8e9);
  assert.strictEqual(passesFilters(wrong, normalize({}), meta), false);
  assert.strictEqual(passesFilters(right, normalize({}), meta), true);
});

test('drops junk and implausibly small releases', () => {
  const meta = { kind: 'movie', title: 'Dune', year: 2021 };
  const exe = item('Dune.2021.1080p.Setup.exe', 500, 2e9);
  const tiny = item('Dune.2021.2160p.BluRay.x265', 500, 40e6); // 40 MB "4K"
  assert.strictEqual(passesFilters(exe, normalize({}), meta), false);
  assert.strictEqual(passesFilters(tiny, normalize({}), meta), false);
});

test('strict matching can be turned off', () => {
  const meta = { kind: 'movie', title: 'Dune', year: 2021 };
  const wrong = item('Dune.1984.2160p.BluRay.x265', 500, 8e9);
  assert.strictEqual(passesFilters(wrong, normalize({ strictMatch: false }), meta), true);
});

/* ------------------------------------------------------------ unreleased */
console.log('\nunreleased');

const { isUnreleased } = require('../src/metadata');
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-31T00:00:00Z');

test('flags a film that has not opened yet', () => {
  assert.strictEqual(isUnreleased({ releasedAt: now + 30 * DAY }, now), true);
  assert.strictEqual(isUnreleased({ releasedAt: now - 30 * DAY }, now), false);
  assert.strictEqual(isUnreleased({ releasedAt: null }, now), false, 'unknown date is not a reason to hide');
});

test('an unaired episode wins over the series start date', () => {
  const meta = { releasedAt: now - 3000 * DAY, episodeReleasedAt: now + 5 * DAY };
  assert.strictEqual(isUnreleased(meta, now), true);
});

test('a day of slack absorbs timezone differences', () => {
  assert.strictEqual(isUnreleased({ releasedAt: now + 6 * 60 * 60 * 1000 }, now), false);
});

testAsync('skips the scrape entirely for unreleased content', async () => {
  const { gather } = require('../src/orchestrator');
  const meta = {
    kind: 'movie',
    imdbId: 'tt9999999',
    title: 'Not Out Yet',
    year: 2027,
    season: null,
    episode: null,
    genres: [],
    releasedAt: Date.now() + 90 * DAY,
  };
  const res = await gather(normalize({ mode: 'p2p' }), meta);
  assert.strictEqual(res.unreleased, true);
  assert.strictEqual(res.items.length, 0);
  assert.strictEqual(res.stats.providers, 0, 'should not have queried any provider');

  const off = await gather(normalize({ mode: 'p2p', hideUnreleased: false }), meta);
  assert.ok(off.unreleased === undefined, 'turning the filter off should scrape normally');
});

/* ------------------------------------------------------------ diagnostics */
console.log('\ndiagnostics');

const { classify, mostInformative } = require('../src/http');

test('labels a Cloudflare challenge', () => {
  const c = classify({
    status: 403,
    headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
    text: '<title>Just a moment...</title>',
    requested: 'https://apibay.org/q.php',
    url: 'https://apibay.org/q.php',
  });
  assert.strictEqual(c.reason, 'cloudflare');
  assert.match(c.hint, /proxy|Prowlarr/i);
});

test('labels a bare 403 as blocked, not cloudflare', () => {
  const c = classify({
    status: 403,
    headers: { server: 'nginx' },
    text: 'Forbidden',
    requested: 'https://x.test/a',
    url: 'https://x.test/a',
  });
  assert.strictEqual(c.reason, 'blocked');
});

test('names the new host when a redirect precedes a failure', () => {
  const c = classify({
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    text: '',
    requested: 'https://solidtorrents.to/api',
    url: 'https://bitsearch.eu/api',
  });
  assert.strictEqual(c.reason, 'cloudflare');
  assert.match(c.hint, /bitsearch\.eu/, 'hint should blame the host that actually failed');
});

test('does not invent a redirect when a proxy was used', () => {
  const c = classify({
    status: 403,
    headers: { server: 'nginx' },
    text: '',
    requested: 'https://x.test/a',
    url: 'https://proxy.test/?url=x',
    proxied: true,
  });
  assert.strictEqual(c.reason, 'blocked');
  assert.doesNotMatch(c.hint, /redirecting/);
});

test('a specific reason outranks a timeout across mirrors', () => {
  const cf = Object.assign(new Error('cf'), { reason: 'cloudflare' });
  const to = Object.assign(new Error('timeout'), { reason: 'timeout' });
  assert.strictEqual(mostInformative([cf, to]).reason, 'cloudflare');
  assert.strictEqual(mostInformative([to, cf]).reason, 'cloudflare');
  assert.strictEqual(mostInformative([]), null);
});

/* ------------------------------------------------------------ proxy worker */
console.log('\nproxy worker');

const workerUrl = encodeURIComponent('https://apibay.org/q.php?q=dune&cat=0');

testAsync('accepts every proxy URL shape the addon can produce', async () => {
  const { extractTarget } = await import('../worker/index.mjs');
  const want = 'https://apibay.org/q.php?q=dune&cat=0';
  assert.strictEqual(extractTarget(`https://w.dev/?url=${workerUrl}`), want, '?url= form');
  assert.strictEqual(extractTarget(`https://w.dev/f/${workerUrl}`), want, '/f/ form');
  assert.strictEqual(extractTarget(`https://w.dev/${workerUrl}`), want, 'bare prefix form');
  assert.strictEqual(extractTarget('https://w.dev/'), null, 'root is not a target');
  assert.strictEqual(extractTarget('https://w.dev/not-a-url'), null, 'junk rejected');
});

testAsync('blocks hosts outside the allowlist', async () => {
  const { isAllowed, allowList } = await import('../worker/index.mjs');
  const allow = allowList({});
  assert.strictEqual(isAllowed('apibay.org', allow), true);
  assert.strictEqual(isAllowed('cdn.apibay.org', allow), true, 'subdomains allowed');
  assert.strictEqual(isAllowed('evil-apibay.org', allow), false, 'suffix trick rejected');
  assert.strictEqual(isAllowed('apibay.org.evil.com', allow), false, 'prefix trick rejected');
  assert.strictEqual(isAllowed('169.254.169.254', allow), false, 'metadata IP rejected');
  assert.deepStrictEqual(allowList({ ALLOW_HOSTS: 'my.tracker' }), ['my.tracker'], 'env override');
});

testAsync('refuses to proxy an SSRF target', async () => {
  const { default: handler } = await import('../worker/index.mjs');
  const target = encodeURIComponent('http://169.254.169.254/latest/meta-data');
  const res = await handler.fetch(new Request(`https://w.dev/?url=${target}`), {});
  assert.strictEqual(res.status, 403);
});

testAsync('routes a provider through the configured proxy', async () => {
  // Stand up a local stand-in for the Worker and check the addon actually uses
  // it, rather than quietly falling back to a direct (blocked) request.
  const http = require('node:http');
  const payload = JSON.stringify([
    {
      id: '1',
      name: 'Interstellar (2014) 1080p BluRay x264',
      info_hash: 'a'.repeat(40),
      size: '1500000000',
      seeders: '42',
    },
  ]);

  let forwarded = null;
  const server = http.createServer((req, res) => {
    forwarded = new URL(req.url, 'http://x').searchParams.get('url');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const apibay = require('../src/providers/apibay');
    const rows = await apibay.search({
      kind: 'movie',
      title: 'Interstellar',
      year: 2014,
      season: null,
      episode: null,
      cfg: { proxy: `http://127.0.0.1:${port}/?url=` },
    });

    assert.strictEqual(rows.length, 1, 'should parse the proxied payload');
    assert.strictEqual(rows[0].seeders, 42);
    assert.match(String(forwarded), /apibay\.org\/q\.php/, 'the real target should be forwarded');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------- addon sources */
console.log('\naddon sources');

test('reads seeders and size out of an addon card', () => {
  const row = toRow(
    {
      name: 'Torrentio\n4k',
      title: 'Inception.2010.2160p.UHD.BluRay\n👤 421 💾 58.2 GB ⚙️ TPB',
      infoHash: 'a'.repeat(40),
    },
    'torrentio',
    'Torrentio'
  );
  assert.strictEqual(row.title, 'Inception.2010.2160p.UHD.BluRay', 'picked the wrong line as the name');
  assert.strictEqual(row.seeders, 421);
  assert.strictEqual(Math.round(row.size / 1e9), 58);
});

test('recovers the infohash from a magnet url', () => {
  const row = toRow(
    { name: 'x', title: 'Film.2020.1080p', url: `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=x` },
    'comet',
    'Comet'
  );
  assert.strictEqual(row.infoHash, 'b'.repeat(40));
});

test('prefers behaviorHints.videoSize over the card text', () => {
  const row = toRow(
    { name: 'x', title: 'Film.2021.720p 💾 1.0 GB', infoHash: 'c'.repeat(40), behaviorHints: { videoSize: 1234567890 } },
    'comet',
    'Comet'
  );
  assert.strictEqual(row.size, 1234567890);
});

test('drops a stream that has no infohash', () => {
  assert.strictEqual(toRow({ name: 'junk', title: 'nothing useful' }, 'comet', 'Comet'), null);
});

/* ------------------------------------------------------------- stremthru */
console.log('\nstremthru torz');

test('builds the zero-config torz blob', () => {
  // The whole point: no debrid account and no indexers. If either requirement
  // creeps back in, this decodes to something that fails HasRequiredValues().
  const decoded = JSON.parse(Buffer.from(stremthru.BLOB, 'base64').toString('utf8'));
  assert.deepStrictEqual(decoded, { indexers: [], stores: [{ c: 'p2p' }] });
});

test('ships enabled by default', () => {
  const cfg = normalize({});
  assert.strictEqual(cfg.providers.stremthru, true, 'torz should be on out of the box');
});

test('appears in the provider registry and in health', () => {
  assert.ok(ALL.some((p) => p.id === 'stremthru'), 'provider not registered');
  const body = JSON.parse(handleHealth().body);
  assert.ok(body.providers.some((p) => p.id === 'stremthru'), 'health must list it');
});

test('normalises a self-hosted instance url', () => {
  assert.strictEqual(
    normalize({ stremthruUrl: 'stremthru.mydomain.dev' }).stremthruUrl,
    'https://stremthru.mydomain.dev'
  );
  assert.strictEqual(
    normalize({ stremthruUrl: 'https://tz.example.com/manifest.json' }).stremthruUrl,
    'https://tz.example.com'
  );
  assert.strictEqual(normalize({ stremthruUrl: '   ' }).stremthruUrl, '');
});

test('turns the provider off when deselected', () => {
  assert.strictEqual(normalize({ providers: { stremthru: false } }).providers.stremthru, false);
});

/* ---------------------------------------------------------------- filters */
console.log('\nfilters');

function candidate(title, size) {
  return { title, size, seeders: 20, parsed: parseRelease(title) };
}

test('drops results above the size cap', () => {
  const cfg = normalize({ maxGB: 40 });
  assert.strictEqual(passesFilters(candidate('Film.2021.2160p.BluRay.x264', 50e9), cfg, null), false);
  assert.strictEqual(passesFilters(candidate('Film.2021.2160p.BluRay.x264', 30e9), cfg, null), true);
});

test('keeps results with no declared size', () => {
  const cfg = normalize({ maxGB: 40 });
  assert.strictEqual(passesFilters(candidate('Film.2021.1080p.WEB-DL', 0), cfg, null), true);
});

test('maxGB of 0 means no cap', () => {
  const cfg = normalize({ maxGB: 0 });
  assert.strictEqual(passesFilters(candidate('Film.2021.2160p.BluRay.x264', 90e9), cfg, null), true);
});

test('rejects a release tagged in a language you did not ask for', () => {
  const cfg = normalize({ langs: ['en'] });
  assert.strictEqual(passesFilters(candidate('Amelie.2001.FRENCH.1080p.BluRay.x264', 8e9), cfg, null), false);
});

test('keeps an untagged release under a language filter', () => {
  const cfg = normalize({ langs: ['en'] });
  assert.strictEqual(passesFilters(candidate('Interstellar.2014.1080p.BluRay.x264', 8e9), cfg, null), true);
});

test('keeps a multi-audio release under a language filter', () => {
  const cfg = normalize({ langs: ['en'] });
  assert.strictEqual(passesFilters(candidate('Dune.2021.ITA.MULTI.1080p', 8e9), cfg, null), true);
});

test('keeps an explicitly English release', () => {
  const cfg = normalize({ langs: ['en'] });
  assert.strictEqual(passesFilters(candidate('Dune.2021.ENG.1080p.WEB-DL', 8e9), cfg, null), true);
});

test('does not read "Dan Brown" as Danish', () => {
  assert.deepStrictEqual(detectLanguages('Dan.Browns.The.Lost.Symbol.2009.1080p').codes, []);
  assert.deepStrictEqual(detectLanguages('Film.2020.DAN.1080p').codes, ['da']);
});

test('parses the size formats addons actually emit', () => {
  assert.strictEqual(parseSizeText('12.4 GB'), 12400000000);
  assert.strictEqual(parseSizeText('850 MB'), 850000000);
  assert.strictEqual(parseSizeText('1,2 GB'), 1200000000);
  assert.strictEqual(parseSizeText('no size'), 0);
});

test('drops unsupported language codes instead of trusting them', () => {
  const cfg = normalize({ langs: ['en', 'xx', 'klingon'] });
  assert.deepStrictEqual(cfg.langs, ['en']);
});

test('keeps only http(s) custom addon urls', () => {
  const cfg = normalize({ addons: ['https://a.dev/addon', 'ftp://b.dev', 'javascript:alert(1)', ''] });
  assert.deepStrictEqual(cfg.addons, ['https://a.dev/addon']);
});

/* -------------------------------------------------------------- routing */
console.log('\nrouting');

// Stremio will install the bare manifest.json even though it advertises
// `configurable`, so every route the manifest promises has to resolve without
// a config prefix. Keep the Vercel table and the dev server in agreement.
const REWRITES = require('../vercel.json').rewrites;

function rewriteFor(pathname) {
  for (const r of REWRITES) {
    const pattern = new RegExp(`^${r.source.replace(/:[a-z]+/gi, '[^/]+')}$`);
    if (pattern.test(pathname)) return r.destination;
  }
  return null;
}

test('serves streams from an un-prefixed install', () => {
  const dest = rewriteFor('/stream/movie/tt0816692.json');
  assert.ok(dest, 'no rewrite matches /stream/movie/tt0816692.json');
  assert.ok(!/c=:c/.test(dest), 'the bare route must not expect a config blob');
  assert.ok(/type=:type/.test(dest) && /id=:id/.test(dest), 'type and id must be forwarded');
});

test('serves the un-prefixed manifest too', () => {
  assert.strictEqual(rewriteFor('/manifest.json'), '/api/manifest');
});

test('still routes a configured install through its own blob', () => {
  const dest = rewriteFor('/d1abc/stream/movie/tt0816692.json');
  assert.ok(dest && /c=:c/.test(dest), 'configured installs must carry the blob');
});

test('falls back to defaults when no config is supplied', () => {
  const cfg = normalize(decode(undefined));
  assert.strictEqual(cfg.maxGB, 40);
  assert.deepStrictEqual(cfg.langs, []);
  assert.ok(Object.values(cfg.providers).some(Boolean), 'defaults must enable providers');
});

/* ---------------------------------------------------------------- live */
console.log('\nlive scrape (network)');

testAsync('returns real streams for a known movie', async () => {
  const blob = encode(normalize({ mode: 'p2p', providers: { knaben: true, yts: true } }));
  const res = await require('../src/app').handleStream({ c: blob, type: 'movie', id: 'tt0816692' }, headers);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.streams), 'streams must be an array');
  assert.ok(body.streams.length > 0, 'expected at least one stream');
  for (const s of body.streams) {
    assert.ok(s.name && s.title, 'stream needs name + title');
    assert.ok(s.url || s.infoHash, 'stream needs url or infoHash');
  }
});

testAsync('torz answers with nothing configured', async () => {
  // The claim this feature rests on: `{indexers:[],stores:[{c:"p2p"}]}` is
  // enough. If StremThru ever starts requiring a store or an indexer, this
  // fails loudly instead of silently contributing zero rows forever.
  const ctx = { kind: 'movie', imdbId: 'tt0816692', cfg: normalize({}) };
  const rows = await stremthru.search(ctx);
  assert.ok(rows.length > 0, 'expected rows from the public torz instance');
  for (const r of rows) {
    assert.match(r.infoHash, /^[a-f0-9]{40}$/, 'every row needs a real infohash');
    assert.ok(r.provider === 'stremthru');
  }
  assert.ok(rows.some((r) => r.size > 0), 'sizes should come through from videoSize');
});

/* -------------------------------------------------------------- report */// Wait for the async (network) tests before judging the run, so the summary is
// honest and the exit code reflects them.
Promise.all(pending).then(() => {
  const total = passed + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed}/${total} passed\x1b[0m\n`);
  if (failures.length) process.exit(1);
});
