#!/usr/bin/env python3
"""
Hydra promo renderer — 1080x1920 @ 30fps, ~42s vertical (YouTube Shorts).

Renders frames with Pillow and pipes raw RGB to ffmpeg.
Text is drawn as real type, not AI-generated, so the URL and wordmark stay sharp.
"""
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

# ---------------------------------------------------------------- config
W, H = 1080, 1920
FPS = 30
DUR = 42.0
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "promo", "hydra-promo.mp4")
OUT = os.path.normpath(OUT)

BG      = (11, 9, 8)
CARD    = (21, 17, 14)
SUNKEN  = (15, 12, 10)
GOLD    = (233, 196, 106)
GOLD_HI = (244, 212, 136)
TEXT    = (244, 239, 230)
MUTED   = (155, 145, 135)
DIM     = (107, 99, 91)
GREEN   = (95, 208, 138)
VIOLET  = (139, 92, 246)
RED     = (240, 115, 107)

FONTS = "C:/Windows/Fonts/"
FILES = {"b": "segoeuib.ttf", "r": "segoeui.ttf", "l": "segoeuil.ttf", "m": "consolab.ttf"}
_fc = {}


def F(kind, size):
    key = (kind, size)
    if key not in _fc:
        _fc[key] = ImageFont.truetype(os.path.join(FONTS, FILES[kind]), size)
    return _fc[key]


# ---------------------------------------------------------------- easing
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def seg(t, start, dur):
    """normalized 0..1 progress of a sub-timeline"""
    if dur <= 0:
        return 1.0 if t >= start else 0.0
    return clamp((t - start) / dur)


def eo(x):      # ease out cubic
    return 1 - (1 - x) ** 3


def ei(x):      # ease in cubic
    return x ** 3


