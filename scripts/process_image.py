#!/usr/bin/env python3
"""Compose the derived image variants for one artwork.

Wallpaper (1640x2360): the painting matted on a dark museum-wall background,
positioned below the iOS lock-screen clock zone, with a soft drop shadow,
hairline frame, and a small serif caption underneath. The full painting is
always visible -- no cropping -- so landscape works survive the portrait
lock screen intact.

iPad wallpaper (2388x2388 square): iPads rotate, and iPadOS center-crops a
single wallpaper for both orientations -- portrait shows the middle column,
landscape the middle band. The painting and caption are composed inside the
central region that survives BOTH crops (and sits below the clock zone of
either orientation), so nothing is cut off no matter how the iPad is held.

Display (<=1600px long edge): plain resize for the PWA.

Icon mode (--icon): square center-crop PNGs for the web app manifest.
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None  # museum scans can exceed Pillow's bomb limit

W, H = 1640, 2360               # portrait lock screen (phone / pinned iPad)
ART_MAX_W = int(W * 0.865)      # 1418
ART_MAX_H = int(H * 0.68)       # 1604
ART_CENTER_Y = int(H * 0.560)   # painting sits below the clock zone

# Square iPad canvas: 11" iPad Pro panel is 2420x1668, so a 2420 square is
# pixel-exact in portrait (no iPadOS upscale softening the caption). Portrait
# crop shows the central 1668-wide column; landscape shows the central
# 1668-tall band with the clock over its top ~340px. The art box keeps
# painting + caption inside the intersection of both visible regions.
SQ = 2420
SQ_ART_MAX_W = 1500             # within the 1668 portrait column, with margin
SQ_ART_MAX_H = 1060             # landscape band minus clock zone and caption
SQ_ART_CENTER_Y = 1330

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
            cw, ch, art_max_w, art_max_h, art_center_y, caption_max_w):
    bg = wall_color(img)
    canvas = Image.new("RGB", (cw, ch), bg)

    # Gentle top-lit gradient, like gallery lighting.
    mask = Image.new("L", (1, ch))
    mask.putdata([int(16 * (1 - y / ch) ** 2) for y in range(ch)])
    white = Image.new("RGB", (cw, ch), (255, 255, 255))
    canvas = Image.composite(white, canvas, mask.resize((cw, ch)))

    scale = min(art_max_w / img.width, art_max_h / img.height)
    pw, ph = round(img.width * scale), round(img.height * scale)
    art = img.resize((pw, ph), Image.LANCZOS)
    x, y = cw // 2 - pw // 2, art_center_y - ph // 2

    shadow = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([x, y + 20, x + pw, y + ph + 20], fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    canvas.paste(art, (x, y))
    hairline = tuple(min(255, c + 72) for c in bg)
    ImageDraw.Draw(canvas).rectangle([x - 1, y - 1, x + pw, y + ph], outline=hairline)

    draw = ImageDraw.Draw(canvas)
    title_font = fitted_font(draw, title, 46, caption_max_w)
    meta_line = f"{artist}  ·  {year}"
    meta_font = fitted_font(draw, meta_line, 33, caption_max_w)
    ty = y + ph + 68
    draw.text((cw / 2, ty), title, font=title_font, fill=(228, 224, 214), anchor="mm")
    draw.text((cw / 2, ty + 58), meta_line, font=meta_font, fill=(158, 154, 144), anchor="mm")

    # subsampling=0 (4:4:4): default 4:2:0 chroma smears light serif text
    # against the dark matte — the single biggest caption-sharpness win.
    canvas.save(out_path, "JPEG", quality=92, optimize=True, subsampling=0)


def make_wallpaper(img, title, artist, year, out_path):
    compose(img, title, artist, year, out_path,
            W, H, ART_MAX_W, ART_MAX_H, ART_CENTER_Y, caption_max_w=W - 220)


def make_wallpaper_ipad(img, title, artist, year, out_path):
    # Caption must also survive the portrait crop's central column (1668 wide).
    compose(img, title, artist, year, out_path,
            SQ, SQ, SQ_ART_MAX_W, SQ_ART_MAX_H, SQ_ART_CENTER_Y, caption_max_w=1500)


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
