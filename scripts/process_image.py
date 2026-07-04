#!/usr/bin/env python3
"""Compose the derived image variants for one artwork.

Wallpaper (1640x2360): the painting matted on a dark museum-wall background,
full-bleed to the screen width, with a soft drop shadow and a small serif
caption stamped in the bottom-left corner (clear of iOS notifications, which
stack center-bottom). The full painting is always visible -- no cropping --
so landscape works survive the portrait lock screen intact. Assumes the
lock-screen clock is user-positioned away from the art.

iPad wallpaper (2420x2420 square): iPads rotate, and iPadOS center-crops a
single wallpaper for both orientations -- portrait shows the middle column,
landscape the middle band. The painting and caption are composed inside the
central square that survives BOTH crops, so nothing is cut off no matter how
the iPad is held.

The matte, gradient, and shadow are composed in float32 and dithered with
+/-1-level triangular noise before quantizing: an 8-bit dark gradient bands
visibly on a good panel, and JPEG then blockifies the near-flat steps.
Wallpapers save at quality 95 / 4:4:4 to preserve the dither.

Display (<=1600px long edge): plain resize for the PWA.

Icon mode (--icon): square center-crop PNGs for the web app manifest.
"""

import argparse
import os
import sys
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None  # museum scans can exceed Pillow's bomb limit

W, H = 1640, 2360               # portrait lock screen (phone / pinned iPad)
ART_MAX_W = W                   # full bleed: art may touch the side edges
ART_MAX_H = 2000
ART_CENTER_Y = 1080
CAPTION_X = 72                  # bottom-left corner stamp
CAPTION_TITLE_Y = H - 176
CAPTION_META_Y = H - 118

# Square iPad canvas: 11" iPad Pro panel is 2420x1668, so a 2420 square is
# pixel-exact in portrait (no iPadOS upscale softening the caption). Portrait
# crop shows the central 1668-wide column; landscape the central 1668-tall
# band, i.e. rows/cols 376..2044. Art and caption both live inside that
# central 1668x1668 intersection so neither orientation cuts anything off.
SQ = 2420
SQ_VIS_LO = (SQ - 1668) // 2    # 376: first row/col visible in both crops
SQ_VIS_HI = SQ - SQ_VIS_LO      # 2044
SQ_ART_MAX_W = 1560
SQ_ART_MAX_H = 1340
SQ_ART_CENTER_Y = 1150
SQ_CAPTION_X = SQ_VIS_LO + 64
SQ_CAPTION_TITLE_Y = SQ_VIS_HI - 160
SQ_CAPTION_META_Y = SQ_VIS_HI - 106

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Baskerville.ttc",
    "/System/Library/Fonts/Times.ttc",
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def fitted_font(draw, text, size, max_w):
    while size > 18:
        font = load_font(size)
        if draw.textlength(text, font=font) <= max_w:
            return font
        size -= 2
    return load_font(size)


def wall_color(img):
    """A very dark neutral tinted toward the painting's average color."""
    r, g, b = img.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    m = max(r, g, b, 1)
    k = 34 / m
    return tuple(min(255, int(c * k)) for c in (r, g, b))


def compose(img, title, artist, year, out_path,
            cw, ch, art_max_w, art_max_h, art_center_y,
            caption_x, caption_title_y, caption_meta_y, caption_max_w):
    bg = wall_color(img)

    scale = min(art_max_w / img.width, art_max_h / img.height)
    pw, ph = round(img.width * scale), round(img.height * scale)
    x, y = cw // 2 - pw // 2, art_center_y - ph // 2

    # Matte + gallery-light gradient + shadow, all in float32 so the dark
    # gradient isn't quantized until after dithering.
    grad = 16.0 * (1.0 - np.arange(ch, dtype=np.float32) / ch) ** 2 / 255.0
    base = np.empty((ch, cw, 3), np.float32)
    for c in range(3):
        base[:, :, c] = (bg[c] + (255.0 - bg[c]) * grad)[:, None]

    shadow = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(shadow).rectangle([x, y + 20, x + pw, y + ph + 20], fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))
    base *= 1.0 - np.asarray(shadow, np.float32)[..., None] / 255.0

    rng = np.random.default_rng(zlib.crc32(os.path.basename(out_path).encode()))
    base += rng.triangular(-1.0, 0.0, 1.0, base.shape).astype(np.float32)
    canvas = Image.fromarray(np.clip(np.rint(base), 0, 255).astype(np.uint8))

    art = img.resize((pw, ph), Image.LANCZOS)
    canvas.paste(art, (x, y))
    hairline = tuple(min(255, c + 72) for c in bg)
    ImageDraw.Draw(canvas).rectangle([x - 1, y - 1, x + pw, y + ph], outline=hairline)

    # Caption: small corner stamp, left-aligned, out of the notification zone.
    draw = ImageDraw.Draw(canvas)
    title_font = fitted_font(draw, title, 42, caption_max_w)
    meta_line = f"{artist}  ·  {year}"
    meta_font = fitted_font(draw, meta_line, 31, caption_max_w)
    draw.text((caption_x, caption_title_y), title,
              font=title_font, fill=(230, 226, 216), anchor="lm")
    draw.text((caption_x, caption_meta_y), meta_line,
              font=meta_font, fill=(158, 154, 144), anchor="lm")

    # subsampling=0 (4:4:4): default 4:2:0 chroma smears light serif text
    # against the dark matte. quality=95 keeps the dither noise that masks
    # gradient banding — lower quality flattens it back into bands.
    canvas.save(out_path, "JPEG", quality=95, optimize=True, subsampling=0)


