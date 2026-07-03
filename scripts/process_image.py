#!/usr/bin/env python3
"""Compose the derived image variants for one artwork.

Wallpaper (1640x2360): the painting matted on a dark museum-wall background,
positioned below the iOS lock-screen clock zone, with a soft drop shadow,
hairline frame, and a small serif caption underneath. The full painting is
always visible -- no cropping -- so landscape works survive the portrait
lock screen intact.

Display (<=1600px long edge): plain resize for the PWA.

Icon mode (--icon): square center-crop PNGs for the web app manifest.
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None  # museum scans can exceed Pillow's bomb limit

W, H = 1640, 2360               # iPad portrait lock screen
ART_MAX_W = int(W * 0.865)      # 1418
ART_MAX_H = int(H * 0.68)       # 1604
ART_CENTER_Y = int(H * 0.560)   # painting sits below the clock zone

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


def make_wallpaper(img, title, artist, year, out_path):
    bg = wall_color(img)
    canvas = Image.new("RGB", (W, H), bg)

    # Gentle top-lit gradient, like gallery lighting.
    mask = Image.new("L", (1, H))
    mask.putdata([int(16 * (1 - y / H) ** 2) for y in range(H)])
    white = Image.new("RGB", (W, H), (255, 255, 255))
    canvas = Image.composite(white, canvas, mask.resize((W, H)))

    scale = min(ART_MAX_W / img.width, ART_MAX_H / img.height)
    pw, ph = round(img.width * scale), round(img.height * scale)
    art = img.resize((pw, ph), Image.LANCZOS)
    x, y = W // 2 - pw // 2, ART_CENTER_Y - ph // 2

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([x, y + 20, x + pw, y + ph + 20], fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    canvas.paste(art, (x, y))
    hairline = tuple(min(255, c + 72) for c in bg)
    ImageDraw.Draw(canvas).rectangle([x - 1, y - 1, x + pw, y + ph], outline=hairline)

    draw = ImageDraw.Draw(canvas)
    title_font = fitted_font(draw, title, 42, W - 220)
    meta_line = f"{artist}  ·  {year}"
    meta_font = fitted_font(draw, meta_line, 30, W - 220)
    ty = y + ph + 66
    draw.text((W / 2, ty), title, font=title_font, fill=(226, 222, 212), anchor="mm")
    draw.text((W / 2, ty + 54), meta_line, font=meta_font, fill=(156, 152, 142), anchor="mm")

    canvas.save(out_path, "JPEG", quality=86, optimize=True)


def make_display(img, out_path, long_edge=1600):
    scale = min(1.0, long_edge / max(img.width, img.height))
    out = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    out.save(out_path, "JPEG", quality=84, optimize=True)


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
    make_display(img, os.path.join(args.site_dir, "images", "display", f"{args.slug}.jpg"))


if __name__ == "__main__":
    sys.exit(main())
