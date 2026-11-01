# Hydra

**One addon. Every source.** A Stremio / Nuvio addon that aggregates public trackers, Stremio
addons and Torznab indexers, probes your debrid cache in a single batch call, and falls back to
native P2P — so there is always something to press play on.

Runs entirely on Vercel's free tier. Zero runtime dependencies.

```
Stremio  ──┐
           ├──►  Hydra  ──►  Cinemeta (title lookup)
Nuvio    ──┘         │
                     ├──►  16 sources in parallel, hard deadline
                     ├──►  debrid checkcached  (1 request, N hashes)
                     └──►  ranked stream list
                              ├─ ⚡ cached  → /r/<hash>  → direct link
                              └─ P2P        → infohash + trackers
```

---

## What a result looks like

Every card carries one fact per line, so a choice takes a glance instead of a decode:

```
⚡ TB
🔥 4K | ⚡ Cached | 🛰️ 6.71 GB
🎬 Sugar ▸ S02E03 · Shibboleth
💎 WEB-DL · x265 · DV
🔊 Atmos · DD+
📚 TorBox Library · ABC
```

Switch to `style: compact` for a single line. No image badges: no client renders markdown images
reliably in a stream title, so Hydra uses Unicode glyphs only — the same approach AIOStreams takes.

---

## Why this is different

Most addons that get popular on a VPS fall apart on serverless, because they assume a long-running
process with a warm cache and unlimited time. Hydra is designed around the opposite constraint, and
that constraint turns out to be an advantage:

| Problem on serverless | Hydra's answer |
|---|---|
| No database for user config | Config lives compressed in the URL (`~310 bytes`) |
| 10–60 s function limit | Deadline-budgeted scraping, returns partial results instead of failing |
| Cold starts | Zero dependencies — pure Node built-ins, no SDK/axios/cheerio |
| No persistent cache | Per-instance LRU + single-flight, which covers the real traffic pattern |
| N debrid API calls per result | **One** batched `checkcached` call for up to 100 hashes |
| Debrid account filled with dead torrents | **Lazy resolve** — a torrent is only added when you press play |
| Can't seed torrents from a lambda | **Native P2P** — return an infohash, let the client do the work |
| Trackers blocked unevenly by network | **Source diagnostics** — probe them, keep the ones that answer |

Three details worth calling out:

**Lazy resolution.** Stream URLs point at Hydra (`/r/<infohash>`), not at your debrid account. On
play, Hydra registers the magnet (instant, because it is cached), picks the right file inside the
torrent, mints a direct link, and 302-redirects you there. Browsing 40 results costs exactly one
debrid request.

**Ranking that respects physics.** A 4K REMUX with one seeder is not better than a 1080p WEB-DL with
ninety — it just buffers forever. Seed count feeds the score as a liveness penalty, and cached
results skip that penalty entirely because the service serves them from disk.

**Informed choice over a fixed list.** Public trackers are fragile and fail asymmetrically: a source
dead from one datacenter is fine from another. Rather than guess, the setup page runs a live probe
and shows you what each source returned, with latency. Keep the winners.

---

## Deploy in five minutes

### 1. Push to GitHub

```bash
git clone https://github.com/<you>/hydrastream.git
cd hydrastream
git remote set-url origin https://github.com/<you>/hydrastream.git
git push -u origin main
```

### 2. Import into Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
2. Framework preset: **Other**. Build command: leave empty. Output directory: leave empty.
3. (Optional) Add environment variable `CONFIG_SECRET` — see below.
4. Deploy.

That is it. Vercel detects `api/*.js` as serverless functions and serves `public/` as static files.
No build step, no `npm install`, nothing to compile.

### 3. Install the addon

Open `https://<your-project>.vercel.app/configure`, work through the four steps, and use
**Direct Install** (opens the app), **Manifest URL** (paste into Nuvio), or **Download**.

---

## Local development

```bash
npm run dev     # http://localhost:7000
npm test        # 19 assertions, no framework
```

`npm run dev` runs a dependency-free HTTP server that mirrors the Vercel routing table exactly, so
what you test locally is what you deploy. There is nothing to install.

---

## Configuration reference

Everything below is set through `/configure` and encoded into the addon URL.