def make_wallpaper(img, title, artist, year, out_path):
    compose(img, title, artist, year, out_path,
            W, H, ART_MAX_W, ART_MAX_H, ART_CENTER_Y,
            CAPTION_X, CAPTION_TITLE_Y, CAPTION_META_Y,
            caption_max_w=W - 2 * CAPTION_X)


def make_wallpaper_ipad(img, title, artist, year, out_path):
    compose(img, title, artist, year, out_path,
            SQ, SQ, SQ_ART_MAX_W, SQ_ART_MAX_H, SQ_ART_CENTER_Y,
            SQ_CAPTION_X, SQ_CAPTION_TITLE_Y, SQ_CAPTION_META_Y,
            caption_max_w=SQ_VIS_HI - SQ_CAPTION_X - 40)


def make_display(img, out_path, long_edge=1600):
    scale = min(1.0, long_edge / max(img.width, img.height))
    out = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    out.save(out_path, "JPEG", quality=84, optimize=True)


def make_zoom(img, out_path, long_edge=2600):
    """Highest-resolution variant we serve — for the PWA's fullscreen viewer.
    Only ever downscales, so it's capped by what the museum gave us."""
    scale = min(1.0, long_edge / max(img.width, img.height))
    out = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    out.save(out_path, "JPEG", quality=86, optimize=True)


def make_home(img, out_path, w, h):
    """Home-screen variant: the painting aspect-filled edge to edge, no matte
    or caption. iOS blurs/darkens behind icons anyway; a full-bleed crop
    reads far better there than a blurred matte composition."""
    scale = max(w / img.width, h / img.height)
    fw, fh = round(img.width * scale), round(img.height * scale)
    out = img.resize((fw, fh), Image.LANCZOS)
    left, top = (fw - w) // 2, (fh - h) // 2
    out = out.crop((left, top, left + w, top + h))
    out.save(out_path, "JPEG", quality=88, optimize=True)


def make_icons(img, site_dir):
    side = min(img.width, img.height)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    square = img.crop((left, top, left + side, top + side))
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
        square.resize((size, size), Image.LANCZOS).save(
            os.path.join(site_dir, "icons", name), "PNG"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("site_dir")
    ap.add_argument("slug")
    ap.add_argument("--title", default="")
    ap.add_argument("--artist", default="")
    ap.add_argument("--year", default="")
    ap.add_argument("--icon", action="store_true")
    args = ap.parse_args()

    img = Image.open(args.input).convert("RGB")

    if args.icon:
        make_icons(img, args.site_dir)
        return

    make_wallpaper(img, args.title, args.artist, args.year,
                   os.path.join(args.site_dir, "images", "wall", f"{args.slug}.jpg"))
    make_wallpaper_ipad(img, args.title, args.artist, args.year,
                        os.path.join(args.site_dir, "images", "wall-ipad", f"{args.slug}.jpg"))
    make_home(img, os.path.join(args.site_dir, "images", "home", f"{args.slug}.jpg"), W, H)
    make_home(img, os.path.join(args.site_dir, "images", "home-ipad", f"{args.slug}.jpg"), SQ, SQ)
    make_zoom(img, os.path.join(args.site_dir, "images", "zoom", f"{args.slug}.jpg"))
    make_display(img, os.path.join(args.site_dir, "images", "display", f"{args.slug}.jpg"))


if __name__ == "__main__":
    sys.exit(main())
