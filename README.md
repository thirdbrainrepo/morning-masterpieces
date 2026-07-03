# Morning Masterpieces

A daily art history lesson. Every day, one public-domain masterpiece — van Eyck
(1434) through Kandinsky (1913), in chronological order, looping — appears as
your iPad/iPhone lock screen via an iOS Shortcut, with a companion PWA that
shows the day's painting alongside a written lesson.

## How it works

```
data/seeds/*.mjs          50 curated works: sources + hand-written lessons
        │
        ▼  node scripts/build.mjs
.cache/originals/         one-time downloads (Met / AIC / Wikimedia Commons)
        │
        ▼  scripts/process_image.py (Pillow)
site/images/wall/         1640×2360 portrait lock wallpapers, captioned (iPhone)
site/images/wall-ipad/    2420×2420 square lock wallpapers, safe in both iPad orientations
site/images/home*/        full-bleed home-screen crops (no matte/caption)
site/images/zoom/         ≤2600px for the PWA's fullscreen viewer
site/images/display/      ≤1600px inline images for the PWA
site/artworks.json        the manifest, in rotation order
        │
        ▼  node scripts/today.mjs        (GitHub Actions, daily 00:10 Pacific)
site/today.json                    today's metadata at a stable URL
site/today/wallpaper[-ipad].jpg    today's lock wallpaper   ← Shortcut
site/today/home[-ipad].jpg         today's home wallpaper   ← Shortcut
```

**Deterministic "today":** days since `2026-01-01` (local midnight), modulo 50.
The PWA computes it client-side; the GitHub Action materializes the same index
into static files. No state, no coordination.

**Copyright is architectural, not judgment-based:** works from the Met and AIC
are only included when the museum's own API flags them public domain
(`isPublicDomain` / `is_public_domain`); the build hard-fails any work whose
flag flips. That's why there's no *American Gothic* — AIC still flags it.
Every seed also carries an `expect` string checked against the API response,
so a wrong object ID fails loudly instead of shipping the wrong painting.

**Wallpaper composition:** paintings are never cropped. Each is matted on a
dark wall tinted from the painting's own palette, positioned below the iOS
lock-screen clock zone, with a drop shadow, hairline frame, and serif caption
(title / artist / year) — so the lock screen is self-describing and Siri's
screen awareness has text to read. Two variants: portrait (phones) and a
square iPad build whose art zone survives iPadOS's center-crop in *both*
orientations, since iPads rotate and one wallpaper must serve both.

## Commands

```sh
node scripts/build.mjs               # fetch + verify + process everything
node scripts/build.mjs --verify-only # check sources/flags without downloading
node scripts/build.mjs --force       # reprocess images (e.g. after tweaking the compositor)
node scripts/today.mjs               # materialize today.json + today/wallpaper.jpg
node scripts/narrate.mjs [--today]   # pre-render docent narration (needs Chatterbox on :8100)
python3 -m http.server -d site 8080  # local preview
```

Requires Node 18+ and a Python 3 with Pillow (the build auto-detects among
common installs; override with `PYTHON=/path/to/python3`).

## Deploying

1. Create a GitHub repo and push (`site/images/` is committed on purpose —
   CI never re-downloads from the museums).
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. Done. Pushes deploy; the cron in `.github/workflows/deploy.yml` rolls
   `today.json` + `today/wallpaper.jpg` just after midnight Pacific.

Then build the 3-action iOS Shortcut: see [docs/shortcut.md](docs/shortcut.md).

## Adding artworks

Append a seed to the right era file in `data/seeds/` (keep chronological
order), run `node scripts/build.mjs`, commit. Sources:

- `met` — object ID from metmuseum.org URL; API enforces the PD flag
- `aic` — artwork ID from artic.edu URL; API enforces the PD flag
- `commons` — exact Commons filename (no `File:` prefix); PD by curation, so
  stick to artists dead 100+ years

Note: changing the rotation length shifts which work lands on which date
(index = days mod N). Harmless, but today's painting will jump.