| Key | Meaning |
|---|---|
| `svc` | `torbox` · `realdebrid` |
| `key` | API key for the selected service. Optional. |
| `mode` | `hybrid` (cached via debrid, rest P2P) · `debrid` (debrid only) · `p2p` (never contact it) |
| `style` | `rich` (one fact per line) · `compact` (single line) |
| `providers` | Per-source toggles |
| `res` | Allowed resolutions: `4k` `1080p` `720p` `480p` |
| `max` | Max results returned (5–100) |
| `minSeed` | Minimum seeders |
| `noCam` | Drop CAM / TS / screener releases |
| `strictMatch` | Drop releases that are a different film (default on). Turn off to see everything. |
| `hideUnreleased` | Drop everything when the film has not opened or the episode has not aired (default on). |
| `sort` | `quality` · `seeders` · `size` |
| `cachedOnly` | Only show what the service can serve right now |
| `uncached` | Allow the service to fetch uncached torrents on play (slow first play) |
| `preferEfficient` | Slight boost for x265 / AV1 encodes |
| `maxGB` | Hard cap on file size in GB (default 40). `0` disables it. |
| `langs` | Language filter, ISO codes, e.g. `["en"]`. Empty means any. |
| `addons` | Extra addon manifest URLs — StremThru Torz, Sootio, Zilean, or any Stremio addon |
| `proxy` | Fetch sources through a proxy. Prefix (`https://w.dev/?url=`) or template (`https://w.dev/f/{url}`). Fixes TLS-fingerprint blocks. |
| `torznab` | `{ url, key }` — Jackett / Prowlarr / any Torznab endpoint |
| `prowlarr` | `{ url, key }` — Prowlarr's aggregate JSON API |

### Environment variables

| Variable | Required | Effect |
|---|---|---|
| `CONFIG_SECRET` | no | Encrypts the config blob with AES-256-GCM. Changing it invalidates existing URLs. |
| `PORT` | no | Local dev port (default `7000`). |

---

## Debrid services

| Service | Status | Notes |
|---|---|---|
| **TorBox** | stable | Verified end-to-end against the live API. Batch `checkcached` handles 100 hashes per call. |
| **Real-Debrid** | beta | Follows the documented v1 API. Not exercised against a live account during development, so treat it as untested until you confirm with your own key. |
| Premiumize, AllDebrid, PikPak, OffCloud | not yet | Shown in the setup grid so the shape of the product is clear. |

Adding a service is deliberately small — implement two functions in `src/debrid/<name>.js` and
register it in `src/debrid/index.js`:

```js
async function checkCached(key, hashes) -> Set<infohash>   // which are instant
async function resolve(key, hash, hint, opts) -> string    // a direct HTTPS URL
```

---

## Sources

Two kinds. **Addons** already did the scraping — Hydra asks them the same question Stremio
would and merges the answer, so one request returns what used to take a dozen. **Trackers**
are scraped directly.

| Source | Tier | Notes |
|---|---|---|
| **Torrentio** | 1 | Addon. Aggregates dozens of indexers; ~150 rows for a well-known film. |
| **Comet** | 1 | Addon. The largest catalogue of the bunch — 1,600+ rows for the same film. |
| **TorrentsDB** | 1 | Addon. Curated releases, good 4K coverage. |
| **StremThru Torz** | 1 | Addon. Crowdsourced P2P pool — needs no account and no indexers. |
| **Knaben** | 1 | Meta-search over dozens of trackers, with *live* seeders. |
| **YTS** | 1 | Movies, small high-quality encodes. IMDb-addressable. |
| **EZTV** | 1 | Series, IMDb-addressable, so episode matching is exact. |
| **BitSearch** | 1 | DHT index, clean JSON API. Formerly SolidTorrents — the old domain now 301s here. |
| **Nyaa** | 1 | Anime, via RSS. |
| **MediaFusion** | 2 | Addon. The public instance currently answers with an empty list. |
| **The Pirate Bay** | 2 | Via `apibay.org`. Blocked for server-side clients by TLS fingerprinting — needs a proxy. Knaben already indexes TPB, so you rarely lose anything. |
| **AniTosho** | 2 | Anime mirrors. |
| **RARBG** | 2 | Off by default — heavily rate limited. |
| **TorrentGalaxy** | 3 | Direct HTML scrape. Every public mirror is currently dead or challenged, and listings carry no infohash so the top rows need a detail-page fetch. Off by default; Knaben already indexes TGX. |
| **Torznab** | 3 | **Jackett, Prowlarr, or any Torznab endpoint.** One URL can unlock hundreds of indexers. |
| **Prowlarr** | 3 | Prowlarr's aggregate JSON search endpoint. |

