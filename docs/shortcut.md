# iOS Shortcut: daily lock-screen masterpiece

Once the site is deployed, GitHub Actions refreshes these stable URLs just
after midnight Pacific every day:

- `https://thirdbrainrepo.github.io/morning-masterpieces/today/wallpaper.jpg` — portrait 1640×2360 lock screen, for **iPhone**
- `https://thirdbrainrepo.github.io/morning-masterpieces/today/wallpaper-ipad.jpg` — square 2420×2420 lock screen, for **iPad**
- `https://thirdbrainrepo.github.io/morning-masterpieces/today/home.jpg` — full-bleed **home screen** crop, iPhone
- `https://thirdbrainrepo.github.io/morning-masterpieces/today/home-ipad.jpg` — full-bleed **home screen** crop, iPad
- `https://thirdbrainrepo.github.io/morning-masterpieces/today.json` — full metadata for today's work

Why two: an iPad rotates, and iPadOS center-crops a single wallpaper for both
orientations. The square variant keeps the painting and caption inside the
central region that survives both crops, so nothing is ever cut off no matter
how the iPad is held. On iPhone the portrait variant fills edge to edge.

Because "today" is materialized server-side, the Shortcut needs only **three
actions** and zero logic.

## The Shortcut (build once, ~2 minutes)

Open **Shortcuts** → **+** to create a new shortcut named `Morning Masterpiece`:

1. **Get Contents of URL**
   `.../today/wallpaper-ipad.jpg` on iPad, `.../today/wallpaper.jpg` on iPhone
   (full URLs above)
2. **Set Wallpaper** — set input to the *Contents of URL* variable.
   - Tap the arrow on the action and **turn OFF "Show Preview"** — otherwise
     iOS pops a confirmation dialog every morning and the automation stalls.
   - Choose which wallpaper it targets (your art lock screen — see below).
3. *(Optional)* **Show Notification** with *Get Dictionary from Input* on
   `today.json` if you want the title/artist to appear when it swaps.

## Home screen too (recommended)

By default iOS pairs the home screen with a blurred copy of the lock screen —
wasted real estate. The `home` variants are the painting itself, aspect-filled
edge to edge with no matte or caption (icons sit better over full-bleed art,
and iOS adds its own legibility treatment). Add two more actions to the same
shortcut:

4. **Get Contents of URL** → `.../today/home-ipad.jpg` (or `home.jpg` on iPhone)
5. **Set Wallpaper** — same wallpaper, but target **Home Screen**, with
   "Show Preview" off.

## If the caption text looks soft

Two things control sharpness, both one-time fixes:

- iOS applies a slight **parallax/perspective zoom** to wallpapers by default,
  which scales the image and softens fine text. Long-press the lock screen →
  **Customize** → pinch the image out/in to reset the crop, and disable
  Perspective Zoom if the option appears.
- Make sure the Shortcut points at the **iPad** variant on iPad — the square
  is sized pixel-exact for an 11" iPad Pro panel (2420px), so portrait shows
  it 1:1 with no upscale.

## The Automation

Shortcuts → **Automation** tab → **+** → **Time of Day**:

- Time: e.g. 6:00 AM, repeating **Daily**
- Select **Run Immediately** (not "Run After Confirmation") — this is what
  makes it fully hands-off.
- Action: run `Morning Masterpiece`.

## One-time iOS setup gotchas

- The target lock screen must be a plain **Photo** wallpaper, not **Photo
  Shuffle** — Shortcuts cannot modify a Shuffle wallpaper. Easiest path:
  create a dedicated wallpaper (long-press the lock screen → **+**) from any
  photo, then let the Shortcut overwrite it daily.
- On the lock screen, iOS may enable the **depth effect** or legibility blur
  unpredictably on paintings. The composed wallpaper puts the artwork below
  the clock zone on a dark matte specifically to avoid this — but if iOS
  gets clever, long-press the lock screen → **Customize** → disable Depth
  Effect.
- Run the shortcut manually once before trusting the automation; iOS asks
  for one-time permission to connect to your domain and to set wallpapers.

## Manifest-driven variant (no GitHub Actions needed)

If you ever host the site somewhere static without the daily cron, the
Shortcut can compute the index itself:

1. **Get Contents of URL** → `.../artworks.json`
2. **Get Dictionary Value** → `items` → **Count** items
3. **Format Date** (Current Date, custom format `D` = day of year) — or
   compute days since 2026-01-01 with **Get Time Between Dates** (in Days)
4. **Calculate** → days **Modulus** count
5. **Get Item from List** (Item at Index — note Shortcuts lists are 1-indexed,
   so add 1 to the modulus result)
6. **Get Dictionary Value** → `wallpaper` → prepend the site URL
7. **Get Contents of URL** → **Set Wallpaper**

The three-action version is better. Use this only as a fallback.

## Siri / Apple Intelligence

With iOS 26/27 on-screen awareness, "What can you tell me about my lock
screen?" works directly since the wallpaper carries the title and artist in
its caption. For richer context, the PWA's **Copy a prompt** button builds a
fully-specified question about today's work, and `today.json` is a stable,
agent-readable endpoint for anything else you want to wire up.