def eio(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def back(x, s=1.9):  # overshoot
    x -= 1
    return 1 + (s + 1) * x ** 3 + s * x ** 2


def lerp(a, b, u):
    return a + (b - a) * u


def lerp_col(c1, c2, u):
    return tuple(int(lerp(c1[i], c2[i], u)) for i in range(3))


# ---------------------------------------------------------------- text
def _measure(text, font, tracking):
    d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    if tracking == 0:
        b = d.textbbox((0, 0), text, font=font, anchor="la")
        return b[2] - b[0], b[3] - b[1], b
    w = sum(d.textlength(ch, font=font) for ch in text) + tracking * max(0, len(text) - 1)
    asc, desc = font.getmetrics()
    return w, asc + desc, None


_tcache = {}


def T(text, size, color, kind="b", tracking=0, glow=None, glow_r=22, glow_a=170, pad=90):
    """Render a line of text to a padded RGBA image (cached)."""
    key = (text, size, color, kind, tracking, glow, glow_r, glow_a, pad)
    if key in _tcache:
        return _tcache[key]

    font = F(kind, size)
    w, h, bb = _measure(text, font, tracking)
    img = Image.new("RGBA", (int(w) + pad * 2, int(h) + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if tracking == 0:
        x0 = pad - (bb[0] if bb else 0)
        d.text((x0, pad), text, font=font, fill=color + (255,), anchor="la")
    else:
        x = pad
        for ch in text:
            d.text((x, pad), ch, font=font, fill=color + (255,), anchor="la")
            x += d.textlength(ch, font=font) + tracking

    if glow:
        a = img.getchannel("A").filter(ImageFilter.GaussianBlur(glow_r))
        a = a.point(lambda v: int(v * glow_a / 255))
        g = Image.new("RGBA", img.size, glow + (0,))
        g.putalpha(a)
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        out.paste(g, (0, 0), g)
        out.paste(img, (0, 0), img)
        img = out

    _tcache[key] = img
    return img


def put(base, layer, cx, cy, scale=1.0, alpha=1.0, rot=0.0):
    if alpha <= 0.003:
        return
    im = layer
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, expand=False)
    if abs(scale - 1.0) > 0.002:
        nw, nh = max(1, int(im.width * scale)), max(1, int(im.height * scale))
        im = im.resize((nw, nh), Image.LANCZOS)
    if alpha < 0.997:
        im = im.copy()
        im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
    base.paste(im, (int(cx - im.width / 2), int(cy - im.height / 2)), im)


# ---------------------------------------------------------------- background
def make_bg():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.zeros((H, W, 3), np.float32)
    base[:] = BG
    glows = [
        (W * 0.50, H * 0.20, H * 0.62, GOLD, 0.115),
        (W * 0.10, H * 0.88, H * 0.55, VIOLET, 0.075),
        (W * 0.92, H * 0.62, H * 0.45, GOLD, 0.045),
    ]
    for cx, cy, r, col, amt in glows:
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
        f = np.clip(1 - d, 0, 1) ** 2.3 * amt
        base += f[..., None] * np.array(col, np.float32)

    dv = np.sqrt(((xx - W / 2) / (W * 0.80)) ** 2 + ((yy - H / 2) / (H * 0.80)) ** 2)
    base *= np.clip(1 - 0.60 * np.clip(dv - 0.30, 0, None) ** 1.5, 0, 1)[..., None]
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert("RGB")


BG_IMG = make_bg()

# grain
_rng = np.random.default_rng(7)
GRAIN = []
for _ in range(8):
    n = _rng.integers(0, 60, (H // 3, W // 3), dtype=np.uint8)
    g = Image.fromarray(n, "L").resize((W, H), Image.BILINEAR)
    layer = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    layer.putalpha(g.point(lambda v: int(v * 0.10)))
    GRAIN.append(layer)


# ---------------------------------------------------------------- shapes
def rr(d, box, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def pill(w, h, color, label, fsize, tcolor, tracking=2, alpha=255):
    img = Image.new("RGBA", (w + 60, h + 60), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rr(d, (30, 30, 30 + w, 30 + h), h // 2, fill=color + (alpha,))
    t = T(label, fsize, tcolor, "m", tracking, pad=40)
    img.paste(t, (int((img.width - t.width) / 2), int((img.height - t.height) / 2)), t)
    return img


def icon_badge(size, color, kind):
    """simple geometric icons: play / shield / bolt / infinity"""
    img = Image.new("RGBA", (size + 40, size + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2 + 20
    r = size / 2
    d.ellipse((c - r, c - r, c + r, c + r), outline=color + (90,), width=2)
    g = size * 0.36
    if kind == "play":
        d.polygon([(c - g * 0.55, c - g), (c - g * 0.55, c + g), (c + g * 0.85, c)], fill=color + (255,))
    elif kind == "shield":
        d.polygon([(c, c - g), (c + g * 0.85, c - g * 0.5), (c + g * 0.85, c + g * 0.25),
                   (c, c + g), (c - g * 0.85, c + g * 0.25), (c - g * 0.85, c - g * 0.5)], fill=color + (255,))
    elif kind == "bolt":
        d.polygon([(c + g * 0.25, c - g), (c - g * 0.6, c + g * 0.12),
                   (c - g * 0.02, c + g * 0.12), (c - g * 0.25, c + g),
                   (c + g * 0.62, c - g * 0.18), (c + g * 0.04, c - g * 0.18)], fill=color + (255,))
    elif kind == "inf":
        for dx in (-g * 0.42, g * 0.42):
            d.ellipse((c + dx - g * 0.5, c - g * 0.5, c + dx + g * 0.5, c + g * 0.5), outline=color + (255,), width=4)
    return img


# ---------------------------------------------------------------- scenes
def scene_hook(lt):
    img = BG_IMG.copy()
    p = seg(lt, 0.35, 0.55)
    if p > 0:
        a = eo(p)
        put(img, T("ADDONS KEEP", 86, MUTED, "b", 10), W / 2, 800 - (1 - a) * 30, alpha=a)

    p = seg(lt, 1.05, 0.5)
    if p > 0:
        a = eo(p)
        s = lerp(1.22, 1.0, back(p, 2.4))
        put(img, T("BREAKING.", 150, GOLD, "b", 3, glow=GOLD, glow_r=34, glow_a=120), W / 2, 950, s, a)

    p = seg(lt, 2.15, 0.6)
    if p > 0:
        a = eo(p)
        put(img, T("OR CHARGING YOU.", 64, TEXT, "b", 8), W / 2, 1110 - (1 - a) * 26, alpha=a)

    p = seg(lt, 3.75, 0.55)
    if p > 0:
        a = eo(p)
        put(img, T("EVERY. SINGLE. TIME.", 40, DIM, "m", 8), W / 2, 1230, alpha=a * 0.9)

    # exit push + flash
    if lt > 4.55:
        f = seg(lt, 4.55, 0.45)
        put(img, T("BREAKING.", 150, GOLD, "b", 3), W / 2, 950, lerp(1.0, 1.08, f), 1 - f)
        put(img, T("OR CHARGING YOU.", 64, TEXT, "b", 8), W / 2, 1110, lerp(1.0, 1.08, f), 1 - f)
        put(img, T("ADDONS KEEP", 86, MUTED, "b", 10), W / 2, 800, lerp(1.0, 1.08, f), 1 - f)
    return img


def scene_pain(lt):
    img = BG_IMG.copy()
    put(img, T("EVERY. SINGLE. TIME.", 38, DIM, "m", 8), W / 2, 620, alpha=eo(seg(lt, 0.15, 0.4)) * 0.9)

    items = [
        (0.55, "NO SOURCES FOUND", "0 results after 30s"),
        (1.55, "BUFFERING… 99%", "forever. always 99%."),
        (2.55, "PAYWALLED", "premium required"),
    ]
    for i, (st, label, sub) in enumerate(items):
        p = seg(lt, st, 0.42)
        if p <= 0:
            continue
        a = eo(p)
        dy = (1 - a) * 34
        y = 750 + i * 200 + dy

        card = Image.new("RGBA", (860, 176), (0, 0, 0, 0))
        d = ImageDraw.Draw(card)
        rr(d, (0, 0, 859, 175), 26, fill=CARD + (235,), outline=RED + (60,), width=2)
        rr(d, (0, 26, 8, 149), 4, fill=RED + (230,))
        # x mark
        cx, cy = 74, 88
        d.line((cx - 16, cy - 16, cx + 16, cy + 16), fill=RED + (235,), width=6)
        d.line((cx + 16, cy - 16, cx - 16, cy + 16), fill=RED + (235,), width=6)
        t = T(label, 46, TEXT, "b", 2, pad=40)
        card.paste(t, (120, int(66 - t.height / 2)), t)
        s = T(sub, 30, MUTED, "m", 1, pad=40)
        card.paste(s, (120, int(132 - s.height / 2)), s)
        put(img, card, W / 2, y, alpha=a)

    # shake near the end
    if lt > 3.6:
        f = seg(lt, 3.6, 0.5)
        put(img, T("SOUND FAMILIAR?", 54, GOLD, "b", 6, glow=GOLD, glow_r=26, glow_a=110), W / 2, 1420,
            lerp(1.15, 1.0, back(f, 2.2)), eo(f))
    return img


def scene_logo(lt):
    img = BG_IMG.copy()
    cx, cy = W / 2, 700

    # pulse ring
    p = seg(lt, 0.0, 0.9)
    if p > 0:
        r = lerp(30, 340, eo(p))
        a = (1 - p) * 0.5
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(ov).ellipse((cx - r, cy - r, cx + r, cy + r), outline=GOLD + (int(200 * a),), width=3)
        img.paste(ov, (0, 0), ov)

    # emblem: a crest of rising tendrils ("many heads")
    p = seg(lt, 0.15, 1.5)
    if p > 0:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        bx, by = cx, cy + 150
        n = 7
        for i in range(n):
            u = (i / (n - 1)) - 0.5
            ang = -math.pi / 2 + u * math.radians(152)
            R = 285 * (1 - 0.30 * abs(u) * 2)
            side = 1 if u > 0 else -1 if u < 0 else 0
            # spread the roots along a shallow arc so they don't knot
            p0 = (bx + math.cos(ang) * 24, by + math.sin(ang) * 6)
            tip = (bx + math.cos(ang) * R, by + math.sin(ang) * R)
            c1 = (p0[0] + math.cos(ang) * R * 0.10 + side * 30, p0[1] - R * 0.46)
            c2 = (tip[0] - math.cos(ang) * R * 0.06 - side * 26, tip[1] + R * 0.30)

            prog = clamp((p - abs(u) * 0.26) * 1.45)
            if prog <= 0:
                continue
            steps = 40
            k = max(2, int(prog * steps))
            pts = []
            for s_ in range(k + 1):
                tt = s_ / steps
                mt = 1 - tt
                px = mt ** 3 * p0[0] + 3 * mt ** 2 * tt * c1[0] + 3 * mt * tt ** 2 * c2[0] + tt ** 3 * tip[0]
                py = mt ** 3 * p0[1] + 3 * mt ** 2 * tt * c1[1] + 3 * mt * tt ** 2 * c2[1] + tt ** 3 * tip[1]
                pts.append((px, py))
            for s_ in range(len(pts) - 1):
                w_ = max(2, int(round(5 - 3 * (s_ / steps))))
                d.line([pts[s_], pts[s_ + 1]], fill=GOLD + (210,), width=w_)
            if prog >= 0.985:
                hx, hy = pts[-1]
                d.ellipse((hx - 8, hy - 8, hx + 8, hy + 8), fill=GOLD_HI + (255,))
        # base node
        d.ellipse((bx - 10, by - 7, bx + 10, by + 11), fill=GOLD + (int(255 * clamp(p * 2.2)),))
        gl = ov.filter(ImageFilter.GaussianBlur(13))
        img.paste(gl, (0, 0), gl)
        img.paste(ov, (0, 0), ov)

    # wordmark
    p = seg(lt, 1.55, 0.55)
    if p > 0:
        a = eo(p)
        s = lerp(1.35, 1.0, back(p, 2.6))
        put(img, T("HYDRA", 196, GOLD, "b", 16, glow=GOLD, glow_r=48, glow_a=150), W / 2, 1010, s, a)

    p = seg(lt, 2.15, 0.6)
    if p > 0:
        a = eo(p)
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        wdt = 300 * a
        ImageDraw.Draw(ov).line((W / 2 - wdt, 1122, W / 2 + wdt, 1122), fill=GOLD + (110,), width=2)
        img.paste(ov, (0, 0), ov)

    p = seg(lt, 2.5, 0.7)
    if p > 0:
        put(img, T("ONE ADDON. MANY HEADS.", 38, MUTED, "m", 6), W / 2, 1190, alpha=eo(p))

    # flash on slam
    if 1.55 < lt < 1.78:
        f = seg(lt, 1.55, 0.23)
        fl = Image.new("RGBA", (W, H), GOLD + (int(70 * (1 - f)),))
        img.paste(fl, (0, 0), fl)
    return img


FEATS = [
    ("play",   "STREMIO + NUVIO",     "one install link. both apps."),
    ("shield", "TORBOX + P2P",        "your key, your choice."),
    ("bolt",   "10 SOURCES, ONE HIT", "more heads, more links."),
    ("inf",    "FREE FOREVER",        "no account. no paywall."),
]


_FEAT_LEFT = None


def feats_left():
    """Left edge of the widest feature row, so every row shares one baseline."""
    global _FEAT_LEFT
    if _FEAT_LEFT is None:
        mx = 0
        for _, ti_, si_ in FEATS:
            mx = max(mx,
                     T(ti_, 58, GOLD_HI, "b", 3).width - 180,
                     T(si_, 31, MUTED, "m", 1).width - 180)
        _FEAT_LEFT = (W - (82 + 46 + mx)) / 2
    return _FEAT_LEFT


def scene_feats(lt):
    img = BG_IMG.copy()
    put(img, T("WHAT YOU GET", 34, DIM, "m", 10), W / 2, 470, alpha=eo(seg(lt, 0.1, 0.4)))

    ys = [620, 810, 1000, 1190]
    for i, (ic, title, sub) in enumerate(FEATS):
        st = 0.45 + i * 2.35
        p = seg(lt, st, 0.5)
        if p <= 0:
            continue
        a = eo(p)
        # dim older rows once a newer one lands (the last one stays lit)
        nxt = seg(lt, st + 2.35, 0.4) if i < len(FEATS) - 1 else 0.0
        act = 1.0 if nxt <= 0 else lerp(1.0, 0.46, eo(nxt))
        y = ys[i] + (1 - a) * 40

        col = GOLD if act > 0.6 else DIM
        ti = T(title, 58, GOLD_HI if act > 0.6 else MUTED, "b", 3)
        si = T(sub, 31, MUTED if act > 0.6 else DIM, "m", 1)
        tw, sw = ti.width - 180, si.width - 180
        left = feats_left()
        icon_cx = left + 41
        text_cx = left + 82 + 46

        badge = icon_badge(82, col, ic)
        put(img, badge, icon_cx, y, alpha=a * act)
        put(img, ti, text_cx + tw / 2, y - 36, alpha=a * act)
        put(img, si, text_cx + sw / 2, y + 40, alpha=a * act * 0.95)

    p = seg(lt, 10.0, 0.6)
    if p > 0:
        put(img, T("ONE LINK. DONE.", 44, GOLD, "b", 6, glow=GOLD, glow_r=24, glow_a=90), W / 2, 1420,
            lerp(1.1, 1.0, back(p, 2.0)), eo(p))
    return img


ROWS = [
    ("4K",    "2160p · BluRay · 12.4 GB", True),
    ("4K",    "2160p · WEB-DL · 9.1 GB",  True),
    ("1080p", "1080p · BluRay · 4.2 GB",  True),
    ("720p",  "720p · HDTV · 1.1 GB",     False),
]


def scene_ui(lt):
    img = BG_IMG.copy()
    put(img, T("WHAT IT LOOKS LIKE", 34, DIM, "m", 8), W / 2, 466, alpha=eo(seg(lt, 0.05, 0.4)))

    p = seg(lt, 0.2, 0.6)
    if p <= 0:
        return img
    a = eo(p)
    dy = (1 - a) * 60

    PW, PH = 880, 900
    panel = Image.new("RGBA", (PW, PH), (0, 0, 0, 0))
    d = ImageDraw.Draw(panel)
    rr(d, (0, 0, PW - 1, PH - 1), 34, fill=(18, 15, 13, 246), outline=(233, 196, 106, 45), width=2)

    # poster placeholder with a drawn play glyph
    rr(d, (34, 34, 34 + 96, 34 + 138), 14, fill=(31, 26, 22, 255), outline=(233, 196, 106, 40), width=1)
    pcx, pcy = 34 + 48, 34 + 69
    d.polygon([(pcx - 13, pcy - 19), (pcx - 13, pcy + 19), (pcx + 19, pcy)], fill=GOLD + (210,))

    ti = T("Interstellar", 46, TEXT, "b", 0, pad=40)
    panel.paste(ti, (152, 52), ti)
    mi = T("2014 · 2h 49m · Sci-Fi", 29, DIM, "m", 0, pad=40)
    panel.paste(mi, (152, 116), mi)

    y = 210
    for i, (q, meta, cached) in enumerate(ROWS):
        rp = seg(lt, 0.75 + i * 0.38, 0.45)
        if rp <= 0:
            continue
        ra = eo(rp)
        row = Image.new("RGBA", (812, 112), (0, 0, 0, 0))
        rd = ImageDraw.Draw(row)
        rr(rd, (0, 0, 811, 111), 20, fill=(27, 22, 19, 255), outline=(255, 255, 255, 14), width=1)
        bw = 88 if len(q) <= 2 else 126
        rr(rd, (18, 28, 18 + bw, 84), 12, fill=(233, 196, 106, 30))
        t = T(q, 33, GOLD, "b", 1, pad=30)
        row.paste(t, (18 + int(bw / 2 - t.width / 2 + 30), int(56 - t.height / 2)), t)

        m = T(meta, 29, TEXT, "r", 0, pad=40)
        row.paste(m, (18 + bw + 24, int(56 - m.height / 2)), m)

        if cached:
            pl = pill(126, 42, (95, 208, 138), "CACHED", 22, GREEN, 1, alpha=34)
            row.paste(pl, (int(811 - pl.width + 26), int(56 - pl.height / 2)), pl)
        else:
            rd.polygon([(770, 44), (770, 68), (788, 56)], fill=MUTED + (220,))
        put(panel, row, 440, y + 56 - (1 - ra) * 20, alpha=ra)
        y += 124

    bp = seg(lt, 2.9, 0.5)
    if bp > 0:
        ba = eo(bp)
        btn = Image.new("RGBA", (812, 96), (0, 0, 0, 0))
        bd = ImageDraw.Draw(btn)
        rr(bd, (0, 0, 811, 95), 22, fill=GOLD + (255,))
        lbl = T("PLAY  4K", 38, (25, 20, 14), "b", 5, pad=30)
        tw = lbl.width - 60
        gx = (812 - (26 + 16 + tw)) / 2
        bd.polygon([(gx, 32), (gx, 64), (gx + 26, 48)], fill=(25, 20, 14, 255))
        btn.paste(lbl, (int(gx + 26 + 16 - 30), int(48 - lbl.height / 2)), lbl)
        put(panel, btn, 440, 790, alpha=ba)

    put(img, panel, W / 2, 540 + PH / 2 + dy, alpha=a)

    p = seg(lt, 3.5, 0.5)
    if p > 0:
        put(img, T("ranked. filtered. ready.", 32, MUTED, "m", 2), W / 2, 1545, alpha=eo(p))
    return img


def scene_cta(lt):
    img = BG_IMG.copy()
    p = seg(lt, 0.15, 0.5)
    if p > 0:
        put(img, T("FREE. OPEN SOURCE.", 38, MUTED, "m", 8), W / 2, 690, alpha=eo(p))

    p = seg(lt, 0.55, 0.55)
    if p > 0:
        a = eo(p)
        s = lerp(1.12, 1.0, back(p, 2.2))
        put(img, T("HYDRA", 168, GOLD, "b", 14, glow=GOLD, glow_r=44, glow_a=140), W / 2, 830, s, a)

    p = seg(lt, 1.25, 0.55)
    if p > 0:
        a = eo(p)
        u = T("hydra-addon.vercel.app", 64, TEXT, "m", 0)
        sc = min(1.0, 920 / u.width)
        put(img, u, W / 2, 1033, sc, a)

    p = seg(lt, 1.55, 0.7)
    if p > 0:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        wdt = 430 * eo(p)
        ImageDraw.Draw(ov).line((W / 2 - wdt, 1096, W / 2 + wdt, 1096), fill=GOLD + (120,), width=2)
        img.paste(ov, (0, 0), ov)

    p = seg(lt, 2.1, 0.5)
    if p > 0:
        put(img, T("STREMIO   ·   NUVIO", 42, GOLD_HI, "b", 6), W / 2, 1180, alpha=eo(p))

    p = seg(lt, 2.9, 0.6)
    if p > 0:
        a = eo(p)
        put(img, T("Coded with love by Yassine Aka DesertBoy", 31, MUTED, "r", 0), W / 2, 1320, alpha=a)
        put(img, T("github.com/yhammou86-jpg/StreamMaster", 26, DIM, "m", 0), W / 2, 1370, alpha=a * 0.95)

    # end fade
    if lt > 5.9:
        f = seg(lt, 5.9, 1.1)
        blk = Image.new("RGBA", (W, H), (0, 0, 0, int(255 * f)))
        img.paste(blk, (0, 0), blk)
    return img


SCENES = [
    (0.0, 5.0, scene_hook),
    (5.0, 4.5, scene_pain),
    (9.5, 6.0, scene_logo),
    (15.5, 12.0, scene_feats),
    (27.5, 7.0, scene_ui),
    (34.5, 7.5, scene_cta),
]


def render_frame(t):
    for start, dur, fn in SCENES:
        if start <= t < start + dur:
            img = fn(t - start)
            break
    else:
        img = BG_IMG.copy()

    # grain + subtle vignette flicker
    img.paste(GRAIN[int(t * FPS) % len(GRAIN)], (0, 0), GRAIN[int(t * FPS) % len(GRAIN)])

    # camera shake on the two slams
    for ts, amp in ((1.05, 7), (11.05, 9)):
        if 0 <= t - ts < 0.32:
            k = (1 - (t - ts) / 0.32)
            dx = int(math.sin((t - ts) * 90) * amp * k)
            dy = int(math.cos((t - ts) * 77) * amp * k * 0.7)
            img = ImageChops.offset(img, dx, dy)

    return img


def main():
    ff = None
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ff = "ffmpeg"

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    total = int(DUR * FPS)
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", OUT]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    for i in range(total):
        img = render_frame(i / FPS)
        proc.stdin.write(img.tobytes())
        if i % 90 == 0:
            print(f"  {i}/{total} frames ({i/total*100:.0f}%)", flush=True)

    proc.stdin.close()
    proc.wait()
    print(f"done -> {OUT}  ({os.path.getsize(OUT)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