### Bring your own addon

Sootio and Zilean are config-required: each hands you a personal manifest URL containing your own
settings, and there is no usable anonymous instance to ship. Paste that URL into **Your own addons**
in step 2 — one per line — and Hydra will query it like any other source.

Hit **Check these URLs** before relying on one. A config-required addon answers `200` with an
empty stream list when it is not configured, which is indistinguishable from "this film has no
results". The check reads the manifest instead: an empty `types` array or
`configurationRequired: true` means the URL is a stub, and it says so.

StremThru Torz is the exception, and it is built in. Its config accepts a `p2p` store with no
token and an empty indexer list, because it serves from a crowdsourced pool rather than scraping
indexers itself — so the toggle works with nothing configured. See `src/providers/stremthru.js`.

Providers fail independently. If Cloudflare blocks three of them from your region, the rest
still answer and the request still succeeds. Use **Test all sources** in step 2 to see exactly
which ones work from your deployment.

---

## Filters

| Setting | Default | Behaviour |
|---|---|---|
| `maxGB` | 40 | Hard cap on file size. `0` disables it. Releases with no declared size always pass — several addons omit it, and dropping those would silently remove a whole source. |
| `langs` | `[]` (any) | ISO codes. Only a *positive* mismatch is excluded: a release tagged `FRENCH` is dropped when you asked for English, but an untagged one is kept because unknown is not the same as foreign. `MULTi`/`DUAL` releases carry several tracks and always pass. |

Language tags are matched in two classes, which matters more than it sounds: three-letter
codes (`ITA`, `FRE`, `DAN`) are matched **case-sensitively** because release names uppercase
them, while spelled-out names (`French`, `Castellano`) are matched case-insensitively. Matching
`dan` loosely would read "Dan Brown" as Danish and drop the film.

---

## Why a link played the wrong thing

Most sources search by **title text**, not by ID. A search for "Dune" returns Dune (1984),
"Dune: Part Two", "Dune Drifter", and a pile of unrelated uploads. If nothing checks the
result, the addon happily plays whichever one ranked highest. Three filters stop that.

**Exact title and year** (`strictMatch`, on by default). The release name is parsed into a
title and a year, then compared with what you actually clicked. Token-set equality — not
substring — because substring is exactly how "Dune" matches "Dune: Part Two". Edition words
(`Extended`, `IMAX`, `Unrated`) are tolerated; extra words are not.

Two parsing traps this has to survive:

- `Blade.Runner.2049.2017.1080p` — the first four-digit number is part of the **title**, not
  the year. Title and year are resolved together so `2049` is not eaten.
- `1917.2019.1080p` — same shape, opposite answer: `1917` *is* the title. A number only counts
  as the year if it could plausibly be one and is not the only thing left.

**Junk and impossible sizes.** Executables, password dumps and URL spam are dropped. So is a
"4K" release under 600 MB — that is not a 4K movie, it is a sample or a fake. Series episodes
get lower floors because they are shorter, and unknown sizes are never rejected.

**Unreleased content** (`hideUnreleased`, on by default). If the film has not opened, or the
episode has not aired, then *every* result claiming to be it is fake. The scrape is skipped
entirely and the stream list says why instead of showing CAM rips.

### The one that was silent

EZTV is IMDb-addressable, which should make it the most accurate series source. It was
returning whatever aired last night instead — for every show.

The API keys its index by the **numeric** part of the IMDb id. Sending `tt0903747` is not
rejected; it is ignored, and the response is the entire global catalogue — about 1.1 million
torrents — with a normal `200`. `0903747` filters correctly. A 403 would have been obvious;
this looked like success, and it is why a series request could play an unrelated show.

