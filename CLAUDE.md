# Morning Masterpieces

A daily art-history lesson: 50 public-domain masterpieces rotate as iOS
lock/home wallpapers (via Shortcuts) with a companion PWA that shows each
day's painting, a hand-written lesson, and a pre-rendered spoken docent.
Live at https://thirdbrainrepo.github.io/morning-masterpieces/ (repo:
thirdbrainrepo/morning-masterpieces).

**To add artworks, follow the wave runbook in README.md — it is the
canonical procedure.** Everything below is the context that makes it safe.

## Invariants — do not break these

- **"Today" is deterministic**: days since `2026-01-01` (local midnight),
  mod rotation length — computed identically in `site/app.js` and
  `scripts/today.mjs`. No stored state anywhere.
- **Copyright is enforced by the museum's own API flag** (Met
  `isPublicDomain`, AIC `is_public_domain`); the build hard-fails otherwise.
  Commons works are PD by curation (artists dead 100+ years). Never bypass.
- **Every seed carries `expect`** — an API-response sanity substring so a
  wrong object ID fails loudly instead of shipping the wrong painting.
- **The docent voice must stay consistent across waves**: reference audio is
  vendored at `data/voice/hanna.wav`; pacing is the `PAUSE_*` constants in
  `scripts/narrate.mjs`. The narration hash covers text + voice + pacing, so
  new works render to match automatically. Changing voice/pacing re-renders
  the entire gallery (~1 hr) — only do it deliberately.
- **Wallpapers never crop the painting** (matte composition, art below the
  iOS clock zone). The iPad variant is square because iPadOS center-crops
  one image for both orientations.
- `site/images/` and `site/audio/` are **committed on purpose** — CI only
  runs `today.mjs` and deploys; it never contacts museums or the TTS server.

## Local environment quirks

- `python3` on PATH is a pyenv shim **without Pillow**; `build.mjs`
  auto-detects a Pillow-capable python (framework python has it).
- Narration needs the Chatterbox Turbo server at `localhost:8100`
  (OpenAI-compatible `/v1/audio/speech`) and ffmpeg. Batch renders are good
  work for a cheap-model subagent: loop `node scripts/narrate.mjs` (it's
  incremental) until a run reports "0 rendered", then verify 50 files AND
  50 entries in `site/audio/hashes.json`.
- Wikimedia rate-limits hard — the build already serializes Commons requests.
- GitHub Pages deploys fail transiently (~half the time); the workflow
  retries once after a 2-minute cool-down. If a manual deploy fails, a fresh
  `gh workflow run deploy.yml` has always worked.

## Front-end gotchas already learned the hard way

- `[hidden]` loses to any authored `display:` — the stylesheet has a global
  `[hidden] { display: none !important; }`. Keep it.
- Verify UI changes with an **at-rest screenshot**, not DOM state queries.
- The wide-viewport layout locks page scroll (`overflow: hidden`) — new
  standalone pages (like `shortcuts.html`) must NOT link `styles.css`.
- In the installed PWA, download links trap users (no chrome); wallpaper
  saves go through the share sheet in standalone mode.
- The service worker shell is network-first by design (cache-first pinned
  installed PWAs to stale versions). `/today/*` must never be cache-first —
  content changes daily under fixed URLs.
