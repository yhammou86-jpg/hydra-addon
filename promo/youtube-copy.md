# Hydra promo — YouTube upload kit

**File:** `promo/hydra-promo.mp4` · 1080×1920 (9:16) · 30fps · 42s · H.264 / yuv420p

---

## Title options

1. I built a free Stremio + Nuvio addon because everything else broke
2. Free addon for Stremio & Nuvio — no account, no paywall (Hydra)
3. Hydra: one addon, both apps, zero cost

## Description

```
Hydra — a free, open-source addon for Stremio and Nuvio.

One install link. Both apps. No account. No subscription.

▶ Install: https://hydrastream.vercel.app
💻 Source: https://github.com/yhammou86-jpg/hydra-addon

Works with TorBox and P2P — your key, your choice.
10 sources, one query. Ranked, filtered, ready.

Built as a thank-you to the community that made my setup better for years.
Coded with love by Yassine Aka DesertBoy.

#stremio #nuvio #stremioaddons #opensource #cordcutting
```

---

## Shot list

| Time | Scene | On screen |
|------|-------|-----------|
| 0:00–0:05 | Hook | "ADDONS KEEP / BREAKING. / OR CHARGING YOU." |
| 0:05–0:09 | Pain | Three error cards: no sources, buffering 99%, paywalled |
| 0:09–0:15 | Logo | Tendril crest draws, HYDRA slams in, "One addon. Many heads." |
| 0:15–0:27 | Features | Stremio + Nuvio · TorBox + P2P · 10 sources · Free forever |
| 0:27–0:34 | Product | Stream list mockup with quality badges and CACHED pills |
| 0:34–0:42 | CTA | HYDRA, hydrastream.vercel.app, Stremio · Nuvio, credit |

---

## Before you upload

- **Audio is silent by design.** Add trending audio in the YouTube app
  (Shorts → edit → Add sound). Shorts with licensed audio get pushed harder
  than uploads with no track.
- **First frame is dark** — if you want a custom thumbnail, use `promo/p012.6.png`
  (the logo frame) rather than a text frame.
- **Vertical only.** If you also want a 16:9 version for a normal upload,
  the layout needs a horizontal variant — ask and it's a quick re-render.

---

## Re-rendering

```bash
cd promo && python render.py
```

Timeline lives in the `SCENES` list at the bottom of `render.py`; each entry is
`(start_seconds, duration, function)`. Preview a single frame without encoding:

```bash
python -c "import render as R; R.render_frame(12.6).save('check.png')"
```