The provider now sends the numeric id and rejects any response whose count is implausibly
large for one show, so a future change in that API fails loudly instead of quietly.

---

## Troubleshooting a source that returns 0

A source reporting `0` is not one problem. The probe classifies each failure, so you can tell them
apart instead of guessing:

| Reason | What it means | Fix |
|---|---|---|
| `cloudflare` | The site fingerprints the **TLS handshake** (JA3/JA4) and refuses non-browser clients. | Proxy, FlareSolverr, or Prowlarr. Headers will not help. |
| `blocked` | A plain 403/401 with no bot-check markers. | IP or region ban, or the source now needs a key. |
| `rate-limit` | 429, or 403 with `Retry-After`. | Back off; it works, just slowly. |
| `missing` | 404 on the endpoint. | The API or domain changed. |
| `timeout` | No response within the budget. | Slow host, or blocked at the network level. |
| `empty` | Reached and answered, but had no matches. | **Working.** Keep it enabled. |
| `parse` | Got HTML where JSON was expected. | Usually a challenge page in disguise. |

### Why "HTTP 403 — Cloudflare" is often misdiagnosed

Two cases came up while building this, and both looked identical from the outside:

**1. It was a rename, not a block.** `solidtorrents.to` stopped being the real host. The probe saw a
failure and blamed Cloudflare; the actual cause was a redirect to a new domain. The fix was to point
at the new host — now `BitSearch`. Redirects are followed silently, so the failure is annotated with
the host that *actually* failed:

```
Cloudflare bot check (after redirecting to bitsearch.eu) — TLS fingerprint, not headers.
```

**2. The same URL answers differently per client.** This is the tell that it really is fingerprinting:

| Client → `apibay.org` | Result |
|---|---|
| `curl` (same IP, same User-Agent) | **200 OK**, real JSON |
| Node `fetch` (same IP, same User-Agent) | **403**, `<title>Just a moment...</title>` |

Same IP, same headers, different TLS stack. Setting Chrome's `ciphers` and `ecdhCurve` on
`https.request` still returns 403. There is no server-side fix — the decision happens below HTTP.
Use a proxy (field in step 2) or let Knaben cover that catalogue, since Knaben already indexes TPB.

**Quick check for any suspect source:**

```bash
curl -sS -o /dev/null -D - -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
  (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" "https://apibay.org/q.php?q=inception&cat=0" \
  | grep -iE "^HTTP/|cf-mitigated|^location"
```

- `200` + JSON in the body → the host is fine; your runtime is being fingerprinted.
- `403` + `cf-mitigated: challenge` → Cloudflare, needs a proxy.
- `301` + `location:` → the domain moved. Follow it.

---

## HTTP routes

| Route | Purpose |
|---|---|
| `GET /manifest.json` | Default manifest (P2P, no key) |
| `GET /<config>/manifest.json` | Personalised manifest |
| `GET /<config>/stream/<movie\|series>/<id>.json` | Stream list |
| `GET /r/<infohash>?c=<config>` | Lazy resolve → 302 to a direct link |
| `GET /health` | Status, per-source success rates, debrid services |
| `POST /api/config` | `{action:"encode"}` · `{action:"verify"}` · `{action:"probe"}` |

Responses include an `x-hydra-stats` header with per-provider counts and timing, useful when
debugging a source that stopped working.

---

## Security and privacy

- **No server-side storage.** There is no database and no user account. Your key lives inside your
  own URL and nowhere else.
- **No password collection.** “Direct Install” uses the `stremio://` deep link, so Hydra never asks
  for — or sees — a Stremio account.
- **No video proxying.** Hydra never handles a byte of media. Debrid links go straight from the
  service to your player; P2P traffic goes straight from peers to your player.
- **Opaque URLs (optional).** With `CONFIG_SECRET` set, the config blob is AES-256-GCM encrypted.
  Without it, it is deflate-compressed and base64url-encoded — readable by anyone who sees the URL,
  the same trade-off every addon of this kind makes.
- **P2P exposes your IP** to other peers in the swarm. That is inherent to BitTorrent, not to this
  addon. Use a VPN if that matters, or stay in `debrid` mode.

---

## Free proxy for blocked sources

A TLS-fingerprint block cannot be fixed in the addon — the request has to come from
somewhere else. That normally means a proxy, which normally means something to host.
This is the exception: a Cloudflare Worker, on the free plan, with nothing to run.

**No card, no server, no Prowlarr, no domain.** 100,000 requests a day is the free
allowance, and one stream request is one call.

### Deploy it (about two minutes, no tooling)

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Worker**.
2. Replace the starter code with [`worker/index.mjs`](./worker/index.mjs), then **Deploy**.
3. Note the URL it gives you: `https://<name>.<your-subdomain>.workers.dev`.
4. Open **`<that-url>/__check`** in a browser.

Step 4 is the important one. It makes the Worker test the trackers *from its own
network* and tells you whether the block is actually bypassed:

```json
{
  "ok": true,
  "working": 4,
  "total": 4,
  "results": [
    { "name": "TPB (apibay)", "status": 200, "ok": true, "bytes": 8421 },
    { "name": "BitSearch",    "status": 200, "ok": true },
    { "name": "Knaben",       "status": 200, "ok": true },
    { "name": "YTS",          "status": 200, "ok": true }
  ]
}
```

If `TPB` comes back `200`, the proxy is doing its job. Paste the Worker URL into
**step 2 of `/configure`** as the proxy and every blocked source routes through it.

### Or deploy with the CLI

```bash
cd worker
npx wrangler deploy
```

### It is not an open proxy

An unrestricted fetch endpoint is an SSRF hazard and an abuse magnet, so the target is
checked against an allowlist of tracker hosts — not "any URL". Host matching is
boundary-aware, so `evil-apibay.org` and `apibay.org.evil.com` are both rejected, and
private ranges like `169.254.169.254` never match in the first place.

To add a source, set `ALLOW_HOSTS` in `wrangler.toml` (or the dashboard):

```toml
[vars]
ALLOW_HOSTS = "apibay.org,my-tracker.example"
```

### What it accepts

All three shapes, so any proxy setting works:

| Form | Example |
|---|---|
| `?url=` | `https://<worker>/?url=https%3A%2F%2Fapibay.org%2Fq.php%3Fq%3Ddune` |
| `/f/` | `https://<worker>/f/https%3A%2F%2Fapibay.org%2Fq.php%3Fq%3Ddune` |
| bare | `https://<worker>/https%3A%2F%2Fapibay.org%2Fq.php%3Fq%3Ddune` |

GET and POST are both forwarded — Knaben searches by POST, and a GET-only proxy would
report it healthy while every real search returned nothing. GET responses are cached at
the edge for 5 minutes to stay friendly to the trackers.

### If TPB still fails

You lose almost nothing. Knaben indexes The Pirate Bay and reports it as
`cachedOrigin: "The Pirate Bay"` in its own results, so that catalogue is already
covered by a source that needs no proxy at all.

---

## Project layout

```
api/                 Vercel serverless functions (thin wrappers)
src/
  app.js             route handlers, shared by Vercel and local dev
  config.js          schema, defaults, clamping
  codec.js           URL config encode/decode (+ optional AES-256-GCM)
  orchestrator.js    fan-out, deadline, dedupe, probe
  rank.js            scoring and filtering
  parse.js           release-name intelligence
  format.js          stream cards
  health.js          per-source success telemetry
  debrid/            service adapters (torbox, realdebrid) + registry
  providers/         one file per source
  metadata.js        Cinemeta lookups
  cache.js           LRU + single-flight
  http.js            fetch with timeouts
  trackers.js        P2P tracker list
public/
  index.html         landing page
  configure.html     four-step setup wizard
scripts/
  dev.js             local server
  selftest.js        test suite
worker/
  index.mjs          Cloudflare Worker fetch proxy
  wrangler.toml      Worker config
vercel.json          routing table
```

---

## Licence and disclaimer

MIT. See [LICENSE](LICENSE).

Hydra is an indexer. It does not host, store, upload, or distribute any media. All metadata and
torrent references come from third-party public services, and debrid playback is performed entirely
by your own account. You are responsible for complying with the laws of your jurisdiction and with
the terms of any service you connect.

---

<div align="center">

**Hydra** · Coded with ♥ love by **Yassine Aka DesertBoy**

</div>
